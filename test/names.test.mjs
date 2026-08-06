// Tests for the shared name helpers (/shared/names.js) and the pure mapping
// helpers in provision.js. Run with `npm test` (node's built-in runner, no deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// /shared/names.js has no exports by design (it must double as a browser
// <script>), so import it for its side effect and read the global — the same
// contract the browser and the server modules use.
import '../shared/names.js';
const { normalizeName, firstLastKey, stripKnownNameSuffix, buildTeamCanonMap, titleToRole, looksLikeLookupId,
        buildRoleIndexFromUsers, resolveTeamNode, unassignedShare,
        shiftToCampaign, shiftCampaignKeys } = globalThis.BoomerangNames;
const UNASSIGNED = '— Unassigned';

// provision.js eagerly imports db.js, which reads env vars at module-eval and
// constructs a pg Pool. Set dummy env BEFORE the dynamic import so eval doesn't
// throw; the Pool is lazy, so these pure-function tests never open a connection.
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-not-used';
const { canonicalCampaign, jobTitleToRole, emailLocalPart, campaignSlug } =
  await import('../server/src/provision.js');

// ── normalizeName ───────────────────────────────────────────────────────────
test('normalizeName: empty-ish inputs all return null', () => {
  assert.equal(normalizeName(null), null);
  assert.equal(normalizeName(undefined), null);
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName('   '), null);       // whitespace only
  assert.equal(normalizeName('!!!'), null);       // punctuation only → empty after strip
});

test('normalizeName: lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalizeName('  John   SMITH '), 'john smith');
  assert.equal(normalizeName("O'Brien-Smith"), 'obriensmith');
  assert.equal(normalizeName('Anne-Marie  de  Vries'), 'annemarie de vries');
});

test('normalizeName: accents are stripped, not transliterated (documented lossy behaviour)', () => {
  assert.equal(normalizeName('José'), 'jos');            // é removed, not → e
  assert.equal(normalizeName('Renée O’Brien'), 'rene obrien');
});

// ── firstLastKey ────────────────────────────────────────────────────────────
test('firstLastKey: one token → null, two/three tokens → first + last', () => {
  assert.equal(firstLastKey('Cher'), null);                     // single token
  assert.equal(firstLastKey('John Smith'), 'john smith');       // two tokens
  assert.equal(firstLastKey('john michael smith'), 'john smith'); // middle dropped
  assert.equal(firstLastKey(''), null);
  assert.equal(firstLastKey(null), null);
});

// ── stripKnownNameSuffix ────────────────────────────────────────────────────
test('stripKnownNameSuffix: drops a trailing parenthetical, keeps case', () => {
  assert.equal(stripKnownNameSuffix('John Smith (MedExpress)'), 'John Smith');
  assert.equal(stripKnownNameSuffix('John Smith'), 'John Smith');   // no suffix → unchanged
  assert.equal(stripKnownNameSuffix(null), null);
});

// ── buildTeamCanonMap ───────────────────────────────────────────────────────
test('buildTeamCanonMap: folds first-name-only spelling into the full name', () => {
  const canon = buildTeamCanonMap(["Elzette's team", "Elzette Saaiman's team"]);
  assert.equal(canon.get("Elzette's team"), "Elzette Saaiman's team");
  assert.equal(canon.get("Elzette Saaiman's team"), "Elzette Saaiman's team");
});

test('buildTeamCanonMap: two DIFFERENT leaders sharing a first name are NOT merged', () => {
  const canon = buildTeamCanonMap(["Sarah Jones's team", "Sarah Adams's team"]);
  // Each maps to itself, never to the other — fusing them would move a whole
  // team under the wrong leader.
  assert.equal(canon.get("Sarah Jones's team"), "Sarah Jones's team");
  assert.equal(canon.get("Sarah Adams's team"), "Sarah Adams's team");
  assert.notEqual(canon.get("Sarah Jones's team"), "Sarah Adams's team");
});

test('buildTeamCanonMap: skip sentinel is excluded from the map', () => {
  const canon = buildTeamCanonMap(
    ['— Unassigned', "Elzette's team", "Elzette Saaiman's team"],
    { skip: '— Unassigned' }
  );
  assert.equal(canon.has('— Unassigned'), false);
  assert.equal(canon.get("Elzette's team"), "Elzette Saaiman's team");
});

// ── provision.js pure helpers (the "(unit-tested)" claim at provision.js:25) ──
test('jobTitleToRole: seniority order, case-insensitive, defaults to agent', () => {
  assert.equal(jobTitleToRole('Campaign Manager'), 'campaign_lead');
  assert.equal(jobTitleToRole('Senior Team Leader'), 'tm');
  assert.equal(jobTitleToRole('Shift Leader'), 'tm');
  assert.equal(jobTitleToRole('Customer Service Agent'), 'agent');
  assert.equal(jobTitleToRole(null), 'agent');
});

test('canonicalCampaign: casing/spacing variants collapse to fixed slugs', () => {
  assert.deepEqual(canonicalCampaign('PICKnPAY'), { name: 'PicknPay', slug: 'picknpay' });
  assert.deepEqual(canonicalCampaign('PicknPay'), { name: 'PicknPay', slug: 'picknpay' });
  // Butternut Box must stay 'butternutbox' (not 'butternut-box') or its data
  // would split in two — assert both aliases resolve to the fixed slug.
  assert.equal(canonicalCampaign('BBOX').slug, 'butternutbox');
  assert.equal(canonicalCampaign('Butternut Box').slug, 'butternutbox');
});

test('canonicalCampaign: internal departments and empty → null', () => {
  assert.equal(canonicalCampaign('Admin/Operations'), null);  // admin-prefixed
  assert.equal(canonicalCampaign('Human Resources'), null);   // internal support fn
  assert.equal(canonicalCampaign(''), null);
  assert.equal(canonicalCampaign(null), null);
});

test('canonicalCampaign: unknown workgroup becomes its own campaign', () => {
  assert.deepEqual(canonicalCampaign('Wonka Sweets'), { name: 'Wonka Sweets', slug: 'wonka-sweets' });
});

test('emailLocalPart: first.last, single token, null on empty', () => {
  assert.equal(emailLocalPart('John Michael Smith'), 'john.smith');
  assert.equal(emailLocalPart('Cher'), 'cher');
  assert.equal(emailLocalPart('   '), null);
});

test('campaignSlug: lowercased, non-alphanumerics → single hyphens, trimmed', () => {
  assert.equal(campaignSlug('The Good Life Sorted'), 'the-good-life-sorted');
  assert.equal(campaignSlug('Just Park US'), 'just-park-us');
  assert.equal(campaignSlug('  Foo!!  Bar  '), 'foo-bar');
});

// ── titleToRole (shared, canonical mapper) ──────────────────────────────────
test('titleToRole: every team-leader title variant resolves to tm', () => {
  // The variants the two former copies between them matched, incl. the bare
  // "Team Lead" that provision.js used to miss (→ agent).
  for (const t of ['Team Leader', 'Team Lead', 'Shift Leader', 'Senior Team Leader',
                   'TEAM LEADER', 'Team Leader (Beer52)']) {
    assert.equal(titleToRole(t), 'tm', `expected tm for "${t}"`);
  }
  assert.equal(titleToRole('Campaign Manager'), 'campaign_lead');
  assert.equal(titleToRole('Customer Service Agent'), 'agent');
});

test('titleToRole: the provision.jobTitleToRole export is the same shared mapper', () => {
  assert.equal(jobTitleToRole('Team Lead'), 'tm');           // was agent before consolidation
  assert.equal(jobTitleToRole('Team Leader'), 'tm');
  assert.equal(jobTitleToRole('Campaign Manager'), 'campaign_lead');
});

test('titleToRole: a lookup-id title is gated by looksLikeLookupId, not silently classified', () => {
  const id = '610962000011338364';
  // titleToRole itself has no way to know an id isn't a title — it would return
  // 'agent'. The protection is that callers MUST gate on looksLikeLookupId first
  // (buildTeamRoleIndex does, and bails to null). Assert the gate fires.
  assert.equal(looksLikeLookupId(id), true);
  assert.equal(looksLikeLookupId('Team Leader'), false);
  assert.equal(titleToRole(id), 'agent');  // documents WHY the gate is required
});

// ── buildTeamCanonMap: the TL-collapse the role-index fix relies on ──────────
test('buildTeamCanonMap: folds "Rugshana\'s team" + "Rugshana Hendricks" to one node', () => {
  // Once TLs are recognised, resolveTeamNode emits the TL's own name for their
  // row while agents keep the "<Leader>'s team" label; canon must fold both.
  const canon = buildTeamCanonMap(["Rugshana's team", "Rugshana Hendricks"]);
  assert.equal(canon.get("Rugshana's team"), 'Rugshana Hendricks');       // longest spelling wins
  assert.equal(canon.get('Rugshana Hendricks'), 'Rugshana Hendricks');
  // Exactly one canonical target → one node.
  assert.equal(new Set(canon.values()).size, 1);
});

test('buildTeamCanonMap: two different leaders sharing a first name are NOT merged', () => {
  const canon = buildTeamCanonMap(["Rugshana Hendricks", "Rugshana Adams"]);
  assert.equal(canon.get('Rugshana Hendricks'), 'Rugshana Hendricks');
  assert.equal(canon.get('Rugshana Adams'), 'Rugshana Adams');
  assert.notEqual(canon.get('Rugshana Hendricks'), canon.get('Rugshana Adams'));
});

// ── role index: the regressions that shipped with a green suite (BUGs 1–4) ───
test('BUG 1: a name with a "( ... )" suffix is findable by its clean form', () => {
  // users.full_name carries a Zoho parenthetical; lookups arrive clean from
  // User_metrics_3. Keys must be built from the stripped name on both sides.
  const idx = buildRoleIndexFromUsers([{ full_name: 'Rugshana Hendricks ( Rugshana )', role: 'tm' }]);
  assert.equal(idx.roleOf('Rugshana Hendricks'), 'tm');   // fails before the fix (was null)
  assert.equal(idx.isTL('Rugshana Hendricks'), true);
});

test('BUG 2: "Rugshana\'s team" resolves to the TL stored as "Rugshana Hendricks"', () => {
  const idx = buildRoleIndexFromUsers([
    { full_name: 'Rugshana Hendricks ( Rugshana )', role: 'tm' },
    { full_name: 'Abdul Kader ( Abdul )', role: 'agent' },
  ]);
  assert.equal(idx.resolveLeaderLabel("Rugshana's team"), 'rugshana hendricks');
  // TL's own row → their person name; an agent's row → the raw team label; canon
  // folds the two into one node (covered by the buildTeamCanonMap tests above).
  assert.equal(resolveTeamNode('Rugshana Hendricks', "Rugshana's team", idx, UNASSIGNED), 'Rugshana Hendricks');
  assert.equal(resolveTeamNode('Abdul Kader', "Rugshana's team", idx, UNASSIGNED), "Rugshana's team");
});

test('BUG 2: a curly-apostrophe "Rugshana’s team" resolves identically', () => {
  const idx = buildRoleIndexFromUsers([{ full_name: 'Rugshana Hendricks', role: 'tm' }]);
  assert.equal(idx.resolveLeaderLabel('Rugshana’s team'), 'rugshana hendricks');
  assert.equal(idx.resolveLeaderLabel("Rugshana's team"), 'rugshana hendricks');
});

test('BUG 2: two leaders sharing a first name are never fused by a team label', () => {
  const idx = buildRoleIndexFromUsers([
    { full_name: 'Rugshana Hendricks', role: 'tm' },
    { full_name: 'Rugshana Adams', role: 'tm' },
  ]);
  // Ambiguous bare first name → refused, not guessed.
  assert.equal(idx.resolveLeaderLabel("Rugshana's team"), null);
  // Full labels still resolve to the right person.
  assert.equal(idx.resolveLeaderLabel("Rugshana Adams's team"), 'rugshana adams');
});

test('BUG 4: a one-TL (scoped tm) index dumps the org to UNASSIGNED → guard trips', () => {
  const scoped = buildRoleIndexFromUsers([{ full_name: 'Solo Leader', role: 'tm' }]);
  assert.equal(scoped.tlCount, 1);   // passes the old tlCount>0 check…
  const rows = [
    ['Agent A', "Someone's team"], ['Agent B', "Another's team"],
    ['Agent C', "Third's team"],   ['Agent D', "Fourth's team"],
  ];
  const nodes = rows.map(([p, l]) => resolveTeamNode(p, l, scoped, UNASSIGNED));
  assert.ok(unassignedShare(nodes, UNASSIGNED) > 0.60);   // …but the OUTCOME guard catches it
});

test('resolveTeamNode: returns the raw leader label when the index is null', () => {
  assert.equal(resolveTeamNode('Anyone', "Rugshana's team", null, UNASSIGNED), "Rugshana's team");
  assert.equal(resolveTeamNode('Anyone', '', null, UNASSIGNED), UNASSIGNED);
});

// ── shiftToCampaign / shiftCampaignKeys (Phase 8b: shift→campaign scoping) ─────
test('shiftToCampaign maps shift text to a campaign key, else null', () => {
  assert.equal(shiftToCampaign('MedExpress Day Shift'), 'Medexpress');
  assert.equal(shiftToCampaign('JustPark Space Owner Evening'), 'JUSTPARK_usa');
  assert.equal(shiftToCampaign('Just Park UK'), 'JUSTPARK_uk');
  assert.equal(shiftToCampaign('Beer52 CS'), 'BEER52');
  assert.equal(shiftToCampaign('Office Admin'), null);
  assert.equal(shiftToCampaign(''), null);
});
test('shiftCampaignKeys returns every campaign a split shift touches', () => {
  assert.deepEqual(shiftCampaignKeys('MedExpress Day'), ['Medexpress']);
  const split = shiftCampaignKeys('HYVE (11:00-12:00) +Gousto Split Shift (12:00-20:00)');
  assert.ok(split.includes('HYVE') && split.includes('Gousto'), `got ${split}`);
  assert.deepEqual(shiftCampaignKeys('Office Admin'), []);
});

// ── buildEmpIdToUid (Phase 8c: resolve terminated/duplicate People IDs) ────────
const { buildEmpIdToUid } = globalThis.BoomerangNames;
test('buildEmpIdToUid maps active AND terminated duplicate records to the same uid', () => {
  const agents = [{ name: 'Sasha-Lee Tammy De Klerk', uid: 'u1' }];
  const emp = [
    { ID: 'ACTIVE_1', 'Employee Name': 'Sasha-Lee Tammy De Klerk', 'Employee Status': 'Active' },
    { ID: 'TERM_1',   'Employee Name': 'Sasha-Lee Tammy De Klerk', 'Employee Status': 'Terminated' },
    { ID: 'OTHER',    'Employee Name': 'Someone Else Entirely',     'Employee Status': 'Active' },
  ];
  const map = buildEmpIdToUid(emp, agents);
  assert.equal(map.get('ACTIVE_1'), 'u1');
  assert.equal(map.get('TERM_1'), 'u1');           // the regression: was unmatched → "— Unassigned"
  assert.equal(map.get('OTHER'), undefined);       // genuinely not in metrics → stays unmatched
});
test('buildEmpIdToUid: prefix fallback for a metrics name truncated at ~30 chars', () => {
  const agents = [{ name: 'Kimlin Adosinda Opperman Van Der', uid: 'u2' }];  // truncated in metrics
  const emp = [{ ID: 'X', 'Employee Name': 'Kimlin Adosinda Opperman Van Der Merwe' }];
  assert.equal(buildEmpIdToUid(emp, agents).get('X'), 'u2');
});
