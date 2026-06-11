// Proxy endpoint that lets the front-end dashboard (Summary/Campaigns/Trends)
// fetch Zoho Analytics views through our backend instead of the legacy
// Google Apps Script proxy. Single source of Zoho auth: server env vars only.

import { Router } from 'express';
import { requireRole } from '../rbac.js';
import { fetchView, fetchViewByDate, VIEW } from '../zoho.js';

const router = Router();

// Map the friendly names the frontend uses → view IDs we know about.
const VIEW_KEYS = {
  'User_metrics_3':       VIEW.userMetrics,
  'AttendanceUserReport': VIEW.attendance,
  'EmployeeProfile':      VIEW.employee,
};

router.get('/view/:key', requireRole('tm'), async (req, res) => {
  const viewId = VIEW_KEYS[req.params.key];
  if (!viewId) return res.status(400).json({ error: 'unknown_view', detail: req.params.key });

  const since = req.query.since;

  try {
    // When a lower bound is given, filter server-side. The date column name
    // varies per view, so probe for it (open-ended upper bound).
    const rows = since
      ? await fetchViewByDate(viewId, since, '9999-12-31')
      : await fetchView(viewId);
    // Match the shape the existing extractRows() in index.html expects.
    res.json({ data: rows });
  } catch (err) {
    console.error(`[zoho/view] ${req.params.key} failed:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
