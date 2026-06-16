// Campaign targets (required FTE + monthly billable hours → slippage).
// Effective-dated per campaign. Read by anyone who can see the analytics
// (tm+); edited by admin only; the Targets screen is also visible to EXCO
// (read-only, enforced in the UI — EXCO simply can't call the write routes).

import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireRole } from '../rbac.js';

const router = Router();

// All target versions, newest first. Joined with campaign slug/name so the
// front-end can map them to its campaign keys and render the editor.
router.get('/', requireRole('tm'), async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.campaign_id, c.slug, c.name,
            to_char(t.effective_from, 'YYYY-MM-DD') AS effective_from,
            t.req_fte, t.req_hrs_month
       FROM campaign_targets t
       JOIN campaigns c ON c.id = t.campaign_id
      ORDER BY c.name, t.effective_from DESC`
  );
  res.json({ targets: rows });
});

const upsertSchema = z.object({
  campaign_id: z.number().int().positive(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  req_fte: z.number().min(0).max(100000).nullable().optional(),
  req_hrs_month: z.number().min(0).max(10000000).nullable().optional(),
});

// Create or update the target for (campaign, effective_from).
router.put('/', requireRole('admin'), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  const { campaign_id, effective_from, req_fte, req_hrs_month } = parsed.data;
  try {
    const { rows } = await query(
      `INSERT INTO campaign_targets (campaign_id, effective_from, req_fte, req_hrs_month, created_by)
       VALUES ($1, $2::date, $3, $4, $5)
       ON CONFLICT (campaign_id, effective_from)
       DO UPDATE SET req_fte = EXCLUDED.req_fte, req_hrs_month = EXCLUDED.req_hrs_month, updated_at = NOW()
       RETURNING id`,
      [campaign_id, effective_from, req_fte ?? null, req_hrs_month ?? null, req.user.id]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata)
       VALUES ($1, 'target.upsert', $2, $3)`,
      [req.user.id, rows[0].id, { campaign_id, effective_from, req_fte, req_hrs_month }]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'unknown_campaign' });
    throw err;
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  await query(`DELETE FROM campaign_targets WHERE id = $1`, [id]);
  await query(`INSERT INTO audit_log (user_id, action, target_id) VALUES ($1, 'target.delete', $2)`, [req.user.id, id]);
  res.json({ ok: true });
});

export default router;
