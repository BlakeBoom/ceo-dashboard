# Proposal: drive team structure from the reporting hierarchy

**Status:** DRAFT — proposal only, nothing here is implemented.
**Author:** Claude Code · **Depends on:** the role-index fixes merged in PR #10.

## Why

Team membership is currently reconstructed in the browser by parsing the messy
`User_metrics_3.team_name` label (`"Rugshana's team"`) and guessing leaders from
job titles. That path has produced a string of production bugs (unstripped name
keys, team-label matching, scoped role feeds, everyone-in-one-bucket). The
discovery run on live data showed a far stronger signal already sitting in
EmployeeProfile:

| Metric (active employees) | Value |
|---|---|
| Active employees | 609 |
| `Reporting To (Name)` parses to a trailing employee number | 593 (97.4%) |
| …and that number matches an **active** Employee ID | **593 / 593 (100%)** |
| Distinct people with ≥1 active direct report | 71 |
| Active employees with no manager | 6 |

A reporting edge (`employee → manager employee-number`) resolves 100% of the
time once parsed. Combined with the **authoritative role** we already resolve
server-side (`users.role`), that lets us build team structure from exact IDs
instead of fuzzy strings.

## The rule we are encoding (from the business owner)

- **All hours show under some team** — no hour is dropped.
- **A Team Leader's node** = the TL's own hours + productivity **plus every
  BAE/agent that reports to them**.
- **A Campaign Manager's node** = everyone in the campaign **not already under a
  TL**: people who report directly to the CM, plus the unassigned — and the CM's
  own hours.

## What we already have (no change needed)

- `users.role` — `agent | tm | campaign_lead | admin | exco`, resolved from Job
  Title lookup ids by `provision.js`. This is our TL/CM/agent classifier.
- `users.zoho_employee_no` — the HR "Employee Number"; this is the join key to
  EmployeeProfile's `Employee ID` **and** the trailing number in
  `Reporting To (Name)`.
- `users.zoho_user_id` — equals `User_metrics_3.user_id`, so metrics rows join
  to `users` by exact id (today's grouping relies on fuzzy `team_name` instead).
- `teams (id, campaign_id, name, tm_user_id)` and `users.team_id`.

## What is missing

One edge: **who reports to whom.** Nothing in Postgres stores the manager link.

---

## Design

### 1. Schema — migration `0013_user_manager.sql`

```sql
-- Manager link, resolved from EmployeeProfile "Reporting To (Name)".
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INT
  REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_manager_idx ON users (manager_id);
```

Forward-only, additive, nullable — no backfill risk. (New numbered file; never
edit an applied migration.)

### 2. Populate `manager_id` during provisioning/sync

`provision.js` already reads EmployeeProfile. Add one resolved field per row:

```js
// "Amaarah De Vries 1302" -> "1302". Trailing employee number only.
// NOTE: loosen from the discovery snippet's \d{3,} to \d+ — the 10 unparsed
// rows were short IDs ("Robert Joubert 1", "... Pavy 17"), not garbage.
function managerEmployeeNo(reportingToName) {
  const m = String(reportingToName ?? '').match(/(\d+)\s*$/);
  return m ? m[1] : null;
}
```

Then, in a second pass after users exist (so the FK target is present):

```sql
UPDATE users u
   SET manager_id = mgr.id
  FROM users mgr
 WHERE mgr.zoho_employee_no = $manager_no
   AND mgr.active = TRUE
   AND u.zoho_employee_no = $employee_no;
```

- Resolve only against **active** managers. An inactive/unmatched manager leaves
  `manager_id` NULL → the person falls to the campaign CM / Unassigned bucket.
- `Secondary Reporting to` (dotted-line) is **ignored** for the primary tree.

### 3. Team-node assignment (the rule, as an algorithm)

Pure function over `{ role, manager_id, campaign_id }`, no fuzzy matching:

```
teamNodeFor(user):
  if user.role == 'tm':                      # a TL is their own node
      return TL(user)

  # agent (or 2IC/QA/etc. that isn't a tm): walk UP the manager chain
  seen = {}                                   # cycle guard
  m = user.manager
  while m and m.id not in seen:
      seen.add(m.id)
      if m.role == 'tm':            return TL(m)   # nearest TL ancestor wins
      if m.role == 'campaign_lead': return CM(m)   # hit a CM before any TL
      m = m.manager

  # no TL/CM in the chain → campaign catch-all, else org Unassigned
  return campaignCM(user.campaign_id) or UNASSIGNED
```

This is exactly the owner's rule:
- **TL node** = TL + everyone whose nearest managerial ancestor is that TL.
- **CM node** = the CM + direct-report agents + anyone whose chain reaches the CM
  without passing a TL + (via the catch-all) the unassigned.
- Every user resolves to a node → **all hours shown under teams**.

Rollups are unchanged: the existing aggregation sums metrics per node; we only
change which node a row is assigned to.

### 4. Serve it to the dashboard

The metrics rows key by `zoho_user_id`, and so do `users` — so we can hand the
browser an **exact** map and delete the string parsing.

`GET /api/team-structure` (authenticated; org-wide name+role is already
precedented by `/api/users/roles`):

```json
{ "nodes": [
  { "zoho_user_id": "5567", "team_node": "Rugshana Hendricks",
    "node_type": "tl", "campaign_slug": "beer52" },
  { "zoho_user_id": "5570", "team_node": "Rugshana Hendricks",
    "node_type": "tl", "campaign_slug": "beer52" },
  { "zoho_user_id": "5588", "team_node": "Amaarah De Vries — direct & unassigned",
    "node_type": "cm", "campaign_slug": "beer52" }
] }
```

### 5. Dashboard change

`resolveTeamNode(personName, leaderName, index, unassigned)` becomes a lookup by
`r.user_id` against this map:

```js
resolveTeamNode(r) = structureByUserId.get(String(r.user_id))?.team_node
                     ?? UNASSIGNED_TEAM;   // no structure row → unassigned
```

Retired once verified: title parsing (`titleToRole` for the index),
team-label parsing (`resolveLeaderLabel`), first-name-unique guessing, and
`buildTeamCanonMap` **for team nodes** (node names are now canonical ids, so
there's nothing to fold). The BUG-4 unassigned-share guard **stays** as a
safety net through the transition.

**Not retired:** `buildNameMatcher` (name → Employee ID) is still needed for the
attendance/billable EmployeeProfile↔metrics join, which has no shared id. Be
honest that this migration removes 3 of the 4 fragile mechanisms, not all 4 —
but it removes the 3 that actually broke.

---

## Rollout (three shippable PRs, in order)

1. **Data** — migration `0013` + `manager_id` resolution in provisioning + an
   admin diagnostic reporting: # TL nodes, # CM catch-alls, unassigned share,
   and any users whose `manager_id` didn't resolve. No UI change. Verify the
   tree looks right before anything renders from it.
2. **Serve + read** — `GET /api/team-structure`; `resolveTeamNode` consults it
   by `user_id`, behind a fallback to the current path for one release. Verify
   **Beer52 W30 2026 reconciles to 298.55** and `"Rugshana's team"` +
   `"Rugshana Hendricks"` land in one node.
3. **Cleanup** — delete the retired parsing paths once (2) is confirmed live.

## Campaign attribution — explicitly out of scope

The discovery showed `Department` is unresolved lookup ids (21 distinct) and
`Division Name` is only `Customer Service / Sales / Boomerang Team` — neither is
campaign. Campaign stays on the existing `workgroup → WG_MAP` path. The team
node is *within* a campaign; this proposal does not touch campaign mapping.

## Edge cases / decisions I need from you

1. **CM catch-all label.** What should it read in the Teams list? Proposed:
   `"<CM name> — direct & unassigned"`. Alternatives: `"<Campaign> — unassigned"`.
2. **CM's own hours.** The rule says "assigned to the CM," so the CM's own
   metrics land in their catch-all node. Confirm.
3. **No campaign + no manager.** Org-level `— Unassigned`, or drop (they produce
   no hours anyway)? Proposed: org-level Unassigned so no hour is ever dropped.
4. **A TL reporting to another TL.** Sub-TL is their own node; the parent TL does
   **not** absorb the sub-TL's agents. Confirm that's the intent.
5. **Manager parses but is inactive/unmatched.** Treat as no manager → CM/Unassigned.
6. **Refresh cadence.** `manager_id` is resolved at provisioning/sync time
   (daily). Acceptable, or does it need to be live?
7. **Regex loosening** (`\d+` trailing) risks a name that genuinely ends in a
   number. The data looks clean ("Name <id>"), but flag if you know exceptions.

## Verification plan

- Unit tests (in `test/`, no new deps): `teamNodeFor` over a fixture tree
  covering agent→TL, agent→CM-direct, unassigned, TL-under-TL, and a reporting
  cycle (must not loop).
- Live reconciliation: Beer52 W30 2026 = **298.55** across its team buckets;
  org-wide unassigned share below the existing 60% guard.
