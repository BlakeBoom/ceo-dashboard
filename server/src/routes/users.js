import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { hashPassword } from '../auth.js';
import { requireRole, scopeClause } from '../rbac.js';
import { provisionFromEmployeeProfile } from '../provision.js';

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
      ORDER BY u.role DESC, c.name NULLS LAST, u.full_name`,
    params
  );
  res.json({ users: rows });
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
  password: z.string().min(10).max(200),
  role: z.enum(['agent', 'tm', 'campaign_lead', 'admin']),
  campaign_id: z.number().int().positive().nullable().optional(),
  team_id: z.number().int().positive().nullable().optional(),
  zoho_user_id: z.string().max(64).nullable().optional(),
});
router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });

  const { email, full_name, password, role, campaign_id, team_id, zoho_user_id } = parsed.data;
  const pwHash = await hashPassword(password);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, full_name, role, campaign_id, team_id, zoho_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, full_name, role, campaign_id, team_id, active`,
      [email, pwHash, full_name, role, campaign_id ?? null, team_id ?? null, zoho_user_id ?? null]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata)
       VALUES ($1, 'user.create', $2, $3)`,
      [req.user.id, rows[0].id, { role, email }]
    );
    res.status(201).json({ user: rows[0] });
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
    `UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2`,
    [newHash, id]
  );
  await query(
    `INSERT INTO audit_log (user_id, action, target_id) VALUES ($1, 'user.reset_password', $2)`,
    [req.user.id, id]
  );
  res.json({ ok: true });
});

export default router;
