// User provisioning from the Zoho EmployeeProfile view.
//
// The raw Zoho People EmployeeProfile view stores Job Title (and possibly other
// fields) as numeric lookup ids into companion tables. We resolve Job Title via
// the Job Description view, then map:
//   - Workgroup/Department → which client campaign they belong to
//   - Job Title (resolved) → their level (Campaign Manager / Team Leader / Agent)
//   - Employee Name        → display name + the key we match on elsewhere
//   - Employee ID          → stable HR identity (stored as zoho_employee_no)
//
// Team membership (which agents sit under which Team Leader) is NOT here —
// it comes from User_metrics_3.team_name via the bonus sync — so we set
// role + campaign here and leave team_id to the sync / manual assignment.

import crypto from 'node:crypto';
import { query, withTx } from './db.js';
import { fetchView, VIEW } from './zoho.js';
import { hashPassword } from './auth.js';

// Companion tables that EmployeeProfile lookup ids resolve against.
const JOB_TITLE_VIEW_ID = '2292884000019602033'; // Job description table
const CAMPAIGN_VIEW_ID  = '2292884000019602061'; // Campaign table → Department ids
const DIVISIONS_VIEW_ID = '2292884000019604699'; // Divisions table (merged as fallback)

// ── Pure mapping helpers (unit-tested) ──────────────────────────────────────

// Collapse a Workgroup string to a canonical campaign. Handles the inconsistent
// casing/spacing in the source data (PICKnPAY vs PicknPay, 1LIFE vs 1Life,
// Just Park vs JUST PARK, …). Returns null for internal Admin/* departments.
// Slugs are FIXED (not derived) so they line up with the existing campaigns
// seed and the bonus sync's CAMPAIGN_WORKGROUPS keys — e.g. Butternut Box must
// stay 'butternutbox', not 'butternut-box', or its data would split in two.
const CAMPAIGN_BY_KEY = {
  '1life':           { name: '1Life',               slug: '1life' },
  pinter:            { name: 'Pinter',              slug: 'pinter' },
  medexpress:        { name: 'MedExpress',          slug: 'medexpress' },
  picknpay:          { name: 'PicknPay',            slug: 'picknpay' },
  bbox:              { name: 'Butternut Box',       slug: 'butternutbox' },
  butternutbox:      { name: 'Butternut Box',       slug: 'butternutbox' },
  gousto:            { name: 'Gousto',              slug: 'gousto' },
  justpark:          { name: 'Just Park',           slug: 'justpark' },
  justparkeventpass: { name: 'JustPark Event Pass', slug: 'justpark-event-pass' },
  lintbells:         { name: 'Lintbells',           slug: 'lintbells' },
  hunzag:            { name: 'HunzaG',              slug: 'hunzag' },
  royalcanin:        { name: 'RoyalCanin',          slug: 'royalcanin' },
  beer52:            { name: 'Beer52',              slug: 'beer52' },
  thegoodlifesorted: { name: 'The Good Life Sorted', slug: 'thegoodlifesorted' },
  leadgen:           { name: 'LeadGen',             slug: 'leadgen' },
};

// Returns { name, slug } or null (internal/empty).
export function canonicalCampaign(workgroup) {
  const raw = String(workgroup ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key || key.startsWith('admin')) return null; // internal department
  if (INTERNAL_DEPARTMENTS.has(key)) return null;    // internal support function
  if (CAMPAIGN_BY_KEY[key]) return CAMPAIGN_BY_KEY[key];
  return { name: raw, slug: campaignSlug(raw) }; // unknown workgroup → own campaign
}

// Resolved Department names that are internal support functions, not client
// campaigns — excluded from provisioning (they have no "Admin/" prefix once
// resolved through the Campaign lookup table).
const INTERNAL_DEPARTMENTS = new Set([
  'operations', 'humanresources', 'hr', 'finance', 'wfm', 'workforcemanagement',
  'itinformationtechnology', 'it', 'informationtechnology', 'informationandtechnology',
  'businesssupportqualityassurance', 'qualityassurance', 'qa', 'businesssupport',
  'learninganddevelopment', 'ld', 'recruitment', 'facilities', 'facility',
  'marketing', 'digitaltransformation', 'people', 'peopleengagement', 'admin',
  'boomerangteam', 'boomeranginternal', 'headofstaff', 'hos',
]);

export function campaignSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Map a Job Title to a role in our hierarchy. Order matters: most senior first.
export function jobTitleToRole(title) {
  const t = String(title ?? '').toLowerCase();
  if (t.includes('campaign manager')) return 'campaign_lead';
  if (t.includes('team leader') || t.includes('shift leader')) return 'tm';
  return 'agent';
}

// ── Column detection ────────────────────────────────────────────────────────
// The EmployeeProfile view's column labels vary between exports ("Fullname" vs
// "Employee Name" vs "Full Name", "Job Title" vs "Designation", …). Detect the
// actual columns once per batch by normalised header name instead of trusting
// exact keys.

function normKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const COL_CANDIDATES = {
  fullname:  ['fullname', 'employeename', 'name', 'agentname', 'fullnamesasperid', 'knownname'],
  workgroup: ['workgroup', 'workgroupname', 'campaign', 'campaignname', 'department', 'divisionname', 'division', 'businessunit'],
  jobTitle:  ['jobtitle', 'designation', 'title', 'position'],
  empNo:     ['employeenumber', 'employeeno', 'employeeid', 'empno', 'empid', 'staffnumber'],
  email:     ['workemailaddress', 'emailaddress', 'email', 'workemail', 'clientemail'],
  manager:   ['reportingtoname', 'reportingto', 'managername', 'manager'],
  status:    ['employeestatus', 'status'],
};

// Map fields → actual column key (or null).
export function detectProfileColumns(rows) {
  const sample = rows.find(r => r) || {};
  const byNorm = new Map(Object.keys(sample).map(k => [normKey(k), k]));
  const out = {};
  for (const [field, cands] of Object.entries(COL_CANDIDATES)) {
    out[field] = null;
    for (const c of cands) {
      if (byNorm.has(c)) { out[field] = byNorm.get(c); break; }
    }
  }
  return out;
}

// A value looks like an unresolved Zoho lookup id (long all-digit string) rather
// than human text — e.g. Job Title returning "610962000011338364".
export function looksLikeLookupId(v) {
  return /^\d{10,}$/.test(String(v ?? '').trim());
}

// For diagnostics: up to `n` distinct non-empty sample values for each named
// column that exists, so we can see which column actually holds the campaign /
// job title text.
export function probeFieldValues(rows, names, n = 8) {
  const out = {};
  const have = new Set(rows.length ? Object.keys(rows.find(r => r) || {}) : []);
  for (const name of names) {
    if (!have.has(name)) continue;
    const seen = new Set();
    for (const r of rows) {
      const v = (r[name] ?? '').toString().trim();
      if (v) seen.add(v);
      if (seen.size >= n) break;
    }
    out[name] = [...seen];
  }
  return out;
}

// Build lookup-id → text map from a Zoho companion view (Job Title, Department,
// …). Column names aren't guaranteed: the id column is the one called "id" or
// whose values look like lookup ids; the text column is the first candidate
// name present, else the non-id column with the most distinct human text.
export function buildLookupMap(rows, textCandidates) {
  const map = new Map();
  if (!rows?.length) return map;
  const sample = rows.find(r => r) || {};
  const keys = Object.keys(sample);

  let idCol = keys.find(k => normKey(k) === 'id');
  if (!idCol) idCol = keys.find(k => looksLikeLookupId(sample[k]));
  if (!idCol) return map;

  let textCol = null;
  for (const c of textCandidates) {
    const k = keys.find(k => normKey(k) === c);
    if (k && k !== idCol) { textCol = k; break; }
  }
  if (!textCol) {
    let best = null, bestN = 0;
    for (const k of keys) {
      if (k === idCol) continue;
      const vals = new Set();
      for (const r of rows.slice(0, 200)) {
        const v = (r[k] ?? '').toString().trim();
        if (v && !/^\d+$/.test(v)) vals.add(v);
      }
      if (vals.size > bestN) { best = k; bestN = vals.size; }
    }
    textCol = best;
  }
  if (!textCol) return map;

  for (const r of rows) {
    const id = (r[idCol] ?? '').toString().trim();
    const text = (r[textCol] ?? '').toString().trim();
    if (id && text) map.set(id, text);
  }
  return map;
}

export const buildJobTitleMap = (rows) =>
  buildLookupMap(rows, ['jobtitle', 'title', 'name', 'jobdescription', 'designation', 'description']);
export const buildDepartmentMap = (rows) =>
  buildLookupMap(rows, ['department', 'departmentname', 'workgroup', 'name', 'title', 'description']);

// Read one EmployeeProfile row using the detected column map.
export function parseEmployeeRow(r, cols) {
  const get = (field) => (cols[field] != null ? r[cols[field]] : undefined);
  const fullname = (get('fullname') ?? '').toString().trim();
  const workgroup = (get('workgroup') ?? '').toString().trim();
  const jobTitle = (get('jobTitle') ?? '').toString().trim();
  const empNoRaw = (get('empNo') ?? '').toString().trim();
  const manager = (get('manager') ?? '').toString().trim();
  const emailRaw = (get('email') ?? '').toString().trim().toLowerCase();
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : null;
  // Drop sentinels that aren't real ids ("0", "#N/A", "").
  const empNo = /^[0-9]+[a-z]?$/i.test(empNoRaw) && empNoRaw !== '0' ? empNoRaw : null;
  return { fullname, workgroup, jobTitle, empNo, manager, email };
}

// Build a deterministic login-email local-part from a name, e.g.
// "Mogamat Azmie Behardien" → "mogamat.behardien".
export function emailLocalPart(fullname) {
  const cleaned = String(fullname)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');
  const local = parts.length >= 2 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0];
  return local;
}

function tempPassword() {
  // 12 url-safe chars, no ambiguous characters, always shown once to the admin.
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + 'A1';
}

// ── Provisioning ────────────────────────────────────────────────────────────

// Classify every EmployeeProfile row into the account we'd create. Pure given
// rows — used by both preview and commit so they can't drift.
export function planProvisioning(rows, { domain, jobTitleMap = new Map(), departmentMap = new Map() }) {
  const cols = detectProfileColumns(rows);
  const seenEmail = new Map(); // local → count, for collision suffixes
  const plan = [];
  const skipped = [];
  let titlesResolved = 0, titlesUnresolved = 0;

  for (const r of rows) {
    let { fullname, workgroup, jobTitle, empNo, email: realEmail } = parseEmployeeRow(r, cols);
    if (!fullname) { skipped.push({ reason: 'no_name' }); continue; }

    // Only provision current staff: skip Terminated/Resigned/etc. when the
    // view exposes an employee status.
    if (cols.status != null) {
      const status = (r[cols.status] ?? '').toString().trim().toLowerCase();
      if (status && status !== 'active') { skipped.push({ reason: 'not_active', fullname }); continue; }
    }

    // Resolve lookup-id Job Titles via the companion table.
    if (looksLikeLookupId(jobTitle)) {
      const resolved = jobTitleMap.get(jobTitle);
      if (resolved) { jobTitle = resolved; titlesResolved++; }
      else { jobTitle = ''; titlesUnresolved++; }
    }

    // Department/Workgroup is also a lookup id in the raw view — resolve it.
    if (looksLikeLookupId(workgroup)) {
      const resolved = departmentMap.get(workgroup);
      if (resolved) workgroup = resolved;
      else { skipped.push({ reason: 'workgroup_lookup_id', fullname, workgroup }); continue; }
    }
    const camp = canonicalCampaign(workgroup);
    if (!camp) {
      skipped.push({ reason: workgroup ? 'internal_admin' : 'no_workgroup', fullname, workgroup });
      continue;
    }

    const role = jobTitleToRole(jobTitle);
    // Prefer the real work email; otherwise generate a deterministic one.
    let email = realEmail;
    if (!email) {
      const local = emailLocalPart(fullname);
      const n = (seenEmail.get(local) || 0) + 1;
      seenEmail.set(local, n);
      email = `${local}${n > 1 ? n : ''}@${domain}`;
    }

    plan.push({ fullname, workgroup, campaign: camp.name, slug: camp.slug, role, jobTitle, empNo, email });
  }
  return { plan, skipped, cols, titlesResolved, titlesUnresolved };
}

// Fetch EmployeeProfile, plan accounts, and (unless preview) upsert them.
// Idempotent: re-running updates role/campaign/title and only issues a temp
// password to brand-new accounts (so existing users keep their password).
export async function provisionFromEmployeeProfile({ preview = false, domain = 'boomerang.local', includeRoles = ['campaign_lead', 'tm', 'agent'], viewId = null, deptViewId = null } = {}) {
  const employeeViewId = viewId || process.env.ZOHO_EMPLOYEE_VIEW_ID || VIEW.employee;
  const jobTitleViewId = process.env.ZOHO_JOB_TITLE_VIEW_ID || JOB_TITLE_VIEW_ID;
  const departmentViewId = deptViewId || process.env.ZOHO_DEPARTMENT_VIEW_ID || CAMPAIGN_VIEW_ID;
  const safeFetch = (id) => id ? fetchView(id).catch(err => {
    console.warn(`[provision] companion view ${id} fetch failed:`, err.message);
    return [];
  }) : Promise.resolve([]);

  const [rows, jobTitleRows, departmentRows, divisionRows] = await Promise.all([
    fetchView(employeeViewId),
    safeFetch(jobTitleViewId),
    safeFetch(departmentViewId),
    safeFetch(DIVISIONS_VIEW_ID),
  ]);
  const jobTitleMap = buildJobTitleMap(jobTitleRows);
  // Department ids resolve against the Campaign table; merge Divisions in as a
  // fallback for any employee whose Department points at a division instead.
  const departmentMap = buildDepartmentMap(departmentRows);
  for (const [id, name] of buildDepartmentMap(divisionRows)) {
    if (!departmentMap.has(id)) departmentMap.set(id, name);
  }
  const { plan, skipped, cols, titlesResolved, titlesUnresolved } =
    planProvisioning(rows, { domain, jobTitleMap, departmentMap });
  const filtered = plan.filter(p => includeRoles.includes(p.role));

  const summary = {
    source_rows: rows.length,
    planned: filtered.length,
    skipped: skipped.length,
    skip_reasons: tally(skipped.map(s => s.reason)),
    job_titles: { lookup_rows: jobTitleMap.size, resolved: titlesResolved, unresolved: titlesUnresolved },
    departments: { lookup_rows: departmentMap.size, configured: !!departmentViewId },
    by_role: tally(filtered.map(p => p.role)),
    by_campaign: tally(filtered.map(p => p.campaign)),
  };

  if (preview) {
    // Diagnostics so the admin can see WHY rows were skipped: the actual columns
    // Zoho returned, which we matched, whether Job Title came back as an
    // unresolved lookup id, and distinct sample values for the columns most
    // likely to hold the campaign / job-title text.
    const sampleRow = rows.find(r => r) || {};
    const jobTitleVal = cols.jobTitle ? sampleRow[cols.jobTitle] : null;
    const probeCols = ['Department', 'Division', 'Division Name', 'Location', 'Seating Location',
      'Job Title', 'Designation', 'Role', 'Work Group', 'Workgroup', 'Business Unit', 'Team',
      'Reporting To (Name)', 'Employee Status'];
    return {
      preview: true,
      summary,
      diagnostics: {
        detected_columns: cols,
        source_columns: Object.keys(sampleRow),
        job_title_is_lookup_id: looksLikeLookupId(jobTitleVal),
        job_title_samples: [...new Set(jobTitleMap.values())].slice(0, 15),
        field_values: probeFieldValues(rows, probeCols, 10),
      },
      sample: filtered.slice(0, 25),
      skipped_sample: skipped.slice(0, 15),
    };
  }

  const created = [];
  const failures = [];
  let updated = 0;
  await withTx(async (client) => {
    // Ensure every campaign exists.
    const campIdBySlug = new Map();
    for (const slug of new Set(filtered.map(p => p.slug))) {
      const name = filtered.find(p => p.slug === slug).campaign;
      const res = await client.query(
        `INSERT INTO campaigns (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = campaigns.name
         RETURNING id`,
        [slug, name]
      );
      campIdBySlug.set(slug, res.rows[0]?.id);
    }

    // Per-row savepoint so one bad row (e.g. duplicate email) is reported and
    // skipped instead of aborting the whole batch.
    for (const p of filtered) {
      try {
        await client.query('SAVEPOINT row');
        const campaignId = campIdBySlug.get(p.slug);
        // Match an existing account by employee number first, then by email.
        const { rows: existing } = await client.query(
          `SELECT id FROM users
            WHERE (zoho_employee_no IS NOT NULL AND zoho_employee_no = $1)
               OR LOWER(email) = LOWER($2)
            LIMIT 1`,
          [p.empNo, p.email]
        );
        if (existing.length) {
          await client.query(
            `UPDATE users
                SET full_name = $1, role = $2, campaign_id = $3,
                    job_title = $4, workgroup = $5,
                    zoho_employee_no = COALESCE($6, zoho_employee_no),
                    updated_at = NOW()
              WHERE id = $7`,
            [p.fullname, p.role, campaignId, p.jobTitle, p.workgroup, p.empNo, existing[0].id]
          );
          updated++;
        } else {
          const temp = tempPassword();
          const hash = await hashPassword(temp);
          const { rows: ins } = await client.query(
            `INSERT INTO users (email, password_hash, full_name, role, campaign_id,
                                job_title, workgroup, zoho_employee_no, must_change_password)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
             RETURNING id`,
            [p.email, hash, p.fullname, p.role, campaignId, p.jobTitle, p.workgroup, p.empNo]
          );
          created.push({ id: ins.rows[0].id, full_name: p.fullname, email: p.email, role: p.role, campaign: p.campaign, temp_password: temp });
        }
        await client.query('RELEASE SAVEPOINT row');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT row').catch(() => {});
        failures.push({ name: p.fullname, email: p.email, error: err.message });
      }
    }
  });

  return {
    preview: false,
    summary: { ...summary, created: created.length, updated, failed: failures.length },
    created,
    failures: failures.slice(0, 25),
  };
}

function tally(arr) {
  const out = {};
  for (const x of arr) out[x] = (out[x] || 0) + 1;
  return out;
}
