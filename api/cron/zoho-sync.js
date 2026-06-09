// Hourly Zoho sync. Phase 2 wires this up to pull bonus_metrics from
// Zoho People + Analytics into Neon. For now: a stub that validates the
// Vercel-Cron signature and returns 202 so the cron config is valid.
//
// Vercel sends a CRON_SECRET in the Authorization header on scheduled
// invocations. Reject anything else to prevent public re-triggering.

export default function handler(req, res) {
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Phase 2 will replace this with:
  //   1. Refresh Zoho access token via ZOHO_REFRESH_TOKEN
  //   2. Page through User_metrics_3 (Analytics) for current period
  //   3. Page through Attendance form (People) for callouts
  //   4. UPSERT bonus_metrics rows, recompute bonus_awards
  return res.status(202).json({ ok: true, status: 'phase-2-stub' });
}
