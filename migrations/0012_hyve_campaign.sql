-- 0012 · HYVE is now a standalone campaign. Previously it was only a Zoho
-- workgroup whose Beer52 shifts were folded into the Beer52 campaign; it now
-- gets its own campaign so targets, rules and billable roll up independently.
INSERT INTO campaigns (slug, name)
VALUES ('hyve', 'HYVE')
ON CONFLICT (slug) DO NOTHING;
