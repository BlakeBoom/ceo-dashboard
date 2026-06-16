-- 0010 · Consolidate Just Park into two campaigns.
-- "Just Park" = Just Park UK; "Just Park US" and "JustPark Event Pass" are both
-- Just Park US. Fold the Event Pass campaign into US and rename the two.

-- Ensure the US campaign exists.
INSERT INTO campaigns (slug, name) VALUES ('justpark-us', 'Just Park US')
  ON CONFLICT (slug) DO UPDATE SET name = 'Just Park US';

-- Rename UK.
UPDATE campaigns SET name = 'Just Park UK' WHERE slug = 'justpark';

-- Move any Event Pass users to US (clear their team — teams were per-campaign).
UPDATE users
   SET campaign_id = (SELECT id FROM campaigns WHERE slug = 'justpark-us'),
       team_id = NULL, token_version = token_version + 1, updated_at = NOW()
 WHERE campaign_id = (SELECT id FROM campaigns WHERE slug = 'justpark-event-pass');

-- Remove the now-empty Event Pass campaign (cascades its teams/rules/targets).
DELETE FROM campaigns WHERE slug = 'justpark-event-pass';
