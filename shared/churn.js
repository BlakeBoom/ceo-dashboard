// Churn / attrition maths — the single source of truth shared by the dashboard
// and (potentially) the server, exactly like /shared/names.js.
//
// This file deliberately has NO import/export statements so it works UNCHANGED in
// both runtimes: the browser loads it as a classic <script src="/shared/churn.js">
// placed BEFORE the inline app script (which reads globalThis.BoomerangChurn), and
// the server can do a side-effect ESM import and read the same global. Do NOT add
// import/export, and do NOT load it as type="module" in the browser — see the
// header of /shared/names.js for the full reasoning.
//
// Every function is pure. Dates are passed in already-parsed (extractChurnRows
// takes the caller's parseDate as an argument) so nothing here depends on a date
// library or on how the browser vs. the tests parse strings.
(function (root) {
  // ── Column detection ────────────────────────────────────────────────────────
  // EmployeeProfile header labels vary between exports, so probe by NORMALISED key
  // (lowercase, strip everything non-alphanumeric) — that is how
  // "Date of exit (Last Day of Employment)" collapses to a stable key.
  const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
  const CHURN_COL_CANDIDATES = {
    join:         ['groupjoiningdate', 'joiningdate', 'dateofjoining', 'joindate', 'hiredate'],
    exit:         ['dateofexitlastdayofemployment', 'dateofexit', 'exitdate', 'lastdayofemployment', 'lastworkingday'],
    reason:       ['reasonforexit', 'exitreason', 'reasonforleaving', 'reason'],
    status:       ['employeestatus', 'status'],
    contractType: ['employeecontracttype', 'contracttype'],
    // The human Employee ID (e.g. "HRM123", "1302") — NOT the Zoho record id
    // ('id' → 610962…), which is why 'id' is deliberately absent from the list.
    empId:        ['employeeid', 'employeeno', 'employeenumber', 'empno', 'empid', 'staffnumber'],
  };

  // Employee IDs with this prefix are HR / management staff, excluded from
  // attrition entirely (numerator and denominator). Exported so it can be tuned
  // without touching logic. Anchored + case-insensitive, tolerant of leading space.
  const EXCLUDED_EMPID_RE = /^\s*hrm/i;

  let _warnedNoCols = false, _warnedNoEmpId = false;
  // Returns { join, exit, reason, status, contractType } (actual header keys, or
  // null per field) — or null overall when EITHER date column is missing. Null
  // rather than a zero-filled result is deliberate: the same reasoning as
  // buildRoleIndex returning null — a churn view we can't read must fail loudly and
  // let callers fall back, not silently report zero attrition.
  function detectChurnCols(empRows) {
    const sample = (empRows || []).find(r => r) || {};
    const byNorm = new Map(Object.keys(sample).map(k => [normKey(k), k]));
    const out = {};
    for (const [field, cands] of Object.entries(CHURN_COL_CANDIDATES)) {
      out[field] = null;
      for (const c of cands) if (byNorm.has(c)) { out[field] = byNorm.get(c); break; }
    }
    if (!out.join || !out.exit) {
      if (!_warnedNoCols) { console.warn('[churn] EmployeeProfile is missing a join and/or exit date column — churn disabled.'); _warnedNoCols = true; }
      return null;
    }
    if (!out.empId && !_warnedNoEmpId) {
      console.warn('[churn] no Employee ID column detected — HRM-prefixed staff cannot be excluded from attrition.');
      _warnedNoEmpId = true;
    }
    return out;
  }

  // ── Row extraction ──────────────────────────────────────────────────────────
  // parseDate is INJECTED (not imported) so this stays pure/testable. Returns
  // { join, exit, reason, status, contractType, campaignSlug }[]. Drops a row with
  // no join date, and — when opts.campaignOnly !== false (the default) — any row
  // whose _campaign_slug is null (the admin/internal exclusion). Both filters apply
  // to numerator and denominator alike because every downstream figure derives from
  // this one array. The two drop reasons are counted SEPARATELY: a big no-join-date
  // count (data quality) and a big not-in-a-campaign count (scope) mean very
  // different things and must not be collapsed into one number.
  function extractChurnRows(empRows, parseDate, opts = {}) {
    const campaignOnly = opts.campaignOnly !== false;
    const cols = detectChurnCols(empRows);
    if (!cols) return [];
    const out = [];
    let droppedNoJoin = 0, droppedHrm = 0, droppedNotInCampaign = 0;
    for (const r of (empRows || [])) {
      const join = parseDate(r[cols.join]);
      if (!join) { droppedNoJoin++; continue; }            // no join date → not a real tenure
      const empId = cols.empId ? String(r[cols.empId] ?? '') : '';
      if (EXCLUDED_EMPID_RE.test(empId)) { droppedHrm++; continue; }  // HR / management — never in attrition
      const campaignSlug = r._campaign_slug ?? null;
      if (campaignOnly && campaignSlug == null) { droppedNotInCampaign++; continue; }  // admin/internal
      out.push({
        join,
        exit: parseDate(cols.exit ? r[cols.exit] : null) || null,
        reason: (cols.reason ? r[cols.reason] : '') || '',
        status: (cols.status ? r[cols.status] : '') || '',
        contractType: (cols.contractType ? r[cols.contractType] : '') || '',
        empId,
        campaignSlug,
      });
    }
    console.info(`[churn] extractChurnRows: ${out.length} kept · dropped ${droppedNoJoin} no-join-date · dropped ${droppedHrm} HRM-prefixed · dropped ${droppedNotInCampaign} not-in-a-campaign (campaignOnly=${campaignOnly})`);
    return out;
  }

  // ── Date helpers (UTC, date-granularity) ────────────────────────────────────
  // Month keys are 'YYYY-MM' strings. All bounds are UTC so results don't shift
  // with the runner's timezone.
  const ymParts = (ym) => { const [y, m] = String(ym).split('-').map(Number); return { y, m }; };
  const monthStart = (ym) => { const { y, m } = ymParts(ym); return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)); };
  const monthEnd   = (ym) => { const { y, m } = ymParts(ym); return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)); };
  // ym shifted by deltaMonths (may be negative), returned as a 'YYYY-MM' string.
  function ymShift(ym, deltaMonths) {
    const { y, m } = ymParts(ym);
    const idx = y * 12 + (m - 1) + deltaMonths;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  }

  // ── Point-in-time headcount ─────────────────────────────────────────────────
  // Employed at `asAt` = joined on/before it and either still here or left strictly
  // after it. `exit > asAt` (not >=) is deliberate: someone whose last day IS asAt
  // has left by the end of that instant.
  function headcountAsAt(churnRows, asAtDate) {
    const asAt = +asAtDate;
    let n = 0;
    for (const r of churnRows) {
      if (+r.join <= asAt && (!r.exit || +r.exit > asAt)) n++;
    }
    return n;
  }

  // Involuntary exit reasons. Exported so it can be tuned WITHOUT touching logic —
  // MUST be validated against real `Reason for exit` values before trusting the
  // voluntary/involuntary split.
  const INVOLUNTARY_RE = /dismiss|terminat|redundan|retrench|misconduct|abscond|end of contract/i;

  // Leaver ROWS whose exit falls in [start, end] inclusive. opts.voluntaryOnly
  // drops involuntary exits (INVOLUNTARY_RE on the reason).
  function leaversBetween(churnRows, start, end, opts = {}) {
    const s = +start, e = +end;
    const out = [];
    for (const r of churnRows) {
      if (!r.exit) continue;
      const t = +r.exit;
      if (t < s || t > e) continue;
      if (opts.voluntaryOnly && INVOLUNTARY_RE.test(r.reason)) continue;
      out.push(r);
    }
    return out;
  }

  // ── Tenure classification ───────────────────────────────────────────────────
  // 'early' = left BEFORE the 3-month anniversary of the join date; 'established'
  // = on/after it. Calendar-month arithmetic against the anniversary (NOT a flat
  // 90-day count) so month lengths don't move the boundary, with the month-end edge
  // handled: joined 31 Jan → 3-month anniversary is 30 Apr (31 Apr doesn't exist),
  // so exit 30 Apr is established and 29 Apr is early.
  function tenureBucket(joinDate, exitDate) {
    const j = joinDate, y = j.getUTCFullYear(), m0 = j.getUTCMonth(), d = j.getUTCDate();
    const idx = y * 12 + m0 + 3;
    const ty = Math.floor(idx / 12), tm0 = idx % 12;
    const lastDay = new Date(Date.UTC(ty, tm0 + 1, 0)).getUTCDate();   // last day of the anniversary month
    const anniversary = Date.UTC(ty, tm0, Math.min(d, lastDay), 0, 0, 0, 0);
    return +exitDate < anniversary ? 'early' : 'established';
  }

  // ── Monthly churn (trend line only) ─────────────────────────────────────────
  // avgHC is the two-point (prior month-end + this month-end) / 2 here — adequate
  // for a single month. Returns churn_pct ONLY: it deliberately does NOT return a
  // churn_pct * 12 field. Keeping an extrapolated "annualised" number next to the
  // measured rolling one guarantees someone eventually reports the wrong one.
  function computeMonthlyChurn(churnRows, months, opts = {}) {
    return months.map(ym => {
      const prevEnd = monthEnd(ymShift(ym, -1));
      const thisEnd = monthEnd(ym);
      const avgHC = (headcountAsAt(churnRows, prevEnd) + headcountAsAt(churnRows, thisEnd)) / 2;
      const leavers = leaversBetween(churnRows, monthStart(ym), thisEnd, opts).length;
      return { month: ym, leavers, avgHC, churn_pct: avgHC > 0 ? (leavers / avgHC) * 100 : null };
    });
  }

  // ── Rolling 12-month churn — THE HEADLINE KPI ───────────────────────────────
  // Measured directly over the trailing 12 calendar months, NOT a monthly rate ×12.
  // Extrapolating one month to a year makes a single bulk exit swing the annual
  // figure wildly — unacceptable for a CEO tile. Both tenure buckets use the SAME
  // headline denominator so churn_early + churn_established === churn_annual exactly
  // (the tiles DECOMPOSE the headline, they aren't three unrelated rates).
  function computeRolling12Churn(churnRows, months, opts = {}) {
    // Earliest join present: a window that starts before this is incomplete —
    // leavers from the missing months are absent from the numerator while the
    // denominator still populates, so we must not report a number.
    let dataStart = Infinity;
    for (const r of churnRows) if (+r.join < dataStart) dataStart = +r.join;

    return months.map(ym => {
      const windowStart = monthStart(ymShift(ym, -11));   // first day of the month 11 before M
      const windowEnd = monthEnd(ym);                      // last day of M
      const nullResult = {
        month: ym, windowStart, windowEnd, leavers: 0, avgHC: 0,
        churn_annual_pct: null, retention_annual_pct: null,
        churn_early_pct: null, churn_established_pct: null,
        early_share_of_leavers_pct: null, incomplete_window: false,
      };

      if (churnRows.length === 0 || +windowStart < dataStart) {
        return { ...nullResult, incomplete_window: churnRows.length > 0 };
      }

      // Mean of the 12 month-end headcounts — NOT a two-point average. Headcount
      // grows/shrinks non-linearly with campaign launches, so two points misstate
      // the denominator.
      let hcSum = 0;
      for (let i = 11; i >= 0; i--) hcSum += headcountAsAt(churnRows, monthEnd(ymShift(ym, -i)));
      const avgHC = hcSum / 12;
      if (!(avgHC > 0)) return nullResult;   // guard 1: non-positive denominator → all null

      const leavers = leaversBetween(churnRows, windowStart, windowEnd, opts);
      let early = 0;
      for (const r of leavers) if (tenureBucket(r.join, r.exit) === 'early') early++;
      const established = leavers.length - early;

      const churn_annual_pct = (leavers.length / avgHC) * 100;
      return {
        month: ym, windowStart, windowEnd, leavers: leavers.length, avgHC,
        churn_annual_pct,
        retention_annual_pct: 100 - churn_annual_pct,
        churn_early_pct: (early / avgHC) * 100,
        churn_established_pct: (established / avgHC) * 100,
        // Diagnostic: of everyone who left, the share who never cleared probation.
        // Independent of headcount growth. null (not NaN) when nobody left.
        early_share_of_leavers_pct: leavers.length > 0 ? (early / leavers.length) * 100 : null,
        incomplete_window: false,
      };
    });
  }

  root.BoomerangChurn = {
    detectChurnCols, extractChurnRows, headcountAsAt, leaversBetween,
    tenureBucket, computeMonthlyChurn, computeRolling12Churn, INVOLUNTARY_RE, EXCLUDED_EMPID_RE,
  };
})(globalThis);
