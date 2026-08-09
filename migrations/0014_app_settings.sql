-- 0014_app_settings.sql · Generic key/value app settings
-- A small JSONB store for org-wide dashboard settings that aren't per-campaign
-- (those live in campaign_targets / campaign_rules). First consumer: the
-- per-role tab-visibility matrix the admin edits on the Access tab, letting an
-- admin hide tabs from a role's view (e.g. while a tab is being built out).
-- Additive, forward-only.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INT REFERENCES users(id) ON DELETE SET NULL
);
