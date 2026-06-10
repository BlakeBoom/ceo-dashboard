// Zoho Analytics v2 API client.
// Token refresh is in-memory and survives within a single warm Vercel function
// instance; cold starts re-fetch. Access tokens are 1h-lived.

import { env } from './env.js';

const ACCOUNTS_BASE   = () => `https://accounts.zoho.${env.ZOHO_REGION}`;
const ANALYTICS_BASE  = () => `https://analyticsapi.zoho.${env.ZOHO_REGION}`;

let _token = null; // { access_token, expires_at_ms }

async function getAccessToken() {
  if (_token && _token.expires_at_ms > Date.now() + 30_000) return _token.access_token;

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
  _token = {
    access_token: data.access_token,
    expires_at_ms: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
  };
  return _token.access_token;
}

// View IDs for the Boomerang workspace. Hard-coded since they're stable and
// stored in env.ZOHO_ANALYTICS_WORKSPACE_ID is the parent workspace.
export const VIEW = {
  userMetrics: '2292884000018755200', // User_metrics_3   (CSAT, QA, productivity)
  attendance:  '2292884000019604651', // AttendanceUserReport (Status → callouts)
  employee:    '2292884000019602125', // EmployeeProfile
};

// Fetch a view as an array of row objects. Optionally filtered with a
// criteria string in Zoho's syntax, e.g. `"Date" >= '2026-06-01'`.
export async function fetchView(viewId, { criteria = null } = {}) {
  const token = await getAccessToken();
  const config = { responseFormat: 'json', keyValueFormat: true };
  if (criteria) config.criteria = criteria;

  const url = new URL(`${ANALYTICS_BASE()}/restapi/v2/workspaces/${env.ZOHO_ANALYTICS_WORKSPACE_ID}/views/${viewId}/data`);
  url.searchParams.set('CONFIG', JSON.stringify(config));

  const r = await fetch(url, {
    headers: {
      'Authorization':     `Zoho-oauthtoken ${token}`,
      'ZANALYTICS-ORGID':  env.ZOHO_ANALYTICS_ORG_ID,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Zoho fetch view ${viewId} ${r.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  // v2 with keyValueFormat returns: { data: [{col1: val, col2: val}, ...] }
  // Older format: { data: { rows: [[]], columns: [{name}] } }
  if (Array.isArray(json.data)) return json.data;
  if (json.data?.rows && json.data?.columns) {
    const cols = json.data.columns.map(c => c.name || c);
    return json.data.rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  }
  return [];
}

// "YYYY-MM" → ["YYYY-MM-01", "YYYY-MM-DD-last"]
export function monthBounds(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const start = `${yyyyMm}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${yyyyMm}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}
