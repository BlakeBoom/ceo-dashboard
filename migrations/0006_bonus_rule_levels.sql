-- 0006 · Bonus rules per role level.
-- Rules now exist per (campaign, role_level): agents are scored on their own
-- metrics; team leaders on their team's aggregates; campaign managers on the
-- campaign's aggregates. Admin maintains these in the Rules screen.

ALTER TABLE bonus_rules ADD COLUMN IF NOT EXISTS role_level user_role NOT NULL DEFAULT 'agent';

-- Replace the (campaign_id, effective_from) uniqueness with one that includes
-- the level, so each level can have its own rule for the same window.
ALTER TABLE bonus_rules DROP CONSTRAINT IF EXISTS bonus_rules_campaign_id_effective_from_key;
CREATE UNIQUE INDEX IF NOT EXISTS bonus_rules_camp_level_from_idx
  ON bonus_rules (campaign_id, role_level, effective_from);
