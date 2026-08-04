// Team-structure resolution from the reporting hierarchy + roles.
//
// Pure functions, NO imports — so the diagnostic script, the (future) API
// endpoint, and node:test can all use them without a DB or env. The rule (signed
// off by the business owner):
//   • a Team Leader (role 'tm') is their OWN node — their hours + their agents;
//   • a Campaign Manager (role 'campaign_lead') is their own catch-all node;
//   • an agent lands under the NEAREST managerial ancestor: a TL if one is hit
//     first, otherwise the CM whose chain they're in;
//   • anyone with no TL/CM in their chain falls to their campaign's CM
//     catch-all, or org-level "— Unassigned" if the campaign has no single CM —
//     so no hour is ever dropped.

export const UNASSIGNED_TEAM = '— Unassigned';

// "Amaarah De Vries 1302" → "1302". The manager's HR number is a trailing token.
// \d+ (not \d{3,}) on purpose: some managers have 1–2 digit numbers
// ("Robert Joubert 1"), which the discovery snippet's \d{3,} missed.
export function managerEmployeeNo(reportingToName) {
  const m = String(reportingToName ?? '').match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

function tlLabel(u) { return u.full_name; }
function cmLabel(u) { return `${u.full_name} — direct & unassigned`; }

// Resolve one user to { node, type }. `byId` maps user.id → user; `cmByCampaign`
// maps campaign_id → the campaign's sole CM (or absent when 0 or >1 CMs).
export function teamNodeFor(user, byId, cmByCampaign) {
  if (!user) return { node: UNASSIGNED_TEAM, type: 'unassigned' };
  if (user.role === 'tm') return { node: tlLabel(user), type: 'tl' };
  if (user.role === 'campaign_lead') return { node: cmLabel(user), type: 'cm' };

  // agent (or 2IC/QA/etc. that isn't a manager): walk UP the reporting chain.
  const seen = new Set([user.id]);            // cycle guard
  let m = user.manager_id != null ? byId.get(user.manager_id) : null;
  while (m && !seen.has(m.id)) {
    seen.add(m.id);
    if (m.role === 'tm') return { node: tlLabel(m), type: 'tl' };
    if (m.role === 'campaign_lead') return { node: cmLabel(m), type: 'cm' };
    m = m.manager_id != null ? byId.get(m.manager_id) : null;
  }
  // No TL/CM ancestor → the campaign's CM catch-all, else org Unassigned.
  const cm = user.campaign_id != null ? cmByCampaign.get(user.campaign_id) : null;
  if (cm) return { node: cmLabel(cm), type: 'cm' };
  return { node: UNASSIGNED_TEAM, type: 'unassigned' };
}

// A campaign's catch-all CM is only auto-assigned when the campaign has EXACTLY
// one CM — otherwise "the campaign's CM" is ambiguous and we don't guess.
export function cmByCampaignFrom(users) {
  const count = new Map();
  const pick = new Map();
  for (const u of users) {
    if (u.role === 'campaign_lead' && u.campaign_id != null) {
      count.set(u.campaign_id, (count.get(u.campaign_id) || 0) + 1);
      pick.set(u.campaign_id, u);
    }
  }
  for (const [cid, n] of count) if (n !== 1) pick.delete(cid);
  return pick;
}

// Resolve every user to a node and summarise. Returns { nodes, stats }.
export function computeTeamStructure(users) {
  const byId = new Map(users.map(u => [u.id, u]));
  const cmByCampaign = cmByCampaignFrom(users);
  const nodes = [];
  const stats = { total: 0, tl: 0, cm: 0, unassigned: 0 };
  const tlNodes = new Set(), cmNodes = new Set();
  for (const u of users) {
    const { node, type } = teamNodeFor(u, byId, cmByCampaign);
    nodes.push({ user_id: u.id, zoho_user_id: u.zoho_user_id, campaign_id: u.campaign_id, team_node: node, node_type: type });
    stats.total++;
    stats[type]++;
    if (type === 'tl') tlNodes.add(node);
    if (type === 'cm') cmNodes.add(node);
  }
  stats.tlNodeCount = tlNodes.size;
  stats.cmNodeCount = cmNodes.size;
  stats.unassignedShare = stats.total ? stats.unassigned / stats.total : 0;
  return { nodes, stats };
}
