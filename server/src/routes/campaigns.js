import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireRole } from '../rbac.js';
import { buildCampaignConfig } from '../campaign-config.js';

const router = Router();

// Admin: list ALL campaigns (active + inactive) with rule counts + a KPI-config
// hint. GET /api/teams/campaigns still exists for the scope-filtered "which
// campaigns can I see" case used by every non-admin view — this endpoint is
// meant for the Campaigns admin screen.
router.get('/', requireRole('admin'), async (_req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.slug, c.name, c.shift_key, c.display_name, c.section, c.active,
            COALESCE(r.n, 0)::int AS rule_count,
            COALESCE(ra.n, 0)::int AS active_rule_count,
            COALESCE(k.n, 0)::int AS kpi_count,
            COALESCE(w.n, 0)::int AS workgroup_count
       FROM campaigns c
       LEFT JOIN (SELECT campaign_id, COUNT(*) AS n FROM shift_campaign_rules GROUP BY campaign_id) r
              ON r.campaign_id = c.id
       LEFT JOIN (SELECT campaign_id, COUNT(*) AS n FROM shift_campaign_rules WHERE active GROUP BY campaign_id) ra
              ON ra.campaign_id = c.id
       LEFT JOIN (SELECT campaign_id, COUNT(*) AS n FROM campaign_kpis WHERE active GROUP BY campaign_id) k
              ON k.campaign_id = c.id
       LEFT JOIN (SELECT campaign_id, COUNT(*) AS n FROM campaign_workgroups WHERE active GROUP BY campaign_id) w
              ON w.campaign_id = c.id
      ORDER BY c.active DESC, c.name`
  );
  res.json({ campaigns: rows });
});

// GET /api/campaigns/config — flat maps the client uses to overlay its
// hardcoded WG_MAP / CAMP_DISPLAY / CAMP_SECTION / TARGETS / KPI_CONFIG on
// boot. Any authenticated user may read (the same shape as SHIFT_PATTERNS —
// it drives which tiles are rendered, not who can see what).
router.get('/config', async (_req, res) => {
  const [{ rows: camps }, { rows: kpis }, { rows: wgs }] = await Promise.all([
    query(`SELECT id, slug, shift_key, display_name, section
             FROM campaigns WHERE active AND shift_key IS NOT NULL`),
    query(`SELECT k.campaign_id, c.shift_key, k.kpi_key, k.label, k.direction,
                  k.target, k.priority, k.is_tile
             FROM campaign_kpis k
             JOIN campaigns c ON c.id = k.campaign_id
            WHERE k.active AND c.active AND c.shift_key IS NOT NULL
            ORDER BY c.shift_key, k.priority, k.id`),
    query(`SELECT w.label, c.shift_key
             FROM campaign_workgroups w
             JOIN campaigns c ON c.id = w.campaign_id
            WHERE w.active AND c.active AND c.shift_key IS NOT NULL`),
  ]);
  res.json(buildCampaignConfig(camps, kpis, wgs));
});

// KPI CRUD ----------------------------------------------------------------
router.get('/:id/kpis', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { rows } = await query(
    `SELECT id, campaign_id, kpi_key, label, direction, target, priority, is_tile, active
       FROM campaign_kpis WHERE campaign_id = $1 ORDER BY priority, id`, [id]);
  res.json({ kpis: rows });
});

const kpiSchema = z.object({
  kpi_key: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_]*$/),
  label:   z.string().min(1).max(80),
  direction: z.enum(['higher', 'lower', 'none']),
  target: z.number().nullable().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
  is_tile: z.boolean().optional(),
  active: z.boolean().optional(),
});
router.post('/:id/kpis', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = kpiSchema.safeParse(req.body);
  if (!Number.isFinite(id) || !parsed.success) {
    return res.status(400).json({ error: 'invalid_input', detail: parsed.success ? undefined : parsed.error.flatten() });
  }
  const d = parsed.data;
  try {
    const { rows } = await query(
      `INSERT INTO campaign_kpis (campaign_id, kpi_key, label, direction, target, priority, is_tile, active)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 100), COALESCE($7, TRUE), COALESCE($8, TRUE))
       RETURNING id, campaign_id, kpi_key, label, direction, target, priority, is_tile, active`,
      [id, d.kpi_key, d.label, d.direction, d.target ?? null, d.priority ?? null, d.is_tile ?? null, d.active ?? null]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'campaign_kpi.create', $2, $3)`,
      [req.user.id, rows[0].id, { campaign_id: id, ...d }]
    );
    res.status(201).json({ kpi: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'kpi_key_exists_for_campaign' });
    if (err.code === '23503') return res.status(400).json({ error: 'invalid_campaign' });
    throw err;
  }
});

const kpiPatch = kpiSchema.partial().refine(o => Object.keys(o).length, { message: 'no fields' });
router.patch('/kpis/:kpiId', requireRole('admin'), async (req, res) => {
  const kpiId = parseInt(req.params.kpiId, 10);
  const parsed = kpiPatch.safeParse(req.body);
  if (!Number.isFinite(kpiId) || !parsed.success) {
    return res.status(400).json({ error: 'invalid_input', detail: parsed.success ? undefined : parsed.error.flatten() });
  }
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
  sets.push(`updated_at = NOW()`);
  vals.push(kpiId);
  const { rows } = await query(
    `UPDATE campaign_kpis SET ${sets.join(', ')} WHERE id = $${vals.length}
      RETURNING id, campaign_id, kpi_key, label, direction, target, priority, is_tile, active`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  await query(
    `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'campaign_kpi.update', $2, $3)`,
    [req.user.id, kpiId, parsed.data]
  );
  res.json({ kpi: rows[0] });
});

router.delete('/kpis/:kpiId', requireRole('admin'), async (req, res) => {
  const kpiId = parseInt(req.params.kpiId, 10);
  if (!Number.isFinite(kpiId)) return res.status(400).json({ error: 'invalid_id' });
  const { rowCount } = await query(`DELETE FROM campaign_kpis WHERE id = $1`, [kpiId]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  await query(
    `INSERT INTO audit_log (user_id, action, target_id) VALUES ($1, 'campaign_kpi.delete', $2)`,
    [req.user.id, kpiId]
  );
  res.json({ ok: true });
});

// Workgroup CRUD ----------------------------------------------------------
router.get('/:id/workgroups', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { rows } = await query(
    `SELECT id, campaign_id, label, active FROM campaign_workgroups WHERE campaign_id = $1 ORDER BY label`, [id]);
  res.json({ workgroups: rows });
});

const wgSchema = z.object({
  label: z.string().min(1).max(120),
  active: z.boolean().optional(),
});
router.post('/:id/workgroups', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = wgSchema.safeParse(req.body);
  if (!Number.isFinite(id) || !parsed.success) {
    return res.status(400).json({ error: 'invalid_input', detail: parsed.success ? undefined : parsed.error.flatten() });
  }
  try {
    const { rows } = await query(
      `INSERT INTO campaign_workgroups (campaign_id, label, active)
       VALUES ($1, $2, COALESCE($3, TRUE))
       RETURNING id, campaign_id, label, active`,
      [id, parsed.data.label, parsed.data.active ?? null]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'campaign_workgroup.create', $2, $3)`,
      [req.user.id, rows[0].id, { campaign_id: id, label: parsed.data.label }]
    );
    res.status(201).json({ workgroup: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'workgroup_label_exists' });
    if (err.code === '23503') return res.status(400).json({ error: 'invalid_campaign' });
    throw err;
  }
});

router.delete('/workgroups/:wgId', requireRole('admin'), async (req, res) => {
  const wgId = parseInt(req.params.wgId, 10);
  if (!Number.isFinite(wgId)) return res.status(400).json({ error: 'invalid_id' });
  const { rowCount } = await query(`DELETE FROM campaign_workgroups WHERE id = $1`, [wgId]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  await query(
    `INSERT INTO audit_log (user_id, action, target_id) VALUES ($1, 'campaign_workgroup.delete', $2)`,
    [req.user.id, wgId]
  );
  res.json({ ok: true });
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
  display_name: z.string().min(1).max(200).nullable().optional(),
  section: z.string().min(1).max(80).nullable().optional(),
});
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  shift_key: shiftKeySchema.optional(),
  display_name: z.string().min(1).max(200).nullable().optional(),
  section: z.string().min(1).max(80).nullable().optional(),
  active: z.boolean().optional(),
}).refine(o => Object.keys(o).length > 0, { message: 'no fields to update' });

router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  const { slug, name, shift_key, display_name, section } = parsed.data;
  try {
    const { rows } = await query(
      `INSERT INTO campaigns (slug, name, shift_key, display_name, section)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, slug, name, shift_key, display_name, section, active`,
      [slug, name, shift_key || null, display_name || null, section || null]
    );
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'campaign.create', $2, $3)`,
      [req.user.id, rows[0].id, { slug, name, shift_key, display_name, section }]
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
        RETURNING id, slug, name, shift_key, display_name, section, active`,
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
