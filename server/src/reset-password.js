// Reset password for an existing user by email. Used by the db-setup GitHub
// Action workflow when the admin password is lost or rotation is needed.
//
// Required env: DATABASE_URL, JWT_SECRET (validated by env.js), RESET_EMAIL,
// RESET_PASSWORD (>= 10 chars).

import { hashPassword } from './auth.js';
import { pool, query } from './db.js';

async function main() {
  const email = process.env.RESET_EMAIL;
  const password = process.env.RESET_PASSWORD;
  if (!email || !password) {
    console.error('[reset] RESET_EMAIL and RESET_PASSWORD env vars are required');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('[reset] RESET_PASSWORD must be at least 10 characters');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const { rowCount, rows } = await query(
    `UPDATE users
        SET password_hash = $1,
            token_version = token_version + 1,
            active = TRUE,
            updated_at = NOW()
      WHERE LOWER(email) = LOWER($2)
      RETURNING id, email, role`,
    [hash, email]
  );

  if (rowCount === 0) {
    console.error(`[reset] no user found with email ${email}`);
    process.exit(1);
  }
  console.log(`[reset] password reset for user id=${rows[0].id} email=${rows[0].email} role=${rows[0].role}`);
  console.log('[reset] all existing sessions for this user are now invalid');
}

main()
  .catch(err => { console.error('[reset] fatal', err); process.exit(1); })
  .finally(() => pool.end());
