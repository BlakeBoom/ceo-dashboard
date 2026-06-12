import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { scopeClause, requireRole } from '../rbac.js';

const router = Router();

// ── Admin: rules management (per campaign × role level) ─────────────────────

// Current rule for every active campaign at every level, for the Rules screen.
router.get('/rules/all', requireRole('admin'), async (req, res) => {
  const { rows } = await query(
    `SELECT c.id AS campaign_id, c.slug, c.name, r.role_level, r.rule_json
       FROM campaigns c
       LEFT JOIN LATERAL (
         SELECT DISTINCT ON (role_level) role_level, rule_json
           FROM bonus_rules
          WHERE campaign_id = c.id
            AND effective_from <= CURRENT_DATE
            AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
          ORDER BY role_level, effective_from DESC
       ) r ON TRUE
      WHERE c.active = TRUE
      ORDER BY c.name`
  );
  const byCampaign = new Map();
  for (const r of rows) {
    if (!byCampaign.has(r.campaign_id)) {
      byCampaign.set(r.campaign_id, { campaign_id: r.campaign_id, slug: r.slug, name: r.name, rules: {} });
    }
    if (r.role_level) byCampaign.get(r.campaign_id).rules[r.role_level] = r.rule_json;
  }
  res.json({ campaigns: [...byCampaign.values()] });
});

const componentSchema = z.object({
  key: z.enum(['sa', 'productivity', 'csat', 'qa']),
  label: z.string().max(40).optional(),
  type: z.enum(['callouts_le', 'value_ge', 'pct_ge']),
  metric_column: z.string().max(60).optional(),
  threshold: z.number(),
  amount: z.number().min(0).max(1000000),
});
const ruleSchema = z.object({
  campaign_id: z.number().int().positive(),
  role_level: z.enum(['agent', 'tm', 'campaign_lead']),
  rule_json: z.object({
    components: z.array(componentSchema).max(8),
    unplanned_statuses: z.array(z.string().max(60)).optional(),
    kpi_min_components: z.number().int().min(0).max(8).optional(),
  }),
});

// Upsert the open-ended current rule for (campaign, level).
router.put('/rules', requireRole('admin'), async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  const { campaign_id, role_level, rule_json } = parsed.data;
  const { rows } = await query(
    `INSERT INTO bonus_rules (campaign_id, role_level, effective_from, effective_to, rule_json, created_by)
     VALUES ($1, $2, '2026-01-01'::date, NULL, $3, $4)
     ON CONFLICT (campaign_id, role_level, effective_from)
     DO UPDATE SET rule_json = EXCLUDED.rule_json
     RETURNING id`,
    [campaign_id, role_level, rule_json, req.user.id]
  );
  await query(
    `INSERT INTO audit_log (user_id, action, target_id, metadata)
     VALUES ($1, 'bonus.rule_update', $2, $3)`,
    [req.user.id, rows[0].id, { campaign_id, role_level }]
  );
  res.json({ ok: true, rule_id: rows[0].id });
});

// ── Admin: financial summary per campaign for a month, drillable ────────────
router.get('/summary', requireRole('admin'), async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.year_month || '') ? req.query.year_month : null;
  const { rows: monthRows } = await query(
    `SELECT DISTINCT to_char(period_start, 'YYYY-MM') AS ym FROM bonus_periods ORDER BY ym DESC`
  );
  const months = monthRows.map(r => r.ym);
  const month = ym || months[0] || null;
  if (!month) return res.json({ months: [], month: null, campaigns: [] });

  const { rows } = await query(
    `SELECT c.id AS campaign_id, c.name, bp.id AS period_id, bp.locked,
            u.role,
            COUNT(ba.id)::int AS awarded,
            COUNT(ba.id) FILTER (WHERE ba.qualified)::int AS qualified,
            COALESCE(SUM(ba.final_bonus), 0)::numeric AS total
       FROM bonus_periods bp
       JOIN campaigns c ON c.id = bp.campaign_id
       LEFT JOIN bonus_awards ba ON ba.period_id = bp.id
       LEFT JOIN users u ON u.id = ba.user_id
      WHERE to_char(bp.period_start, 'YYYY-MM') = $1
      GROUP BY c.id, c.name, bp.id, bp.locked, u.role
      ORDER BY c.name`,
    [month]
  );
  const byCampaign = new Map();
  for (const r of rows) {
    if (!byCampaign.has(r.campaign_id)) {
      byCampaign.set(r.campaign_id, {
        campaign_id: r.campaign_id, name: r.name, period_id: r.period_id,
        locked: r.locked, total: 0, levels: {},
      });
    }
    const c = byCampaign.get(r.campaign_id);
    if (r.role) {
      c.levels[r.role] = { awarded: r.awarded, qualified: r.qualified, total: Number(r.total) };
      c.total += Number(r.total);
    }
  }
  res.json({ months, month, campaigns: [...byCampaign.values()] });
});

// List periods visible to the caller (scoped by campaign).
router.get('/periods', async (req, res) => {
  const params = [];
  let where = 'TRUE';
  if (req.user.role !== 'admin') {
    if (req.user.campaign_id == null) return res.json({ periods: [] });
    where = 'bp.campaign_id = $1';
    params.push(req.user.campaign_id);
  }
  const { rows } = await query(
    `SELECT bp.id, bp.campaign_id, bp.period_start, bp.period_end, bp.locked,
            c.name AS campaign_name, c.slug AS campaign_slug
       FROM bonus_periods bp
       JOIN campaigns c ON c.id = bp.campaign_id
      WHERE ${where}
      ORDER BY bp.period_start DESC, c.name`,
    params
  );
  res.json({ periods: rows });
});

// Awards for a given period, scope-filtered by role.
// Returns: agent rows with metrics + bonus components + final bonus.
router.get('/awards', async (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!Number.isFinite(periodId)) return res.status(400).json({ error: 'period_id required' });

  // First, confirm the caller has visibility on this period's campaign.
  const { rows: prows } = await query(`SELECT campaign_id, locked FROM bonus_periods WHERE id = $1`, [periodId]);
  if (!prows.length) return res.status(404).json({ error: 'period_not_found' });
  const campaignId = prows[0].campaign_id;
  if (req.user.role !== 'admin' && req.user.campaign_id !== campaignId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Build scope clause for which users this caller can see.
  const params = [periodId];
  let scopeSql = 'TRUE';
  if (req.user.role === 'tm') {
    // Team leaders: by assigned team when set; otherwise by teams they manage;
    // name-based narrowing happens after the fetch (team names live in Zoho).
    if (req.user.team_id != null) {
      params.push(req.user.team_id);
      scopeSql = `u.team_id = $${params.length}`;
    } else {
      params.push(req.user.campaign_id, req.user.id);
      scopeSql = `(u.campaign_id = $${params.length - 1} AND (t.tm_user_id = $${params.length} OR TRUE))`;
    }
  } else if (req.user.role === 'agent') {
    params.push(req.user.id);
    scopeSql = `u.id = $${params.length}`;
  } else if (req.user.role === 'campaign_lead') {
    params.push(req.user.campaign_id);
    scopeSql = `u.campaign_id = $${params.length}`;
  }

  // Only agents that actually have metrics or a computed award this period —
  // not every account in the campaign (provisioning creates logins for staff
  // who may have no scored data yet).
  let { rows } = await query(
    `SELECT u.id            AS user_id,
            u.full_name,
            u.role          AS user_role,
            t.name          AS team_name,
            tm.full_name    AS tm_name,
            bm.attendance_days,
            bm.productivity,
            bm.csat_pct,
            bm.qa_pct,
            bm.callouts,
            ba.components,
            ba.kpi_bonus,
            ba.final_bonus,
            ba.qualified,
            ba.calculated_at
       FROM users u
       LEFT JOIN teams t   ON t.id = u.team_id
       LEFT JOIN users tm  ON tm.id = t.tm_user_id
       LEFT JOIN bonus_metrics bm ON bm.user_id = u.id AND bm.period_id = $1
       LEFT JOIN bonus_awards  ba ON ba.user_id = u.id AND ba.period_id = $1
      WHERE u.active = TRUE
        AND u.campaign_id = (SELECT campaign_id FROM bonus_periods WHERE id = $1)
        AND (bm.id IS NOT NULL OR ba.id IS NOT NULL)
        AND ${scopeSql}
      ORDER BY t.name NULLS LAST, ba.final_bonus DESC NULLS LAST, u.full_name`,
    params
  );

  // Team leaders without an assigned team: narrow to rows whose team name
  // matches them (managed-team join or normalised-name match). If nothing
  // matches we return empty + a flag rather than leaking the whole campaign.
  let teamMatch = true;
  if (req.user.role === 'tm' && req.user.team_id == null) {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const me = norm(req.user.team_name) || norm(req.user.full_name);
    const mine = rows.filter(r => r.tm_name && norm(r.tm_name) === norm(req.user.full_name)
                               || me && norm(r.team_name) === me);
    teamMatch = mine.length > 0;
    rows = mine;
  }

  res.json({
    period_id: periodId,
    locked: prows[0].locked,
    team_match: teamMatch,
    rows,
  });
});

// Returns the active rule for the period's campaign — used by the UI to
// show thresholds alongside the values for context.
router.get('/rules', async (req, res) => {
  const campaignId = parseInt(req.query.campaign_id, 10);
  const onDate = req.query.on_date || new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(campaignId)) return res.status(400).json({ error: 'campaign_id required' });
  if (req.user.role !== 'admin' && req.user.campaign_id !== campaignId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { rows } = await query(
    `SELECT id, campaign_id, effective_from, effective_to, rule_json
       FROM bonus_rules
      WHERE campaign_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [campaignId, onDate]
  );
  res.json({ rule: rows[0] || null });
});

export default router;
