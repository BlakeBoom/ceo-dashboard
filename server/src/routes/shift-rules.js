import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireRole } from '../rbac.js';
import '../../../shared/names.js';

const router = Router();
const N = globalThis.BoomerangNames;

// Cache the active rule set on the server so every request that resolves a
// shift → campaign (scoping, provisioning, sync) uses the same list as
// shiftToCampaign() reads on the client. Rebuilt after every admin write, or
// on the next read after the cache is invalidated.
let _cache = null;

async function loadActiveRules() {
  const { rows } = await query(
    `SELECT r.id, r.pattern, r.match_mode, r.priority, r.active,
            c.shift_key, c.id AS campaign_id, c.name AS campaign_name
       FROM shift_campaign_rules r
       JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.active AND c.active AND c.shift_key IS NOT NULL
      ORDER BY r.priority, r.id`
  );
  return rows;
}
async function primeCache() {
  _cache = await loadActiveRules();
  N.setShiftRules(_cache);
  return _cache;
}
function invalidateCache() { _cache = null; }
export async function ensureRulesLoaded() {
  if (_cache) return _cache;
  return primeCache();
}
// Prime once at import time so the very first request already resolves through
// DB rules — failures are swallowed (module import can't wait on I/O), and the
// SHIFT_PATTERNS fallback in shared/names.js keeps behaviour intact.
ensureRulesLoaded().catch((e) => console.warn('[shift-rules] initial load failed:', e.message));

// GET /api/shift-rules — used by the client to prime shiftToCampaign() on
// boot AND by the admin editor to render the rule table. Any authenticated
// user may read (there's nothing sensitive here — same as /api/teams/campaigns).
router.get('/', async (_req, res) => {
  if (!_cache) await primeCache();
  // Return the full row list so the admin screen can show inactive rules too
  // when it wants; also include a compact "resolver" list the client feeds
  // straight to setShiftRules.
  const { rows: all } = await query(
    `SELECT r.id, r.campaign_id, r.pattern, r.match_mode, r.priority, r.active,
            r.note, r.created_at, r.updated_at,
            c.shift_key, c.name AS campaign_name, c.slug AS campaign_slug
       FROM shift_campaign_rules r
       JOIN campaigns c ON c.id = r.campaign_id
      ORDER BY r.priority, r.id`
  );
  const active = all.filter(r => r.active && r.shift_key);
  res.json({ rules: all, active });
});

const ruleSchema = z.object({
  campaign_id: z.number().int().positive(),
  pattern: z.string().min(1).max(500),
  match_mode: z.enum(['contains', 'word', 'regex']),
  priority: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});
const patchSchema = ruleSchema.partial()
  .refine(o => Object.keys(o).length > 0, { message: 'no fields to update' });

// Regex-mode patterns get compiled to reject bad user input up front (instead
// of silently dropping at resolve time).
function validatePattern(pattern, mode) {
  if (mode !== 'regex') return null;
  try { new RegExp(pattern, 'i'); return null; }
  catch (e) { return e.message; }
}

router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  const bad = validatePattern(parsed.data.pattern, parsed.data.match_mode);
  if (bad) return res.status(400).json({ error: 'invalid_pattern', detail: bad });
  try {
    const { campaign_id, pattern, match_mode, priority, active, note } = parsed.data;
    const { rows } = await query(
      `INSERT INTO shift_campaign_rules (campaign_id, pattern, match_mode, priority, active, note, created_by)
       VALUES ($1, $2, $3, COALESCE($4, 100), COALESCE($5, TRUE), $6, $7)
       RETURNING id, campaign_id, pattern, match_mode, priority, active, note`,
      [campaign_id, pattern, match_mode, priority ?? null, active ?? null, note ?? null, req.user.id]
    );
    invalidateCache();
    await primeCache();
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'shift_rule.create', $2, $3)`,
      [req.user.id, rows[0].id, parsed.data]
    );
    res.status(201).json({ rule: rows[0] });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'invalid_campaign' });
    throw err;
  }
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = patchSchema.safeParse(req.body);
  if (!Number.isFinite(id) || !parsed.success) {
    return res.status(400).json({ error: 'invalid_input', detail: parsed.success ? undefined : parsed.error.flatten() });
  }
  if (parsed.data.pattern != null || parsed.data.match_mode != null) {
    // Need both to validate a regex — fetch the row's other side if only one is provided.
    let pattern = parsed.data.pattern, mode = parsed.data.match_mode;
    if (pattern == null || mode == null) {
      const { rows } = await query(`SELECT pattern, match_mode FROM shift_campaign_rules WHERE id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      pattern = pattern ?? rows[0].pattern;
      mode = mode ?? rows[0].match_mode;
    }
    const bad = validatePattern(pattern, mode);
    if (bad) return res.status(400).json({ error: 'invalid_pattern', detail: bad });
  }
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(parsed.data)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const { rows } = await query(
    `UPDATE shift_campaign_rules SET ${sets.join(', ')} WHERE id = $${vals.length}
      RETURNING id, campaign_id, pattern, match_mode, priority, active, note`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  invalidateCache();
  await primeCache();
  await query(
    `INSERT INTO audit_log (user_id, action, target_id, metadata) VALUES ($1, 'shift_rule.update', $2, $3)`,
    [req.user.id, id, parsed.data]
  );
  res.json({ rule: rows[0] });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { rowCount } = await query(`DELETE FROM shift_campaign_rules WHERE id = $1`, [id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  invalidateCache();
  await primeCache();
  await query(
    `INSERT INTO audit_log (user_id, action, target_id) VALUES ($1, 'shift_rule.delete', $2)`,
    [req.user.id, id]
  );
  res.json({ ok: true });
});

// Rule tester — pass a shift name (or a batch), get back the resolved campaign
// key + which rule fired first. Admin-only because it's a debugging tool that
// implicitly reveals the whole rule list on ambiguous inputs.
const testSchema = z.object({
  shift: z.string().min(1).max(500).optional(),
  shifts: z.array(z.string().min(1).max(500)).max(200).optional(),
}).refine(o => o.shift || (o.shifts && o.shifts.length), { message: 'shift or shifts required' });

router.post('/test', requireRole('admin'), async (req, res) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
  if (!_cache) await primeCache();
  // Compile the cached rules the same way shared/names.js does, but track
  // which rule fired so we can return the winning row.
  const compiled = [];
  for (const r of _cache) {
    let source;
    if (r.match_mode === 'regex') source = r.pattern;
    else if (r.match_mode === 'word') source = `\\b${r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
    else source = r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { compiled.push({ re: new RegExp(source, 'i'), r }); } catch {}
  }
  const evalOne = (s) => {
    for (const { re, r } of compiled) {
      if (re.test(s)) return { shift: s, shift_key: r.shift_key, campaign_id: r.campaign_id,
        campaign_name: r.campaign_name, rule_id: r.id, matched_pattern: r.pattern, match_mode: r.match_mode };
    }
    return { shift: s, shift_key: null };
  };
  const shifts = parsed.data.shifts || [parsed.data.shift];
  const results = shifts.map(evalOne);
  res.json({ results: parsed.data.shifts ? results : undefined, result: parsed.data.shift ? results[0] : undefined });
});

export default router;
