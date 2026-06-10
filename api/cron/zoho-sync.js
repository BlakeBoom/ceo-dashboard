// Daily Zoho → Neon sync at 06:00 UTC (08:00 SAST).
// Refreshes bonus_metrics and bonus_awards for the current calendar month
// across every campaign that has an active bonus_rules row.
//
// Auth: Vercel injects Authorization: Bearer <CRON_SECRET> on cron invocations.
// We reject anything else so the endpoint isn't publicly re-triggerable.

import { syncAll, currentYearMonth } from '../../server/src/sync.js';

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const yearMonth = req.query?.year_month || currentYearMonth();
  try {
    const results = await syncAll(yearMonth);
    return res.status(200).json({ ok: true, year_month: yearMonth, results });
  } catch (err) {
    console.error('[cron/zoho-sync] failed', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
