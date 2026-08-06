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
import { canonicalCampaign, buildDepartmentMap, resolveDeptCampaign, CAMPAIGN_VIEW_ID, DIVISIONS_VIEW_ID } from '../provision.js';
import { seesAllScope } from '../rbac.js';
// Shared with the dashboard so name matching lines up exactly (see
// /shared/names.js). firstLast is this file's local name for firstLastKey.
import '../../../shared/names.js';
const { normalizeName: normName, firstLastKey: firstLast } = globalThis.BoomerangNames;

const router = Router();

// Map the friendly names the frontend uses → view IDs we know about.
const VIEW_KEYS = {
  'User_metrics_3':       VIEW.userMetrics,
  'AttendanceUserReport': VIEW.attendance,
  'EmployeeProfile':      VIEW.employee,
};

function metricName(r) {
  return r.fullname ?? r.Full_Name ?? r.full_name ?? null;
}
function profileName(r) {
  return r['Employee Name'] ?? r.employee_name ?? null;
}

// The set of employee name-keys (full + first/last) the caller is allowed to see,
// derived from their SCOPED User_metrics_3 rows. null → sees everything (no
// filtering). This is how we row-limit the attendance / profile feeds to exactly
// the caller's agents, so every role runs the same formulas on fewer rows rather
// than on a different (org-wide) dataset.
async function allowedNameKeys(user) {
  if (seesAllScope(user)) return null;
  const metrics = scopeMetricsRows(user, await fetchView(VIEW.userMetrics));
  const keys = new Set();
  for (const r of metrics) {
    const full = normName(metricName(r)); if (full) keys.add(full);
    const fl = firstLast(metricName(r));  if (fl) keys.add(fl);
  }
  return keys;
}
function nameAllowed(rawName, keys) {
  const full = normName(rawName); if (full && keys.has(full)) return true;
  const fl = firstLast(rawName);  if (fl && keys.has(fl)) return true;
  return false;
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

// EmployeeProfile.Department holds a Zoho lookup id, not a readable name. It
// resolves against the Campaign companion table (with Divisions merged in as a
// fallback) — the SAME two views + merge order provision.js uses. The browser
// must never try to interpret the raw id (shared/names.js.looksLikeLookupId
// exists so it can refuse them), so we resolve it here and attach the result.
//
// The companion views change rarely and Zoho rate-limits aggressively (see the
// header of server/src/zoho.js on why the access token is cached in Neon), so we
// keep a process-local map with a 1-hour TTL rather than fetching two extra views
// on every EmployeeProfile request. Process-local (not a DB table) is fine: a
// stale map for up to an hour only misattributes newly-created departments.
const DEPT_MAP_TTL_MS = 60 * 60 * 1000;
let _deptMap = null;         // Map<lookupId, campaignText>
let _deptMapAt = 0;

async function getDepartmentCampaignMap() {
  if (_deptMap && Date.now() - _deptMapAt < DEPT_MAP_TTL_MS) return _deptMap;
  // safeFetch-style (provision.js): a companion-view failure must not fail the
  // whole request — log and fall back to the last-good map (or empty on cold miss).
  const safeFetch = (id) => fetchView(id).catch(err => {
    console.warn(`[zoho/dept] companion view ${id} fetch failed:`, err.message);
    return null;
  });
  const [campaignRows, divisionRows] = await Promise.all([
    safeFetch(CAMPAIGN_VIEW_ID),
    safeFetch(DIVISIONS_VIEW_ID),
  ]);
  if (campaignRows == null && divisionRows == null) {
    return _deptMap || new Map();   // total outage → keep serving the previous map
  }
  const merged = new Map(buildDepartmentMap(campaignRows || []).map);
  for (const [id, name] of buildDepartmentMap(divisionRows || []).map) {
    if (!merged.has(id)) merged.set(id, name);   // Divisions fill gaps only
  }
  _deptMap = merged;
  _deptMapAt = Date.now();
  return _deptMap;
}

// Attach _campaign_slug / _campaign_name to each EmployeeProfile row from its
// Department lookup id, and log resolution quality once — unresolvable ids
// silently shrink the churn denominator (inflating the rate), so it must be
// visible, not silent.
async function attachCampaignToProfiles(rows) {
  const map = await getDepartmentCampaignMap();
  const counts = { campaign: 0, internal: 0, blank: 0, unresolved: 0 };
  for (const r of rows) {
    const { slug, name, status } = resolveDeptCampaign(r['Department'], map);
    counts[status]++;
    r._campaign_slug = slug;
    r._campaign_name = name;
  }
  console.info(`[zoho/EmployeeProfile] department resolution: ${rows.length} rows · ${counts.campaign} campaign · ${counts.internal} internal/admin · ${counts.blank} blank · ${counts.unresolved} unresolved-lookup-id (map=${map.size})`);
  return rows;
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
    // Scope EVERY feed to the caller so roles only ever limit WHICH rows are
    // returned — never the formulas or the figures computed from them.
    if (req.params.key === 'User_metrics_3') {
      rows = scopeMetricsRows(req.user, rows);
      // Attach the canonical campaign slug so the dashboard can line each metrics
      // campaign up with the churn feed (whose _campaign_slug comes from the same
      // canonicalCampaign) without duplicating the workgroup→slug map client-side.
      for (const r of rows) { const c = canonicalCampaign(r.workgroup); r._campaign_slug = c ? c.slug : null; }
    } else if (!seesAllScope(req.user)) {
      // Attendance & EmployeeProfile have no campaign/team column, so we narrow
      // them to the caller's agents by name. admin/exco skip this entirely.
      const keys = await allowedNameKeys(req.user);
      if (req.params.key === 'EmployeeProfile') {
        rows = rows.filter(r => nameAllowed(profileName(r), keys));
      } else if (req.params.key === 'AttendanceUserReport') {
        // Attendance keys people by Zoho People ID; map allowed names → IDs via
        // EmployeeProfile, then keep only those rows.
        const profiles = await fetchView(VIEW.employee);
        const allowedIds = new Set();
        for (const p of profiles) {
          if (!nameAllowed(profileName(p), keys)) continue;
          const id = String(p['ID'] ?? p.id ?? p.employee_id ?? '');
          if (id) allowedIds.add(id);
        }
        rows = rows.filter(r => allowedIds.has(String(r['Employee'] ?? r.employee ?? '')));
      }
    }
    // Resolve Department → campaign server-side (the browser can't read the raw
    // lookup id) so churn can exclude internal/admin staff from its denominator.
    if (req.params.key === 'EmployeeProfile') {
      rows = await attachCampaignToProfiles(rows);
    }
    // Match the shape the existing extractRows() in index.html expects.
    res.json({ data: rows });
  } catch (err) {
    console.error(`[zoho/view] ${req.params.key} failed:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
