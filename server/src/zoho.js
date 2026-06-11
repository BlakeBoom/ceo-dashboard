// Zoho Analytics v2 API client with shared (DB-backed) access-token cache.
//
// Why: Zoho rate-limits /oauth/v2/token aggressively (a few requests per
// minute will trigger "Access Denied — too many requests"). In a serverless
// environment, each cold-start function instance would do its own refresh,
// blowing through the limit fast. We store the access token in Neon so
// every instance shares it, and only refresh when actually expired.

import { env } from './env.js';
import { pool, query } from './db.js';

const ACCOUNTS_BASE  = () => `https://accounts.zoho.${env.ZOHO_REGION}`;
const ANALYTICS_BASE = () => `https://analyticsapi.zoho.${env.ZOHO_REGION}`;

let _local = null;     // { access_token, expires_at_ms } — per-instance cache
let _inFlight = null;  // singleflight to avoid duplicate refresh within an instance

async function readDbCache() {
  try {
    const { rows } = await query(
      `SELECT access_token, expires_at FROM zoho_tokens WHERE id = 1`
    );
    if (!rows[0]) return null;
    const expiresMs = new Date(rows[0].expires_at).getTime();
    return { access_token: rows[0].access_token, expires_at_ms: expiresMs };
  } catch {
    return null; // table doesn't exist yet, fall through to live refresh
  }
}

async function writeDbCache(accessToken, expiresAtMs) {
  try {
    await query(
      `INSERT INTO zoho_tokens (id, access_token, expires_at, refreshed_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         expires_at   = EXCLUDED.expires_at,
         refreshed_at = NOW()`,
      [accessToken, new Date(expiresAtMs)]
    );
  } catch (err) {
    console.warn('[zoho] failed to persist token cache:', err.message);
  }
}

async function refreshFromZoho() {
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id:     env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });
  const r = await fetch(`${ACCOUNTS_BASE()}/oauth/v2/token`, { method: 'POST', body });
  const text = await r.text();
  if (!r.ok) throw new Error(`Zoho token refresh ${r.status}: ${text}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error(`Zoho token refresh returned no access_token: ${text}`);
  const expiresAtMs = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return { access_token: data.access_token, expires_at_ms: expiresAtMs };
}

async function getAccessToken() {
  // 1. Per-instance cache (fastest)
  if (_local && _local.expires_at_ms > Date.now() + 30_000) return _local.access_token;

  // 2. Shared DB cache (avoids duplicate refresh across function instances)
  const dbCached = await readDbCache();
  if (dbCached && dbCached.expires_at_ms > Date.now() + 30_000) {
    _local = dbCached;
    return dbCached.access_token;
  }

  // 3. Singleflight refresh (avoids duplicate refresh within one instance)
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const fresh = await refreshFromZoho();
      _local = fresh;
      await writeDbCache(fresh.access_token, fresh.expires_at_ms);
      return fresh.access_token;
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

// View IDs for the Boomerang workspace.
export const VIEW = {
  userMetrics: '2292884000018755200',
  attendance:  '2292884000019604651',
  employee:    '2292884000019602125',
};

export async function fetchView(viewId, { criteria = null } = {}) {
  const token = await getAccessToken();
  const config = { responseFormat: 'json', keyValueFormat: true };
  if (criteria) config.criteria = criteria;

  const url = new URL(`${ANALYTICS_BASE()}/restapi/v2/workspaces/${env.ZOHO_ANALYTICS_WORKSPACE_ID}/views/${viewId}/data`);
  url.searchParams.set('CONFIG', JSON.stringify(config));

  const r = await fetch(url, {
    headers: {
      'Authorization':    `Zoho-oauthtoken ${token}`,
      'ZANALYTICS-ORGID': env.ZOHO_ANALYTICS_ORG_ID,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Zoho fetch view ${viewId} ${r.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  if (Array.isArray(json.data)) return json.data;
  if (json.data?.rows && json.data?.columns) {
    const cols = json.data.columns.map(c => c.name || c);
    return json.data.rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  }
  return [];
}

// Candidate names for a view's date column, in priority order. Views don't
// share a convention (User_metrics_3's date column is not named "Date"), so we
// probe rather than hardcode. Mirrors the dashboard's detectDateCol list.
export const DATE_COL_CANDIDATES = ['Date', 'date', 'DATE', 'call_date',
  'Call_Date', 'metric_date', 'Metric_Date', 'activity_date', 'report_date',
  'Report_Date', 'log_date', 'day', 'Day', 'datetime', 'date_time', 'Date_Time',
  'created_date', 'Created_Date'];

// Known date-column names per view, used to skip probing on the common path.
// Anything not listed here falls back to probing DATE_COL_CANDIDATES.
export const VIEW_DATE_COL = {
  [VIEW.userMetrics]: 'metric_date',
  [VIEW.attendance]:  'Date',
};

// Resolved date-column name per view, cached for the lifetime of the lambda so
// we only probe once. Seeded with the known mapping above.
const _dateColCache = new Map(Object.entries(VIEW_DATE_COL));

// Fetch a view filtered to [start, end] (inclusive, 'YYYY-MM-DD') server-side.
// Since the date column name varies per view, try candidates until one isn't
// rejected by Zoho as an unknown filter column (errorCode 7330); a bad column
// returns a fast 400, so probing is cheap. The winner is cached per view.
export async function fetchViewByDate(viewId, start, end, candidates = DATE_COL_CANDIDATES) {
  const cached = _dateColCache.get(viewId);
  const order = cached ? [cached, ...candidates.filter(c => c !== cached)] : candidates;
  let lastErr;
  for (const col of order) {
    const criteria = `"${col}" >= '${start}' AND "${col}" <= '${end}'`;
    try {
      const rows = await fetchView(viewId, { criteria });
      _dateColCache.set(viewId, col);
      return rows;
    } catch (err) {
      // Unknown-column → try the next candidate; anything else is a real error.
      if (/UNKNOWN_COLUMN_IN_FILTERCRITERIA|\b7330\b/.test(err.message)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`No usable date column for view ${viewId}`);
}

export function monthBounds(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const start = `${yyyyMm}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${yyyyMm}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

// Silence unused-import warning if pool is later removed.
void pool;
