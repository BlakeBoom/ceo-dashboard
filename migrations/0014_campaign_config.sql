-- 0014 · DB-backed campaign display metadata, KPI tiles / targets, and
-- workgroup routing. Until now these three lived as hardcoded objects in
-- index.html (WG_MAP, CAMP_DISPLAY, CAMP_SECTION, TARGETS, KPI_CONFIG), so a
-- new campaign only surfaced on dashboards after a code edit. This migration
-- moves each one into rows so the Campaign admin screen can edit them.
--
--   • campaigns.display_name / campaigns.section — the short uppercase label
--     shown on campaign cards ("BUTTERNUT BOX", "JUST PARK UK") and the
--     section it groups under ("Customer Services" / "Sales").
--
--   • campaign_kpis — one row per (campaign, KPI) pair. Holds the label the
--     tile shows, the direction (higher = green when higher, lower = green
--     when lower, none = display only), the numeric target used for RAG
--     scoring, a priority for tile order, and an is_tile flag so a target
--     used off-tile (e.g. VETNIQUE.acw) can still live in the table.
--
--   • campaign_workgroups — one row per (workgroup label → campaign). The
--     label side is UNIQUE: WG_MAP was many-to-one, and enforcing that here
--     stops two campaigns silently claiming the same workgroup on ingest.
--
-- All three are seeded from the current hardcoded maps so BEHAVIOUR IS
-- UNCHANGED post-migration; the client keeps the hardcoded literals as a
-- fallback if /api/campaigns/config fails on boot.

BEGIN;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS section      TEXT;

-- Backfill display_name / section from CAMP_DISPLAY / CAMP_SECTION for every
-- campaign whose shift_key is one of the hardcoded keys. JUSTPARK_so is not
-- a real shift_key (a legacy display alias for _usa) so it is not seeded.
UPDATE campaigns c SET display_name = v.display_name, section = v.section
  FROM (VALUES
    ('Gousto',         'GOUSTO',            'Customer Services'),
    ('VETNIQUE',       'VETNIQUE',          'Customer Services'),
    ('JUSTPARK_usa',   'JUST PARK US',      'Customer Services'),
    ('JUSTPARK_uk',    'JUST PARK UK',      'Customer Services'),
    ('BUTTERNUTBOX',   'BUTTERNUT BOX',     'Customer Services'),
    ('Medexpress',     'MEDEXPRESS',        'Customer Services'),
    ('PICKNPAY',       'PICKNPAY',          'Customer Services'),
    ('ROYALCANIN',     'ROYAL CANIN',       'Customer Services'),
    ('HUNZAG',         'HUNZAG',            'Customer Services'),
    ('GOODLIFESORTED', 'GOOD LIFE SORTED',  'Customer Services'),
    ('HYVE',           'HYVE',              'Customer Services'),
    ('PINTER',         'PINTER',            'Sales'),
    ('BEER52',         'BEER52',            'Sales'),
    ('1LIFE',          '1LIFE',             'Sales')
  ) AS v(shift_key, display_name, section)
 WHERE c.shift_key = v.shift_key
   AND (c.display_name IS NULL OR c.section IS NULL);

CREATE TABLE IF NOT EXISTS campaign_kpis (
  id           SERIAL PRIMARY KEY,
  campaign_id  INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kpi_key      TEXT NOT NULL,
  label        TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('higher', 'lower', 'none')),
  target       NUMERIC,
  priority     INT NOT NULL DEFAULT 100,
  is_tile      BOOLEAN NOT NULL DEFAULT TRUE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, kpi_key)
);
CREATE INDEX IF NOT EXISTS campaign_kpis_camp_priority_idx
  ON campaign_kpis (campaign_id, priority);

-- Seed KPI tiles + targets. Priority preserves the array order of the
-- hardcoded KPI_CONFIG (10, 20, 30, …). Targets come from TARGETS[camp][kpi];
-- entries in TARGETS that are NOT tiles (VETNIQUE.acw) are inserted with
-- is_tile=false at priority 999 so the target value stays visible to RAG code
-- but the tile grid does not render it.
INSERT INTO campaign_kpis (campaign_id, kpi_key, label, direction, target, priority, is_tile)
SELECT c.id, v.kpi_key, v.label, v.direction, v.target, v.priority, v.is_tile
  FROM (VALUES
    -- Gousto
    ('Gousto', 'csat',        'CSAT',        'higher', 88::numeric,  10, TRUE),
    ('Gousto', 'qa',          'QA',          'higher', 90::numeric,  20, TRUE),
    ('Gousto', 'cph',         'CPH',         'higher', 5.5::numeric, 30, TRUE),
    ('Gousto', 'adherence',   'Adherence',   'higher', 95::numeric,  40, TRUE),
    ('Gousto', 'fulfil',      'Fulfil',      'higher', 100::numeric, 50, TRUE),
    ('Gousto', 'realisation', 'Realisation', 'higher', 90::numeric,  60, TRUE),
    ('Gousto', 'churn',       'Churn',       'lower',  20::numeric,  70, TRUE),
    ('Gousto', 'absence',     'Absence',     'lower',  5::numeric,   80, TRUE),
    -- VETNIQUE (acw target only, not a tile)
    ('VETNIQUE', 'csat',        'CSAT',        'higher', 90::numeric,  10, TRUE),
    ('VETNIQUE', 'qa',          'QA',          'higher', 95::numeric,  20, TRUE),
    ('VETNIQUE', 'cph',         'CPH',         'higher', 6::numeric,   30, TRUE),
    ('VETNIQUE', 'res_time',    'Res. time',   'lower',  48::numeric,  40, TRUE),
    ('VETNIQUE', 'fulfil',      'Fulfil',      'higher', 100::numeric, 50, TRUE),
    ('VETNIQUE', 'realisation', 'Realisation', 'higher', 90::numeric,  60, TRUE),
    ('VETNIQUE', 'churn',       'Churn',       'lower',  20::numeric,  70, TRUE),
    ('VETNIQUE', 'absence',     'Absence',     'lower',  5::numeric,   80, TRUE),
    ('VETNIQUE', 'acw',         'ACW',         'lower',  1.25::numeric, 999, FALSE),
    -- JUSTPARK_usa
    ('JUSTPARK_usa', 'csat',        'CSAT',        'higher', 80::numeric,  10, TRUE),
    ('JUSTPARK_usa', 'qa',          'QA',          'higher', 85::numeric,  20, TRUE),
    ('JUSTPARK_usa', 'fcr',         'FCR',         'higher', 90::numeric,  30, TRUE),
    ('JUSTPARK_usa', 'sla',         'SLA',         'higher', 90::numeric,  40, TRUE),
    ('JUSTPARK_usa', 'fulfil',      'Fulfil',      'higher', 100::numeric, 50, TRUE),
    ('JUSTPARK_usa', 'realisation', 'Realisation', 'higher', 90::numeric,  60, TRUE),
    ('JUSTPARK_usa', 'churn',       'Churn',       'lower',  20::numeric,  70, TRUE),
    ('JUSTPARK_usa', 'absence',     'Absence',     'lower',  5::numeric,   80, TRUE),
    -- JUSTPARK_uk
    ('JUSTPARK_uk', 'csat',        'CSAT',        'higher', 80::numeric,  10, TRUE),
    ('JUSTPARK_uk', 'qa',          'QA',          'higher', 90::numeric,  20, TRUE),
    ('JUSTPARK_uk', 'cph',         'CPH',         'higher', 6::numeric,   30, TRUE),
    ('JUSTPARK_uk', 'fcr',         'FCR',         'higher', 85::numeric,  40, TRUE),
    ('JUSTPARK_uk', 'tickets',     'Tickets',     'none',   NULL,         50, TRUE),
    ('JUSTPARK_uk', 'fulfil',      'Fulfil',      'higher', 100::numeric, 60, TRUE),
    ('JUSTPARK_uk', 'realisation', 'Realisation', 'higher', 90::numeric,  70, TRUE),
    ('JUSTPARK_uk', 'churn',       'Churn',       'lower',  20::numeric,  80, TRUE),
    ('JUSTPARK_uk', 'absence',     'Absence',     'lower',  5::numeric,   90, TRUE),
    -- BUTTERNUTBOX
    ('BUTTERNUTBOX', 'csat',        'CSAT',        'higher', 90::numeric,  10, TRUE),
    ('BUTTERNUTBOX', 'qa',          'QA',          'higher', 90::numeric,  20, TRUE),
    ('BUTTERNUTBOX', 'cpd',         'CPD',         'higher', 50::numeric,  30, TRUE),
    ('BUTTERNUTBOX', 'fulfil',      'Fulfil',      'higher', 100::numeric, 40, TRUE),
    ('BUTTERNUTBOX', 'realisation', 'Realisation', 'higher', 90::numeric,  50, TRUE),
    ('BUTTERNUTBOX', 'churn',       'Churn',       'lower',  20::numeric,  60, TRUE),
    ('BUTTERNUTBOX', 'absence',     'Absence',     'lower',  5::numeric,   70, TRUE),
    -- Medexpress (compliance / productivity are targets, aht + tickets are the tiles)
    ('Medexpress', 'csat',         'CSAT',         'higher', 85::numeric,  10, TRUE),
    ('Medexpress', 'qa',           'QA',           'higher', 90::numeric,  20, TRUE),
    ('Medexpress', 'aht',          'AHT',          'lower',  NULL,         30, TRUE),
    ('Medexpress', 'tickets',      'Tickets',      'none',   NULL,         40, TRUE),
    ('Medexpress', 'fulfil',       'Fulfil',       'higher', 100::numeric, 50, TRUE),
    ('Medexpress', 'realisation',  'Realisation',  'higher', 90::numeric,  60, TRUE),
    ('Medexpress', 'churn',        'Churn',        'lower',  20::numeric,  70, TRUE),
    ('Medexpress', 'absence',      'Absence',      'lower',  5::numeric,   80, TRUE),
    ('Medexpress', 'compliance',   'Compliance',   'higher', 100::numeric, 999, FALSE),
    ('Medexpress', 'productivity', 'Productivity', 'higher', 90::numeric,  999, FALSE),
    -- PICKNPAY (talk_sla / calls_abn are targets, sla + calls + abandon_rate are the tiles)
    ('PICKNPAY', 'qa',           'QA',        'higher', 80::numeric,  10, TRUE),
    ('PICKNPAY', 'sla',          'Talk SLA',  'higher', NULL,         20, TRUE),
    ('PICKNPAY', 'calls',        'Calls',     'none',   NULL,         30, TRUE),
    ('PICKNPAY', 'abandon_rate', 'Abandoned', 'lower',  NULL,         40, TRUE),
    ('PICKNPAY', 'fulfil',       'Fulfil',    'higher', 100::numeric, 50, TRUE),
    ('PICKNPAY', 'realisation',  'Realisation','higher',90::numeric,  60, TRUE),
    ('PICKNPAY', 'churn',        'Churn',     'lower',  20::numeric,  70, TRUE),
    ('PICKNPAY', 'absence',      'Absence',   'lower',  5::numeric,   80, TRUE),
    ('PICKNPAY', 'csat',         'CSAT',      'higher', 85::numeric,  999, FALSE),
    ('PICKNPAY', 'talk_sla',     'Talk SLA',  'higher', 90::numeric,  999, FALSE),
    ('PICKNPAY', 'calls_abn',    'Calls abn', 'lower',  5::numeric,   999, FALSE),
    -- ROYALCANIN (error_rate is a target only)
    ('ROYALCANIN', 'qa',           'QA',          'higher', 95::numeric,  10, TRUE),
    ('ROYALCANIN', 'cph',          'CPH',         'higher', 4::numeric,   20, TRUE),
    ('ROYALCANIN', 'tickets',      'Tickets',     'none',   NULL,         30, TRUE),
    ('ROYALCANIN', 'fulfil',       'Fulfil',      'higher', 100::numeric, 40, TRUE),
    ('ROYALCANIN', 'realisation',  'Realisation', 'higher', 90::numeric,  50, TRUE),
    ('ROYALCANIN', 'churn',        'Churn',       'lower',  20::numeric,  60, TRUE),
    ('ROYALCANIN', 'absence',      'Absence',     'lower',  5::numeric,   70, TRUE),
    ('ROYALCANIN', 'error_rate',   'Error rate',  'lower',  2::numeric,   999, FALSE),
    -- HUNZAG
    ('HUNZAG', 'qa',           'QA',          'higher', 95::numeric,  10, TRUE),
    ('HUNZAG', 'cpd',          'CPD',         'higher', 20::numeric,  20, TRUE),
    ('HUNZAG', 'res_time',     'Res. time',   'lower',  24::numeric,  30, TRUE),
    ('HUNZAG', 'tickets',      'Tickets',     'none',   NULL,         40, TRUE),
    ('HUNZAG', 'fulfil',       'Fulfil',      'higher', 100::numeric, 50, TRUE),
    ('HUNZAG', 'realisation',  'Realisation', 'higher', 90::numeric,  60, TRUE),
    ('HUNZAG', 'churn',        'Churn',       'lower',  20::numeric,  70, TRUE),
    ('HUNZAG', 'absence',      'Absence',     'lower',  5::numeric,   80, TRUE),
    -- GOODLIFESORTED (calls_abn as target-only)
    ('GOODLIFESORTED', 'qa',           'QA',          'higher', 95::numeric,  10, TRUE),
    ('GOODLIFESORTED', 'cph',          'CPH',         'higher', 4::numeric,   20, TRUE),
    ('GOODLIFESORTED', 'aht',          'AHT',         'lower',  3::numeric,   30, TRUE),
    ('GOODLIFESORTED', 'calls',        'Calls',       'none',   NULL,         40, TRUE),
    ('GOODLIFESORTED', 'fulfil',       'Fulfil',      'higher', 100::numeric, 50, TRUE),
    ('GOODLIFESORTED', 'realisation',  'Realisation', 'higher', 90::numeric,  60, TRUE),
    ('GOODLIFESORTED', 'churn',        'Churn',       'lower',  20::numeric,  70, TRUE),
    ('GOODLIFESORTED', 'absence',      'Absence',     'lower',  5::numeric,   80, TRUE),
    ('GOODLIFESORTED', 'calls_abn',    'Calls abn',   'lower',  8::numeric,   999, FALSE),
    -- PINTER (avg_resp_time target-only)
    ('PINTER', 'csat',           'CSAT',           'higher', 80::numeric,  10, TRUE),
    ('PINTER', 'qa',             'QA',             'higher', 90::numeric,  20, TRUE),
    ('PINTER', 'res_time',       'Res. time',      'lower',  24::numeric,  30, TRUE),
    ('PINTER', 'tickets',        'Tickets',        'none',   NULL,         40, TRUE),
    ('PINTER', 'fulfil',         'Fulfil',         'higher', 100::numeric, 50, TRUE),
    ('PINTER', 'realisation',    'Realisation',    'higher', 90::numeric,  60, TRUE),
    ('PINTER', 'churn',          'Churn',          'lower',  20::numeric,  70, TRUE),
    ('PINTER', 'absence',        'Absence',        'lower',  5::numeric,   80, TRUE),
    ('PINTER', 'avg_resp_time',  'Avg resp time',  'lower',  4::numeric,   999, FALSE),
    -- BEER52
    ('BEER52', 'qa',           'QA',          'higher', 90::numeric,   10, TRUE),
    ('BEER52', 'sph',          'SPH',         'higher', 1.25::numeric, 20, TRUE),
    ('BEER52', 'calls',        'Calls',       'none',   NULL,          30, TRUE),
    ('BEER52', 'sales',        'Sales',       'none',   NULL,          40, TRUE),
    ('BEER52', 'fulfil',       'Fulfil',      'higher', 100::numeric,  50, TRUE),
    ('BEER52', 'realisation',  'Realisation', 'higher', 90::numeric,   60, TRUE),
    ('BEER52', 'churn',        'Churn',       'lower',  20::numeric,   70, TRUE),
    ('BEER52', 'absence',      'Absence',     'lower',  5::numeric,    80, TRUE),
    -- 1LIFE (sales target is higher for 1LIFE, tile shows sales as 'higher')
    ('1LIFE', 'qa',           'QA',          'higher', 90::numeric,  10, TRUE),
    ('1LIFE', 'sales',        'Sales',       'higher', 350::numeric, 20, TRUE),
    ('1LIFE', 'tickets',      'Tickets',     'none',   NULL,         30, TRUE),
    ('1LIFE', 'fulfil',       'Fulfil',      'higher', 100::numeric, 40, TRUE),
    ('1LIFE', 'realisation',  'Realisation', 'higher', 90::numeric,  50, TRUE),
    ('1LIFE', 'churn',        'Churn',       'lower',  20::numeric,  60, TRUE),
    ('1LIFE', 'absence',      'Absence',     'lower',  5::numeric,   70, TRUE)
  ) AS v(shift_key, kpi_key, label, direction, target, priority, is_tile)
  JOIN campaigns c ON c.shift_key = v.shift_key
 ON CONFLICT (campaign_id, kpi_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS campaign_workgroups (
  id           SERIAL PRIMARY KEY,
  campaign_id  INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label        TEXT NOT NULL UNIQUE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS campaign_workgroups_camp_idx ON campaign_workgroups (campaign_id);

INSERT INTO campaign_workgroups (campaign_id, label)
SELECT c.id, v.label FROM (VALUES
  ('1LIFE',         '1LIFE'),
  ('BUTTERNUTBOX',  'BBOX'),
  ('BUTTERNUTBOX',  'Butternut Box'),
  ('Gousto',        'Gousto'),
  ('HUNZAG',        'HunzaG'),
  ('JUSTPARK_uk',   'JUST PARK'),
  ('JUSTPARK_uk',   'Just Park'),
  ('JUSTPARK_uk',   'JustPark'),
  ('JUSTPARK_usa',  'JustPark Space Owner'),
  ('JUSTPARK_usa',  'Just Park Space Owner'),
  ('JUSTPARK_usa',  'JustPark SP'),
  ('JUSTPARK_usa',  'JustPark Event Pass'),
  ('JUSTPARK_usa',  'JustPark US'),
  ('JUSTPARK_usa',  'JUST PARK US'),
  ('Medexpress',    'MedExpress'),
  ('PICKNPAY',      'PICKnPAY'),
  ('PINTER',        'Pinter'),
  ('ROYALCANIN',    'Royal Canin'),
  ('ROYALCANIN',    'RoyalCanin'),
  ('GOODLIFESORTED','The Good Life Sorted'),
  ('VETNIQUE',      'VETNIQUE'),
  ('VETNIQUE',      'Lint Bells'),
  ('VETNIQUE',      'Lintbells'),
  ('BEER52',        'Beer52'),
  ('HYVE',          'HYVE')
) AS v(shift_key, label)
JOIN campaigns c ON c.shift_key = v.shift_key
ON CONFLICT (label) DO NOTHING;

COMMIT;
