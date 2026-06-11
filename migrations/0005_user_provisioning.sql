-- 0005 · Columns to support provisioning login accounts from EmployeeProfile.
--   zoho_employee_no     · HR "Employee Number" (distinct from zoho_user_id,
--                          which is the User_metrics_3 metrics id). Stable key
--                          we upsert on so provisioning is idempotent.
--   job_title / workgroup · raw source values, kept for traceability + the
--                          admin Users screen.
--   must_change_password  · TRUE for accounts created with a generated temp
--                          password, so the UI can force a reset on first login.

ALTER TABLE users ADD COLUMN IF NOT EXISTS zoho_employee_no     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS workgroup            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS users_zoho_employee_no_idx
  ON users (zoho_employee_no) WHERE zoho_employee_no IS NOT NULL;
