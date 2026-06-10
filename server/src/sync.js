// End-to-end Zoho → Neon sync for one bonus period.
//
// Steps:
//   1. Resolve the period (default: current calendar month) for the campaign,
//      and the active bonus_rules row.
//   2. Fetch User_metrics_3 + AttendanceUserReport + EmployeeProfile rows.
//   3. Filter to just this campaign's workgroup(s).
//   4. Auto-create any missing teams + agents seen in the data so first-run
//      bootstrap takes one click instead of manual user setup.
//   5. Aggregate per-agent monthly metrics, UPSERT bonus_metrics.
//   6. Apply rule_json → UPSERT bonus_awards.
//
// Called from the cron handler and the manual `/api/sync/now` endpoint.

import { query, withTx } from './db.js';
import { fetchView, VIEW, monthBounds } from './zoho.js';
import { aggregateUserMetrics, aggregateCallouts, buildEmployeeUserMap, applyRule } from './bonus.js';

// Campaign slug → list of Zoho "workgroup" values to include. Mirrors the
// existing dashboard's WG_MAP. Add new campaigns here as they're rolled out.
const CAMPAIGN_WORKGROUPS = {
  'medexpress':        ['MedExpress'],
  'picknpay':          ['PICKnPAY'],
  'butternutbox':      ['BBOX', 'Butternut Box'],
  'pinter':            ['Pinter'],
  'boomerang-internal': [],
};

export function currentYearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function syncCampaign(campaignId, yearMonth = currentYearMonth()) {
  // 1. Get campaign slug + active rule_json
  const { rows: campRows } = await query(`SELECT slug FROM campaigns WHERE id = $1`, [campaignId]);
  if (!campRows.length) return { campaign_id: campaignId, error: 'campaign_not_found' };
  const slug = campRows[0].slug;
  const validWorkgroups = CAMPAIGN_WORKGROUPS[slug] || [];

  const { rows: ruleRows } = await query(
    `SELECT id, rule_json FROM bonus_rules
      WHERE campaign_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [campaignId, `${yearMonth}-01`]
  );
  if (!ruleRows.length) return { campaign_id: campaignId, skipped: 'no_active_rule' };
  const ruleId = ruleRows[0].id;
  const rule = ruleRows[0].rule_json;

  // 2. Ensure bonus_period row exists
  const { start, end } = monthBounds(yearMonth);
  const { rows: periodRows } = await query(
    `INSERT INTO bonus_periods (campaign_id, period_start, period_end)
     VALUES ($1, $2::date, $3::date)
     ON CONFLICT (campaign_id, period_start, period_end) DO UPDATE SET period_start = EXCLUDED.period_start
     RETURNING id, locked`,
    [campaignId, start, end]
  );
  const period = periodRows[0];
  if (period.locked) return { campaign_id: campaignId, period_id: period.id, skipped: 'locked' };

  // 3. Fetch from Zoho
  const dateCriteria = `"Date" >= '${start}' AND "Date" <= '${end}'`;
  const [umRowsRaw, attRows, empRows] = await Promise.all([
    fetchView(VIEW.userMetrics, { criteria: dateCriteria }),
    fetchView(VIEW.attendance,  { criteria: dateCriteria }),
    fetchView(VIEW.employee),
  ]);

  // 4. Filter to this campaign's workgroups. Empty list = no rows.
  const umRows = validWorkgroups.length
    ? umRowsRaw.filter(r => validWorkgroups.includes(r.workgroup))
    : [];

  if (umRows.length === 0) {
    return { campaign_id: campaignId, period_id: period.id, skipped: 'no_matching_workgroup_rows', workgroups: validWorkgroups };
  }

  // 5. Aggregate
  const productivityComponent = (rule.components || []).find(c => c.key === 'productivity');
  const productivityColumn = productivityComponent?.metric_column || 'tickets';
  const metricsByUser = aggregateUserMetrics(umRows, { productivityColumn });
  const empToUser = buildEmployeeUserMap(empRows, metricsByUser);
  const calloutsByEmp = aggregateCallouts(attRows, {
    unplannedStatuses: rule.unplanned_statuses,
  });
  // Inverse map: zoho user_id → employee_id (for callouts join)
  const userToEmp = new Map();
  for (const [empId, uid] of empToUser) userToEmp.set(uid, empId);

  // 6. Within a single tx: auto-create teams, auto-create users, upsert metrics + awards
  let usersCreated = 0, teamsCreated = 0, updated = 0, skipped = 0;
  await withTx(async (client) => {
    // 6a. Distinct team_names present in this period for this campaign
    const teamNames = new Set();
    for (const r of umRows) {
      const tn = (r.team_name || '').trim();
      if (tn) teamNames.add(tn);
    }
    const teamIdByName = new Map();
    for (const name of teamNames) {
      const res = await client.query(
        `INSERT INTO teams (campaign_id, name)
         VALUES ($1, $2)
         ON CONFLICT (campaign_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name, (xmax = 0) AS inserted`,
        [campaignId, name]
      );
      teamIdByName.set(name, res.rows[0].id);
      if (res.rows[0].inserted) teamsCreated++;
    }

    // 6b. Auto-create users for every distinct Zoho user_id in this campaign's rows
    // Pick the most common team per user across the period.
    const teamCountByUser = new Map(); // zohoUserId → Map(teamName → count)
    for (const r of umRows) {
      const uid = String(r.user_id ?? '');
      const tn = (r.team_name || '').trim();
      if (!uid || !tn) continue;
      if (!teamCountByUser.has(uid)) teamCountByUser.set(uid, new Map());
      const m = teamCountByUser.get(uid);
      m.set(tn, (m.get(tn) || 0) + 1);
    }
    function dominantTeam(uid) {
      const m = teamCountByUser.get(uid);
      if (!m) return null;
      let best = null, bestCount = -1;
      for (const [t, c] of m) if (c > bestCount) { best = t; bestCount = c; }
      return best;
    }

    for (const [zohoUid, agg] of metricsByUser) {
      const team = dominantTeam(zohoUid);
      const teamId = team ? teamIdByName.get(team) : null;
      const res = await client.query(
        `INSERT INTO users (full_name, role, campaign_id, team_id, zoho_user_id)
         VALUES ($1, 'agent', $2, $3, $4)
         ON CONFLICT (zoho_user_id) DO UPDATE SET
           campaign_id = EXCLUDED.campaign_id,
           team_id     = COALESCE(EXCLUDED.team_id, users.team_id),
           full_name   = EXCLUDED.full_name,
           updated_at  = NOW()
         RETURNING id, (xmax = 0) AS inserted`,
        [agg.fullname || `Agent ${zohoUid}`, campaignId, teamId, zohoUid]
      );
      if (res.rows[0].inserted) usersCreated++;
    }

    // 6c. Now fetch the (refreshed) campaign users and upsert their metrics + awards
    const { rows: users } = await client.query(
      `SELECT u.id, u.full_name, u.zoho_user_id FROM users u
        WHERE u.campaign_id = $1 AND u.active = TRUE`,
      [campaignId]
    );

    for (const user of users) {
      const um = user.zoho_user_id ? metricsByUser.get(user.zoho_user_id) : null;
      if (!um) { skipped++; continue; }

      const empId = userToEmp.get(user.zoho_user_id);
      const callouts = empId ? (calloutsByEmp.get(empId) || 0) : 0;

      const metricsRow = {
        productivity: um.productivity ?? 0,
        csat_pct:     um.csat_pct,
        qa_pct:       um.qa_pct,
        callouts,
        attendance_days: null,
      };

      await client.query(
        `INSERT INTO bonus_metrics (period_id, user_id, attendance_days, productivity, csat_pct, qa_pct, callouts, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (period_id, user_id) DO UPDATE SET
           productivity = EXCLUDED.productivity,
           csat_pct     = EXCLUDED.csat_pct,
           qa_pct       = EXCLUDED.qa_pct,
           callouts     = EXCLUDED.callouts,
           raw          = EXCLUDED.raw,
           synced_at    = NOW()`,
        [period.id, user.id, metricsRow.attendance_days, metricsRow.productivity,
         metricsRow.csat_pct, metricsRow.qa_pct, metricsRow.callouts, um]
      );

      const award = applyRule(metricsRow, rule);
      await client.query(
        `INSERT INTO bonus_awards (period_id, user_id, rule_id, components, kpi_bonus, final_bonus, qualified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (period_id, user_id) DO UPDATE SET
           rule_id      = EXCLUDED.rule_id,
           components   = EXCLUDED.components,
           kpi_bonus    = EXCLUDED.kpi_bonus,
           final_bonus  = EXCLUDED.final_bonus,
           qualified    = EXCLUDED.qualified,
           calculated_at = NOW()`,
        [period.id, user.id, ruleId, award.components, award.kpi_bonus, award.final_bonus, award.qualified]
      );
      updated++;
    }
  });

  return {
    campaign_id: campaignId, period_id: period.id,
    teams_created: teamsCreated, users_created: usersCreated,
    updated, skipped,
    rows_in_workgroup: umRows.length,
  };
}

export async function syncAll(yearMonth = currentYearMonth()) {
  const { rows } = await query(
    `SELECT DISTINCT campaign_id FROM bonus_rules
      WHERE effective_from <= $1::date
        AND (effective_to IS NULL OR effective_to >= $1::date)`,
    [`${yearMonth}-01`]
  );
  const results = [];
  for (const r of rows) {
    try {
      results.push(await syncCampaign(r.campaign_id, yearMonth));
    } catch (err) {
      results.push({ campaign_id: r.campaign_id, error: err.message });
    }
  }
  return results;
}
