-- 0013_user_manager.sql · Reporting hierarchy
-- Adds the manager link used to build team structure from EmployeeProfile's
-- "Reporting To (Name)" instead of parsing team-name labels / job titles.
-- Resolved in provisioning: the trailing employee number in Reporting To (Name)
-- is matched to users.zoho_employee_no. Additive, nullable, forward-only.

ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INT
  REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_manager_idx ON users (manager_id);
