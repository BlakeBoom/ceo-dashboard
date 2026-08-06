// Phase 8 regression guard: billable (and every hours figure) may come ONLY from
// AttendanceUserReport, never from User_metrics_3. rollup() lives inline in
// index.html and isn't importable, so the one pure decision that enforces the rule
// — the billable seed — lives in /shared/hours.js and is asserted here. This is the
// regression that must never come back: a metrics bucket must seed billable to null,
// not the User_metrics_3 hours column and not 0.
//
// New file (not folded into kpi.test.mjs) because it guards a distinct rule —
// hours-sourcing, not KPI scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../shared/hours.js';
const { seedBillableFromMetrics } = globalThis.BoomerangHours;

test('metrics rows carrying billable_hours seed billable === null (not the value, not 0)', () => {
  const rows = [{ billable_hours: 5000, billable: 5000 }, { billable_hours: 1200 }];
  const v = seedBillableFromMetrics(rows);
  assert.equal(v, null);
  assert.notEqual(v, 0);
  assert.notEqual(v, 6200);   // never the summed User_metrics_3 hours
});

test('rows with a `billable` column (the other fallback) also seed null', () => {
  assert.equal(seedBillableFromMetrics([{ billable: 999 }]), null);
});

test('no billable columns at all still seeds null, never 0', () => {
  assert.equal(seedBillableFromMetrics([{ calls: 10, qa: 90 }]), null);
  assert.equal(seedBillableFromMetrics([]), null);
});
