// Tests for the pure Department→campaign resolution that the /api/zoho
// EmployeeProfile route uses to attribute churn. No network: the id→text map is
// passed in, exactly as the route builds it from the companion views.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// provision.js eagerly imports db.js (constructs a pg Pool at module-eval), so
// set dummy env before importing — the Pool is lazy, these pure tests never open
// a connection. Same contract as test/names.test.mjs.
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-not-used';
const { resolveDeptCampaign } = await import('../server/src/provision.js');

// A stand-in for the merged Campaign+Divisions map (lookup id → resolved text).
const MAP = new Map([
  ['610962000000000001', 'Beer52'],              // a client campaign
  ['610962000000000002', 'Human Resources'],     // an internal support function
  ['610962000000000003', 'RoyalCanin'],          // another client campaign
]);

test('a lookup id naming a campaign resolves to that campaign slug', () => {
  const r = resolveDeptCampaign('610962000000000001', MAP);
  assert.equal(r.slug, 'beer52');
  assert.equal(r.name, 'Beer52');
  assert.equal(r.status, 'campaign');
});

test('a lookup id naming an internal department resolves to null', () => {
  const r = resolveDeptCampaign('610962000000000002', MAP);
  assert.equal(r.slug, null);
  assert.equal(r.name, null);
  assert.equal(r.status, 'internal');
});

test('a lookup id absent from the map resolves to null (unresolved)', () => {
  const r = resolveDeptCampaign('610962000000000999', MAP);
  assert.equal(r.slug, null);
  assert.equal(r.name, null);
  assert.equal(r.status, 'unresolved');
});

test('a blank department resolves to null (blank)', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const r = resolveDeptCampaign(blank, MAP);
    assert.equal(r.slug, null, `blank input ${JSON.stringify(blank)}`);
    assert.equal(r.status, 'blank');
  }
});
