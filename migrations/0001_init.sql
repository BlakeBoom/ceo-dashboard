-- 0001_init.sql · Boomerang dashboard core schema
-- Roles, campaigns, teams, users, sessions

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Campaign = top-level client (Medexpress, PicknPay, Butternut Box, etc.)
CREATE TABLE IF NOT EXISTS campaigns (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,        -- 'medexpress'
  name        TEXT NOT NULL,               -- 'Medexpress'
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Team = sub-group within a campaign (typically a cohort or pod)
CREATE TABLE IF NOT EXISTS teams (
  id           SERIAL PRIMARY KEY,
  campaign_id  INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,              -- 'Cohort 10'
  tm_user_id   INT,                        -- FK added after users table exists
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, name)
);

-- Role taxonomy. Hierarchy: admin > campaign_lead > tm > agent
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('agent', 'tm', 'campaign_lead', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  email           CITEXT UNIQUE,                       -- nullable so agents w/o email can exist
  password_hash   TEXT,                                -- nullable until first password set
  full_name       TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'agent',
  campaign_id     INT REFERENCES campaigns(id) ON DELETE SET NULL,
  team_id         INT REFERENCES teams(id) ON DELETE SET NULL,
  zoho_user_id    TEXT UNIQUE,                         -- link to Zoho People record
  token_version   INT NOT NULL DEFAULT 0,              -- bump to invalidate all sessions
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE teams
    ADD CONSTRAINT teams_tm_fk
    FOREIGN KEY (tm_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS users_campaign_idx ON users (campaign_id);
CREATE INDEX IF NOT EXISTS users_team_idx     ON users (team_id);
CREATE INDEX IF NOT EXISTS users_role_idx     ON users (role);

-- Audit trail for security-sensitive events
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,                  -- 'login.success', 'login.fail', 'user.create', etc.
  target_id   INT,                            -- id of affected row, if any
  ip          INET,
  user_agent  TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action, created_at DESC);

-- Seed campaigns from the existing dashboard list
INSERT INTO campaigns (slug, name) VALUES
  ('medexpress',     'Medexpress'),
  ('picknpay',       'PICKnPAY'),
  ('butternutbox',   'Butternut Box'),
  ('pinter',         'Pinter'),
  ('boomerang-internal', 'Boomerang Internal')
ON CONFLICT (slug) DO NOTHING;
