-- 0010 · Consolidate Just Park. There are two campaigns: Just Park UK and Just
-- Park US. "Just Park" = UK; "JustPark Event Pass" is the Space Owner team and
-- belongs to UK; only the genuine "Just Park US" workgroup is US. Fold the
-- Event Pass campaign into UK and rename.

-- Ensure both campaigns exist + rename.
INSERT INTO campaigns (slug, name) VALUES ('justpark', 'Just Park UK')
  ON CONFLICT (slug) DO UPDATE SET name = 'Just Park UK';
INSERT INTO campaigns (slug, name) VALUES ('justpark-us', 'Just Park US')
  ON CONFLICT (slug) DO UPDATE SET name = 'Just Park US';

-- Safety: if an Event Pass user shares an employee number with someone already
-- in UK (shouldn't happen — zoho_employee_no is globally unique — but be
-- defensive), deactivate the duplicate instead of moving it.
UPDATE users e
   SET active = FALSE, token_version = token_version + 1, updated_at = NOW()
 WHERE e.campaign_id = (SELECT id FROM campaigns WHERE slug = 'justpark-event-pass')
   AND e.zoho_employee_no IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM users u
      WHERE u.id <> e.id AND u.zoho_employee_no = e.zoho_employee_no
        AND u.campaign_id = (SELECT id FROM campaigns WHERE slug = 'justpark'));

-- Move remaining Event Pass users to UK (clear their team — teams were per-campaign).
UPDATE users
   SET campaign_id = (SELECT id FROM campaigns WHERE slug = 'justpark'),
       team_id = NULL, token_version = token_version + 1, updated_at = NOW()
 WHERE campaign_id = (SELECT id FROM campaigns WHERE slug = 'justpark-event-pass')
   AND active = TRUE;

-- Remove the now-empty Event Pass campaign (cascades its teams/rules/targets).
DELETE FROM campaigns WHERE slug = 'justpark-event-pass';
