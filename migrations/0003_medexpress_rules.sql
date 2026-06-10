-- 0003 · Seed Medexpress bonus rules.
-- Components, thresholds, and amounts taken from the cohort tracker
-- (Automation_Rules_2026, Medexpress section):
--   S&A:           callouts == 0 → 1000
--   Productivity:  >= 1470       → 1000
--   CSAT:          >= 90%        →  500
--   QA:            >= 90%        →  500
--   Final bonus = sum of components met (max 3000)
-- "Callouts" derived from rows in AttendanceUserReport whose Status falls
-- in the unplanned set (Sick Leave, Absent, No Show, AWOL, etc.).
-- metric_column under Productivity tells the sync layer which Zoho column
-- to SUM monthly. 'tickets' is the placeholder — confirm with ops; adjust
-- with `UPDATE bonus_rules SET rule_json = jsonb_set(...)` if it should be
-- 'calls' or another column.

INSERT INTO bonus_rules (campaign_id, effective_from, effective_to, rule_json)
SELECT c.id, '2026-01-01'::date, NULL, $${
  "components": [
    { "key": "sa",
      "label": "S&A",
      "type": "callouts_le",
      "threshold": 0,
      "amount": 1000 },
    { "key": "productivity",
      "label": "Productivity",
      "type": "value_ge",
      "metric_column": "tickets",
      "threshold": 1470,
      "amount": 1000 },
    { "key": "csat",
      "label": "CSAT",
      "type": "pct_ge",
      "threshold": 0.90,
      "amount": 500 },
    { "key": "qa",
      "label": "QA",
      "type": "pct_ge",
      "threshold": 0.90,
      "amount": 500 }
  ],
  "unplanned_statuses": [
    "Sick Leave", "Sick Leave Shifts",
    "Absent", "No Show",
    "Unpaid Leave", "Unpaid Leave Shifts",
    "AWOL", "System Downtime"
  ],
  "kpi_min_components": 0
}$$::jsonb
FROM campaigns c
WHERE c.slug = 'medexpress'
ON CONFLICT (campaign_id, effective_from) DO NOTHING;
