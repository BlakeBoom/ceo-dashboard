import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireRole, scopeClause } from '../rbac.js';

const router = Router();

// Campaigns visible to caller.
router.get('/campaigns', async (req, res) => {
  if (req.user.role === 'admin') {
    const { rows } = await query(
      `SELECT id, slug, name, active FROM campaigns WHERE active = TRUE ORDER BY name`
    );
    return res.json({ campaigns: rows });
  }
  if (req.user.campaign_id == null) return res.json({ campaigns: [] });
  const { rows } = await query(
    `SELECT id, slug, name, active FROM campaigns WHERE id = $1`,
    [req.user.campaign_id]
  );
  res.json({ campaigns: rows });
});

// Teams visible to caller (scope-filtered).
router.get('/', async (req, res) => {
  const { sql, params } = scopeClause(req.user, {
    campaignCol: 't.campaign_id',
    teamCol: 't.id',
    userCol: 't.tm_user_id', // agents see only the team they're on
  });
  // Agents need their own team rather than the one they manage — special-case below.
  let rowsResult;
  if (req.user.role === 'agent') {
    rowsResult = await query(
      `SELECT t.id, t.campaign_id, t.name, t.tm_user_id, c.name AS campaign_name
         FROM teams t JOIN campaigns c ON c.id = t.campaign_id
        WHERE t.id = $1`,
      [req.user.team_id]
    );
  } else {
    rowsResult = await query(
      `SELECT t.id, t.campaign_id, t.name, t.tm_user_id, c.name AS campaign_name
         FROM teams t JOIN campaigns c ON c.id = t.campaign_id
        WHERE ${sql}
        ORDER BY c.name, t.name`,
      params
    );
  }
  res.json({ teams: rowsResult.rows });
});

// Admin-only: create team.
const createSchema = z.object({
  campaign_id: z.number().int().positive(),
  name: z.string().min(1).max(120),
  tm_user_id: z.number().int().positive().nullable().optional(),
});
router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  try {
    const { rows } = await query(
      `INSERT INTO teams (campaign_id, name, tm_user_id)
       VALUES ($1, $2, $3)
       RETURNING id, campaign_id, name, tm_user_id`,
      [parsed.data.campaign_id, parsed.data.name, parsed.data.tm_user_id ?? null]
    );
    res.status(201).json({ team: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'team_exists' });
    throw err;
  }
});

export default router;
