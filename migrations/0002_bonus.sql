-- 0002_bonus.sql · Bonus engine (Phase 2 wires these up)
-- Per-campaign rules, per-period metrics pulled from Zoho, computed awards.

-- A rules row defines bonus thresholds + amounts for a campaign over a date window.
-- rule_json shape:
-- {
--   "components": [
--     { "key": "sa",           "label": "S&A",          "type": "callouts_le",  "threshold": 0, "amount": 1000 },
--     { "key": "productivity", "label": "Productivity", "type": "value_ge",     "threshold": 1500, "amount": 1000 },
--     { "key": "csat",         "label": "CSAT",         "type": "pct_ge",       "threshold": 0.85, "amount": 0 },
--     { "key": "qa",           "label": "QA",           "type": "pct_ge",       "threshold": 0.80, "amount": 0 }
--   ],
--   "kpi_sum_threshold": 2,           -- min components hit to qualify for final bonus
--   "final_bonus_formula": "sum"       -- "sum" | "fixed" | future variants
-- }
CREATE TABLE IF NOT EXISTS bonus_rules (
  id              SERIAL PRIMARY KEY,
  campaign_id     INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  effective_from  DATE NOT NULL,
  effective_to    DATE,                                       -- NULL = open-ended
  rule_json       JSONB NOT NULL,
  created_by      INT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, effective_from)
);
CREATE INDEX IF NOT EXISTS bonus_rules_campaign_idx ON bonus_rules (campaign_id, effective_from DESC);

-- A bonus period = the window we score (typically monthly per campaign).
CREATE TABLE IF NOT EXISTS bonus_periods (
  id            SERIAL PRIMARY KEY,
  campaign_id   INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  locked        BOOLEAN NOT NULL DEFAULT FALSE,   -- TM/Ops sign-off freezes the numbers
  locked_at     TIMESTAMPTZ,
  locked_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, period_start, period_end)
);

-- Raw metric snapshot per agent per period, pulled from Zoho.
CREATE TABLE IF NOT EXISTS bonus_metrics (
  id                 BIGSERIAL PRIMARY KEY,
  period_id          INT NOT NULL REFERENCES bonus_periods(id) ON DELETE CASCADE,
  user_id            INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_days    INT,
  productivity       NUMERIC(10,2),
  csat_pct           NUMERIC(5,4),     -- 0.0000 .. 1.0000
  qa_pct             NUMERIC(5,4),
  callouts           INT,
  raw                JSONB,            -- everything else returned by Zoho, for audit
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, user_id)
);
CREATE INDEX IF NOT EXISTS bonus_metrics_user_idx ON bonus_metrics (user_id, period_id);

-- Computed awards. Re-derivable from metrics + rules; we persist for audit + speed.
CREATE TABLE IF NOT EXISTS bonus_awards (
  id                 BIGSERIAL PRIMARY KEY,
  period_id          INT NOT NULL REFERENCES bonus_periods(id) ON DELETE CASCADE,
  user_id            INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id            INT NOT NULL REFERENCES bonus_rules(id),
  components         JSONB NOT NULL,         -- { sa: 1000, productivity: 1000, csat: 0, qa: 0 }
  kpi_bonus          NUMERIC(12,2) NOT NULL, -- sum of components
  final_bonus        NUMERIC(12,2) NOT NULL, -- after qualification rules
  qualified          BOOLEAN NOT NULL,
  calculated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, user_id)
);
CREATE INDEX IF NOT EXISTS bonus_awards_user_idx ON bonus_awards (user_id, period_id);
