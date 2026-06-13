// Proxy endpoint that lets the front-end dashboard (Summary/Campaigns/Trends)
// fetch Zoho Analytics views through our backend instead of the legacy
// Google Apps Script proxy. Single source of Zoho auth: server env vars only.
//
// Row-level scoping is enforced HERE (not in the browser): a campaign manager
// only ever receives their campaign's rows, a team leader only their team's.
// The dashboard is driven by User_metrics_3, so scoping it scopes every tab.

import { Router } from 'express';
import { requireRole } from '../rbac.js';
import { fetchView, fetchViewByDate, VIEW } from '../zoho.js';
import { canonicalCampaign } from '../provision.js';
import { seesAllScope } from '../rbac.js';

const router = Router();

// Map the friendly names the frontend uses → view IDs we know about.
const VIEW_KEYS = {
  'User_metrics_3':       VIEW.userMetrics,
  'AttendanceUserReport': VIEW.attendance,
  'EmployeeProfile':      VIEW.employee,
};

function normName(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Restrict User_metrics_3 rows to what the caller may see.
//   admin         → everything
//   campaign_lead → their campaign (all teams)
//   tm            → their campaign, narrowed to their own team when the team is
//                   identifiable by name (team_name matches the leader's name)
// A non-admin with no campaign sees nothing rather than everything.
function scopeMetricsRows(user, rows) {
  if (seesAllScope(user)) return rows;
  const slug = user.campaign_slug;
  if (!slug) return [];
  let out = rows.filter(r => {
    const c = canonicalCampaign(r.workgroup);
    return c && c.slug === slug;
  });
  if (user.role === 'tm') {
    const me = normName(user.team_name) || normName(user.full_name);
    const mine = out.filter(r => normName(r.team_name) === me);
    if (mine.length) out = mine; // narrow to their team when we can identify it
  }
  return out;
}

router.get('/view/:key', requireRole('tm'), async (req, res) => {
  const viewId = VIEW_KEYS[req.params.key];
  if (!viewId) return res.status(400).json({ error: 'unknown_view', detail: req.params.key });

  const since = req.query.since;

  try {
    // When a lower bound is given, filter server-side. The date column name
    // varies per view, so probe for it (open-ended upper bound).
    let rows = since
      ? await fetchViewByDate(viewId, since, '9999-12-31')
      : await fetchView(viewId);
    // Scope the metrics view (drives the whole dashboard) to the caller.
    if (req.params.key === 'User_metrics_3') rows = scopeMetricsRows(req.user, rows);
    // Match the shape the existing extractRows() in index.html expects.
    res.json({ data: rows });
  } catch (err) {
    console.error(`[zoho/view] ${req.params.key} failed:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
