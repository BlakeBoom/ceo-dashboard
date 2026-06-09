// One-shot seed: creates the bootstrap admin user from SEED_ADMIN_* env vars
// if none exists yet. Safe to re-run.

import { env } from './env.js';
import { pool, query } from './db.js';
import { hashPassword } from './auth.js';

async function main() {
  if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
    console.log('[seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — nothing to do');
    return;
  }

  const { rows: existing } = await query(
    `SELECT id FROM users WHERE role = 'admin' AND active = TRUE LIMIT 1`
  );
  if (existing.length > 0) {
    console.log('[seed] admin user already exists — skipping');
    return;
  }

  const pwHash = await hashPassword(env.SEED_ADMIN_PASSWORD);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email`,
    [env.SEED_ADMIN_EMAIL, pwHash, env.SEED_ADMIN_NAME]
  );
  if (rows.length === 0) {
    console.log('[seed] user with that email already existed — left as-is');
  } else {
    console.log(`[seed] created admin user id=${rows[0].id} email=${rows[0].email}`);
    console.log('[seed] >>> CHANGE THE PASSWORD ON FIRST LOGIN <<<');
  }
}

main()
  .catch(err => { console.error('[seed] fatal', err); process.exit(1); })
  .finally(() => pool.end());
