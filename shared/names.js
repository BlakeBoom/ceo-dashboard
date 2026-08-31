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

  // Strip a team label down to its leader-name tokens: remove the possessive
  // ("'s"/"’s", straight or curly) and the word "team", so "Rugshana's team"
  // reduces to "Rugshana ". Pre-normalisation. One copy, used by both
  // buildTeamCanonMap (dedup) and resolveLeaderLabel (team-label → leader).
  function stripTeamLabel(s) {
    return String(s ?? '').replace(/['’]s\b/gi, '').replace(/\bteam\b/gi, '');
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
    const canonKey = (n) => normalizeName(stripTeamLabel(n));
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

  const _ROLE_RANK = { agent: 0, tm: 1, campaign_lead: 2 };

  // Build the team role index — { roleOf, isTL, resolveLeaderLabel, tlCount,
  // source } — from {name, role} pairs, keyed by full normalised name +
  // first+last key. "Leader role wins ties" (a name seen as both agent and tm
  // resolves to tm; unknown roles like admin/exco rank below agent so they never
  // displace a tm).
  //
  // BUG 1 fix: stripKnownNameSuffix is applied HERE, on both the key side and
  // the roleOf() lookup side, so a Zoho parenthetical ("Rugshana Hendricks
  // ( Rugshana )") in users.full_name can't desync the stored keys from the
  // clean names that arrive from User_metrics_3. Doing it inside the builder
  // means no caller can forget it and no future builder can reintroduce the bug.
  function _buildRoleIndex(pairs, source) {
    const roleByKey = new Map();
    const tlByFirst = new Map();   // first token → Set of distinct TL full-name keys
    let tlCount = 0;
    const put = (key, role) => {
      if (!key) return;
      const cur = roleByKey.get(key);
      if (cur == null || (_ROLE_RANK[role] ?? -1) > (_ROLE_RANK[cur] ?? -1)) roleByKey.set(key, role);
    };
    for (const { name, role } of pairs) {
      const clean = stripKnownNameSuffix(name);
      if (!clean || !role) continue;
      const full = normalizeName(clean);
      put(full, role);
      put(firstLastKey(clean), role);
      if (role === 'tm') {
        tlCount++;
        const first = full ? full.split(' ')[0] : null;
        if (first) {
          if (!tlByFirst.has(first)) tlByFirst.set(first, new Set());
          tlByFirst.get(first).add(full);
        }
      }
    }
    const roleOf = (name) => {
      const clean = stripKnownNameSuffix(name);
      return roleByKey.get(normalizeName(clean)) ?? roleByKey.get(firstLastKey(clean)) ?? null;
    };
    // BUG 2 fix: resolving a TEAM LABEL (e.g. "Rugshana's team") to a leader is a
    // DISTINCT operation from roleOf (which takes a person name) — don't overload
    // roleOf. Strip the possessive + "team", try full then first+last, then a
    // first-name index built ONLY where a first name maps to exactly one TL
    // (ambiguous first names are refused, never guessed — mirrors
    // buildTeamCanonMap's fullFls.size===1 guard). Returns the resolved TL's
    // normalised name key, or null.
    const resolveLeaderLabel = (label) => {
      if (!label) return null;
      const bare = stripTeamLabel(label);
      const full = normalizeName(bare);
      if (full && roleByKey.get(full) === 'tm') return full;
      const fl = firstLastKey(bare);
      if (fl && roleByKey.get(fl) === 'tm') return fl;
      const first = full ? full.split(' ')[0] : null;
      if (first) {
        const set = tlByFirst.get(first);
        if (set && set.size === 1) return [...set][0];   // unique first name among TLs
      }
      return null;
    };
    return { roleOf, isTL: n => roleOf(n) === 'tm', resolveLeaderLabel, tlCount, source };
  }

  // Preferred source: the authoritative resolved roles from Postgres, provided
  // by GET /api/users/roles ({ full_name, role } for active users, org-wide).
  // Returns null when there's nothing to build from, so callers fall back.
  function buildRoleIndexFromUsers(users) {
    if (!Array.isArray(users) || !users.length) return null;
    return _buildRoleIndex(users.map(u => ({ name: u.full_name, role: u.role })), 'users');
  }

  // Which team node a metrics row belongs to. Only Team Leaders are team nodes:
  //   • a Team Leader's own row  → their own person name
  //   • an agent under a TL      → that TL's team label (raw leaderName)
  //   • everyone else            → `unassigned`
  // With a null / empty index it falls back to the raw leader label, preserving
  // the pre-index behaviour. Takes the index and sentinel as arguments (no
  // globals) so it is unit-testable.
  function resolveTeamNode(personName, leaderName, index, unassigned) {
    if (!index || index.tlCount === 0) return leaderName || unassigned;
    if (index.roleOf(personName) === 'tm') return personName || unassigned;
    if (leaderName && index.resolveLeaderLabel(leaderName)) return leaderName;
    return unassigned;
  }

  // BUG 4 helper: fraction of resolved team nodes that landed in `unassigned`.
  // An index that dumps most of the org into one bucket is worse than no index;
  // the caller compares this to a threshold and discards the index if exceeded.
  function unassignedShare(nodes, unassigned) {
    if (!nodes.length) return 0;
    let lost = 0;
    for (const n of nodes) if (n === unassigned) lost++;
    return lost / nodes.length;
  }

  // ── KPI scoring (moved here from index.html so it is unit-testable) ─────────
  // Direction tokens are 'higher' | 'lower' | 'none'. LOWER_BETTER holds KPI KEYS
  // (not directions); rag() keeps it for historical parity even though the live
  // check reduces to `direction === 'lower'`. Do NOT change rag()'s body — it is a
  // regression-guarded contract.
  const LOWER_BETTER = new Set(['aht','absence','abandon_rate','error_rate','res_time','acw','avg_resp_time','calls_abn','churn']);
  // KPIs that accumulate over the period (totals), so their targets must be
  // pro-rated to the elapsed fraction of an in-progress month/week. Rate-based
  // KPIs (csat, qa, sph, absence, fulfil, realisation, …) are period-agnostic and
  // never scaled — adding a rate here would double-discount partial periods.
  const CUMULATIVE_KPIS = new Set(['sales','billable','calls','tickets']);

  function rag(val, tgt, direction) {
    if (val == null || isNaN(val)) return 'grey';
    if (tgt == null || direction === 'none') return 'grey';
    if (LOWER_BETTER.has(direction) || direction === 'lower') {
      if (val <= tgt) return 'green';
      if (val <= tgt * 1.10) return 'amber';
      return 'red';
    }
    if (val >= tgt) return 'green';
    if (val >= tgt * 0.95) return 'amber';
    return 'red';
  }

  function overallRag(metrics, targets, config, frac = 1) {
    let r = false, a = false, assessed = 0;
    for (const [k,,dir] of config) {
      if (dir === 'none') continue;
      const v = metrics[k];
      let t = targets[k];
      if (v == null || t == null) continue;
      if (frac !== 1 && CUMULATIVE_KPIS.has(k)) t = t * frac;  // run-rate target for partial period
      const x = rag(v, t, dir);
      assessed++;                             // a KPI we could actually score
      if (x === 'red') r = true;
      else if (x === 'amber') a = true;
    }
    // Nothing was scorable (campaign missing from KPI_CONFIG/TARGETS, or every
    // value was null) — return 'none' so callers can hold it out of the tally
    // instead of the loop falling through to a bogus 'green'.
    if (assessed === 0) return 'none';
    return r ? 'red' : a ? 'amber' : 'green';
  }

  // Composite attainment score for an agent: mean of per-KPI (actual ÷ target,
  // inverted for lower-is-better), capped at 150%, × 100. null when nothing
  // scorable. Realisation is excluded when the period's paid hours are below the
  // noise threshold (flagged as `_noRealScore` during aggregation): a tiny
  // denominator makes the ratio meaningless. It is still displayed, just unscored.
  function agentScore(m, cfg, tgts) {
    let sum = 0, n = 0;
    for (const [k,, dir] of cfg) {
      if (dir === 'none') continue;
      if (k === 'realisation' && m._noRealScore) continue;
      const v = m[k], t = tgts[k];
      if (v == null || t == null || t === 0) continue;
      let ratio = dir === 'lower' ? t / v : v / t;
      if (!isFinite(ratio) || ratio <= 0) continue;
      sum += Math.min(ratio, 1.5);
      n++;
    }
    return n ? (sum / n) * 100 : null;
  }

  // Fulfilment % = billable ÷ required × 100 (commercial delivery vs the contract).
  // null when there is no required-hours target, so a campaign without a contract
  // target never scores a bogus green. `reqHrs` must ALREADY be pro-rated for
  // in-progress periods by the caller — fulfil is a rate and must not be scaled
  // again (that is why 'fulfil' is deliberately absent from CUMULATIVE_KPIS).
  function fulfilPct(billableHrs, reqHrs) {
    if (!(reqHrs > 0) || billableHrs == null) return null;
    return (billableHrs / reqHrs) * 100;
  }

  // Realisation % = billable ÷ paid (payable) hours × 100. Comes entirely from
  // attendance, so it is immune to headcount/vacancy and to gross/net contract
  // differences — it measures adherence and productive-time discipline. null when
  // there are no paid hours to divide by.
  function realisationPct(billableHrs, paidHrs) {
    if (!(paidHrs > 0) || billableHrs == null) return null;
    return (billableHrs / paidHrs) * 100;
  }

  // Detect the EmployeeProfile HR employee-number column ("Employee ID" /
  // "Employee Number" / …) — the stable HR number the users table stores as
  // zoho_employee_no. This is NOT the People "ID" column (r['ID'], a 15-16 digit
  // Zoho People record id that attendance is keyed to); the 'id' header is never
  // a candidate, so the two never collide. Mirrors provision.js's empNo detection
  // so client and server pick the same column. Returns the raw header key or null.
  function detectEmpNoCol(empRows) {
    const sample = (empRows || []).find(r => r) || {};
    const cands = ['employeenumber', 'employeeno', 'employeeid', 'empno', 'empid', 'staffnumber'];
    const nk = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    const byNorm = new Map(Object.keys(sample).map(k => [nk(k), k]));
    for (const c of cands) if (byNorm.has(c)) return byNorm.get(c);
    return null;
  }

  // ── Attendance People ID → metrics user_id ──────────────────────────────────
  // Map EVERY EmployeeProfile People ID → metrics user_id, INCLUDING Terminated /
  // duplicate records. Attendance is frequently keyed to a person's OLD
  // (terminated) People ID while the metrics roster only matches their current
  // (active) one, so an active-only index leaves a large share of real hours
  // unmatched (they fall to "— Unassigned").
  //
  // Two layers, most-authoritative first:
  //   1. STABLE ID-LINK (optional `empNoToUid`): attendance People ID → the row's
  //      HR employee number → users.zoho_employee_no → its zoho_user_id (== metrics
  //      uid). This is namesake-proof: it can never fuse two different people who
  //      share a name. It only covers people whose HR + metrics halves are merged
  //      onto one users row AND who carry metrics this period (validUids).
  //   2. NAME FALLBACK (always): full-name preferred over first+last to limit
  //      namesake collisions; a metrics name truncated at ~30 chars is handled by
  //      the prefix fallback. Used for every People ID the ID-link doesn't cover.
  //
  // `agents` is an array of { name, uid }. `empNoToUid` is an optional
  // Map(zoho_employee_no → uid). `stats` (optional) is filled with coverage counts
  // for diagnostics. First metrics agent to claim a key wins. Returns Map(peopleId
  // → uid).
  function buildEmpIdToUid(empRows, agents, empNoToUid, stats) {
    const fullToUid = new Map(), flToUid = new Map(), fulls = [];
    const validUids = new Set();
    for (const a of (agents || [])) {
      validUids.add(a.uid);
      const full = normalizeName(a.name);
      if (full) { if (!fullToUid.has(full)) fullToUid.set(full, a.uid); fulls.push({ full, uid: a.uid }); }
      const fl = firstLastKey(a.name); if (fl && !flToUid.has(fl)) flToUid.set(fl, a.uid);
    }
    // The ID-link is only usable when we were given a non-empty map AND can find
    // the employee-number column to read the join key from.
    const idLink = (empNoToUid instanceof Map && empNoToUid.size) ? empNoToUid : null;
    const empNoCol = idLink ? detectEmpNoCol(empRows) : null;
    let byId = 0, byName = 0;
    const map = new Map();
    for (const r of (empRows || [])) {
      const id = String(r['ID'] ?? r.id ?? r.employee_id ?? '');
      if (!id || map.has(id)) continue;
      // 1) Stable ID-link — wins over names, but only onto an agent that actually
      //    carries metrics this period (else fall through to names, which land the
      //    same non-covered People IDs where they'd land without the ID-link).
      if (idLink && empNoCol) {
        const empNo = String(r[empNoCol] ?? '').trim();
        const uid = empNo ? idLink.get(empNo) : undefined;
        if (uid != null && validUids.has(uid)) { map.set(id, uid); byId++; continue; }
      }
      // 2) Name fallback.
      const nm = stripKnownNameSuffix(r['Employee Name'] ?? r.employee_name);
      const full = normalizeName(nm), fl = firstLastKey(nm);
      let uid = (full && fullToUid.get(full)) ?? (fl && flToUid.get(fl));
      if (uid == null && full && full.length >= 20) {   // metrics name truncated → EP name starts with it
        for (const c of fulls) if (full.startsWith(c.full)) { uid = c.uid; break; }
      }
      if (uid != null) { map.set(id, uid); byName++; }
    }
    if (stats && typeof stats === 'object') {
      stats.byId = byId; stats.byName = byName; stats.total = map.size;
      stats.idLinkUsed = !!(idLink && empNoCol); stats.empNoCol = empNoCol || null;
    }
    return map;
  }

  // ── Shift → campaign ────────────────────────────────────────────────────────
  // The campaign name appears somewhere in the Shift column (not always at the
  // start); contains-matches, ordered specific-first. Shared so the server can
  // scope a campaign lead's attendance by shift→campaign EXACTLY the way the
  // dashboard attributes billable by shift — the two must agree or a lead's total
  // won't match an admin's.
  const SHIFT_PATTERNS = [
    [/beer\s*52/i,                  'BEER52'],
    // HYVE runs live trade-show events; agents' shifts are labelled with the
    // event name, not "HYVE". Map every spelling variant of those events to the
    // HYVE campaign: "Indaba" (bare, or "Mining Indaba" / "Investing in African
    // Mining Indaba", no-space / hyphen), any shift containing "Mining",
    // "Spring Fair" (any spacing / hyphenation) and "CWIEME" (incl. "CWIEME
    // Berlin/Chicago", "CWIEME Connect", and the loose "C-WIEME" hyphenation).
    // "Indaba" is matched on its own — in this roster it always refers to the
    // Mining Indaba.
    [/\bhyve\b|indaba|\bc[\s-]*wieme\b|\bmining\b|spring[\s-]*fair/i, 'HYVE'],
    [/bb\s*marro|\bmarro\b/i,       'BUTTERNUTBOX'],
    [/butternut|\bbbox\b/i,         'BUTTERNUTBOX'],
    [/gousto/i,                     'Gousto'],
    [/hunza\s*g/i,                  'HUNZAG'],
    [/med\s*express|\bmedx\b/i,     'Medexpress'],
    [/pic?k\s*n\s*pay|\bpnp\b/i,    'PICKNPAY'],
    [/royal\s*canin/i,              'ROYALCANIN'],
    [/good\s*life|\bgls\b/i,        'GOODLIFESORTED'],
    [/lint\s*bells|vetnique/i,      'VETNIQUE'],
    [/pinter/i,                     'PINTER'],
    [/1\s*life|one\s*life/i,        '1LIFE'],
    [/just\s*park.*(space\s*owner|\bsp\b|event\s*pass|\bus\b)/i, 'JUSTPARK_usa'],
    [/just\s*park/i,                'JUSTPARK_uk'],
  ];
  function shiftToCampaign(shiftName) {
    if (!shiftName) return null;
    for (const [re, key] of SHIFT_PATTERNS) if (re.test(shiftName)) return key;
    return null;
  }
  // Every campaign key a shift references, so a '+' split shift (two campaigns in
  // one row) is included for a lead when their campaign is EITHER segment. Primary
  // match first.
  function shiftCampaignKeys(shiftName) {
    const s = String(shiftName ?? '');
    if (!s) return [];
    const keys = new Set();
    const primary = shiftToCampaign(s); if (primary) keys.add(primary);
    if (s.indexOf('+') >= 0) for (const part of s.split('+')) { const k = shiftToCampaign(part); if (k) keys.add(k); }
    return [...keys];
  }

  root.BoomerangNames = {
    normalizeName, firstLastKey, stripKnownNameSuffix, stripTeamLabel, buildTeamCanonMap,
    titleToRole, looksLikeLookupId,
    _buildRoleIndex, buildRoleIndexFromUsers, resolveTeamNode, unassignedShare,
    LOWER_BETTER, CUMULATIVE_KPIS, rag, overallRag, agentScore, fulfilPct, realisationPct,
    SHIFT_PATTERNS, shiftToCampaign, shiftCampaignKeys, buildEmpIdToUid, detectEmpNoCol,
  };
})(globalThis);
