// Bonus computation engine. Pure functions: given raw Zoho rows + rule_json,
// produce a metrics object per agent and a computed award.

const DEFAULT_UNPLANNED_STATUSES = [
  'Sick Leave', 'Sick Leave Shifts',
  'Absent', 'No Show',
  'Unpaid Leave', 'Unpaid Leave Shifts',
  'AWOL', 'System Downtime',
];

// Normalise a name for matching across views (User_metrics_3 vs EmployeeProfile).
function normName(s) {
  if (!s) return null;
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Aggregate User_metrics_3 daily rows → per-agent monthly metrics.
// rule.productivity_column tells us which column to SUM for productivity
// (default 'tickets'). CSAT/QA are averaged across non-null daily values.
export function aggregateUserMetrics(rows, { productivityColumn = 'tickets' } = {}) {
  const byUser = new Map(); // user_id → { name, productivity, csat_sum, csat_n, qa_sum, qa_n }
  for (const r of rows) {
    const uid = r.user_id ?? r.User_ID ?? r.UserId;
    if (uid == null) continue;
    const key = String(uid);
    let agg = byUser.get(key);
    if (!agg) {
      agg = {
        user_id: key,
        fullname: r.fullname || r.Full_Name || r.full_name || null,
        productivity: 0,
        csat_sum: 0, csat_n: 0,
        qa_sum: 0,   qa_n: 0,
      };
      byUser.set(key, agg);
    }
    const prod = Number(r[productivityColumn]);
    if (!Number.isNaN(prod)) agg.productivity += prod;
    const csat = Number(r.csat);
    if (!Number.isNaN(csat) && csat > 0) { agg.csat_sum += csat; agg.csat_n += 1; }
    const qa = Number(r.QA ?? r.qa);
    if (!Number.isNaN(qa) && qa > 0) { agg.qa_sum += qa; agg.qa_n += 1; }
  }
  // Finalise
  const out = new Map();
  for (const [k, v] of byUser) {
    out.set(k, {
      user_id: k,
      fullname: v.fullname,
      productivity: Math.round(v.productivity * 100) / 100,
      // Zoho returns percentages as either 0..1 or 0..100. Normalise to 0..1.
      csat_pct: v.csat_n ? normaliseRate(v.csat_sum / v.csat_n) : null,
      qa_pct:   v.qa_n   ? normaliseRate(v.qa_sum   / v.qa_n)   : null,
    });
  }
  return out;
}

function normaliseRate(v) {
  if (v == null) return null;
  return v > 1 ? v / 100 : v;
}

// Count callouts (rows with unplanned status) per agent from attendance rows.
export function aggregateCallouts(attRows, { unplannedStatuses = DEFAULT_UNPLANNED_STATUSES } = {}) {
  const set = new Set(unplannedStatuses);
  const counts = new Map(); // employee_id → count
  for (const r of attRows) {
    const status = String(r.Status ?? r.status ?? '').trim();
    if (!set.has(status)) continue;
    const empId = String(r.Employee ?? r.employee ?? '').trim();
    if (!empId) continue;
    counts.set(empId, (counts.get(empId) || 0) + 1);
  }
  return counts;
}

// Build employee_id → user_id map by matching names across User_metrics_3
// agents and EmployeeProfile records.
export function buildEmployeeUserMap(empProfileRows, userMetricsByUser) {
  // Indexed by normalised name
  const profileByName = new Map();
  for (const r of empProfileRows) {
    const name = r['Employee Name'] || r.employee_name;
    const id = r.ID || r.id || r.employee_id;
    if (!name || !id) continue;
    profileByName.set(normName(name), String(id));
  }
  const out = new Map(); // employee_id → user_id
  for (const [uid, agg] of userMetricsByUser) {
    const empId = profileByName.get(normName(agg.fullname));
    if (empId) out.set(empId, uid);
  }
  return out;
}

// Apply rule_json to a single agent's metrics, return { components, kpi_bonus, final_bonus, qualified }
export function applyRule(metrics, ruleJson) {
  const components = {};
  let kpiBonus = 0;
  let metCount = 0;

  for (const c of ruleJson.components || []) {
    const v = readMetric(metrics, c.key);
    const met = evalComponent(v, c);
    const earned = met ? Number(c.amount) || 0 : 0;
    components[c.key] = earned;
    kpiBonus += earned;
    if (met) metCount += 1;
  }

  // Default: final bonus equals kpi bonus. A future rule could require
  // a minimum component-count to qualify.
  const minComponents = ruleJson.kpi_min_components ?? 0;
  const qualified = metCount >= minComponents;
  const final_bonus = qualified ? kpiBonus : 0;

  return { components, kpi_bonus: kpiBonus, final_bonus, qualified };
}

function readMetric(metrics, key) {
  switch (key) {
    case 'sa':            return metrics.callouts;
    case 'productivity':  return metrics.productivity;
    case 'csat':          return metrics.csat_pct;
    case 'qa':            return metrics.qa_pct;
    default:              return metrics[key];
  }
}

function evalComponent(value, component) {
  if (value == null) return false;
  const t = Number(component.threshold);
  switch (component.type) {
    case 'callouts_le': return Number(value) <= t;
    case 'value_ge':    return Number(value) >= t;
    case 'value_le':    return Number(value) <= t;
    case 'pct_ge':      return Number(value) >= t;
    case 'pct_le':      return Number(value) <= t;
    default:            return false;
  }
}
