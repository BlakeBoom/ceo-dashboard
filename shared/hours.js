// Hours-sourcing rule (Phase 8): billable — and every hours / attendance figure —
// may come ONLY from AttendanceUserReport, never from User_metrics_3. This module
// holds the one pure decision that enforces it at aggregation time, so the rule is
// unit-testable and cannot be quietly reverted by editing a literal in rollup().
//
// Same no-import/export IIFE contract as /shared/names.js and /shared/churn.js: it
// loads as a browser classic <script> (reading globalThis.BoomerangHours) and as a
// server side-effect ESM import. Do NOT add import/export.
(function (root) {
  // The billable seed for a metrics bucket built from User_metrics_3 rows. ALWAYS
  // null: applyShiftBillable() fills it from AttendanceUserReport later where a
  // bucket exists; with no attendance it STAYS null, which renders "—" and is
  // skipped by the scorers. It deliberately ignores any billable_hours / billable
  // column on the rows — those are not a valid source of hours and must never be
  // displayed, aggregated, or silently substituted. Returning 0 instead would read
  // as a real, catastrophic figure and turn every campaign red.
  function seedBillableFromMetrics(_rows) { return null; }

  root.BoomerangHours = { seedBillableFromMetrics };
})(globalThis);
