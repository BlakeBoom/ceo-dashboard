// Alpha WFM attendance → dashboard attendance rows.
//
// Some campaigns (PICKnPAY, Pinter, Lint Bells) are now scheduled in Alpha, not
// Zoho People, so their shifts never reach Zoho's AttendanceUserReport. Alpha's
// wfm_attendance table is synced into the same Zoho Analytics workspace as the
// other feeds and fetched as the "AlphaAttendance" view. This module converts its
// rows into the SAME shape as AttendanceUserReport rows, so every downstream step
// (billable by shift, shrinkage, absence, headcount, matching, scoping) runs
// unchanged on them — no second code path to drift.
//
// Same no-import/export IIFE contract as /shared/names.js: works as a browser
// classic <script> and as a server side-effect ESM import (globalThis.BoomerangAlpha).
(function (root) {
  // Alpha Status → the Zoho attendance Status vocabulary the dashboard classifies
  // (SHRINKAGE_STATUS + absenceFraction in index.html). Unlisted statuses pass
  // through unchanged, which surfaces them in the "unclassified status" warning
  // rather than silently mis-bucketing them.
  const ALPHA_STATUS_MAP = {
    'CheckedOut':                  'Present',
    'CheckedIn':                   'Present',
    'Absent':                      'Absent',
    'Annual Leave':                'Annual Leave',
    'Carry Forward Annual Leave':  'Annual Leave',
    'Sick Leave':                  'Sick Leave',
    'Unpaid Leave':                'Unpaid Leave',
    'Maternity Leave':             'Maternity Leave',
    'Paternity Leave':             'Paternity Leave',
    'Parental Leave':              'Parental Leave',
    'Family Responsibility Leave': 'Family Responsibility',
    'ILO Leave':                   'ILO Leave',   // classified like Annual Leave in index.html
  };

  // Only shifts that have actually happened count. Allocated / Pending are future
  // schedule (they even carry PayableHours for pre-booked leave), so including them
  // would inflate hours and HC with time nobody has worked yet.
  const ACTUAL_SHIFT_STATUS = new Set(['Complete', 'In progress']);

  // Attendance statuses that mean the person actually worked the shift (and so it
  // can bill). Everything else — leave, absent, pending — bills nothing.
  const WORKED_STATUS = new Set(['CheckedOut', 'CheckedIn']);

  // Alpha's Role column → the role words detectRole() reads from a Shift name, so
  // per-campaign role billability (Targets sbr_/nbr_ rules) applies exactly as it
  // does to Zoho shifts. "Team member" is a front-line agent (no word needed).
  const ROLE_WORD = {
    'team leader':      'Team Leader',
    'campaign manager': 'Campaign Manager',
    'trainer':          'Trainer',
  };

  const num = (v) => { const n = +v; return Number.isFinite(n) ? n : 0; };
  const mins = (hrs) => Math.round(num(hrs) * 60);

  // 'YYYY-MM-DD hh:mm:ss' → 'hh:mm' (or null for the 00:00–00:00 leave placeholder).
  function hhmm(ts) {
    const m = String(ts ?? '').match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : null;
  }

  // Build the synthetic Shift name: "<Workgroup>[ <Role>] (hh:mm - hh:mm)" for a
  // worked shift, "<Workgroup> Leave" for a leave day. It carries the workgroup so
  // the shift→campaign rules attribute it to the right campaign, and the role word
  // so detectRole() sees TLs / CMs / trainers.
  function synthShift(r) {
    const wg = String(r.Workgroup ?? '').trim();
    if (!wg) return '';
    if (String(r.ShiftType) === 'Leave') return `${wg} Leave`;
    const role = ROLE_WORD[String(r.Role ?? '').trim().toLowerCase()];
    const s = hhmm(r.ShiftStart), e = hhmm(r.ShiftEnd);
    const times = (s && e && !(s === '00:00' && e === '00:00')) ? ` (${s} - ${e})` : '';
    return `${wg}${role ? ' ' + role : ''}${times}`;
  }

  // Convert Alpha wfm_attendance rows to AttendanceUserReport-shaped rows.
  //   empNoToPeopleId: Map(HR employee number → Zoho People ID), from EmployeeProfile.
  //     Alpha keys people by HR number (EmployeeId); the rest of the pipeline keys
  //     attendance by People ID, so map it and Alpha rows are indistinguishable from
  //     Zoho rows downstream (same matcher, same Unassigned naming, same scoping).
  //     An HR number with no profile record becomes "alpha:<HR no>" — still counted,
  //     and named via 'Employee Name' if it lands in Unassigned.
  //   today: 'YYYY-MM-DD' upper bound (rows dated after it are schedule, not actuals).
  // Returns { rows, stats }.
  function alphaToAttendanceRows(alphaRows, { empNoToPeopleId = null, today = null } = {}) {
    const stats = { input: 0, kept: 0, future: 0, notActual: 0, noWorkgroup: 0, unmappedPeople: 0, byWorkgroup: {} };
    const out = [];
    for (const r of (alphaRows || [])) {
      stats.input++;
      if (!ACTUAL_SHIFT_STATUS.has(String(r.ShiftStatus ?? '').trim())) { stats.notActual++; continue; }
      const date = String(r.ShiftDate ?? '').slice(0, 10);
      if (today && date > today) { stats.future++; continue; }
      const shift = synthShift(r);
      if (!shift) { stats.noWorkgroup++; continue; }
      const empNo = String(r.EmployeeId ?? '').trim();
      let peopleId = empNo && empNoToPeopleId ? empNoToPeopleId.get(empNo) : null;
      if (!peopleId) { stats.unmappedPeople++; peopleId = `alpha:${empNo || r.UserId || r.ShiftPersonId}`; }
      const status = String(r.Status ?? '').trim();
      const worked = WORKED_STATUS.has(status);
      out.push({
        'Employee':            String(peopleId),
        'Employee Name':       String(r.FullName ?? '').trim(),
        'Date':                date,
        'Shift':               shift,
        'Status':              ALPHA_STATUS_MAP[status] || status,
        // Alpha's PayableHours is ALREADY net of the unpaid lunch (a 9h 08:00–17:00
        // shift pays 8.5), so the lunch is not reported again as an unpaid break —
        // doing so would deduct it twice from billable and count it as shrinkage of
        // time that was never paid. Kept separately in _lunchMins for reference.
        'Payable Hours (Mins)': mins(r.PayableHours),
        'Unpaid Break (Mins)':  0,
        'Paid Break (Mins)':    mins(r.TeaBreak),     // tea breaks are paid → planned shrinkage
        'Total Hours (Mins)':   mins(r.WorkHours),
        // Billable = Alpha's own BillableHours: PayableHours (already net of the
        // unpaid lunch) minus the paid tea break — tea is payable to the employee
        // but not billable to the client, the same rule the dashboard applies to
        // Zoho rows (Payable − Unpaid − Paid). Leave, absent and other non-worked
        // days bill nothing even when PayableHours carries paid leave — hence an
        // explicit billable rather than a formula over the break columns.
        _billableMins:          worked ? mins(r.BillableHours) : 0,
        _lunchMins:             mins(r.LunchBreak),
        _source:                'alpha',
        _alphaEmpNo:            empNo,
        _alphaWorkgroup:        String(r.Workgroup ?? '').trim(),
      });
      stats.kept++;
      const wg = String(r.Workgroup ?? '').trim();
      stats.byWorkgroup[wg] = (stats.byWorkgroup[wg] || 0) + 1;
    }
    return { rows: out, stats };
  }

  // Normalise the attendance Date formats the dashboard sees ("2026-10-21",
  // "21-Oct-26", "21/10/2026") to 'YYYY-MM-DD', or null.
  const _MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function dateKey(v) {
    const s = String(v ?? '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const pad = (n) => String(n).padStart(2, '0');
    m = s.match(/^(\d{1,2})-([a-z]{3})-(\d{2,4})$/i);
    if (m && _MON[m[2].toLowerCase()]) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(_MON[m[2].toLowerCase()])}-${pad(+m[1])}`; }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(+m[2])}-${pad(+m[1])}`; }
    return null;
  }

  // Combine Zoho and (converted) Alpha attendance without double counting. Source
  // precedence is per CAMPAIGN-DAY: wherever Alpha has rows for a campaign on a
  // date, Alpha is that day's source of truth and any Zoho rows for the same
  // campaign + date are dropped. Days Alpha doesn't cover keep their Zoho rows, so
  // history from before a campaign moved to Alpha stays intact and the cutover
  // needs no configured date. `toCampaign` is the shift→campaign resolver
  // (BoomerangNames.shiftToCampaign) so both sources are attributed identically.
  function mergeAttendanceSources(zohoRows, alphaRows, toCampaign) {
    const covered = new Set();
    for (const r of (alphaRows || [])) {
      const c = toCampaign(r['Shift']); const d = dateKey(r['Date']);
      if (c && d) covered.add(c + '|' + d);
    }
    let droppedZoho = 0;
    const kept = [];
    for (const r of (zohoRows || [])) {
      const c = toCampaign(r['Shift'] ?? r.shift ?? '');
      const d = dateKey(r['Date'] ?? r.date);
      if (c && d && covered.has(c + '|' + d)) { droppedZoho++; continue; }
      kept.push(r);
    }
    return { rows: kept.concat(alphaRows || []), droppedZoho, coveredCampaignDays: covered.size };
  }

  // HR employee number → Zoho People ID, from EmployeeProfile rows. Prefers the
  // Active record when one person has several (re-hires / duplicates), so the
  // People ID matches the one the metrics matcher resolves first.
  function buildEmpNoToPeopleId(empRows, detectEmpNoCol) {
    const map = new Map();
    const col = detectEmpNoCol ? detectEmpNoCol(empRows) : null;
    if (!col) return map;
    const statusOf = (r) => String(r['Employee Status'] ?? r.employee_status ?? '').trim().toLowerCase();
    for (const pass of ['active', 'any']) {
      for (const r of (empRows || [])) {
        if (pass === 'active' && statusOf(r) !== 'active') continue;
        const no = String(r[col] ?? '').trim();
        const id = String(r['ID'] ?? r.id ?? '').trim();
        if (no && id && !map.has(no)) map.set(no, id);
      }
    }
    return map;
  }

  root.BoomerangAlpha = {
    ALPHA_STATUS_MAP, ACTUAL_SHIFT_STATUS, WORKED_STATUS, synthShift, dateKey,
    alphaToAttendanceRows, mergeAttendanceSources, buildEmpNoToPeopleId,
  };
})(globalThis);
