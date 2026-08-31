// Pure transformer: turn the three campaign-config row lists (campaigns,
// campaign_kpis, campaign_workgroups) into the flat maps the browser needs to
// overlay WG_MAP / CAMP_DISPLAY / CAMP_SECTION / TARGETS / KPI_CONFIG /
// SLUG_TO_CAMPKEY. Kept dependency-free so the test suite can call it with
// fixture rows without opening a DB connection.
//
// Row shapes:
//   camp: { slug, shift_key, display_name, section }
//   kpi:  { shift_key, kpi_key, label, direction, target, priority, is_tile }
//         Rows arrive sorted by priority ascending (see the SQL ORDER BY).
//   wg:   { label, shift_key }
export function buildCampaignConfig(campRows, kpiRows, wgRows) {
  const CAMP_DISPLAY = {}, CAMP_SECTION = {}, SLUG_TO_CAMPKEY = {};
  for (const c of campRows) {
    if (c.display_name) CAMP_DISPLAY[c.shift_key] = c.display_name;
    if (c.section)      CAMP_SECTION[c.shift_key] = c.section;
    if (c.slug)         SLUG_TO_CAMPKEY[c.slug]   = c.shift_key;
  }
  const WG_MAP = {};
  for (const w of wgRows) WG_MAP[w.label] = w.shift_key;
  const KPI_CONFIG = {}, TARGETS = {};
  for (const k of kpiRows) {
    if (k.is_tile) {
      (KPI_CONFIG[k.shift_key] ||= []).push([k.kpi_key, k.label, k.direction]);
    }
    if (k.target != null) {
      (TARGETS[k.shift_key] ||= {})[k.kpi_key] = Number(k.target);
    }
  }
  return { WG_MAP, CAMP_DISPLAY, CAMP_SECTION, TARGETS, KPI_CONFIG, SLUG_TO_CAMPKEY };
}
