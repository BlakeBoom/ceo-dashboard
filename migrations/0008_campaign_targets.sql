-- 0008 · Campaign targets (the "Automation Rules": required FTE + monthly
-- billable hours that drive slippage). Effective-dated per campaign so each
-- month can be edited and applies from the chosen date forward; the value used
-- for any period is the row with the latest effective_from on/before it.
CREATE TABLE IF NOT EXISTS campaign_targets (
  id             SERIAL PRIMARY KEY,
  campaign_id    INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  req_fte        NUMERIC(10,2),
  req_hrs_month  NUMERIC(12,2),
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, effective_from)
);
CREATE INDEX IF NOT EXISTS campaign_targets_idx ON campaign_targets (campaign_id, effective_from DESC);
