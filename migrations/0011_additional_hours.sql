-- 0011 · Ad-hoc approved additional billable hours. Campaigns sometimes approve
-- extra hours on specific days, unknown until the day. These are worked (so they
-- already flow into billable via attendance) but the fixed Required target
-- (Target FTE × SLA hrs/FTE) doesn't include them — which inflates Fulfilment
-- and understates Slippage. Recording them here lets the dashboard add them to
-- Required for the matching period so the comparison stays honest, and show the
-- base-vs-additional breakdown. One row per (campaign, day); upserted.
CREATE TABLE IF NOT EXISTS campaign_additional_hours (
  id          SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  work_date   DATE NOT NULL,
  hours       NUMERIC(10,2) NOT NULL DEFAULT 0,
  note        TEXT,
  updated_by  INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, work_date)
);
CREATE INDEX IF NOT EXISTS campaign_additional_hours_idx
  ON campaign_additional_hours (campaign_id, work_date DESC);
