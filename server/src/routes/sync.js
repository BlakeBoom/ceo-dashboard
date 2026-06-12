import { Router } from 'express';
import { requireRole } from '../rbac.js';
import { syncCampaign, syncAll, currentYearMonth } from '../sync.js';
import { query } from '../db.js';

const router = Router();

// Manual sync trigger. TMs/campaign leads can refresh their own campaign;
// admin can refresh any.
router.post('/now', requireRole('tm'), async (req, res) => {
  const campaignId = parseInt(req.body?.campaign_id, 10);
  const yearMonth = req.body?.year_month || currentYearMonth();

  // Admin can sync every ruled campaign for the month in one call.
  if (req.body?.all === true && req.user.role === 'admin') {
    try {
      const results = await syncAll(yearMonth);
      await query(
        `INSERT INTO audit_log (user_id, action, metadata)
         VALUES ($1, 'sync.manual_all', $2)`,
        [req.user.id, { year_month: yearMonth, campaigns: results.length }]
      );
      return res.json({ ok: true, results });
    } catch (err) {
      console.error('[sync] all failed', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (!Number.isFinite(campaignId)) return res.status(400).json({ error: 'campaign_id required' });
  if (req.user.role !== 'admin' && req.user.campaign_id !== campaignId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const result = await syncCampaign(campaignId, yearMonth);
    await query(
      `INSERT INTO audit_log (user_id, action, target_id, metadata)
       VALUES ($1, 'sync.manual', $2, $3)`,
      [req.user.id, campaignId, { year_month: yearMonth, result }]
    );
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[sync] failed', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
