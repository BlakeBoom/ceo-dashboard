import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { hashPassword } from '../auth.js';
import { requireRole, scopeClause } from '../rbac.js';
import { provisionFromEmployeeProfile } from '../provision.js';
import { computeTeamStructure } from '../teamStructure.js';
import '../../../shared/names.js';
const { normalizeName, stripKnownNameSuffix } = globalThis.BoomerangNames;

const router = Router();

// List users visible to the caller (scope-filtered).
router.get('/', async (req, res) => {
  const { sql, params } = scopeClause(req.user, {
    campaignCol: 'u.campaign_id',
    teamCol: 'u.team_id',
    userCol: 'u.id',
  });
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.campaign_id, u.team_id,
            u.active, u.last_login_at, u.job_title, u.workgroup,
            u.zoho_employee_no, u.must_change_password,
            c.name AS campaign_name, t.name AS team_name
       FROM users u
       LEFT JOIN campaigns c ON c.id = u.campaign_id
       LEFT JOIN teams t     ON t.id = u.team_id
      WHERE ${sql}
      ORDER BY CASE u.role
                 WHEN 'admin'         THEN 0
                 WHEN 'exco'          THEN 1
                 WHEN 'campaign_lead' THEN 2
                 WHEN 'tm'            THEN 3
                 WHEN 'agent'         THEN 4
                 ELSE 5
               END,
               c.name NULLS LAST, u.full_name`,
    params
  );
  res.json({ users: rows });
});

// Minimal org-structure feed for the dashboard's team-leader role index:
// { full_name, role } for active users only, org-wide, with NO scope clause.
// The Teams tab needs EVERY leader to build a cross-team index; GET / above is
// scope-filtered (a tm sees only their own team), which collapsed the index for
// the very people who use that tab. This deliberately exposes name+role
// org-wide — org structure the Teams tab already implies — and nothing else
// (no email, id, campaign, team, or job title), so it can't become a staff
// directory. Registered before the /:id routes so the literal path wins.
router.get('/roles', async (req, res) => {
  const { rows } = await query(
    `SELECT full_name, role FROM users WHERE active = TRUE`
  );
  res.json({ users: rows });
});

// Per-user team assignment for the dashboard's Teams grouping (rollout Step 2).
// Keyed by zoho_user_id (== User_metrics_3.user_id), so the browser groups its
// live metrics rows by the authoritative reporting hierarchy instead of parsing
// "<leader>'s team" labels. Authenticated (every signed-in user's dashboard
// needs it); returns only zoho_user_id + node label + type — org structure, the
// same sensitivity as /roles. Registered before the /:id routes.
router.get('/team-map', async (req, res) => {
  const { rows: users } = await query(
    `SELECT id, full_name, role, campaign_id, manager_id, zoho_user_id
       FROM users WHERE active = TRUE`
  );
  const { nodes } = computeTeamStructure(users);
  // Two join keys, because zoho_user_id only exists for people the bonus sync
  // registered (bonus-ruled campaigns). name_key (clean, normalised full name)
  // is set by provisioning for EVERY active employee, so non-bonus campaigns
  // (e.g. Beer52) still match — but ONLY when the name is unique, so two people
  // who share a name are never fused (they fall back to the old resolution).
  const nameKeyById = new Map();
  const nameCount = new Map();
  for (const u of users) {
    const k = normalizeName(stripKnownNameSuffix(u.full_name));
    nameKeyById.set(u.id, k);
    if (k) nameCount.set(k, (nameCount.get(k) || 0) + 1);
  }
  const out = nodes.map(n => {
    const k = nameKeyById.get(n.user_id);
    return {
      zoho_user_id: n.zoho_user_id,
      name_key: (k && nameCount.get(k) === 1) ? k : null,
      team_node: n.team_node,
      node_type: n.node_type,
    };
  });
  res.json({ nodes: out });
});

// Admin-only, read-only diagnostic (team-hierarchy rollout Step 1). Returns the
// team structure computed from users.role + users.manager_id — counts and the
// top nodes by member count — so an admin can eyeball the tree in the browser
// before anything renders from it. No per-user PII beyond node names, which are
// org structure. Registered before the /:id routes so the literal path wins.
router.get('/team-structure', requireRole('admin'), async (req, res) => {
  const { rows: users } = await query(
    `SELECT id, full_name, role, campaign_id, manager_id, zoho_user_id, zoho_employee_no
       FROM users WHERE active = TRUE`
  );
  // Resolve every user against the FULL graph (a manager may be outside any
  // subset), then report coverage over two cohorts.
  const { nodes } = computeTeamStructure(users);
  const nodeByUser = new Map(nodes.map(n => [n.user_id, n]));

  const cohortStats = (subset) => {
    const s = { users: 0, tl: 0, cm: 0, unassigned: 0, with_manager: 0 };
    const nodeNames = new Set();
    for (const u of subset) {
      const n = nodeByUser.get(u.id); if (!n) continue;
      s.users++; s[n.node_type]++;
      if (u.manager_id != null) s.with_manager++;
      if (n.node_type !== 'unassigned') nodeNames.add(n.team_node);
    }
    s.node_count = nodeNames.size;
    s.manager_coverage_pct = s.users ? +(s.with_manager / s.users * 100).toFixed(1) : 0;
    s.unassigned_pct = s.users ? +(s.unassigned / s.users * 100).toFixed(1) : 0;
    return s;
  };

  // The dashboard only renders employees who carry metrics for the period. A
  // user gets a zoho_user_id when the metrics sync sees them in User_metrics_3,
  // so "has zoho_user_id" ≈ "appears on the dashboard" — the population that
  // actually matters. The full users table also holds provisioned logins and
  // stale records that never render and would dilute any coverage number.
  // (Caveat: this is "ever synced", not "has data THIS period" — the exact
  // per-period figure comes from the dashboard's own guard once Step 2 wires it.)
  const dataUsers = users.filter(u => u.zoho_user_id != null);

  const byNode = new Map();
  for (const u of dataUsers) {
    const n = nodeByUser.get(u.id); if (!n) continue;
    byNode.set(n.team_node, (byNode.get(n.team_node) || 0) + 1);
  }
  const top_nodes = [...byNode.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([node, members]) => ({ node, members }));

  // Merge health: a person is "merged" once their metrics half (zoho_user_id)
  // and HR half (zoho_employee_no) live on ONE row. If this is ~0, the merge has
  // not run against the data yet (not deployed, no sync since deploy, or it
  // matched nothing) — which is exactly why the data cohort has no roles.
  const merged_people = users.filter(u => u.zoho_user_id != null && u.zoho_employee_no != null).length;

  res.json({
    all_active_users: users.length,
    with_metrics_data: dataUsers.length,            // the dashboard population
    merged_people,                                  // metrics+HR unified onto one row
    coverage_over_all_users: cohortStats(users),    // diluted by dataless records
    coverage_over_data_users: cohortStats(dataUsers), // ← the number that matters
    top_nodes_data_users: top_nodes,
  });
});

// Admin-only: provision login accounts from the Zoho EmployeeProfile view.
// `?preview=1` parses + classifies without writing, so the admin can sanity-
// check the mapping against live data first. On commit, returns the generated
// temp passwords for any NEW accounts (shown once — never stored in plaintext).
router.post('/provision', requireRole('admin'), async (req, res) => {
  const preview = req.query.preview === '1' || req.body?.preview === true;
  const domain = (req.body?.domain || process.env.LOGIN_EMAIL_DOMAIN || 'boomerang.local')
    .toString().trim().toLowerCase();
  const viewId = req.body?.view_id ? String(req.body.view_id).trim() : null;
  const deptViewId = req.body?.dept_view_id ? String(req.body.dept_view_id).trim() : null;
  try {
    const result = await provisionFromEmployeeProfile({ preview, domain, viewId, deptViewId });
    if (!preview) {
      await query(
        `INSERT INTO audit_log (user_id, action, metadata)
         VALUES ($1, 'users.provision', $2)`,
        [req.user.id, { domain, summary: result.summary }]
      );
    }
    res.json(result);
  } catch (err) {
    console.error('[users/provision] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin-only: create a user.
const createSchema = z.object({
  email: z.string().email().max(254),
  full_name: z.string().min(1).max(200),
  password: z.string().min(10).max(200).optional(),
  role: z.enum(['agent', 'tm', 'campaign_lead', 'exco', 'admin']),
  campaign_id: z.number().int().positive().nullable().optional(),
  team_id: z.number().int().positive().nullable().optional(),
  zoho_user_id: z.string().max(64).nullable().optional(),
});

// Admin-only: edit an existing user's role / campaign / team / active flag.
// Any of these change what the user can see, so bump token_version to refresh
// their session immediately.
const updateSchema = z.object({
  full_name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).optional(),
  role: z.enum(['agent', 'tm', 'campaign_lead', 'exco', 'admin']).optional(),
  campaign_id: z.number().int().positive().nullable().optional(),
  team_id: z.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
}).refine(o => Object.keys(o).length > 0, { message: 'no fields to update' });

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = updateSchema.safeParse(req.body);
  if (!Number.isFinite(id) || !parsed.success) {
    return res.status(400).json({ error: 'invalid_input', detail: parsed.success ? undefined : parsed.error.flatten() });
  }
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
  vals.push(id);
  try {
    const { rows } = await query(
      `UPDATE users SET ${sets.join(', ')}, token_version = token_version + 1, updated_at = NOW()
        WHERE id = $${vals.length}
        RETURNING id, email, full_name, role, campaign_id, team_id, active`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'user.update', $2, $3)`,
      [req.user.id, id, parsed.data]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_exists' });
    if (err.code === '23503') return res.status(400).json({ error: 'invalid_campaign_or_team' });
    throw err;
  }
});
router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });

  const { email, full_name, password, role, campaign_id, team_id, zoho_user_id } = parsed.data;
  // If no password is supplied, generate a one-time temp password (shown once)
  // and force a change on first login — same as provisioning.
  const temp = password ? null : crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + 'A1';
  const pwHash = await hashPassword(temp || password);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, full_name, role, campaign_id, team_id, zoho_user_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, email, full_name, role, campaign_id, team_id, active`,
      [email, pwHash, full_name, role, campaign_id ?? null, team_id ?? null, zoho_user_id ?? null, !!temp]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata)
       VALUES ($1, 'user.create', $2, $3)`,
      [req.user.id, rows[0].id, { role, email }]
    );
    res.status(201).json({ user: rows[0], temp_password: temp });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_exists' });
    throw err;
  }
});

// Admin-only: deactivate a user (soft delete; revokes all sessions).
router.post('/:id/deactivate', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  await query(
    `UPDATE users SET active = FALSE, token_version = token_version + 1, updated_at = NOW() WHERE id = $1`,
    [id]
  );
  await query(
    `INSERT INTO audit_log (user_id, action, target_id) VALUES ($1, 'user.deactivate', $2)`,
    [req.user.id, id]
  );
  res.json({ ok: true });
});

// Admin-only: reset another user's password (forces re-login).
const resetSchema = z.object({ new_password: z.string().min(10).max(200) });
router.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = resetSchema.safeParse(req.body);
  if (!Number.isFinite(id) || !parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const newHash = await hashPassword(parsed.data.new_password);
  await query(
    `UPDATE users SET password_hash = $1, must_change_password = TRUE,
            token_version = token_version + 1, updated_at = NOW() WHERE id = $2`,
    [newHash, id]
  );
  await query(
    `INSERT INTO audit_log (user_id, action, target_id) VALUES ($1, 'user.reset_password', $2)`,
    [req.user.id, id]
  );
  res.json({ ok: true });
});

export default router;
