/* Build the standalone, offline, anonymised demo of the operations dashboard.
 *
 *   node demo/build-demo.mjs
 *
 * Output: demo/boomerang-dashboard-demo.html — one self-contained file that
 * opens straight from the filesystem (double-click, no server, no login, no
 * network) and renders the real dashboard against a fictional dataset.
 *
 * The production UI is reused verbatim. Only three things change:
 *   1. the three /shared/*.js modules are inlined (file:// can't fetch them);
 *   2. a demo runtime is injected ahead of the app script — it generates the
 *      dataset and answers every /api/* call in memory;
 *   3. every real client name left in the source is renamed to its fictional
 *      counterpart, and the internal Zoho / Apps Script identifiers are removed.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(HERE, 'boomerang-dashboard-demo.html');

// ── Client anonymisation ────────────────────────────────────────────────────
// Ordered longest-first: every spelling of a real account that survives in the
// source (constants, regexes, comments, UI copy) maps to its demo counterpart.
// The demo runtime serves the campaign config, so these renames exist to make
// the FILE itself clean — nothing identifying ships to the person presenting.
const RENAMES = [
  // Meridian (two geographies, one account family)
  ['JUSTPARK_usa', 'MERIDIAN_us'], ['JUSTPARK_uk', 'MERIDIAN_uk'], ['JUSTPARK_so', 'MERIDIAN_so'],
  ['JUST PARK US', 'MERIDIAN US'], ['JUST PARK UK', 'MERIDIAN UK'], ['JUST PARK', 'MERIDIAN'],
  ['JustPark Space Owner', 'Meridian Space Owner'], ['Just Park Space Owner', 'Meridian Space Owner'],
  ['JustPark Event Pass', 'Meridian Event Pass'], ['JustPark SP', 'Meridian SP'],
  ['JustPark US', 'Meridian US'], ['JustPark UK', 'Meridian UK'],
  ['JUSTPARK', 'MERIDIAN'], ['JustPark', 'Meridian'], ['Just Park', 'Meridian'],
  ['justpark', 'meridian'], [/just\\s\*park/g, 'meridian'], [/just\s*park/gi, 'Meridian'],

  // Northwind Health
  ['MEDEXPRESS', 'NORTHWIND HEALTH'], ['MedExpress', 'Northwind'], ['Medexpress', 'NORTHWIND'],
  ['medexpress', 'northwind'], [/med\\s\*express\|\\bmedx\\b/g, 'northwind|\\bnwh\\b'],
  [/med\s*express/gi, 'Northwind'], [/\bmedx\b/gi, 'NWH'],

  // Summit Retail
  ['PICKNPAY', 'SUMMIT'], ['PicknPay', 'Summit'], ['picknpay', 'summit'],
  [/pic\?k\\s\*n\\s\*pay\|\\bpnp\\b/g, 'summit|\\bsmt\\b'],
  [/pick\s*n\s*pay/gi, 'Summit'], [/\bPnP\b/g, 'SMT'], [/\bpnp\b/g, 'smt'],

  // Kestrel Petcare
  ['BUTTERNUT BOX', 'KESTREL PETCARE'], ['BUTTERNUTBOX', 'KESTREL'],
  ['Butternut Box', 'Kestrel Petcare'], ['butternutbox', 'kestrel'],
  ['Butternut', 'Kestrel'], ['butternut', 'kestrel'],
  ['BBOX', 'KSTL'], ['bbox', 'kstl'], ['BB Marro', 'KP Nest'], ['Marro', 'Nest'], ['marro', 'nest'],

  // Clarity Care
  ['GOODLIFESORTED', 'CLARITY'], ['GOOD LIFE SORTED', 'CLARITY CARE'],
  ['The Good Life Sorted', 'Clarity Care'], ['thegoodlifesorted', 'clarity'],
  ['Good Life', 'Clarity'], [/good\s*life/gi, 'Clarity'],
  [/\bGLS\b/g, 'CLR'], [/\bgls\b/g, 'clr'],

  // Lumen Nutrition
  ['ROYAL CANIN', 'LUMEN NUTRITION'], ['ROYALCANIN', 'LUMEN'],
  ['Royal Canin', 'Lumen Nutrition'], ['RoyalCanin', 'LumenNutrition'],
  ['royalcanin', 'lumen'], [/royal\s*canin/gi, 'Lumen'],

  // Halcyon Petcare
  ['VETNIQUE', 'HALCYON'], ['Vetnique', 'Halcyon'], ['vetnique', 'halcyon'],
  ['Lint Bells', 'Halcyon'], ['Lintbells', 'Halcyon'], ['lintbells', 'halcyon'],
  [/lint\s*bells/gi, 'Halcyon'],

  // Orchid
  ['HUNZAG', 'ORCHID'], ['HunzaG', 'Orchid'], ['hunzag', 'orchid'], [/hunza\s*g/gi, 'Orchid'],

  // Aurora Foods
  ['GOUSTO', 'AURORA FOODS'], ['Gousto', 'AURORA'], ['gousto', 'aurora'],

  // Brewhouse
  ['PINTER', 'BREWHOUSE'], ['Pinter', 'Brewhouse'], ['pinter', 'brewhouse'],

  // Caskway
  ['BEER52', 'CASKWAY'], ['Beer52', 'Caskway'], ['beer52', 'caskway'], [/beer\s*52/gi, 'Caskway'],

  // Sentinel Cover
  ['1LIFE', 'SENTINEL'], ['1life', 'sentinel'], [/one\s*life/gi, 'Sentinel'],

  // Vantage Events (and its event-name shift labels)
  ['HYVE', 'VANTAGE'], ['Hyve', 'Vantage'], ['hyve', 'vantage'],
  ['Investing in African Mining Indaba', 'the flagship trade expo'],
  ['Mining Indaba', 'Trade Expo'], ['Indaba', 'Expo'], ['indaba', 'expo'],
  ['CWIEME', 'CONVENE'], ['C-WIEME', 'C-ONVENE'], ['cwieme', 'convene'],
  ['Spring Fair', 'Trade Fair'], ['spring[\\s-]*fair', 'trade[\\s-]*fair'],

  // Internal identifiers and residual personal names
  ['Automation_Rules_2026.xlsx', 'the commercial rules workbook'],
  ['Elzette Saaiman', 'Sam Walker'], ['Elzette', 'Sam'],
  ['elzettes', 'sams'], ['elzette', 'sam'],
  ['Alpha_BI', 'Demo_BI'],
];

// $-sequences ($&, $`, $') are special in a string replacement, and both the
// shared modules and the demo runtime contain them. Every substitution below
// therefore goes through a replacer FUNCTION, which is taken literally.
const lit = (to) => () => to;
const applyRenames = (src) => RENAMES.reduce(
  (s, [from, to]) => (from instanceof RegExp ? s.replace(from, lit(to)) : s.replaceAll(from, lit(to))),
  src,
);

// ── Build ───────────────────────────────────────────────────────────────────
const read = (p) => readFile(resolve(ROOT, p), 'utf8');

let html = await read('index.html');
const shared = {
  names: await read('shared/names.js'),
  churn: await read('shared/churn.js'),
  hours: await read('shared/hours.js'),
};
const runtime = await read('demo/demo-runtime.js');

// 1 ─ Inline the shared modules and inject the demo runtime ahead of the app.
const SHARED_TAGS = `<script src="/shared/names.js"></script>
<script src="/shared/churn.js"></script>
<script src="/shared/hours.js"></script>`;
if (!html.includes(SHARED_TAGS)) throw new Error('shared <script> block not found — index.html changed shape');
html = html.replace(SHARED_TAGS, lit(
  `<script>\n${shared.names}\n</script>\n` +
  `<script>\n${shared.churn}\n</script>\n` +
  `<script>\n${shared.hours}\n</script>\n` +
  `<!--__DEMO_RUNTIME__-->`));

// 2 ─ Targeted patches to the app so it runs offline and never claims "live".
const patch = (from, to, label) => {
  if (!html.includes(from)) throw new Error(`patch target missing: ${label}`);
  html = html.replaceAll(from, lit(to));
};

// file:// has a null origin, so new URL(path, location.origin) would throw.
patch("new URL(`/api/zoho/view/${encodeURIComponent(viewName)}`, location.origin)",
      "new URL(`/api/zoho/view/${encodeURIComponent(viewName)}`, 'http://demo.local')",
      'fetchView origin');

// The badge must read "Demo data", never "Live".
patch("setBadge('live', STATE.shrinkageAvailable ? 'Live · shrinkage on' : 'Live')",
      "setBadge('live', 'Demo data')", 'live badge');

// No point re-generating an identical dataset every 30 minutes.
patch('REFRESH_INTERVAL_MS: 30 * 60 * 1000', 'REFRESH_INTERVAL_MS: 24 * 60 * 60 * 1000', 'refresh interval');

// Strip the internal Zoho / Apps Script configuration entirely.
patch("PROXY_URL: 'https://script.google.com/macros/s/AKfycbzedp1ePsFRZeaOjvUSo4wAFF-uxYiESfFter5lKNba637svO-iC0viQU4wADN5_Fbg/exec',",
      "PROXY_URL: '',", 'proxy url');
patch("ORG_ID: '723580241',", "ORG_ID: 'DEMO-ORG',", 'org id');

// The footer must not name an internal feed, nor claim the data is live.
patch("Source: ${STATE.dataSource === 'live' ? 'Zoho User_metrics_3 (live)' : 'Embedded W19\u2013W22 snapshot'} \u00b7 Rendered",
      "Source: illustrative demo dataset (generated in-browser) \u00b7 Rendered", 'footer source');

// Fully offline: no webfont fetch, so the file works with no network at all.
patch('<link rel="preconnect" href="https://fonts.googleapis.com">\n<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">\n',
      '', 'google fonts');

// Brand line: label it a demo so nobody mistakes the numbers for the real book.
patch('<span class="brand-sub">Operations dashboard · v2</span>',
      '<span class="brand-sub">Operations dashboard · demo</span>\n      <span class="demo-note">Illustrative data</span>',
      'brand sub');
patch('<title>Boomerang BPO — Operations Dashboard</title>',
      '<title>Boomerang BPO — Operations Dashboard (Demo)</title>', 'title');

// 3 ─ Anonymise every real client name left in the app/shared source, then
//     drop in the demo runtime (which carries no real names of its own).
html = applyRenames(html);
html = html.replace('<!--__DEMO_RUNTIME__-->', lit(`<script>\n${runtime}\n</script>`));

// 4 ─ Refuse to ship if anything identifying survived.
const LEAKS = [/gousto/i, /butternut/i, /just\s*park/i, /medexpress/i, /med\s*express/i, /pick\s*n\s*pay/i,
  /picknpay/i, /royal\s*canin/i, /royalcanin/i, /vetnique/i, /lintbells/i, /hunzag/i, /pinter/i,
  /beer\s*52/i, /1life/i, /\bhyve\b/i, /indaba/i, /cwieme/i, /goodlifesorted/i, /script\.google\.com/i,
  /723580241/, /Elzette/i];
const found = LEAKS.filter(re => re.test(html));
if (found.length) throw new Error('anonymisation incomplete — still present: ' + found.map(String).join(', '));

await mkdir(HERE, { recursive: true });
await writeFile(OUT, html, 'utf8');
console.log(`Wrote ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB) — no identifying strings remain.`);
