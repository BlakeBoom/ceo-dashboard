// Shared name-normalisation + team-canonicalisation helpers — the single source
// of truth for logic that used to be copy-pasted across the client and server.
//
// This file deliberately has NO import/export statements so it works UNCHANGED
// in both runtimes:
//   • the browser loads it as a classic <script src="/shared/names.js"> placed
//     BEFORE the inline app script, which reads globalThis.BoomerangNames;
//   • the server does a side-effect ESM import ('.../shared/names.js') and reads
//     the same globalThis.BoomerangNames.
// Do NOT add import/export here, and do NOT load it with type="module" in the
// browser — a module script is deferred and would run after the classic inline
// script, so the helpers wouldn't be in scope yet.
(function (root) {
  // Lowercase, strip punctuation, collapse whitespace. Empty / blank / entirely
  // punctuation → null, so every caller has one falsy answer to test for "no
  // usable name". (The old copies split between returning null and '' on empty;
  // null is the majority behaviour and all call sites treat both as falsy.)
  function normalizeName(s) {
    if (!s) return null;
    const n = String(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    return n || null;
  }

  // First + last token only, e.g. "john michael smith" → "john smith". Handles a
  // middle name being added/dropped between the two Zoho views. null unless the
  // normalised name has at least two tokens.
  function firstLastKey(s) {
    const n = normalizeName(s);
    if (!n) return null;
    const parts = n.split(' ');
    return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : null;
  }

  // Drop a trailing "(...)" suffix, e.g. "John Smith (MedExpress)" → "John Smith".
  // This is pre-normalisation cleanup (keeps original case/spacing); null on
  // empty input.
  function stripKnownNameSuffix(s) {
    if (!s) return null;
    return String(s).replace(/\s*\([^)]+\)\s*$/, '').trim();
  }

  // Collapse inconsistent team-leader spellings to a single canonical name so one
  // team isn't split across "Elzette" and "Elzette Saaiman". Group by first name;
  // when a first name maps to exactly one full identity, every variant (incl. the
  // bare first name) folds into the longest spelling; when a first name is shared
  // by DIFFERENT people, only exact first+last duplicates merge so distinct
  // leaders are never fused. `skip` is an optional sentinel to ignore — the
  // frontend passes its synthetic UNASSIGNED_TEAM node, the server passes none
  // (the sentinel is a client-side construct and must not be hardcoded here).
  // Returns Map(name -> canonicalName) for names that should be remapped.
  function buildTeamCanonMap(names, { skip = null } = {}) {
    const map = new Map();
    const info = [];
    // Names arrive as "<Leader>'s team"; strip the possessive + trailing "team"
    // word so the apostrophe-s ("elzettes") doesn't corrupt the first-name token.
    const canonKey = (n) => normalizeName(String(n).replace(/['’]s\b/gi, '').replace(/\bteam\b/gi, ''));
    for (const n of names) {
      if (!n || n === skip) continue;
      const k = canonKey(n) || '';
      const toks = k ? k.split(' ') : [];
      if (!toks.length) continue;
      const fl = toks.length >= 2 ? `${toks[0]} ${toks[toks.length - 1]}` : null;
      info.push({ n, k, toks, first: toks[0], fl });
    }
    const byFirst = new Map();
    for (const it of info) {
      if (!byFirst.has(it.first)) byFirst.set(it.first, []);
      byFirst.get(it.first).push(it);
    }
    const longest = gs => gs.slice().sort((a, b) => b.k.length - a.k.length)[0].n;
    for (const group of byFirst.values()) {
      const fullFls = new Set(group.filter(g => g.toks.length >= 2).map(g => g.fl));
      if (fullFls.size === 1) {
        const canonical = longest(group);
        for (const g of group) map.set(g.n, canonical);
      } else {
        const byFl = new Map();
        for (const g of group) {
          if (g.toks.length < 2) continue;   // ambiguous bare first name → leave as-is
          if (!byFl.has(g.fl)) byFl.set(g.fl, []);
          byFl.get(g.fl).push(g);
        }
        for (const gs of byFl.values()) {
          const canonical = longest(gs);
          for (const g of gs) map.set(g.n, canonical);
        }
      }
    }
    return map;
  }

  // Canonical Job Title → role mapper, shared by the dashboard's role index and
  // provision.js. Order matters: most senior first. 'team lead' (no -er) is
  // matched explicitly so the shorter spelling isn't classified as an agent —
  // that omission was the drift between the two copies.
  function titleToRole(title) {
    const t = String(title ?? '').toLowerCase();
    if (t.includes('campaign manager')) return 'campaign_lead';
    if (t.includes('team leader') || t.includes('team lead') || t.includes('shift leader')) return 'tm';
    return 'agent';
  }

  // A value looks like an unresolved Zoho lookup id (a long all-digit string)
  // rather than human text — e.g. a Job Title coming back as "610962000011338364".
  // provision.js resolves these server-side; the browser may still see the raw
  // id, so the client role-index fallback uses this to refuse to classify rather
  // than mislabel everyone as an agent.
  function looksLikeLookupId(v) {
    return /^\d{10,}$/.test(String(v ?? '').trim());
  }

  root.BoomerangNames = {
    normalizeName, firstLastKey, stripKnownNameSuffix, buildTeamCanonMap,
    titleToRole, looksLikeLookupId,
  };
})(globalThis);
