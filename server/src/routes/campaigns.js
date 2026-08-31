import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireRole } from '../rbac.js';

const router = Router();

// Admin: list ALL campaigns (active + inactive) with rule counts + a KPI-config
// hint. GET /api/teams/campaigns still exists for the scope-filtered "which
// campaigns can I see" case used by every non-admin view — this endpoint is
// meant for the Campaigns admin screen.
router.get('/', requireRole('admin'), async (_req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.slug, c.name, c.shift_key, c.active,
            COALESCE(r.n, 0)::int AS rule_count,
            COALESCE(ra.n, 0)::int AS active_rule_count
       FROM campaigns c
       LEFT JOIN (SELECT campaign_id, COUNT(*) AS n FROM shift_campaign_rules GROUP BY campaign_id) r
              ON r.campaign_id = c.id
       LEFT JOIN (SELECT campaign_id, COUNT(*) AS n FROM shift_campaign_rules WHERE active GROUP BY campaign_id) ra
              ON ra.campaign_id = c.id
      ORDER BY c.active DESC, c.name`
  );
  res.json({ campaigns: rows });
});

// Slug shape: lowercase kebab/underscore, keeps FK joins predictable.
const slugSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/,
  'slug must be lowercase, digits, - or _');
// shift_key is the identifier returned by shiftToCampaign(). Legacy keys
// (HYVE, JUSTPARK_usa, Medexpress) are mixed case, so we permit case and
// underscore. Empty string is coerced to null (back-office campaigns).
const shiftKeySchema = z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_]*$/,
  'shift_key must be alphanumeric / _').nullable();

const createSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  shift_key: shiftKeySchema.optional(),
});
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  shift_key: shiftKeySchema.optional(),
  active: z.boolean().optional(),
}).refine(o => Object.keys(o).length > 0, { message: 'no fields to update' });

router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  const { slug, name, shift_key } = parsed.data;
  try {
    const { rows } = await query(
      `INSERT INTO campaigns (slug, name, shift_key) VALUES ($1, $2, $3)
       RETURNING id, slug, name, shift_key, active`,
      [slug, name, shift_key || null]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'campaign.create', $2, $3)`,
      [req.user.id, rows[0].id, { slug, name, shift_key }]
    );
    res.status(201).json({ campaign: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug_or_shift_key_exists' });
    throw err;
  }
});

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
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${vals.length}
        RETURNING id, slug, name, shift_key, active`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'campaign.update', $2, $3)`,
      [req.user.id, id, parsed.data]
    );
    res.json({ campaign: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'shift_key_exists' });
    throw err;
  }
});

export default router;
