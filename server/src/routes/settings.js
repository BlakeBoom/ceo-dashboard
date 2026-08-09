// Org-wide dashboard settings (app_settings key/value JSONB).
//
// First setting: `tab_visibility` — a per-role map of which dashboard tabs are
// HIDDEN for that role, edited by an admin on the Access tab. This is a UI
// convenience (e.g. hide a half-built tab from campaign leads while it's worked
// on), NOT a security boundary: every data endpoint still enforces its own
// requireRole server-side, and the client only ever uses this to HIDE a tab the
// role's min-role already permits — it can never GRANT access. Admins are never
// subject to it (so an admin can't lock themselves out of this very screen).

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireRole } from '../rbac.js';

const router = Router();

const TAB_VISIBILITY_KEY = 'tab_visibility';

// Roles whose visibility can be edited (admin is always all-tabs, never stored).
const EDITABLE_ROLES = ['agent', 'tm', 'campaign_lead', 'exco'];
// The tab views that may appear in the matrix. Kept in sync with the dashboard's
// tab bar; an unknown view is rejected rather than silently stored.
const TAB_VIEWS = ['summary', 'campaigns', 'trends', 'bonus', 'targets', 'rules', 'users', 'access'];

// { role: { view: false } } — only `false` (hidden) is meaningful; a missing
// entry means visible. Strict shape so a malformed body can't poison the store.
const visibilitySchema = z.object(
  Object.fromEntries(EDITABLE_ROLES.map(r => [
    r,
    z.object(Object.fromEntries(TAB_VIEWS.map(v => [v, z.boolean()]))).partial().optional(),
  ]))
).partial();

async function readSetting(key) {
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    return rows.length ? rows[0].value : null;
  } catch (err) {
    // 42P01 = undefined_table: the 0014 migration hasn't run yet. Treat as "no
    // settings" so the dashboard shows every tab rather than erroring.
    if (err.code === '42P01') { console.warn('[settings] app_settings table missing — run `npm run migrate`'); return null; }
    throw err;
  }
}

// Any authenticated user may read the matrix — they need their own role's entry
// to filter their tab bar, and it carries no sensitive data (just tab names).
router.get('/tab-visibility', requireRole('agent'), async (req, res) => {
  try {
    const value = await readSetting(TAB_VISIBILITY_KEY);
    res.json({ visibility: value || {} });
  } catch (err) {
    console.error('[settings/tab-visibility] read failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin-only write. Replaces the whole matrix (the editor always sends the full
// state), normalised to keep only the `false` entries so the row stays compact.
router.put('/tab-visibility', requireRole('admin'), async (req, res) => {
  const parsed = visibilitySchema.safeParse(req.body?.visibility ?? req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  const clean = {};
  for (const role of EDITABLE_ROLES) {
    const row = parsed.data[role];
    if (!row) continue;
    const hidden = {};
    for (const v of TAB_VIEWS) if (row[v] === false) hidden[v] = false;
    if (Object.keys(hidden).length) clean[role] = hidden;
  }
  try {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [TAB_VISIBILITY_KEY, JSON.stringify(clean), req.user.id]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, metadata) VALUES ($1, 'settings.tab_visibility', $2)`,
      [req.user.id, clean]
    );
    res.json({ ok: true, visibility: clean });
  } catch (err) {
    console.error('[settings/tab-visibility] write failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
