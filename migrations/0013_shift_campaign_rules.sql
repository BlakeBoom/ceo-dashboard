-- 0013 · DB-backed shift → campaign routing.
--
-- Until now, the shift-name → campaign mapping lived as a hardcoded array of
-- regexes in shared/names.js (SHIFT_PATTERNS). That meant every new shift-name
-- variation shipped by a client — or a whole new campaign — required a code
-- change + deploy. This migration moves the mapping into two tables so admins
-- can add/edit rules from the UI:
--
--   1. campaigns.shift_key TEXT  — the identifier shiftToCampaign() returns
--      (e.g. 'HYVE', 'Medexpress', 'JUSTPARK_usa'). Kept as a column so the
--      rest of the app (KPI configs, benchmarks, labels indexed by key) stays
--      untouched. Backfilled for every campaign the old SHIFT_PATTERNS knew
--      about; missing campaigns are inserted so seed parity is exact.
--
--   2. shift_campaign_rules — one row per pattern. priority preserves the
--      specific-first order the old array relied on (lower priority wins).
--      match_mode is one of 'contains' (case-insensitive substring), 'word'
--      (case-insensitive with word boundaries), or 'regex' (raw JS regex, i
--      flag). The seed uses 'regex' to reproduce the current patterns EXACTLY;
--      admins can add simpler 'contains'/'word' rules going forward.

BEGIN;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS shift_key TEXT;

-- Backfill shift_key for existing campaigns (slug → shift key).
UPDATE campaigns SET shift_key = 'Medexpress'     WHERE slug = 'medexpress'   AND shift_key IS NULL;
UPDATE campaigns SET shift_key = 'PICKNPAY'       WHERE slug = 'picknpay'     AND shift_key IS NULL;
UPDATE campaigns SET shift_key = 'BUTTERNUTBOX'   WHERE slug = 'butternutbox' AND shift_key IS NULL;
UPDATE campaigns SET shift_key = 'PINTER'         WHERE slug = 'pinter'       AND shift_key IS NULL;
UPDATE campaigns SET shift_key = 'HYVE'           WHERE slug = 'hyve'         AND shift_key IS NULL;
UPDATE campaigns SET shift_key = 'JUSTPARK_uk'    WHERE slug = 'justpark'     AND shift_key IS NULL;
UPDATE campaigns SET shift_key = 'JUSTPARK_usa'   WHERE slug = 'justpark-us'  AND shift_key IS NULL;

-- Insert campaigns for the remaining hardcoded keys so every seed rule has a
-- valid FK. Skipped if the slug already exists.
INSERT INTO campaigns (slug, name, shift_key) VALUES
  ('beer52',          'Beer52',           'BEER52'),
  ('gousto',          'Gousto',           'Gousto'),
  ('hunzag',          'HunzaG',           'HUNZAG'),
  ('royalcanin',      'Royal Canin',      'ROYALCANIN'),
  ('goodlifesorted',  'Good Life Sorted', 'GOODLIFESORTED'),
  ('vetnique',        'Vetnique',         'VETNIQUE'),
  ('1life',           '1Life',            '1LIFE')
ON CONFLICT (slug) DO UPDATE SET shift_key = EXCLUDED.shift_key
  WHERE campaigns.shift_key IS NULL;

-- Unique index once populated (partial so nulls are still allowed for
-- back-office / internal campaigns that never appear in a shift row).
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_shift_key_key
  ON campaigns (shift_key) WHERE shift_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS shift_campaign_rules (
  id           SERIAL PRIMARY KEY,
  campaign_id  INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  pattern      TEXT NOT NULL,
  match_mode   TEXT NOT NULL CHECK (match_mode IN ('contains', 'word', 'regex')),
  priority     INT NOT NULL DEFAULT 100,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  note         TEXT,
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shift_campaign_rules_active_priority_idx
  ON shift_campaign_rules (active, priority);
CREATE INDEX IF NOT EXISTS shift_campaign_rules_campaign_idx
  ON shift_campaign_rules (campaign_id);

-- Seed rules from the old hardcoded SHIFT_PATTERNS. Priorities match the
-- original array order (lower = higher priority; JUSTPARK_usa must beat
-- JUSTPARK_uk, Marro must beat Butternut, etc.). Skipped on re-run via the
-- NOT EXISTS guard.
INSERT INTO shift_campaign_rules (campaign_id, pattern, match_mode, priority, note)
SELECT c.id, v.pattern, 'regex', v.priority,
       'Seeded from legacy SHIFT_PATTERNS on migration 0013'
  FROM (VALUES
    ('BEER52',         'beer\s*52',                                                     10),
    ('HYVE',           '\bhyve\b|indaba|\bc[\s-]*wieme\b|\bmining\b|spring[\s-]*fair', 20),
    ('BUTTERNUTBOX',   'bb\s*marro|\bmarro\b',                                          30),
    ('BUTTERNUTBOX',   'butternut|\bbbox\b',                                            40),
    ('Gousto',         'gousto',                                                        50),
    ('HUNZAG',         'hunza\s*g',                                                     60),
    ('Medexpress',     'med\s*express|\bmedx\b',                                        70),
    ('PICKNPAY',       'pic?k\s*n\s*pay|\bpnp\b',                                       80),
    ('ROYALCANIN',     'royal\s*canin',                                                 90),
    ('GOODLIFESORTED', 'good\s*life|\bgls\b',                                          100),
    ('VETNIQUE',       'lint\s*bells|vetnique',                                        110),
    ('PINTER',         'pinter',                                                       120),
    ('1LIFE',          '1\s*life|one\s*life',                                          130),
    ('JUSTPARK_usa',   'just\s*park.*(space\s*owner|\bsp\b|event\s*pass|\bus\b)',      140),
    ('JUSTPARK_uk',    'just\s*park',                                                  150)
  ) AS v(shift_key, pattern, priority)
  JOIN campaigns c ON c.shift_key = v.shift_key
 WHERE NOT EXISTS (
   SELECT 1 FROM shift_campaign_rules r
    WHERE r.campaign_id = c.id AND r.pattern = v.pattern AND r.match_mode = 'regex'
 );

COMMIT;
