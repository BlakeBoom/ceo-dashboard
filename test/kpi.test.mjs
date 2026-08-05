// Tests for the KPI scoring helpers (rag / overallRag / agentScore) and the two
// derived KPIs (fulfilPct / realisationPct) that Phase 7 moved into
// /shared/names.js so they'd be unit-testable. Run with `npm test`.
//
// New file (not appended to names.test.mjs) because this is a distinct concern —
// commercial KPI scoring, not name normalisation — and keeping it separate makes
// the regression guard on rag() easy to find.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Side-effect import + read the global — the same no-export contract the browser
// and server use for this file.
import '../shared/names.js';
const { rag, overallRag, agentScore, fulfilPct, realisationPct, CUMULATIVE_KPIS } = globalThis.BoomerangNames;

// ── rag(): byte-for-byte behaviour regression guard ─────────────────────────
// Phase 7 must not modify rag(). These pin its exact bands so any accidental
// change (e.g. reintroducing a per-KPI override) fails loudly.
test('rag: null / NaN / no-target / none-direction all grey', () => {
  assert.equal(rag(null, 90, 'higher'), 'grey');
  assert.equal(rag(NaN, 90, 'higher'), 'grey');
  assert.equal(rag(90, null, 'higher'), 'grey');
  assert.equal(rag(90, 90, 'none'), 'grey');
});
test('rag: higher-is-better bands are green>=tgt, amber>=95% of tgt, else red', () => {
  assert.equal(rag(100, 100, 'higher'), 'green');
  assert.equal(rag(95, 100, 'higher'), 'amber');   // exactly 95% of target
  assert.equal(rag(96, 100, 'higher'), 'amber');
  assert.equal(rag(94.9, 100, 'higher'), 'red');
});
test('rag: lower-is-better bands are green<=tgt, amber<=110% of tgt, else red', () => {
  assert.equal(rag(5, 5, 'lower'), 'green');
  assert.equal(rag(5.5, 5, 'lower'), 'amber');     // exactly 110% of target
  assert.equal(rag(5.6, 5, 'lower'), 'red');
});

// ── Realisation scored against a target of 90 via rag()'s standard bands ─────
// green >= 90, amber >= 85.5 (95% of 90), red below — NO per-KPI override.
test('realisation vs target 90: 92 green, 87 amber, 84 red', () => {
  assert.equal(rag(92, 90, 'higher'), 'green');
  assert.equal(rag(87, 90, 'higher'), 'amber');    // 87 >= 85.5
  assert.equal(rag(84, 90, 'higher'), 'red');      // 84 < 85.5
});

// ── overallRag: no double-discount of fulfil on a partial period ────────────
test('overallRag does NOT pro-rate fulfil on a partial period', () => {
  const cfg = [['fulfil', 'Fulfil', 'higher']];
  const tgts = { fulfil: 100 };
  // fulfil is already a rate off a pro-rated denominator. At 96% it is amber.
  // If overallRag wrongly scaled the target by frac (0.5 → 50), 96 would read green.
  assert.equal(overallRag({ fulfil: 96 }, tgts, cfg, 0.5), 'amber');
  assert.equal(overallRag({ fulfil: 96 }, tgts, cfg, 1), 'amber');   // same at frac=1
  assert.ok(!CUMULATIVE_KPIS.has('fulfil'), 'fulfil must not be a cumulative KPI');
  assert.ok(!CUMULATIVE_KPIS.has('realisation'), 'realisation must not be a cumulative KPI');
});
test('overallRag DOES pro-rate a genuinely cumulative KPI (contrast)', () => {
  const cfg = [['sales', 'Sales', 'higher']];
  const tgts = { sales: 100 };
  // 60 sales at 50% elapsed clears the pro-rated target (50) → green, though it
  // would be red against the full-period target.
  assert.equal(overallRag({ sales: 60 }, tgts, cfg, 0.5), 'green');
  assert.equal(overallRag({ sales: 60 }, tgts, cfg, 1), 'red');
});

// ── overallRag: 'none' when nothing is scorable (existing behaviour) ─────────
test("overallRag returns 'none' when every KPI is null", () => {
  const cfg = [['qa', 'QA', 'higher'], ['realisation', 'Realisation', 'higher']];
  assert.equal(overallRag({}, { qa: 90, realisation: 90 }, cfg), 'none');
  assert.equal(overallRag({ qa: null, realisation: null }, { qa: 90, realisation: 90 }, cfg), 'none');
});

// ── agentScore: realisation excluded below the paid-hours threshold ─────────
test('agentScore excludes realisation for an agent flagged _noRealScore', () => {
  const cfg = [['qa', 'QA', 'higher'], ['realisation', 'Realisation', 'higher']];
  const tgts = { qa: 90, realisation: 90 };
  // Scored agent: mean of qa(90/90=1.0) and realisation(60/90=0.667) → 83.3%.
  const scored = agentScore({ qa: 90, realisation: 60 }, cfg, tgts);
  assert.ok(Math.abs(scored - 83.33) < 0.1, `expected ~83.3, got ${scored}`);
  // Below-threshold agent: realisation skipped → score is qa alone (100%).
  const unscored = agentScore({ qa: 90, realisation: 60, _noRealScore: true }, cfg, tgts);
  assert.equal(Math.round(unscored), 100);
  assert.notEqual(Math.round(scored), Math.round(unscored));
});

// ── fulfilPct: no bogus fulfil without a required-hours target ──────────────
test('fulfilPct is null without a positive required-hours target', () => {
  assert.equal(fulfilPct(300, 0), null);
  assert.equal(fulfilPct(300, null), null);
  assert.equal(fulfilPct(300, undefined), null);
  assert.equal(fulfilPct(null, 400), null);
  assert.equal(fulfilPct(300, 400), 75);
});

// ── realisationPct: billable ÷ paid, null without paid hours ────────────────
test('realisationPct = billable ÷ paid × 100, null without paid hours', () => {
  assert.equal(realisationPct(45, 60), 75);
  assert.equal(realisationPct(30, 0), null);
  assert.equal(realisationPct(30, null), null);
  assert.equal(realisationPct(null, 60), null);
});
