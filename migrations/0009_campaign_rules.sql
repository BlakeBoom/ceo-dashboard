-- 0009 · Generic per-campaign automation rules (the full Targets & Rules
-- matrix from Automation_Rules: rates, working days, shifts, training,
-- resources, productive-hours/FTE targets). Key/value so heterogeneous values
-- (money, yes/no, times, hours) all fit. Effective-dated per campaign: a value
-- applies from its effective_from forward until a later one supersedes it.
CREATE TABLE IF NOT EXISTS campaign_rules (
  id             SERIAL PRIMARY KEY,
  campaign_id    INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  rule_key       TEXT NOT NULL,
  value          TEXT,
  updated_by     INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, effective_from, rule_key)
);
CREATE INDEX IF NOT EXISTS campaign_rules_idx ON campaign_rules (campaign_id, effective_from DESC);
