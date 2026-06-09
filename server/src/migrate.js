// Simple forward-only migration runner.
// Tracks applied files in schema_migrations; runs each new .sql file in order.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function applied(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map(r => r.filename));
}

async function main() {
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    for (const file of files) {
      if (done.has(file)) {
        console.log(`[migrate] skip ${file} (already applied)`);
        continue;
      }
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] ok ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] FAILED ${file}:`, err.message);
        process.exit(1);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[migrate] fatal', err);
  process.exit(1);
});
