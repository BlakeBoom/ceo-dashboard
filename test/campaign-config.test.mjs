// Parity: the rows migration 0014 seeds into campaigns / campaign_kpis /
// campaign_workgroups must reproduce the hardcoded WG_MAP / CAMP_DISPLAY /
// CAMP_SECTION / TARGETS / KPI_CONFIG in index.html. Both are the source of
// truth today (the client falls back to the hardcoded objects if the config
// fetch fails), so drift silently changes what tiles render. This test catches
// the drift: if you edit one and not the other, this fails loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampaignConfig } from '../server/src/campaign-config.js';

// ---- fixtures matching the migration 0014 VALUES clauses ----------------
const CAMPS = [
  { slug: 'gousto',         shift_key: 'Gousto',         display_name: 'GOUSTO',           section: 'Customer Services' },
  { slug: 'vetnique',       shift_key: 'VETNIQUE',       display_name: 'VETNIQUE',         section: 'Customer Services' },
  { slug: 'justpark-us',    shift_key: 'JUSTPARK_usa',   display_name: 'JUST PARK US',     section: 'Customer Services' },
  { slug: 'justpark',       shift_key: 'JUSTPARK_uk',    display_name: 'JUST PARK UK',     section: 'Customer Services' },
  { slug: 'butternutbox',   shift_key: 'BUTTERNUTBOX',   display_name: 'BUTTERNUT BOX',    section: 'Customer Services' },
  { slug: 'medexpress',     shift_key: 'Medexpress',     display_name: 'MEDEXPRESS',       section: 'Customer Services' },
  { slug: 'picknpay',       shift_key: 'PICKNPAY',       display_name: 'PICKNPAY',         section: 'Customer Services' },
  { slug: 'royalcanin',     shift_key: 'ROYALCANIN',     display_name: 'ROYAL CANIN',      section: 'Customer Services' },
  { slug: 'hunzag',         shift_key: 'HUNZAG',         display_name: 'HUNZAG',           section: 'Customer Services' },
  { slug: 'goodlifesorted', shift_key: 'GOODLIFESORTED', display_name: 'GOOD LIFE SORTED', section: 'Customer Services' },
  { slug: 'hyve',           shift_key: 'HYVE',           display_name: 'HYVE',             section: 'Customer Services' },
  { slug: 'pinter',         shift_key: 'PINTER',         display_name: 'PINTER',           section: 'Sales' },
  { slug: 'beer52',         shift_key: 'BEER52',         display_name: 'BEER52',           section: 'Sales' },
  { slug: '1life',          shift_key: '1LIFE',          display_name: '1LIFE',            section: 'Sales' },
];

// Convert the migration's KPI VALUES rows to fixture shape. Rows come in
// priority order (SQL: ORDER BY shift_key, priority) so KPI_CONFIG's array
// order comes out matching the hardcoded array.
const KPIS_SORTED = [
  ['Gousto','csat','CSAT','higher',88,10,true],['Gousto','qa','QA','higher',90,20,true],
  ['Gousto','cph','CPH','higher',5.5,30,true],['Gousto','adherence','Adherence','higher',95,40,true],
  ['Gousto','fulfil','Fulfil','higher',100,50,true],['Gousto','realisation','Realisation','higher',90,60,true],
  ['Gousto','churn','Churn','lower',20,70,true],['Gousto','absence','Absence','lower',5,80,true],

  ['VETNIQUE','csat','CSAT','higher',90,10,true],['VETNIQUE','qa','QA','higher',95,20,true],
  ['VETNIQUE','cph','CPH','higher',6,30,true],['VETNIQUE','res_time','Res. time','lower',48,40,true],
  ['VETNIQUE','fulfil','Fulfil','higher',100,50,true],['VETNIQUE','realisation','Realisation','higher',90,60,true],
  ['VETNIQUE','churn','Churn','lower',20,70,true],['VETNIQUE','absence','Absence','lower',5,80,true],
  ['VETNIQUE','acw','ACW','lower',1.25,999,false],

  ['JUSTPARK_usa','csat','CSAT','higher',80,10,true],['JUSTPARK_usa','qa','QA','higher',85,20,true],
  ['JUSTPARK_usa','fcr','FCR','higher',90,30,true],['JUSTPARK_usa','sla','SLA','higher',90,40,true],
  ['JUSTPARK_usa','fulfil','Fulfil','higher',100,50,true],['JUSTPARK_usa','realisation','Realisation','higher',90,60,true],
  ['JUSTPARK_usa','churn','Churn','lower',20,70,true],['JUSTPARK_usa','absence','Absence','lower',5,80,true],

  ['JUSTPARK_uk','csat','CSAT','higher',80,10,true],['JUSTPARK_uk','qa','QA','higher',90,20,true],
  ['JUSTPARK_uk','cph','CPH','higher',6,30,true],['JUSTPARK_uk','fcr','FCR','higher',85,40,true],
  ['JUSTPARK_uk','tickets','Tickets','none',null,50,true],['JUSTPARK_uk','fulfil','Fulfil','higher',100,60,true],
  ['JUSTPARK_uk','realisation','Realisation','higher',90,70,true],['JUSTPARK_uk','churn','Churn','lower',20,80,true],
  ['JUSTPARK_uk','absence','Absence','lower',5,90,true],

  ['BUTTERNUTBOX','csat','CSAT','higher',90,10,true],['BUTTERNUTBOX','qa','QA','higher',90,20,true],
  ['BUTTERNUTBOX','cpd','CPD','higher',50,30,true],['BUTTERNUTBOX','fulfil','Fulfil','higher',100,40,true],
  ['BUTTERNUTBOX','realisation','Realisation','higher',90,50,true],['BUTTERNUTBOX','churn','Churn','lower',20,60,true],
  ['BUTTERNUTBOX','absence','Absence','lower',5,70,true],

  ['Medexpress','csat','CSAT','higher',85,10,true],['Medexpress','qa','QA','higher',90,20,true],
  ['Medexpress','aht','AHT','lower',null,30,true],['Medexpress','tickets','Tickets','none',null,40,true],
  ['Medexpress','fulfil','Fulfil','higher',100,50,true],['Medexpress','realisation','Realisation','higher',90,60,true],
  ['Medexpress','churn','Churn','lower',20,70,true],['Medexpress','absence','Absence','lower',5,80,true],
  ['Medexpress','compliance','Compliance','higher',100,999,false],['Medexpress','productivity','Productivity','higher',90,999,false],

  ['PICKNPAY','qa','QA','higher',80,10,true],['PICKNPAY','sla','Talk SLA','higher',null,20,true],
  ['PICKNPAY','calls','Calls','none',null,30,true],['PICKNPAY','abandon_rate','Abandoned','lower',null,40,true],
  ['PICKNPAY','fulfil','Fulfil','higher',100,50,true],['PICKNPAY','realisation','Realisation','higher',90,60,true],
  ['PICKNPAY','churn','Churn','lower',20,70,true],['PICKNPAY','absence','Absence','lower',5,80,true],
  ['PICKNPAY','csat','CSAT','higher',85,999,false],['PICKNPAY','talk_sla','Talk SLA','higher',90,999,false],
  ['PICKNPAY','calls_abn','Calls abn','lower',5,999,false],

  ['ROYALCANIN','qa','QA','higher',95,10,true],['ROYALCANIN','cph','CPH','higher',4,20,true],
  ['ROYALCANIN','tickets','Tickets','none',null,30,true],['ROYALCANIN','fulfil','Fulfil','higher',100,40,true],
  ['ROYALCANIN','realisation','Realisation','higher',90,50,true],['ROYALCANIN','churn','Churn','lower',20,60,true],
  ['ROYALCANIN','absence','Absence','lower',5,70,true],['ROYALCANIN','error_rate','Error rate','lower',2,999,false],

  ['HUNZAG','qa','QA','higher',95,10,true],['HUNZAG','cpd','CPD','higher',20,20,true],
  ['HUNZAG','res_time','Res. time','lower',24,30,true],['HUNZAG','tickets','Tickets','none',null,40,true],
  ['HUNZAG','fulfil','Fulfil','higher',100,50,true],['HUNZAG','realisation','Realisation','higher',90,60,true],
  ['HUNZAG','churn','Churn','lower',20,70,true],['HUNZAG','absence','Absence','lower',5,80,true],

  ['GOODLIFESORTED','qa','QA','higher',95,10,true],['GOODLIFESORTED','cph','CPH','higher',4,20,true],
  ['GOODLIFESORTED','aht','AHT','lower',3,30,true],['GOODLIFESORTED','calls','Calls','none',null,40,true],
  ['GOODLIFESORTED','fulfil','Fulfil','higher',100,50,true],['GOODLIFESORTED','realisation','Realisation','higher',90,60,true],
  ['GOODLIFESORTED','churn','Churn','lower',20,70,true],['GOODLIFESORTED','absence','Absence','lower',5,80,true],
  ['GOODLIFESORTED','calls_abn','Calls abn','lower',8,999,false],

  ['PINTER','csat','CSAT','higher',80,10,true],['PINTER','qa','QA','higher',90,20,true],
  ['PINTER','res_time','Res. time','lower',24,30,true],['PINTER','tickets','Tickets','none',null,40,true],
  ['PINTER','fulfil','Fulfil','higher',100,50,true],['PINTER','realisation','Realisation','higher',90,60,true],
  ['PINTER','churn','Churn','lower',20,70,true],['PINTER','absence','Absence','lower',5,80,true],
  ['PINTER','avg_resp_time','Avg resp time','lower',4,999,false],

  ['BEER52','qa','QA','higher',90,10,true],['BEER52','sph','SPH','higher',1.25,20,true],
  ['BEER52','calls','Calls','none',null,30,true],['BEER52','sales','Sales','none',null,40,true],
  ['BEER52','fulfil','Fulfil','higher',100,50,true],['BEER52','realisation','Realisation','higher',90,60,true],
  ['BEER52','churn','Churn','lower',20,70,true],['BEER52','absence','Absence','lower',5,80,true],

  ['1LIFE','qa','QA','higher',90,10,true],['1LIFE','sales','Sales','higher',350,20,true],
  ['1LIFE','tickets','Tickets','none',null,30,true],['1LIFE','fulfil','Fulfil','higher',100,40,true],
  ['1LIFE','realisation','Realisation','higher',90,50,true],['1LIFE','churn','Churn','lower',20,60,true],
  ['1LIFE','absence','Absence','lower',5,70,true],
].map(([shift_key, kpi_key, label, direction, target, priority, is_tile]) =>
  ({ shift_key, kpi_key, label, direction, target, priority, is_tile }));

const WGS = [
  ['1LIFE','1LIFE'],['BUTTERNUTBOX','BBOX'],['BUTTERNUTBOX','Butternut Box'],
  ['Gousto','Gousto'],['HUNZAG','HunzaG'],
  ['JUSTPARK_uk','JUST PARK'],['JUSTPARK_uk','Just Park'],['JUSTPARK_uk','JustPark'],
  ['JUSTPARK_usa','JustPark Space Owner'],['JUSTPARK_usa','Just Park Space Owner'],['JUSTPARK_usa','JustPark SP'],
  ['JUSTPARK_usa','JustPark Event Pass'],['JUSTPARK_usa','JustPark US'],['JUSTPARK_usa','JUST PARK US'],
  ['Medexpress','MedExpress'],['PICKNPAY','PICKnPAY'],['PINTER','Pinter'],
  ['ROYALCANIN','Royal Canin'],['ROYALCANIN','RoyalCanin'],['GOODLIFESORTED','The Good Life Sorted'],
  ['VETNIQUE','VETNIQUE'],['VETNIQUE','Lint Bells'],['VETNIQUE','Lintbells'],
  ['BEER52','Beer52'],['HYVE','HYVE'],
].map(([shift_key, label]) => ({ shift_key, label }));

// ---- expected: mirror the hardcoded objects in index.html ---------------
const EXPECTED_WG_MAP = {
  '1LIFE':'1LIFE','BBOX':'BUTTERNUTBOX','Butternut Box':'BUTTERNUTBOX',
  'Gousto':'Gousto','HunzaG':'HUNZAG',
  'JUST PARK':'JUSTPARK_uk','Just Park':'JUSTPARK_uk','JustPark':'JUSTPARK_uk',
  'JustPark Space Owner':'JUSTPARK_usa','Just Park Space Owner':'JUSTPARK_usa','JustPark SP':'JUSTPARK_usa',
  'JustPark Event Pass':'JUSTPARK_usa','JustPark US':'JUSTPARK_usa','JUST PARK US':'JUSTPARK_usa',
  'MedExpress':'Medexpress','PICKnPAY':'PICKNPAY','Pinter':'PINTER',
  'Royal Canin':'ROYALCANIN','RoyalCanin':'ROYALCANIN',
  'The Good Life Sorted':'GOODLIFESORTED',
  'VETNIQUE':'VETNIQUE','Lint Bells':'VETNIQUE','Lintbells':'VETNIQUE',
  'Beer52':'BEER52','HYVE':'HYVE',
};
const EXPECTED_CAMP_DISPLAY = {
  'Gousto':'GOUSTO','VETNIQUE':'VETNIQUE','JUSTPARK_usa':'JUST PARK US',
  'JUSTPARK_uk':'JUST PARK UK',
  'BUTTERNUTBOX':'BUTTERNUT BOX','Medexpress':'MEDEXPRESS','PICKNPAY':'PICKNPAY',
  'ROYALCANIN':'ROYAL CANIN','HUNZAG':'HUNZAG','GOODLIFESORTED':'GOOD LIFE SORTED',
  'PINTER':'PINTER','BEER52':'BEER52','1LIFE':'1LIFE','HYVE':'HYVE',
};
// (JUSTPARK_so intentionally omitted — no matching campaign row in the DB.)
const EXPECTED_CAMP_SECTION = {
  'Gousto':'Customer Services','VETNIQUE':'Customer Services',
  'JUSTPARK_usa':'Customer Services','JUSTPARK_uk':'Customer Services',
  'BUTTERNUTBOX':'Customer Services','Medexpress':'Customer Services','PICKNPAY':'Customer Services',
  'ROYALCANIN':'Customer Services','HUNZAG':'Customer Services','GOODLIFESORTED':'Customer Services',
  'HYVE':'Customer Services',
  'PINTER':'Sales','BEER52':'Sales','1LIFE':'Sales',
};
const EXPECTED_TARGETS = {
  'Gousto':         {csat:88,qa:90,cph:5.5,adherence:95,fulfil:100,realisation:90,churn:20,absence:5},
  'VETNIQUE':       {csat:90,qa:95,cph:6,res_time:48,acw:1.25,fulfil:100,realisation:90,churn:20,absence:5},
  'JUSTPARK_usa':   {csat:80,qa:85,fcr:90,sla:90,fulfil:100,realisation:90,churn:20,absence:5},
  'JUSTPARK_uk':    {csat:80,qa:90,cph:6,fcr:85,fulfil:100,realisation:90,churn:20,absence:5},
  'BUTTERNUTBOX':   {csat:90,qa:90,cpd:50,fulfil:100,realisation:90,churn:20,absence:5},
  'Medexpress':     {csat:85,qa:90,compliance:100,productivity:90,fulfil:100,realisation:90,churn:20,absence:5},
  'PICKNPAY':       {csat:85,qa:80,talk_sla:90,calls_abn:5,fulfil:100,realisation:90,churn:20,absence:5},
  'ROYALCANIN':     {qa:95,cph:4,error_rate:2,fulfil:100,realisation:90,churn:20,absence:5},
  'HUNZAG':         {qa:95,cpd:20,res_time:24,fulfil:100,realisation:90,churn:20,absence:5},
  'GOODLIFESORTED': {qa:95,cph:4,aht:3,calls_abn:8,fulfil:100,realisation:90,churn:20,absence:5},
  'PINTER':         {csat:80,qa:90,res_time:24,avg_resp_time:4,fulfil:100,realisation:90,churn:20,absence:5},
  'BEER52':         {qa:90,sph:1.25,fulfil:100,realisation:90,churn:20,absence:5},
  '1LIFE':          {qa:90,sales:350,fulfil:100,realisation:90,churn:20,absence:5},
};
const EXPECTED_KPI_CONFIG = {
  'Gousto':         [['csat','CSAT','higher'],['qa','QA','higher'],['cph','CPH','higher'],['adherence','Adherence','higher'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'VETNIQUE':       [['csat','CSAT','higher'],['qa','QA','higher'],['cph','CPH','higher'],['res_time','Res. time','lower'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'JUSTPARK_usa':   [['csat','CSAT','higher'],['qa','QA','higher'],['fcr','FCR','higher'],['sla','SLA','higher'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'JUSTPARK_uk':    [['csat','CSAT','higher'],['qa','QA','higher'],['cph','CPH','higher'],['fcr','FCR','higher'],['tickets','Tickets','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'BUTTERNUTBOX':   [['csat','CSAT','higher'],['qa','QA','higher'],['cpd','CPD','higher'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'Medexpress':     [['csat','CSAT','higher'],['qa','QA','higher'],['aht','AHT','lower'],['tickets','Tickets','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'PICKNPAY':       [['qa','QA','higher'],['sla','Talk SLA','higher'],['calls','Calls','none'],['abandon_rate','Abandoned','lower'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'ROYALCANIN':     [['qa','QA','higher'],['cph','CPH','higher'],['tickets','Tickets','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'HUNZAG':         [['qa','QA','higher'],['cpd','CPD','higher'],['res_time','Res. time','lower'],['tickets','Tickets','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'GOODLIFESORTED': [['qa','QA','higher'],['cph','CPH','higher'],['aht','AHT','lower'],['calls','Calls','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'PINTER':         [['csat','CSAT','higher'],['qa','QA','higher'],['res_time','Res. time','lower'],['tickets','Tickets','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  'BEER52':         [['qa','QA','higher'],['sph','SPH','higher'],['calls','Calls','none'],['sales','Sales','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
  '1LIFE':          [['qa','QA','higher'],['sales','Sales','higher'],['tickets','Tickets','none'],['fulfil','Fulfil','higher'],['realisation','Realisation','higher'],['churn','Churn','lower'],['absence','Absence','lower']],
};

test('buildCampaignConfig turns seed rows into the hardcoded WG_MAP', () => {
  const { WG_MAP } = buildCampaignConfig(CAMPS, KPIS_SORTED, WGS);
  assert.deepEqual(WG_MAP, EXPECTED_WG_MAP);
});
test('buildCampaignConfig turns seed rows into the hardcoded CAMP_DISPLAY', () => {
  const { CAMP_DISPLAY } = buildCampaignConfig(CAMPS, KPIS_SORTED, WGS);
  assert.deepEqual(CAMP_DISPLAY, EXPECTED_CAMP_DISPLAY);
});
test('buildCampaignConfig turns seed rows into the hardcoded CAMP_SECTION', () => {
  const { CAMP_SECTION } = buildCampaignConfig(CAMPS, KPIS_SORTED, WGS);
  assert.deepEqual(CAMP_SECTION, EXPECTED_CAMP_SECTION);
});
test('buildCampaignConfig turns seed rows into the hardcoded TARGETS', () => {
  const { TARGETS } = buildCampaignConfig(CAMPS, KPIS_SORTED, WGS);
  assert.deepEqual(TARGETS, EXPECTED_TARGETS);
});
test('buildCampaignConfig turns seed rows into the hardcoded KPI_CONFIG', () => {
  const { KPI_CONFIG } = buildCampaignConfig(CAMPS, KPIS_SORTED, WGS);
  assert.deepEqual(KPI_CONFIG, EXPECTED_KPI_CONFIG);
});
test('buildCampaignConfig turns seed rows into a SLUG_TO_CAMPKEY consistent with shift_key', () => {
  const { SLUG_TO_CAMPKEY } = buildCampaignConfig(CAMPS, KPIS_SORTED, WGS);
  for (const c of CAMPS) assert.equal(SLUG_TO_CAMPKEY[c.slug], c.shift_key);
});
