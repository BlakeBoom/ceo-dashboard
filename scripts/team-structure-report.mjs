// One-off diagnostic for rollout Step 1 — eyeball the team structure computed
// from users.role + users.manager_id BEFORE the dashboard renders from it.
//
//   Run after provisioning has populated manager_id:
//     DATABASE_URL='postgres://…' node scripts/team-structure-report.mjs
//
// Read-only. JWT_SECRET is defaulted (unused) so only DATABASE_URL is required.
process.env.JWT_SECRET ??= 'diagnostic-not-used';
const { query, pool } = await import('../server/src/db.js');
const { computeTeamStructure } = await import('../server/src/teamStructure.js');

const { rows: users } = await query(
  `SELECT id, full_name, role, campaign_id, manager_id, zoho_user_id
     FROM users WHERE active = TRUE`
);

const withMgr = users.filter(u => u.manager_id != null).length;
const { nodes, stats } = computeTeamStructure(users);

console.log('active users:', users.length, '| with manager_id set:', withMgr,
  `(${((withMgr / (users.length || 1)) * 100).toFixed(1)}%)`);
console.log(`team nodes: ${stats.tlNodeCount} TL, ${stats.cmNodeCount} CM catch-all`);
console.log(`assignment: ${stats.tl} under a TL, ${stats.cm} under a CM, ` +
  `${stats.unassigned} unassigned (${(stats.unassignedShare * 100).toFixed(1)}%)`);

const byNode = new Map();
for (const n of nodes) byNode.set(n.team_node, (byNode.get(n.team_node) || 0) + 1);
const top = [...byNode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('\ntop 25 team nodes by member count:');
for (const [node, c] of top) console.log(`  ${String(c).padStart(4)}  ${node}`);

const agentsNoMgr = users.filter(u => u.manager_id == null && u.role === 'agent').length;
console.log(`\nagents with no manager_id (→ campaign CM catch-all / Unassigned): ${agentsNoMgr}`);

await pool.end();
