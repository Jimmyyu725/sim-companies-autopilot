'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareMillUpgradeCandidates } = require('../mill-upgrade-policy.js');

const NOW = Date.parse('2026-07-26T03:25:00.000Z');

test('L1 to L2 dominates L2 to L3 when both add the same Mill capacity', () => {
  const result = compareMillUpgradeCandidates([
    {
      buildingId: 101,
      currentLevel: 1,
      currentRate: 18.04,
      productionIncreasePct: 100,
      cashCost: 31244,
      downtimeHours: 3,
      evidenceAsOf: '2026-07-26T03:24:44Z',
    },
    {
      buildingId: 202,
      currentLevel: 2,
      currentRate: 36.08,
      productionIncreasePct: 50,
      cashCost: 61694,
      downtimeHours: 6,
      evidenceAsOf: '2026-07-26T03:24:57Z',
    },
  ], { nowMs: NOW });

  assert.equal(result.recommendedBuildingId, 101);
  assert.deepEqual(result.frontierBuildingIds, [101]);
  assert.equal(result.financingConsidered, false);
  assert.equal(result.candidates[0].addedRate, 18.04);
  assert.equal(result.candidates[0].downtimeOutputLoss, 54.12);
  assert.equal(result.candidates[1].downtimeOutputLoss, 216.48);
  assert.deepEqual(result.candidates[0].dominates, [202]);
});

test('incomparable candidates stay on the frontier for explicit business judgment', () => {
  const result = compareMillUpgradeCandidates([
    {
      buildingId: 101,
      currentLevel: 1,
      currentRate: 20,
      productionIncreasePct: 100,
      cashCost: 40000,
      downtimeHours: 6,
      evidenceAsOf: '2026-07-26T03:24:44Z',
    },
    {
      buildingId: 202,
      currentLevel: 2,
      currentRate: 30,
      productionIncreasePct: 50,
      cashCost: 30000,
      downtimeHours: 3,
      evidenceAsOf: '2026-07-26T03:24:57Z',
    },
  ], { nowMs: NOW });

  assert.equal(result.recommendedBuildingId, null);
  assert.equal(result.requiresJudgment, true);
  assert.deepEqual(result.frontierBuildingIds, [101, 202]);
});

test('invalid or duplicate candidates are rejected', () => {
  const candidate = {
    buildingId: 101,
    currentLevel: 1,
    currentRate: 18,
    productionIncreasePct: 100,
    cashCost: 30000,
    downtimeHours: 3,
    evidenceAsOf: '2026-07-26T03:24:44Z',
  };
  assert.throws(() => compareMillUpgradeCandidates([candidate], { nowMs: NOW }), /two or three/);
  assert.throws(() => compareMillUpgradeCandidates([candidate, candidate], { nowMs: NOW }), /unique/);
  assert.throws(() => compareMillUpgradeCandidates([
    candidate,
    { ...candidate, buildingId: 202, evidenceAsOf: 'unknown' },
  ], { nowMs: NOW }), /valid timestamp/);

  assert.throws(() => compareMillUpgradeCandidates([
    { ...candidate, evidenceAsOf: '2026-07-26T03:19:59.000Z' },
    { ...candidate, buildingId: 202 },
  ], { nowMs: NOW }), /fresh/);

  assert.throws(() => compareMillUpgradeCandidates([
    { ...candidate, evidenceAsOf: '2026-07-26T03:25:31.000Z' },
    { ...candidate, buildingId: 202 },
  ], { nowMs: NOW }), /future/);
});
