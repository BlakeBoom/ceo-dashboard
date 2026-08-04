// Tests for the pure team-structure resolution (server/src/teamStructure.js).
// Run with `npm test` (node:test, no deps, no DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  managerEmployeeNo, teamNodeFor, cmByCampaignFrom, computeTeamStructure, UNASSIGNED_TEAM,
} from '../server/src/teamStructure.js';

// Fixture org: campaign 1 has CM Carla; TL Rugshana (→ Carla) with agents Abdul
// & Bilqis; TL Sub-Tanya (→ Rugshana) with agent Dee; agent Evan reports to Carla
// directly; agent Fay has no manager (→ campaign CM); Gita is in campaign 2 which
// has no CM (→ Unassigned). Hana reports into a cycle.
const U = [
  { id: 1,  full_name: 'Carla Cortez',    role: 'campaign_lead', campaign_id: 1, manager_id: null },
  { id: 2,  full_name: 'Rugshana Hendricks', role: 'tm',        campaign_id: 1, manager_id: 1 },
  { id: 3,  full_name: 'Abdul Kader',     role: 'agent',        campaign_id: 1, manager_id: 2 },
  { id: 4,  full_name: 'Bilqis Adams',    role: 'agent',        campaign_id: 1, manager_id: 2 },
  { id: 5,  full_name: 'Tanya Smith',     role: 'tm',           campaign_id: 1, manager_id: 2 }, // TL under a TL
  { id: 6,  full_name: 'Dee Daniels',     role: 'agent',        campaign_id: 1, manager_id: 5 },
  { id: 7,  full_name: 'Evan Europa',     role: 'agent',        campaign_id: 1, manager_id: 1 }, // reports to CM
  { id: 8,  full_name: 'Fay Fortune',     role: 'agent',        campaign_id: 1, manager_id: null }, // no manager
  { id: 9,  full_name: 'Gita Grewal',     role: 'agent',        campaign_id: 2, manager_id: null }, // campaign w/o CM
  { id: 10, full_name: 'Hana Hart',       role: 'agent',        campaign_id: 1, manager_id: 11 },
  { id: 11, full_name: 'Ivy Isaacs',      role: 'agent',        campaign_id: 1, manager_id: 10 }, // 10↔11 cycle
];
const byId = new Map(U.map(u => [u.id, u]));
const cm = cmByCampaignFrom(U);
const nodeOf = name => teamNodeFor(U.find(u => u.full_name === name), byId, cm).node;
const typeOf = name => teamNodeFor(U.find(u => u.full_name === name), byId, cm).type;

test('managerEmployeeNo: trailing employee number, incl. short ids', () => {
  assert.equal(managerEmployeeNo('Amaarah De Vries 1302'), '1302');
  assert.equal(managerEmployeeNo('Robert Joubert 1'), '1');           // short id, not garbage
  assert.equal(managerEmployeeNo('No Number Here'), null);
  assert.equal(managerEmployeeNo(null), null);
});

test('a TL is their own node; a CM is their own catch-all node', () => {
  assert.equal(nodeOf('Rugshana Hendricks'), 'Rugshana Hendricks');
  assert.equal(typeOf('Rugshana Hendricks'), 'tl');
  assert.equal(nodeOf('Carla Cortez'), 'Carla Cortez — direct & unassigned');
  assert.equal(typeOf('Carla Cortez'), 'cm');
});

test('agents land under their nearest TL', () => {
  assert.equal(nodeOf('Abdul Kader'), 'Rugshana Hendricks');
  assert.equal(nodeOf('Bilqis Adams'), 'Rugshana Hendricks');
});

test('TL-under-TL: sub-TL is their own node; parent does NOT absorb its agents', () => {
  assert.equal(nodeOf('Tanya Smith'), 'Tanya Smith');           // sub-TL own node
  assert.equal(nodeOf('Dee Daniels'), 'Tanya Smith');           // under the sub-TL, not Rugshana
});

test('agent reporting directly to a CM → the CM catch-all', () => {
  assert.equal(nodeOf('Evan Europa'), 'Carla Cortez — direct & unassigned');
  assert.equal(typeOf('Evan Europa'), 'cm');
});

test('unassigned agent falls to the campaign CM catch-all', () => {
  assert.equal(nodeOf('Fay Fortune'), 'Carla Cortez — direct & unassigned');
});

test('unassigned agent in a campaign with no single CM → org Unassigned', () => {
  assert.equal(nodeOf('Gita Grewal'), UNASSIGNED_TEAM);
  assert.equal(typeOf('Gita Grewal'), 'unassigned');
});

test('a reporting cycle does not loop forever', () => {
  // 10↔11 with no TL/CM in the cycle → campaign-1 CM catch-all (terminates).
  assert.equal(nodeOf('Hana Hart'), 'Carla Cortez — direct & unassigned');
  assert.equal(nodeOf('Ivy Isaacs'), 'Carla Cortez — direct & unassigned');
});

test('computeTeamStructure: every user gets exactly one node; stats add up', () => {
  const { nodes, stats } = computeTeamStructure(U);
  assert.equal(nodes.length, U.length);
  assert.equal(stats.tl + stats.cm + stats.unassigned, stats.total);
  assert.equal(stats.total, U.length);
  assert.equal(stats.unassigned, 1);        // only Gita
  assert.ok(stats.tlNodeCount >= 2);        // Rugshana + Tanya
});
