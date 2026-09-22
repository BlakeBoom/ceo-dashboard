/* ═══════════════════════════════════════════════════════════════════════════
   BOOMERANG OPERATIONS DASHBOARD — OFFLINE DEMO RUNTIME
   ───────────────────────────────────────────────────────────────────────────
   This file turns the production dashboard into a standalone, offline showcase.

   It is injected BEFORE the application script and does exactly two things:

     1. Synthesises a complete, internally-consistent, entirely FICTIONAL
        dataset (campaigns, teams, people, daily metrics, attendance, HR
        records, bonus awards and commercial targets) from a fixed seed, so
        every reload shows the same numbers.

     2. Replaces window.fetch with an in-memory router that answers every
        /api/* call the dashboard makes. Nothing leaves the browser; the file
        works from file:// with no server, no network and no login.

   NOTHING in here is real. Client names, people, rates and every figure are
   invented. Campaign names are deliberately generic placeholders.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Deterministic PRNG (mulberry32) ──────────────────────────────────────
  // A fixed seed keeps the demo identical on every reload, so the CEO can
  // rehearse against the same numbers he presents.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Stable per-key stream: same key → same sequence, independent of call order.
  function keyRng(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return rng(h);
  }
  const R = rng(20260401);
  const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
  // Gaussian-ish noise in [-1,1], concentrated near 0.
  const jitter = (r) => (r() + r() + r() - 1.5) / 1.5;
  const round2 = (n) => Math.round(n * 100) / 100;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // ── Calendar ─────────────────────────────────────────────────────────────
  const DAY = 86400000;
  const MONTH_3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const today = new Date();
  const TODAY = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const WEEKS_OF_HISTORY = 18;                 // daily metrics + attendance window
  const iso = (d) => d.toISOString().slice(0, 10);
  const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const addDays = (d, n) => new Date(d.getTime() + n * DAY);
  const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

  // ISO week label, matching the dashboard's "W23, 2026" scheme exactly.
  function weekLabel(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - dow + 3);
    const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const wk = 1 + Math.round(((t - firstThu) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return `W${wk}, ${t.getUTCFullYear()}`;
  }

  // Window: WEEKS_OF_HISTORY complete ISO weeks, starting on a Monday, plus the
  // current week-to-date — so the first week on the chart is whole and only the
  // latest one is partial, which is what the dashboard expects (it defaults the
  // selection to the penultimate period for exactly that reason).
  const mondayThisWeek = addDays(TODAY, -((TODAY.getUTCDay() + 6) % 7));
  const daysIntoWeek = Math.round((TODAY - mondayThisWeek) / DAY);   // Mon = 0
  // The current week is only included once enough of it has run. Early in the
  // week a one-day bar reads as a collapse rather than as a week in progress,
  // which is a distraction in a walkthrough; from Thursday on it reads as what
  // it is. Either way the newest complete week is always on the chart.
  const endDate = daysIntoWeek >= 4 ? addDays(TODAY, -1) : addDays(mondayThisWeek, -1);
  const startDate = addDays(endDate, -(WEEKS_OF_HISTORY * 7 - 1) - (daysIntoWeek >= 4 ? daysIntoWeek - 1 : 0));
  const ALL_DAYS = [];
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) ALL_DAYS.push(new Date(d));

  // Public holidays are rendered as planned shrinkage; two inside the window.
  const HOLIDAYS = new Set([iso(addDays(endDate, -37)), iso(addDays(endDate, -79))]);

  // ── Campaign roster (fictional) ──────────────────────────────────────────
  // Shaped like the real book of business — one very large health-tech
  // account, a large retail account, a long tail of mid-size D2C/CX accounts
  // and a small sales cluster — so the Summary reads like the real thing.
  // kpis: [key, label, direction]; targets feed the RAG scoring.
  const CORE = (extra) => Object.assign({ fulfil: 100, realisation: 90, churn: 20, absence: 5 }, extra);
  const CORE_TILES = [['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],
                      ['churn','Churn','lower'],['absence','Absence','lower']];

  const ROSTER = [
    { key:'NORTHWIND',   display:'NORTHWIND HEALTH',  slug:'northwind',   section:'Customer Services',
      fte:176, hrsFte:162.5, days:6, health:0.035,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['aht','AHT','lower'],['tickets','Tickets','none']],
      targets:CORE({ csat:85, qa:90, aht:6, compliance:100, productivity:90 }) },

    { key:'SUMMIT',      display:'SUMMIT RETAIL',     slug:'summit',      section:'Customer Services',
      fte:75,  hrsFte:150,   days:7, health:-0.04,
      tiles:[['qa','QA','higher'],['sla','Talk SLA','higher'],['calls','Calls','none'],['abandon_rate','Abandoned','lower']],
      targets:CORE({ csat:85, qa:80, talk_sla:90, sla:90, calls_abn:5 }) },

    { key:'MERIDIAN_uk', display:'MERIDIAN UK',       slug:'meridian',    section:'Customer Services',
      fte:25,  hrsFte:174,   days:6, health:0.03,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['cph','CPH','higher'],['fcr','FCR','higher'],['tickets','Tickets','none']],
      targets:CORE({ csat:80, qa:90, cph:6, fcr:85 }) },

    { key:'KESTREL',     display:'KESTREL PETCARE',   slug:'kestrel',     section:'Customer Services',
      fte:18,  hrsFte:157.4, days:5, health:0.055,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['cpd','CPD','higher']],
      targets:CORE({ csat:90, qa:90, cpd:50 }) },

    { key:'BREWHOUSE',   display:'BREWHOUSE',         slug:'brewhouse',   section:'Sales',
      fte:22,  hrsFte:151.7, days:5, health:-0.06,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['res_time','Res. time','lower'],['tickets','Tickets','none']],
      targets:CORE({ csat:80, qa:90, res_time:24, avg_resp_time:4 }) },

    { key:'LUMEN',       display:'LUMEN NUTRITION',   slug:'lumen',       section:'Customer Services',
      fte:14,  hrsFte:173.4, days:5, health:0.04,
      tiles:[['qa','QA','higher'],['cph','CPH','higher'],['tickets','Tickets','none']],
      targets:CORE({ qa:95, cph:4, error_rate:2 }) },

    { key:'SENTINEL',    display:'SENTINEL COVER',    slug:'sentinel',    section:'Sales',
      fte:14,  hrsFte:173.4, days:5, health:-0.02,
      tiles:[['qa','QA','higher'],['sales','Sales','higher'],['tickets','Tickets','none']],
      targets:CORE({ qa:90, sales:350 }) },

    { key:'HALCYON',     display:'HALCYON PETCARE',   slug:'halcyon',     section:'Customer Services',
      fte:13,  hrsFte:195,   days:5, health:0.06,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['cph','CPH','higher'],['res_time','Res. time','lower']],
      targets:CORE({ csat:90, qa:95, cph:6, res_time:48, acw:1.25 }) },

    { key:'AURORA',      display:'AURORA FOODS',      slug:'aurora',      section:'Customer Services',
      fte:12,  hrsFte:162.5, days:6, health:0.03,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['cph','CPH','higher'],['adherence','Adherence','higher']],
      targets:CORE({ csat:88, qa:90, cph:5.5, adherence:95 }) },

    { key:'MERIDIAN_us', display:'MERIDIAN US',       slug:'meridian-us', section:'Customer Services',
      fte:9,   hrsFte:174,   days:6, health:-0.05,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['fcr','FCR','higher'],['sla','SLA','higher']],
      targets:CORE({ csat:80, qa:85, fcr:90, sla:90 }) },

    { key:'CASKWAY',     display:'CASKWAY',           slug:'caskway',     section:'Sales',
      fte:8,   hrsFte:162.5, days:5, health:0.03,
      tiles:[['qa','QA','higher'],['sph','SPH','higher'],['calls','Calls','none'],['sales','Sales','none']],
      targets:CORE({ qa:90, sph:1.25 }) },

    { key:'CLARITY',     display:'CLARITY CARE',      slug:'clarity',     section:'Customer Services',
      fte:6,   hrsFte:195,   days:5, health:0.03,
      tiles:[['qa','QA','higher'],['cph','CPH','higher'],['aht','AHT','lower'],['calls','Calls','none']],
      targets:CORE({ qa:95, cph:4, aht:3, calls_abn:8 }) },

    { key:'VANTAGE',     display:'VANTAGE EVENTS',    slug:'vantage',     section:'Customer Services',
      fte:6,   hrsFte:150,   days:5, health:0.03,
      tiles:[['csat','CSAT','higher'],['qa','QA','higher'],['cph','CPH','higher']],
      targets:CORE({ csat:85, qa:90, cph:4 }) },

    { key:'ORCHID',      display:'ORCHID',            slug:'orchid',      section:'Customer Services',
      fte:5,   hrsFte:177.1, days:5, health:0.04,
      tiles:[['qa','QA','higher'],['cpd','CPD','higher'],['res_time','Res. time','lower'],['tickets','Tickets','none']],
      targets:CORE({ qa:95, cpd:20, res_time:24 }) },
  ];
  ROSTER.forEach((c, i) => { c.id = 100 + i; c.tiles = c.tiles.concat(CORE_TILES); });
  const BY_KEY = Object.fromEntries(ROSTER.map(c => [c.key, c]));

  // Config the dashboard pulls from /api/campaigns/config — it replaces the
  // hardcoded maps in the app, so the whole UI speaks in demo campaign names.
  const CAMPAIGN_CONFIG = (() => {
    const WG_MAP = {}, CAMP_DISPLAY = {}, CAMP_SECTION = {}, SLUG_TO_CAMPKEY = {},
          TARGETS = {}, KPI_CONFIG = {};
    for (const c of ROSTER) {
      WG_MAP[c.display] = c.key;
      CAMP_DISPLAY[c.key] = c.display;
      CAMP_SECTION[c.key] = c.section;
      SLUG_TO_CAMPKEY[c.slug] = c.key;
      TARGETS[c.key] = c.targets;
      KPI_CONFIG[c.key] = c.tiles;
    }
    return { WG_MAP, CAMP_DISPLAY, CAMP_SECTION, SLUG_TO_CAMPKEY, TARGETS, KPI_CONFIG };
  })();

  // Shift-name → campaign rules. "MERIDIAN US" must beat the bare "MERIDIAN"
  // prefix, hence the explicit priority ordering.
  const SHIFT_RULES = [
    { id: 1, pattern: 'Meridian US', match_mode: 'contains', shift_key: 'MERIDIAN_us', priority: 1, active: true },
  ].concat(ROSTER.filter(c => c.key !== 'MERIDIAN_us').map((c, i) => ({
    id: 2 + i, pattern: c.display.split(' ')[0], match_mode: 'contains',
    shift_key: c.key, priority: 10 + i, active: true,
  })));

  // ── People (fictional) ───────────────────────────────────────────────────
  const FIRST = ['Amahle','Thandiwe','Sipho','Nadia','Riaan','Kirsten','Lebo','Marcelle','Devan','Zanele',
    'Jordan','Chantelle','Ayanda','Werner','Lindiwe','Ruan','Shireen','Tebogo','Megan','Kyle',
    'Nomsa','Deon','Anele','Carmen','Sibusiso','Tarryn','Muhammad','Refilwe','Byron','Jolene',
    'Katlego','Danielle','Ntando','Pieter','Zinhle','Curtly','Yolanda','Mandla','Simone','Rashid',
    'Palesa','Ashwin','Bianca','Thabo','Elmarie','Keagan','Nolwazi','Gerhard','Precious','Rowan',
    'Asanda','Charmaine','Tumelo','Jarryd','Lerato','Nicolaas','Bongi','Stefani','Kagiso','Melissa'];
  const LAST = ['Naidoo','Botha','Mokoena','Pillay','Jacobs','Dlamini','Van Wyk','Khumalo','Petersen','Nkosi',
    'Adams','Maree','Sithole','Fourie','Govender','Mabaso','Daniels','Venter','Ngcobo','Hendricks',
    'Molefe','Steyn','Abrahams','Zulu','Coetzee','Radebe','Isaacs','Meyer','Ntuli','Solomons',
    'Mahlangu','Du Plessis','Cele','Roberts','Mthembu','Swanepoel','Arendse','Msimang','Kruger','Lewis',
    'Mokgatle','September','Buthelezi','Oosthuizen','Samuels','Tshabalala','Erasmus','Mbatha','Fortuin','Nel'];

  const usedNames = new Set();
  function newName(r) {
    for (let i = 0; i < 400; i++) {
      const n = `${pick(r, FIRST)} ${pick(r, LAST)}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    const n = `${pick(r, FIRST)} ${pick(r, LAST)} ${usedNames.size}`;
    usedNames.add(n); return n;
  }

  // Everyone currently on the floor: agents grouped under team leaders, with
  // a campaign manager / QA layer on the larger accounts.
  const PEOPLE = [];          // { uid, empId, empNo, name, role, camp, team, joined }
  const TEAMS = [];           // { camp, leader, members[] }
  let uidSeq = 900100, peopleSeq = 610100, empNoSeq = 10250;

  function addPerson(camp, role, team, joinedDaysAgo) {
    const r = keyRng(`${camp.key}|${role}|${PEOPLE.length}`);
    const p = {
      uid: String(++uidSeq),
      empId: String(++peopleSeq),
      empNo: String(++empNoSeq),
      name: newName(r),
      role, camp: camp.key, team,
      joined: addDays(TODAY, -joinedDaysAgo),
      exit: null, reason: '', status: 'Active',
    };
    PEOPLE.push(p);
    return p;
  }

  for (const camp of ROSTER) {
    const r = keyRng('roster|' + camp.key);
    const headcount = Math.max(3, Math.round(camp.fte * 0.97));
    const perTeam = camp.fte >= 60 ? 14 : camp.fte >= 20 ? 11 : 8;
    const teamCount = Math.max(1, Math.round(headcount / perTeam));
    const leaders = [];
    for (let t = 0; t < teamCount; t++) {
      // A team leader is their own team node; their name labels the team.
      const tl = addPerson(camp, 'team_leader', null, 240 + Math.floor(r() * 900));
      tl.team = tl.name;
      leaders.push(tl);
      TEAMS.push({ camp: camp.key, leader: tl.name, leaderUid: tl.uid, members: [] });
    }
    for (let i = 0; i < headcount; i++) {
      const tl = leaders[i % leaders.length];
      const tenure = 30 + Math.floor(Math.pow(r(), 1.7) * 1100);
      const a = addPerson(camp, 'agent', tl.name, tenure);
      TEAMS.find(t => t.camp === camp.key && t.leader === tl.name).members.push(a);
    }
    // Support layer on the bigger accounts (billable per the targets matrix).
    if (camp.fte >= 20) {
      const cm = addPerson(camp, 'campaign_manager', leaders[0].name, 600 + Math.floor(r() * 600));
      const qa = addPerson(camp, 'quality_analyst', leaders[0].name, 300 + Math.floor(r() * 700));
      void cm; void qa;
    }
  }

  // Leavers: HR history only (never rostered in the metrics window), spread
  // over the past 30 months so rolling-12 attrition lands near the 20% target.
  const LEAVERS = [];
  (function buildLeavers() {
    const r = keyRng('leavers');
    const REASONS = ['Resigned — better offer','Resigned — relocation','Resigned — studies',
      'Dismissed — misconduct','Dismissed — performance','Contract ended','Absconded','Medical'];
    const weights = ROSTER.map(c => c.fte);
    const totalFte = weights.reduce((a, b) => a + b, 0);
    const daysInThisMonth = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() + 1, 0)).getUTCDate();
    for (let m = 30; m >= 0; m--) {
      const monthStart = addMonths(new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 1)), -m);
      // ~1.7% of headcount per month ⇒ ~20% annualised, with seasonal noise. The
      // current month is pro-rated to the days elapsed, so the trend line reflects
      // a month in progress instead of collapsing to zero.
      const elapsed = m === 0 ? TODAY.getUTCDate() / daysInThisMonth : 1;
      const n = Math.max(m === 0 ? 0 : 1, Math.round(totalFte * (0.016 + 0.006 * jitter(r)) * elapsed));
      for (let i = 0; i < n; i++) {
        let roll = r() * totalFte, ci = 0;
        while (roll > weights[ci] && ci < weights.length - 1) { roll -= weights[ci]; ci++; }
        const camp = ROSTER[ci];
        const span = m === 0 ? Math.max(1, TODAY.getUTCDate() - 1) : 27;
        const exit = addDays(monthStart, Math.floor(r() * span));
        const tenureDays = 45 + Math.floor(Math.pow(r(), 1.6) * 900);
        LEAVERS.push({
          uid: null,
          empId: String(++peopleSeq),
          empNo: String(++empNoSeq),
          name: newName(keyRng('leaver|' + m + '|' + i)),
          role: 'agent', camp: camp.key, team: null,
          joined: addDays(exit, -tenureDays),
          exit, reason: pick(r, REASONS), status: 'Terminated',
        });
      }
    }
  })();

  const AGENTS = PEOPLE.filter(p => p.role === 'agent');
  const ROSTERED = PEOPLE;   // everyone who appears on the attendance feed

  // ── Per-campaign shape: how each account performs over the window ────────
  // Each campaign gets a stable performance signature — a level bias, a trend
  // slope across the window, an absence profile and a realisation profile — so
  // the demo shows a genuine spread of RAG states and a readable story on the
  // Trends tab rather than uniform green.
  const AGENTS_PER_CAMP = {};
  for (const p of PEOPLE) if (p.role === 'agent') AGENTS_PER_CAMP[p.camp] = (AGENTS_PER_CAMP[p.camp] || 0) + 1;

  const SHAPE = {};
  for (const c of ROSTER) {
    const r = keyRng('shape|' + c.key);
    SHAPE[c.key] = {
      bias: c.health,
      trend: (r() - 0.45) * 0.10,                  // level drift head-to-tail
      absenceBase: 0.026 + r() * 0.026,            // unplanned-absence propensity
      fulfilBias: 0.975 + r() * 0.095,             // 97.5% – 107% of contracted hours
      realisation: 0.885 + r() * 0.075,            // billable ÷ paid hours, 88.5% – 96%
      headsByWeek: new Map(),                      // week label → Set of people on the roster
      presentByWeek: new Map(),                    // week label → productive days drawn
      hrsByWeek: new Map(),                        // week label → billable hrs per productive day
    };
  }

  // Position of a date through the window, 0 → 1. Drives the trend slope.
  const progress = (d) => (d - startDate) / Math.max(1, endDate - startDate);

  // A metric value around its target. `goodness` > 0 beats target.
  function around(target, goodness, r, lowerBetter) {
    if (target == null) return null;
    const g = lowerBetter ? -goodness : goodness;
    return target * (1 + g + jitter(r) * 0.07);
  }

  const isRosterDay = (camp, d) => {
    const dow = d.getUTCDay();                 // 0 = Sun
    if (camp.days >= 7) return true;
    if (camp.days === 6) return dow !== 0;
    return dow >= 1 && dow <= 5;
  };

  function shiftNameFor(p, camp) {
    if (p.role === 'team_leader')      return `${camp.display} Team Leader Shift (SA 08:00 - 17:00)`;
    if (p.role === 'quality_analyst')  return `${camp.display} Quality Analyst Shift (SA 08:00 - 17:00)`;
    if (p.role === 'campaign_manager') return `${camp.display} Campaign Manager Shift (SA 08:00 - 17:00)`;
    return `${camp.display} Day Shift (SA 08:00 - 17:00)`;
  }

  const STATUS_TABLE = [
    ['Annual Leave',          0.040],
    ['Sick Leave',            0.018],
    ['Absent',                0.008],
    ['Training',              0.006],
    ['Family Responsibility', 0.003],
    ['Unpaid Leave',          0.002],
    ['No Show',               0.002],
  ];

  // ── Pass 1: roster the window ────────────────────────────────────────────
  // Who was on shift on which day, and what happened to them. Hours are NOT
  // set yet: they depend on how many productive days the campaign actually
  // ends up with, which is only known once the whole roster is drawn.
  const SLOTS = [];
  const RNG_BY_UID = new Map();
  for (const p of ROSTERED) {
    const camp = BY_KEY[p.camp];
    const s = SHAPE[p.camp];
    const r = keyRng('feed|' + p.uid);
    RNG_BY_UID.set(p.uid, r);
    for (const d of ALL_DAYS) {
      if (d < p.joined) continue;
      if (!isRosterDay(camp, d)) continue;

      let status = 'Present';
      if (HOLIDAYS.has(iso(d))) {
        status = 'Public Holiday';
      } else {
        let roll = r(), acc = 0;
        const scale = s.absenceBase / 0.039;       // campaign absence propensity
        for (const [st, base] of STATUS_TABLE) {
          acc += st === 'Annual Leave' ? base : base * scale;
          if (roll < acc) { status = st; break; }
        }
      }
      const present = status === 'Present';
      const wk = weekLabel(d);
      SLOTS.push({
        p, camp, d, wk, status, present,
        lateEntry: present && r() < 0.14 ? Math.round(3 + r() * 14) : 0,
        earlyExit: present && r() < 0.09 ? Math.round(3 + r() * 12) : 0,
      });
      let heads = s.headsByWeek.get(wk);
      if (!heads) s.headsByWeek.set(wk, heads = new Set());
      heads.add(p.uid);
      if (present) s.presentByWeek.set(wk, (s.presentByWeek.get(wk) || 0) + 1);
    }
  }

  // ── Calibration ──────────────────────────────────────────────────────────
  // Solve, per campaign per week, for the billable hours a productive day has
  // to carry for the campaign to land on its intended Fulfil % (billable ÷
  // contracted hours). Deriving it from the roster that was actually drawn —
  // rather than assuming an attendance rate — is what keeps Fulfil, Slippage,
  // Capacity and Realisation reconciling with one another instead of drifting
  // apart, and doing it per week stops new joiners inflating later weeks.
  const WEEKS_PER_MONTH = 4.33;                 // same constant the dashboard uses
  for (const c of ROSTER) {
    const s = SHAPE[c.key];
    const weeklyRequired = (c.fte * c.hrsFte) / WEEKS_PER_MONTH;
    const weeks = [...s.headsByWeek.keys()];
    // A week's capacity is the people on the roster that week × the days the
    // campaign runs — NOT the days actually worked. Normalising against capacity
    // is what stops a growing roster inflating the later weeks, while leaving
    // absence, leave and public holidays free to pull the delivered hours down.
    const capacity = (wk) => (s.headsByWeek.get(wk)?.size || 0) * c.days;
    // The last week is the current week-to-date; it is excluded from the
    // averages (the dashboard pro-rates required hours for a period in progress).
    const whole = weeks.length > 1 ? weeks.slice(0, -1) : weeks;
    let cap = 0, pres = 0;
    for (const wk of whole) { cap += capacity(wk); pres += s.presentByWeek.get(wk) || 0; }
    const attendanceRate = cap > 0 ? pres / cap : 0.9;

    const wr = keyRng('fulfil|' + c.key);
    weeks.forEach((wk, i) => {
      // Intended Fulfil for a normal week: the campaign's level, its trend over
      // the window, and week-to-week movement so the chart breathes.
      const glide = s.trend * ((i / Math.max(1, weeks.length - 1)) - 0.5) * 2;
      const target = s.fulfilBias + glide + jitter(wr) * 0.045;
      const denom = capacity(wk) * attendanceRate;
      s.hrsByWeek.set(wk, denom > 0 ? (weeklyRequired * target) / denom : 7.5);
    });
  }

  // ── Pass 2: attendance rows + daily KPI rows ─────────────────────────────
  const ATTENDANCE = [];
  const METRICS = [];

  for (const slot of SLOTS) {
    const { p, camp, d, wk, status, present } = slot;
    const s = SHAPE[p.camp];
    const r = RNG_BY_UID.get(p.uid);
    const shift = shiftNameFor(p, camp);

    const perDayHrs = s.hrsByWeek.get(wk) || 7.5;
    const billMins = present ? Math.round(perDayHrs * 60 * (1 + jitter(r) * 0.06)) : 0;
    // The unpaid lunch break is what separates paid hours from billable hours,
    // so it is derived from the campaign's intended Realisation rather than
    // fixed — a short shift with a fixed break would read as poor realisation.
    const unpaid = present ? Math.round(billMins * (1 / s.realisation - 1)) : 0;
    const payable = present ? billMins + unpaid : 0;

    ATTENDANCE.push({
      'Employee': p.empId,
      'Employee Name': p.name,
      'Date': iso(d),
      'Shift': shift,
      'Status': status,
      'Payable Hours (Mins)': payable,
      'Total Hours (Mins)': payable,
      'Paid Break (Mins)': present ? 15 : 0,
      'Unpaid Break (Mins)': unpaid,
      'Late Entry (Mins)': slot.lateEntry,
      'Early Exit (Mins)': slot.earlyExit,
    });

    if (!present) continue;

    const t = camp.targets;
    const skill = jitter(r) * 0.05;
    const goodness = s.bias + s.trend * (progress(d) - 0.5) * 2 + skill;
    const hrs = billMins / 60;
    const row = {
      user_id: p.uid,
      fullname: p.name,
      workgroup: camp.display,
      team_name: p.team || p.name,
      _campaign_slug: camp.slug,
      date: iso(d),
      Weeks: wk,
      FTEs: 1,
      absenteeism: 0,
    };

    if (p.role === 'agent') {
      const cph = t.cph != null ? clamp(around(t.cph, goodness, r, false), 0.5, 40) : null;
      const cpd = t.cpd != null ? clamp(around(t.cpd, goodness, r, false), 2, 200) : null;
      row.csat = t.csat != null ? clamp(around(t.csat, goodness, r, false), 40, 100) : null;
      row.QA   = t.qa   != null ? clamp(around(t.qa,   goodness, r, false), 40, 100) : null;
      row.CPH  = cph;
      row.CPD  = cpd;
      row.adherence = t.adherence != null ? clamp(around(t.adherence, goodness, r, false), 50, 100) : null;
      row.SLA  = (t.sla ?? t.talk_sla) != null ? clamp(around(t.sla ?? t.talk_sla, goodness, r, false), 40, 100) : null;
      row.AHT  = t.aht  != null ? clamp(around(t.aht,  goodness, r, true), 0.5, 30) : null;
      row.ACW  = t.acw  != null ? clamp(around(t.acw,  goodness, r, true), 0.2, 10) : null;
      row.first_call_resolution = t.fcr != null ? clamp(around(t.fcr, goodness, r, false), 40, 100) : null;
      row.resolution_time = t.res_time != null ? clamp(around(t.res_time, goodness, r, true), 1, 200) : null;
      row.response_time   = t.avg_resp_time != null ? clamp(around(t.avg_resp_time, goodness, r, true), 0.3, 40) : null;
      row.error_rate      = t.error_rate != null ? clamp(around(t.error_rate, goodness, r, true), 0, 20) : null;
      row.Sales_Per_Hour  = t.sph != null ? clamp(around(t.sph, goodness, r, false), 0.1, 8) : null;

      // Volumes follow the rate KPIs so totals reconcile with hours worked.
      row.calls   = cph != null ? Math.round(cph * hrs) : (camp.section === 'Sales' ? Math.round(18 + r() * 22) : null);
      row.tickets = cpd != null ? Math.round(cpd * (1 + jitter(r) * 0.12))
                  : (cph != null ? null : Math.round(14 + r() * 18));
      row.sales   = t.sales != null
                  // ÷ 0.93 because a cumulative target is met by the people who
                  // actually turn up, not by the full roster.
                  ? Math.round(t.sales / Math.max(1, (AGENTS_PER_CAMP[camp.key] || 1) * camp.days * 0.93)
                               * (1 + goodness + jitter(r) * 0.25))
                  : (row.Sales_Per_Hour != null ? Math.round(row.Sales_Per_Hour * hrs) : null);
      const abnTgt = t.calls_abn ?? null;
      row.abandoned_calls = (abnTgt != null && row.calls)
        ? Math.round(row.calls * clamp(around(abnTgt, goodness, r, true), 0, 30) / 100) : null;
    } else {
      // Support roles carry hours and a QA score, no contact volumes.
      row.QA = t.qa != null ? clamp(around(t.qa, goodness + 0.03, r, false), 50, 100) : null;
    }
    METRICS.push(row);
  }

  // ── HR feed (EmployeeProfile) ────────────────────────────────────────────
  const JOB_TITLE = {
    agent: 'Brand Ambassador Executive', team_leader: 'Team Leader',
    quality_analyst: 'Quality Analyst', campaign_manager: 'Campaign Manager',
  };
  const CONTRACTS = ['Permanent', 'Permanent', 'Permanent', 'Fixed Term'];
  const EMPLOYEE_PROFILE = PEOPLE.concat(LEAVERS).map((p, i) => ({
    'ID': p.empId,
    'Employee Name': p.name,
    'Employee Number': p.empNo,
    'Job Title': JOB_TITLE[p.role] || 'Brand Ambassador Executive',
    'Reporting To': p.team && p.team !== p.name ? p.team : '',
    'Group Joining Date': iso(p.joined),
    'Date of exit (Last Day of Employment)': p.exit ? iso(p.exit) : '',
    'Reason for Exit': p.reason || '',
    'Employee Status': p.status,
    'Employee Contract Type': CONTRACTS[i % CONTRACTS.length],
    'Department': BY_KEY[p.camp] ? BY_KEY[p.camp].section : 'Customer Services',
    '_campaign_slug': BY_KEY[p.camp] ? BY_KEY[p.camp].slug : null,
  }));

  // Authoritative role list + team assignment (what Postgres serves in prod).
  const N = (globalThis.BoomerangNames && globalThis.BoomerangNames.normalizeName) || ((s) => String(s || '').toLowerCase().trim());
  const ROLE_USERS = PEOPLE.map(p => ({
    full_name: p.name,
    role: p.role === 'team_leader' ? 'tm' : 'agent',
  }));
  const TEAM_MAP_NODES = PEOPLE.map(p => ({
    zoho_user_id: p.uid,
    zoho_employee_no: p.empNo,
    name_key: N(p.name),
    team_node: p.role === 'team_leader' ? p.name : p.team,
    node_type: p.role === 'team_leader' ? 'leader' : 'member',
  }));

  // ── Commercial targets matrix (/api/targets/rules) ───────────────────────
  // Three effective versions per campaign so the Targets tab has real history.
  const EFFECTIVE = [-4, -2, 0].map(n => {
    const d = addMonths(new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 1)), n);
    return iso(d);
  });
  const TARGET_RULES = [];
  for (const c of ROSTER) {
    const r = keyRng('rules|' + c.key);
    const heads = PEOPLE.filter(p => p.camp === c.key);
    const tls = heads.filter(p => p.role === 'team_leader').length;
    const baes = heads.filter(p => p.role === 'agent').length;
    const baeRate = Math.round((118 + r() * 46) * 100) / 100;      // ZAR per productive hour
    EFFECTIVE.forEach((eff, vi) => {
      const growth = 1 - (EFFECTIVE.length - 1 - vi) * 0.03;         // accounts grew into today's baseline
      const fte = Math.round(c.fte * growth);
      const vals = {
        currency: c.section === 'Sales' ? 'ZAR' : 'GBP',
        client_billing: 'Productive hours',
        productive_bae_rate: baeRate,
        bae_saturday_rate: round2(baeRate * 1.5),
        bae_sunday_rate: round2(baeRate * 2),
        public_holiday_rate: round2(baeRate * 2),
        additional_hours_rate: round2(baeRate * 1.15),
        tl_rate: round2(baeRate * 1.55),
        qa_rate: round2(baeRate * 1.4),
        cm_rate: round2(baeRate * 2.1),
        ic2_rate: round2(baeRate * 1.25),
        trainer_rate: round2(baeRate * 1.35),
        tl_sunday_rate: round2(baeRate * 3.1),
        qa_sunday_rate: round2(baeRate * 2.8),
        special_agent_rate_1: round2(baeRate * 1.1),
        special_agent_rate_2: round2(baeRate * 1.2),
        headcount_discount: (r() * 4).toFixed(1) + '%',
        comm_reactivation_rate: c.section === 'Sales' ? '4.5%' : '',
        comm_retention_rate: c.section === 'Sales' ? '3.0%' : '',
        wd_monday: 'Yes', wd_tuesday: 'Yes', wd_wednesday: 'Yes', wd_thursday: 'Yes', wd_friday: 'Yes',
        wd_saturday: c.days >= 6 ? 'Yes' : 'No',
        wd_sunday: c.days >= 7 ? 'Yes' : 'No',
        wd_public_holidays: c.days >= 7 ? 'Yes' : 'No',
        evening_cutoff: '20:00', morning_cutoff: '06:00',
        nb_office_admin: 'Non-billable', nb_gls_team_leader: 'Non-billable',
        training_duration: (2 + Math.floor(r() * 3)) + ' weeks',
        training_days_billable: String(3 + Math.floor(r() * 5)),
        training_rate_daily: round2(baeRate * 7),
        training_rate_monthly: round2(baeRate * 150),
        training_rate_hourly: round2(baeRate * 0.85),
        training_days_not_billable: String(2 + Math.floor(r() * 4)),
        training_coaching_hours: String(4 + Math.floor(r() * 6)),
        nbr_campaign_manager: c.fte >= 60 ? '1' : '0',
        nbr_team_leader: '0',
        nbr_real_time_analyst: c.fte >= 60 ? '1' : '0',
        sbr_team_leader: String(Math.max(1, tls)),
        sbr_baes: String(baes),
        sbr_smes: String(Math.max(0, Math.round(baes / 25))),
        sbr_2ic: String(c.fte >= 40 ? 1 : 0),
        sbr_campaign_manager: String(c.fte >= 20 ? 1 : 0),
        sbr_quality_analyst: String(c.fte >= 20 ? 1 : 0),
        sbr_trainer: String(c.fte >= 60 ? 1 : 0),
        sbr_zendesk_specialist: String(c.fte >= 100 ? 1 : 0),
        sla_min_hrs_fte: String(c.hrsFte),
        target_fte: String(fte),
        target_baes: String(Math.round(fte * 0.86)),
        req_hrs_month: String(Math.round(fte * c.hrsFte)),
        fte_baes: String(Math.round(fte * 0.86)),
        fte_support: String(Math.max(1, tls + 1)),
        fte_cms: String(c.fte >= 20 ? 1 : 0),
      };
      for (const [rule_key, value] of Object.entries(vals)) {
        if (value === '' || value == null) continue;
        TARGET_RULES.push({ campaign_id: c.id, slug: c.slug, name: c.display, effective_from: eff, rule_key, value: String(value) });
      }
    });
  }

  // Approved ad-hoc hours — shows up as an uplift on required hours.
  const ADDITIONAL = [
    { id: 1, campaign_id: BY_KEY.NORTHWIND.id, slug: 'northwind', work_date: iso(addDays(endDate, -12)), hours: 320, note: 'Approved overflow — seasonal peak' },
    { id: 2, campaign_id: BY_KEY.SUMMIT.id,    slug: 'summit',    work_date: iso(addDays(endDate, -26)), hours: 180, note: 'Weekend campaign support' },
    { id: 3, campaign_id: BY_KEY.KESTREL.id,   slug: 'kestrel',   work_date: iso(addDays(endDate, -5)),  hours: 64,  note: 'Product launch cover' },
  ];

  // ── Bonus engine output ──────────────────────────────────────────────────
  // Four accounts run the incentive scheme; three months of history each.
  const BONUS_CAMPS = ['NORTHWIND', 'SUMMIT', 'MERIDIAN_uk', 'BREWHOUSE'].map(k => BY_KEY[k]);
  const BONUS_MONTHS = [0, -1, -2].map(n => ym(addMonths(new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 1)), n)));
  const PERIODS = [];
  let periodSeq = 500;
  for (const m of BONUS_MONTHS) {
    for (const c of BONUS_CAMPS) {
      const [y, mm] = m.split('-').map(Number);
      PERIODS.push({
        id: ++periodSeq, campaign_id: c.id, campaign_name: c.display, campaign_slug: c.slug,
        period_start: `${m}-01`, period_end: iso(new Date(Date.UTC(y, mm, 0))),
        locked: m !== BONUS_MONTHS[0], year_month: m,
      });
    }
  }

  const AWARDS = {};   // period_id → rows
  for (const p of PERIODS) {
    const camp = ROSTER.find(c => c.id === p.campaign_id);
    const r = keyRng('bonus|' + p.id);
    const staff = PEOPLE.filter(x => x.camp === camp.key && (x.role === 'agent' || x.role === 'team_leader'));
    AWARDS[p.id] = staff.map(x => {
      const isTl = x.role === 'team_leader';
      const callouts = r() < 0.72 ? 0 : Math.round(1 + r() * 2);
      const productivity = Math.round(1290 + r() * 430);
      const csat_pct = camp.targets.csat != null ? round2(clamp(0.78 + r() * 0.22, 0, 1)) : null;
      const qa_pct = round2(clamp(0.80 + r() * 0.20, 0, 1));
      const sa = callouts === 0 ? 250 : 0;
      const prodC = productivity >= 1470 ? (isTl ? 500 : 350) : 0;
      const csatC = csat_pct != null && csat_pct >= 0.9 ? 300 : 0;
      const qaC = qa_pct >= 0.9 ? 300 : 0;
      const kpi_bonus = prodC + csatC + qaC;
      const qualified = callouts === 0 && productivity >= 1470;
      return {
        user_id: x.uid, full_name: x.name, user_role: isTl ? 'tm' : 'agent',
        team_name: isTl ? x.name : x.team, tm_name: isTl ? x.name : x.team,
        attendance_days: Math.round(18 + r() * 5),
        productivity, csat_pct, qa_pct, callouts,
        components: { sa, productivity: prodC, csat: csatC, qa: qaC },
        kpi_bonus, final_bonus: qualified ? sa + kpi_bonus : 0, qualified,
        calculated_at: `${p.year_month}-28T06:00:00Z`,
      };
    });
  }

  function bonusSummary(month) {
    const m = BONUS_MONTHS.includes(month) ? month : BONUS_MONTHS[0];
    const campaigns = PERIODS.filter(p => p.year_month === m).map(p => {
      const rows = AWARDS[p.id] || [];
      const levels = {};
      for (const role of ['agent', 'tm']) {
        const rs = rows.filter(x => x.user_role === role);
        if (!rs.length) continue;
        levels[role] = {
          awarded: rs.length,
          qualified: rs.filter(x => x.qualified).length,
          total: rs.reduce((a, x) => a + x.final_bonus, 0),
        };
      }
      return {
        campaign_id: p.campaign_id, name: p.campaign_name, period_id: p.id, locked: p.locked,
        total: rows.reduce((a, x) => a + x.final_bonus, 0), levels,
      };
    });
    return { months: BONUS_MONTHS, month: m, campaigns };
  }

  // ── The demo viewer ──────────────────────────────────────────────────────
  // EXCO: sees every campaign and the commercial views, but no admin settings.
  const DEMO_USER = {
    id: 1, email: 'demo@example.com', name: 'Demo Viewer', role: 'exco',
    campaign_id: null, campaign_name: null, team_id: null, team_name: null,
    must_change_password: false, active: true,
  };

  // ── In-memory API ────────────────────────────────────────────────────────
  const J = (body, status) => new Response(JSON.stringify(body), {
    status: status || 200, headers: { 'Content-Type': 'application/json' },
  });
  const READ_ONLY = () => J({ error: 'demo_read_only', message: 'This is an offline demo — changes are not saved.' }, 403);

  function route(method, path, params) {
    if (method !== 'GET') {
      if (path === '/api/auth/logout') return J({ ok: true });
      return READ_ONLY();
    }
    switch (path) {
      case '/api/auth/me':                 return J({ user: DEMO_USER });
      case '/api/settings/tab-visibility': return J({ visibility: {} });
      case '/api/shift-rules':             return J({ active: SHIFT_RULES, rules: SHIFT_RULES });
      case '/api/campaigns/config':        return J(CAMPAIGN_CONFIG);
      case '/api/campaigns':               return J({ campaigns: campaignRows() });
      case '/api/teams/campaigns':         return J({ campaigns: campaignRows() });
      case '/api/targets/rules':           return J({ rules: TARGET_RULES });
      case '/api/targets':                 return J({ targets: [] });
      case '/api/targets/additional':      return J({ additional: ADDITIONAL });
      case '/api/users/roles':             return J({ users: ROLE_USERS });
      case '/api/users/team-map':          return J({ nodes: TEAM_MAP_NODES });
      case '/api/bonus/periods':           return J({ periods: PERIODS });
      case '/api/bonus/summary':           return J(bonusSummary(params.get('year_month')));
      case '/api/bonus/awards': {
        const id = parseInt(params.get('period_id'), 10);
        return J({ rows: AWARDS[id] || [], team_match: true });
      }
      case '/api/bonus/rules/all':         return J({ campaigns: [] });
    }
    const zoho = path.match(/^\/api\/zoho\/view\/(.+)$/);
    if (zoho) {
      const view = decodeURIComponent(zoho[1]);
      if (view === 'AttendanceUserReport') return J({ data: ATTENDANCE });
      if (view === 'EmployeeProfile')      return J({ data: EMPLOYEE_PROFILE });
      return J({ data: METRICS });
    }
    return J({ error: 'not_found', path }, 404);
  }

  function campaignRows() {
    return ROSTER.map(c => ({
      id: c.id, slug: c.slug, name: c.display, display_name: c.display,
      shift_key: c.key, section: c.section, active: true,
    }));
  }

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  // fetch() is called three ways in this app: with a plain path string, with a
  // URL object (fetchView builds one), and with a Request. Normalise all three
  // — a URL object has no .url, and treating it as '' would send the call to
  // the network instead of the in-memory API.
  const urlOf = (input) => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
  };
  window.fetch = function (input, init) {
    const url = urlOf(input);
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    let path = url, params = new URLSearchParams();
    try {
      const u = new URL(url, 'http://demo.local');
      path = u.pathname; params = u.searchParams;
    } catch (_) { /* keep the raw string */ }
    if (path.indexOf('/api/') === 0) return Promise.resolve(route(method, path, params));
    return realFetch ? realFetch(input, init) : Promise.reject(new Error('offline demo'));
  };

  // ── Demo chrome ──────────────────────────────────────────────────────────
  // No sign-out (there is no session), and a badge that never claims "live".
  const style = document.createElement('style');
  style.textContent = `
    #userMenu{display:none !important}
    #userChip{cursor:default}
    .demo-note{font-size:10px;color:var(--text3);font-family:var(--mono);
      letter-spacing:0.6px;text-transform:uppercase;padding:2px 8px;border:1px solid var(--border);
      border-radius:999px;white-space:nowrap}
  `;
  document.head.appendChild(style);

  globalThis.BOOMERANG_DEMO = {
    campaigns: ROSTER, people: PEOPLE, leavers: LEAVERS,
    metricRows: METRICS.length, attendanceRows: ATTENDANCE.length,
  };
  console.info(`[demo] ${ROSTER.length} campaigns · ${PEOPLE.length} people · ${METRICS.length} metric rows · ${ATTENDANCE.length} attendance rows · ${LEAVERS.length} HR leaver records. All data is fictional.`);
})();
