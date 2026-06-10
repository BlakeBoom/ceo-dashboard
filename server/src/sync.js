// End-to-end Zoho → Neon sync for one bonus period.
//
// Steps:
//   1. Resolve the period (default: current calendar month) for each campaign
//      that has active bonus_rules.
//   2. Fetch User_metrics_3 + AttendanceUserReport + EmployeeProfile rows
//      filtered to the period.
//   3. Build employee_id → user_id map by name.
//   4. UPSERT bonus_metrics rows.
//   5. Apply the active rule_json → UPSERT bonus_awards rows.
//
// Called from the cron handler and the manual `/api/sync/now` endpoint.

import { query, withTx } from './db.js';
import { fetchView, VIEW, monthBounds } from './zoho.js';
import { aggregateUserMetrics, aggregateCallouts, buildEmployeeUserMap, applyRule } from './bonus.js';

export function currentYearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function syncCampaign(campaignId, yearMonth = currentYearMonth()) {
  // 1. Get active rule_json for the campaign
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
  const [umRows, attRows, empRows] = await Promise.all([
    fetchView(VIEW.userMetrics, { criteria: dateCriteria }),
    fetchView(VIEW.attendance,  { criteria: dateCriteria }),
    fetchView(VIEW.employee),
  ]);

  // 4. Aggregate
  const productivityComponent = (rule.components || []).find(c => c.key === 'productivity');
  const productivityColumn = productivityComponent?.metric_column || 'tickets';
  const metricsByUser = aggregateUserMetrics(umRows, { productivityColumn });
  const empToUser = buildEmployeeUserMap(empRows, metricsByUser);
  const calloutsByEmp = aggregateCallouts(attRows, {
    unplannedStatuses: rule.unplanned_statuses,
  });

  // 5. UPSERT bonus_metrics + bonus_awards, scoped to users on this campaign.
  let updated = 0, skipped = 0;
  await withTx(async (client) => {
    // Pre-fetch this campaign's users (and their zoho mapping)
    const { rows: users } = await client.query(
      `SELECT u.id, u.full_name, u.zoho_user_id FROM users u
        WHERE u.campaign_id = $1 AND u.active = TRUE`,
      [campaignId]
    );

    for (const user of users) {
      // Try matching by zoho_user_id first (most reliable),
      // else fall back to name → zoho_user_id via metricsByUser.
      const um = user.zoho_user_id ? metricsByUser.get(user.zoho_user_id) : null;
      let callouts = null;
      if (um) {
        // Map back to an employee_id via the empToUser inverse
        for (const [empId, uid] of empToUser) {
          if (uid === user.zoho_user_id) { callouts = calloutsByEmp.get(empId) || 0; break; }
        }
        if (callouts == null) callouts = 0;
      }

      if (!um) { skipped++; continue; }

      const metricsRow = {
        productivity: um.productivity ?? 0,
        csat_pct:     um.csat_pct,
        qa_pct:       um.qa_pct,
        callouts:     callouts ?? 0,
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

  return { campaign_id: campaignId, period_id: period.id, updated, skipped };
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
