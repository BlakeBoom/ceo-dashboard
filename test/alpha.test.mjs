// Alpha WFM attendance adapter (/shared/alpha.js): converts Alpha wfm_attendance
// rows into the AttendanceUserReport shape and merges them with Zoho attendance
// without double counting. Fixtures are synthetic — modelled on the real export's
// columns and quirks, with no real names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../shared/names.js';
import '../shared/alpha.js';
const { shiftToCampaign, detectEmpNoCol } = globalThis.BoomerangNames;
const { alphaToAttendanceRows, mergeAttendanceSources, buildEmpNoToPeopleId, synthShift, dateKey } = globalThis.BoomerangAlpha;

const base = {
  Workgroup: 'PICKnPAY', ShiftDate: '2026-10-21', ShiftStart: '2026-10-21 08:00:00', ShiftEnd: '2026-10-21 17:00:00',
  ShiftType: 'Normal', ShiftStatus: 'Complete', EmployeeId: '1001', UserId: '9001', FullName: 'Test Agent',
  Role: 'Team member', Status: 'CheckedOut', WorkHours: '8.5', PayableHours: '8.5', BillableHours: '8',
  LunchBreak: '0.5', TeaBreak: '0.5',
};
const row = (o) => ({ ...base, ...o });

test('worked shift: billable = Alpha BillableHours (payable minus the paid tea break; lunch already out)', () => {
  const { rows } = alphaToAttendanceRows([row({})], { today: '2026-11-06' });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r._billableMins, 480);              // 8h: tea is payable to the employee, not billable
  assert.equal(r['Payable Hours (Mins)'], 510);
  // Same answer the Zoho formula (Payable − Unpaid − Paid) gives on this row.
  assert.equal(r['Payable Hours (Mins)'] - r['Unpaid Break (Mins)'] - r['Paid Break (Mins)'], r._billableMins);
  assert.equal(r['Unpaid Break (Mins)'], 0);       // lunch is already out of Payable
  assert.equal(r['Paid Break (Mins)'], 30);
  assert.equal(r.Status, 'Present');
  assert.equal(r.Date, '2026-10-21');
});

test('paid-leave day carries PayableHours but bills nothing', () => {
  const { rows } = alphaToAttendanceRows([row({
    ShiftType: 'Leave', Status: 'Annual Leave', ShiftStart: '2026-10-21 00:00:00', ShiftEnd: '2026-10-21 00:00:00',
    WorkHours: '0', PayableHours: '8', BillableHours: '0', LunchBreak: '0', TeaBreak: '0', Role: '',
  })], { today: '2026-11-06' });
  assert.equal(rows[0]._billableMins, 0);
  assert.equal(rows[0]['Payable Hours (Mins)'], 480);   // still paid → planned shrinkage
  assert.equal(rows[0].Shift, 'PICKnPAY Leave');
  assert.equal(rows[0].Status, 'Annual Leave');
});

test('scheduled (Allocated/Pending) and future-dated shifts are not actuals', () => {
  const { rows, stats } = alphaToAttendanceRows([
    row({ ShiftStatus: 'Allocated', Status: 'Pending' }),
    row({ ShiftStatus: 'Pending', Status: 'Pending' }),
    row({ ShiftDate: '2026-11-20', ShiftStatus: 'Complete' }),
    row({ ShiftStatus: 'In progress', Status: 'CheckedIn' }),
  ], { today: '2026-11-06' });
  assert.equal(rows.length, 1);                    // only the in-progress shift
  assert.equal(stats.notActual, 2);
  assert.equal(stats.future, 1);
  assert.equal(rows[0].Status, 'Present');
});

test('status mapping: carry-forward annual → Annual Leave; FRL → Family Responsibility; ILO kept; unknown passes through', () => {
  const { rows } = alphaToAttendanceRows([
    row({ Status: 'Carry Forward Annual Leave' }),
    row({ Status: 'Family Responsibility Leave' }),
    row({ Status: 'Maternity Leave' }),
    row({ Status: 'ILO Leave' }),
    row({ Status: 'Something New' }),
  ], { today: '2026-11-06' });
  assert.deepEqual(rows.map(r => r.Status), ['Annual Leave', 'Family Responsibility', 'Maternity Leave', 'ILO Leave', 'Something New']);
  // None of these worked, so none bill — even though the fixture carries hours.
  assert.ok(rows.every(r => r._billableMins === 0));
});

test('synthesized shift names attribute to the right campaign and carry the role word', () => {
  assert.equal(shiftToCampaign(synthShift(row({}))), 'PICKNPAY');
  assert.equal(shiftToCampaign(synthShift(row({ Workgroup: 'Lint Bells' }))), 'VETNIQUE');
  assert.equal(shiftToCampaign(synthShift(row({ Workgroup: 'Pinter' }))), 'PINTER');
  assert.equal(synthShift(row({ Role: 'Team Leader' })), 'PICKnPAY Team Leader (08:00 - 17:00)');
  assert.equal(synthShift(row({ Role: 'Campaign Manager' })), 'PICKnPAY Campaign Manager (08:00 - 17:00)');
  assert.equal(synthShift(row({ Role: 'Team member' })), 'PICKnPAY (08:00 - 17:00)');
});

test('HR employee number → People ID via EmployeeProfile; unmatched kept as alpha:<no> with the Alpha name', () => {
  const emp = [
    { ID: 'P-OLD', 'Employee ID': '1001', 'Employee Status': 'Terminated', 'Employee Name': 'Test Agent' },
    { ID: 'P-NEW', 'Employee ID': '1001', 'Employee Status': 'Active',     'Employee Name': 'Test Agent' },
  ];
  const map = buildEmpNoToPeopleId(emp, detectEmpNoCol);
  assert.equal(map.get('1001'), 'P-NEW');          // Active record preferred
  const { rows, stats } = alphaToAttendanceRows([row({}), row({ EmployeeId: '2002', FullName: 'Not In HR' })],
    { empNoToPeopleId: map, today: '2026-11-06' });
  assert.equal(rows[0].Employee, 'P-NEW');
  assert.equal(rows[1].Employee, 'alpha:2002');
  assert.equal(rows[1]['Employee Name'], 'Not In HR');
  assert.equal(stats.unmappedPeople, 1);
});

test('merge: Alpha wins per campaign-day; other days and other campaigns keep their Zoho rows', () => {
  const { rows: alpha } = alphaToAttendanceRows([row({})], { today: '2026-11-06' });
  const zoho = [
    { Shift: 'Pick n Pay Day Shift', Date: '21-Oct-26' },   // same campaign + day → dropped
    { Shift: 'Pick n Pay Day Shift', Date: '2026-09-01' },  // before the move → kept
    { Shift: 'MedExpress Day Shift', Date: '2026-10-21' },  // other campaign → kept
    { Shift: 'Office Admin',         Date: '2026-10-21' },  // no campaign → kept
  ];
  const m = mergeAttendanceSources(zoho, alpha, shiftToCampaign);
  assert.equal(m.droppedZoho, 1);
  assert.equal(m.rows.length, 4);                  // 3 Zoho + 1 Alpha
  assert.ok(!m.rows.some(r => r.Date === '21-Oct-26'));
});

test('dateKey normalises the attendance date formats', () => {
  assert.equal(dateKey('2026-10-21'), '2026-10-21');
  assert.equal(dateKey('2026-10-21 08:00:00'), '2026-10-21');
  assert.equal(dateKey('4-Jun-26'), '2026-06-04');
  assert.equal(dateKey('21/10/2026'), '2026-10-21');
  assert.equal(dateKey('garbage'), null);
});
