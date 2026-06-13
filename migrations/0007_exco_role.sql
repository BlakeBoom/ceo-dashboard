-- 0007 · Add EXCO role.
-- EXCO sees all campaign data like admin, but not the settings screens
-- (Rules, Users). Scope-wise it ranks with admin; feature-wise it's excluded
-- from admin-only management endpoints in the app layer.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'exco';
