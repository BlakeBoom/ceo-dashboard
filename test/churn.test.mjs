// Tests for the churn maths in /shared/churn.js. node:test + assert/strict, same
// side-effect-import + read-the-global contract as test/names.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../shared/churn.js';
const {
  detectChurnCols, extractChurnRows, headcountAsAt, leaversBetween,
  tenureBucket, computeMonthlyChurn, computeRolling12Churn, INVOLUNTARY_RE, EXCLUDED_EMPID_RE,
} = globalThis.BoomerangChurn;

// UTC date-only parser, mirroring how the dashboard/tests treat Zoho dates.
const pd = (s) => { if (!s) return null; const d = new Date(String(s) + 'T00:00:00Z'); return isNaN(+d) ? null : d; };
// Build a churn row directly (compute helpers take these arrays).
const row = (join, exit, reason = '', slug = 'beer52') =>
  ({ join: pd(join), exit: exit ? pd(exit) : null, reason, status: '', contractType: '', campaignSlug: slug });

// ── headcountAsAt ────────────────────────────────────────────────────────────
test('headcount excludes people who joined after the date', () => {
  const rows = [row('2025-01-01', null)];
  assert.equal(headcountAsAt(rows, pd('2024-06-01')), 0);
});
test('headcount includes someone who left after the date but was employed on it', () => {
  const rows = [row('2024-01-01', '2025-06-01')];
  assert.equal(headcountAsAt(rows, pd('2025-03-01')), 1);
});
test('headcount excludes someone who left before the date', () => {
  const rows = [row('2024-01-01', '2025-06-01')];
  assert.equal(headcountAsAt(rows, pd('2025-08-01')), 0);
});

// ── leaversBetween ───────────────────────────────────────────────────────────
test('a leaver on the exact first and exact last day of the month counts in that month', () => {
  const rows = [row('2024-01-01', '2025-03-01'), row('2024-01-01', '2025-03-31')];
  const got = leaversBetween(rows, pd('2025-03-01'), new Date(Date.UTC(2025, 3, 0, 23, 59, 59, 999)));
  assert.equal(got.length, 2);
});
test('voluntaryOnly excludes an involuntary reason and keeps a resignation', () => {
  const rows = [row('2024-01-01', '2025-05-01', 'Resignation'), row('2024-01-01', '2025-05-02', 'Dismissal — misconduct')];
  const start = pd('2025-01-01'), end = new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999));
  assert.equal(leaversBetween(rows, start, end).length, 2);
  assert.equal(leaversBetween(rows, start, end, { voluntaryOnly: true }).length, 1);
  assert.match('Dismissal — misconduct', INVOLUNTARY_RE);
});

// ── computeRolling12Churn: window bounds ────────────────────────────────────
test('rolling window spans exactly 12 calendar months inclusive of M', () => {
  const rows = [
    row('2020-01-01', null),          // anchor: keeps dataStart early + headcount > 0
    row('2024-06-01', '2024-12-30'),  // 12mo + 1 day before window end → EXCLUDED
    row('2024-06-01', '2025-01-31'),  // within window (11 months before end) → INCLUDED
  ];
  const [r] = computeRolling12Churn(rows, ['2025-12']);
  assert.equal(r.incomplete_window, false);
  assert.equal(r.leavers, 1);        // only the in-window exit
});

// ── computeRolling12Churn: measured, not extrapolated ───────────────────────
test('rolling churn on a flat-headcount fixture is leavers / constant HC (direct, not ×12)', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row('2020-01-01', null));          // 10 permanents
  // 3 leavers, each replaced same-day so month-end headcount stays flat at 13.
  for (const ex of ['2025-03-15', '2025-06-15', '2025-09-15']) {
    rows.push(row('2020-01-01', ex));   // leaver (joined before window)
    rows.push(row(ex, null));           // same-day replacement
  }
  const [r] = computeRolling12Churn(rows, ['2025-12']);
  assert.equal(r.avgHC, 13, 'headcount is flat at 13 across all 12 month-ends');
  const monthlyLeavers = computeMonthlyChurn(rows, [
    '2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12',
  ]).reduce((a, m) => a + m.leavers, 0);
  assert.equal(monthlyLeavers, 3);
  assert.ok(Math.abs(r.churn_annual_pct - (3 / 13) * 100) < 1e-9);
});
test('rolling stays far below a spiky month annualised by ×12', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(row('2020-01-01', null));         // HC 100
  for (let i = 0; i < 20; i++) rows.push(row('2020-01-01', '2025-06-15'));  // 20 leave in one month, unreplaced
  const spikyMonth = computeMonthlyChurn(rows, ['2025-06'])[0];
  const [r] = computeRolling12Churn(rows, ['2025-12']);
  assert.ok(spikyMonth.churn_pct * 12 > 200, `spiky ×12 should be huge, got ${spikyMonth.churn_pct * 12}`);
  assert.ok(r.churn_annual_pct < spikyMonth.churn_pct * 12 / 3, `rolling ${r.churn_annual_pct} should be far below ×12 ${spikyMonth.churn_pct * 12}`);
});

// ── computeRolling12Churn: guards ───────────────────────────────────────────
test('avgHC of 0 yields null across every derived field, not 0 or Infinity', () => {
  const rows = [row('2020-01-01', '2021-01-01')];   // joined before window, but gone by 2025
  const [r] = computeRolling12Churn(rows, ['2025-12']);
  assert.equal(r.avgHC, 0);
  for (const k of ['churn_annual_pct', 'retention_annual_pct', 'churn_early_pct', 'churn_established_pct', 'early_share_of_leavers_pct']) {
    assert.equal(r[k], null, `${k} should be null`);
  }
});
test('a window starting before the earliest join returns null + incomplete_window', () => {
  const rows = [row('2025-06-01', null)];   // earliest join is inside 2025 → 2025-12 window starts before it
  const [r] = computeRolling12Churn(rows, ['2025-12']);
  assert.equal(r.churn_annual_pct, null);
  assert.equal(r.incomplete_window, true);
});

// ── tenure decomposition ────────────────────────────────────────────────────
test('churn_early_pct + churn_established_pct === churn_annual_pct (shared denominator)', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row('2020-01-01', null));
  rows.push(row('2025-01-01', '2025-02-15'));   // early (left <3mo)
  rows.push(row('2020-01-01', '2025-05-01'));   // established
  const [r] = computeRolling12Churn(rows, ['2025-12']);
  assert.ok(Math.abs((r.churn_early_pct + r.churn_established_pct) - r.churn_annual_pct) < 1e-9);
});
test('early_share_of_leavers_pct is null (not NaN) when no leavers in the window', () => {
  const rows = [row('2020-01-01', null), row('2020-01-01', null)];
  const [r] = computeRolling12Churn(rows, ['2025-12']);
  assert.equal(r.churn_annual_pct, 0);          // avgHC > 0, zero leavers → 0, not null
  assert.equal(r.early_share_of_leavers_pct, null);
  assert.ok(!Number.isNaN(r.early_share_of_leavers_pct));
});

// ── tenureBucket ─────────────────────────────────────────────────────────────
test('tenureBucket: day before 3mo anniversary early, on anniversary established', () => {
  assert.equal(tenureBucket(pd('2025-01-15'), pd('2025-04-14')), 'early');
  assert.equal(tenureBucket(pd('2025-01-15'), pd('2025-04-15')), 'established');
});
test('tenureBucket: month-end anniversary edge (joined 31 Jan)', () => {
  assert.equal(tenureBucket(pd('2025-01-31'), pd('2025-04-30')), 'established');  // anniversary clamps to 30 Apr
  assert.equal(tenureBucket(pd('2025-01-31'), pd('2025-04-29')), 'early');
});

// ── detectChurnCols / extractChurnRows ──────────────────────────────────────
test('detectChurnCols returns null when the exit column is absent', () => {
  assert.equal(detectChurnCols([{ 'Group Joining Date': '2024-01-01', 'Reason for exit': 'x' }]), null);
});
test('detectChurnCols finds the exit column by normalised key', () => {
  const cols = detectChurnCols([{ 'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '' }]);
  assert.ok(cols);
  assert.equal(cols.exit, 'Date of exit (Last Day of Employment)');
  assert.equal(cols.join, 'Group Joining Date');
});
test('extractChurnRows drops rows with no join date rather than defaulting to epoch', () => {
  const emp = [
    { 'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '', _campaign_slug: 'beer52' },
    { 'Group Joining Date': '',           'Date of exit (Last Day of Employment)': '2025-01-01', _campaign_slug: 'beer52' },
  ];
  const got = extractChurnRows(emp, pd);
  assert.equal(got.length, 1);
  assert.equal(+got[0].join, +pd('2024-01-01'));
  assert.notEqual(+got[0].join, 0);   // not epoch
});
test('extractChurnRows drops non-campaign rows by default, keeps them when campaignOnly:false', () => {
  const emp = [
    { 'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '', _campaign_slug: 'beer52' },
    { 'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '', _campaign_slug: null },
  ];
  assert.equal(extractChurnRows(emp, pd).length, 1);
  assert.equal(extractChurnRows(emp, pd, { campaignOnly: false }).length, 2);
});
test('extractChurnRows excludes HRM-prefixed Employee IDs (numerator and denominator)', () => {
  const emp = [
    { 'Employee ID': '1302',    'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '',           _campaign_slug: 'beer52' },
    { 'Employee ID': 'HRM045',  'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '2025-06-01', _campaign_slug: 'beer52' }, // a leaver, but HR staff
    { 'Employee ID': 'hrm099',  'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '',           _campaign_slug: 'beer52' }, // case-insensitive
  ];
  const got = extractChurnRows(emp, pd);
  assert.equal(got.length, 1);                 // only the real agent survives
  assert.equal(got[0].empId, '1302');
  assert.match('HRM045', EXCLUDED_EMPID_RE);
  assert.doesNotMatch('CHRM1', EXCLUDED_EMPID_RE);   // must be a PREFIX, not a substring
});
test('detectChurnCols finds the Employee ID column by normalised key', () => {
  const cols = detectChurnCols([{ 'Employee ID': '1302', 'Group Joining Date': '2024-01-01', 'Date of exit (Last Day of Employment)': '' }]);
  assert.equal(cols.empId, 'Employee ID');
});
