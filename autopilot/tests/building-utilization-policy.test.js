'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildingUtilizationJournalGate,
  inspectOperationalUtilization,
} = require('../building-utilization-policy.js');

const NOW = Date.parse('2026-07-26T23:00:00.000Z');

function state(buildings, overrides = {}) {
  return {
    t: '2026-07-26T22:59:30.000Z',
    sources: { buildings: { status: 'ok' } },
    buildings,
    ...overrides,
  };
}

test('blocks journal when a standard production or sales building is confirmed idle', () => {
  const gate = buildingUtilizationJournalGate(state([
    { id: 1, name: 'Mill', size: 1, category: 'production', busy: null },
    { id: 2, name: 'Grocery store', size: 2, category: 'sales', busy: null },
    { id: 3, name: 'Farm', size: 3, category: 'production', busy: { type: 'production' } },
  ]), NOW);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.idleBuildings.map(row => row.buildingId), [1, 2]);
  assert.deepEqual(gate.requiredActions.map(row => row.tool), ['produce', 'sell']);
  assert.match(gate.reason, /Waiting for an upgrade/);
});

test('seasonal, free-and-locked, and unknown-busy buildings are not false idle positives', () => {
  const result = inspectOperationalUtilization(state([
    { id: 1, name: 'Beach market', category: 'seasonal', freeAndLocked: true, busy: null },
    { id: 2, name: 'Locked production', category: 'production', freeAndLocked: true, busy: null },
    { id: 3, name: 'Unknown production', category: 'production' },
    { id: 4, name: 'Mill', category: 'production', busy: { type: 'unknown' } },
  ]), NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.idleBuildings, []);
  assert.equal(buildingUtilizationJournalGate(state([
    { id: 1, name: 'Beach market', category: 'seasonal', freeAndLocked: true, busy: null },
  ]), NOW), null);
});

test('an UNKNOWN Grocery blocks close, while the exact seasonal Beach market remains exempt', () => {
  const gate = buildingUtilizationJournalGate(state([
    {
      id: 54990492, name: 'Beach market', size: 1,
      category: 'seasonal', freeAndLocked: true,
      activity: { status: 'unknown', busy: null, type: 'unknown' },
    },
    {
      id: 54959779, name: 'Grocery store', size: 2,
      category: 'sales', freeAndLocked: false,
      activity: { status: 'unknown', busy: null, type: 'unknown' },
    },
  ]), NOW);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.unknownBuildings.map(row => row.buildingId), [54959779]);
  assert.equal(gate.requiredTool, 'inspect_building');
  assert.deepEqual(gate.requiredActions, [{
    buildingId: 54959779, tool: 'inspect_building', product: null, qty: null,
  }]);
});

test('exact retail page evidence distinguishes active sale, construction, and idle', () => {
  const base = {
    id: 54959779, name: 'Grocery store', size: 2, category: 'sales',
  };
  const inspection = (busy, type, evidence) => ({
    schemaVersion: 1,
    status: 'page-derived',
    observedAt: '2026-07-26T22:59:45.000Z',
    source: '/b/54959779/',
    buildingId: 54959779,
    level: 2,
    busy,
    type,
    evidence: {
      construction: false,
      retailSale: false,
      orderBusy: false,
      collectible: false,
      productionOrderAvailable: false,
      retailOrderAvailable: false,
      retailCardCount: 0,
      ...evidence,
    },
  });
  const sale = buildingUtilizationJournalGate(state([{
    ...base,
    activityInspection: inspection(true, 'sale', { retailSale: true }),
  }]), NOW);
  assert.equal(sale, null);
  const construction = buildingUtilizationJournalGate(state([{
    ...base,
    activityInspection: inspection(true, 'construction', { construction: true }),
  }]), NOW);
  assert.equal(construction, null);
  const idle = buildingUtilizationJournalGate(state([{
    ...base,
    activityInspection: inspection(false, 'idle', { retailOrderAvailable: true,
      retailCardCount: 1 }),
  }]), NOW);
  assert.deepEqual(idle.idleBuildings.map(row => row.buildingId), [54959779]);
  assert.equal(idle.requiredActions[0].tool, 'sell');
});

test('a generic busy object is not guessed to be a retail sale', () => {
  const gate = buildingUtilizationJournalGate(state([{
    id: 54959779, name: 'Grocery store', size: 2, category: 'sales',
    busy: { type: 'unknown' },
  }]), NOW);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.unknownBuildings.map(row => row.buildingId), [54959779]);
});

test('stale or non-authoritative building evidence cannot clear the utilization gate', () => {
  const stale = buildingUtilizationJournalGate(state([], {
    t: '2026-07-26T22:50:00.000Z',
  }), NOW);
  assert.equal(stale.requiredTool, 'refresh_state');
  const unknown = buildingUtilizationJournalGate(state([], {
    sources: { buildings: { status: 'unknown' } },
  }), NOW);
  assert.equal(unknown.requiredTool, 'refresh_state');
});

test('all occupied standard buildings clear the gate', () => {
  const gate = buildingUtilizationJournalGate(state([
    { id: 1, name: 'Mill', category: 'production', busy: { type: 'production' } },
    { id: 2, name: 'Grocery store', category: 'sales', busy: { type: 'sale' } },
    { id: 3, name: 'Farm', category: 'production', busy: { type: 'construction' } },
  ]), NOW);
  assert.equal(gate, null);
});

test('idle Prospector pool targets stay reserved while ordinary idle buildings still block', () => {
  const ownerDirective = {
    status: 'pending',
    prospectorExperiment: {
      building: 'Quarry', buildingId: 10, level: 1, status: 'baseline-verified',
      campaign: {
        mode: 'repeat-until-achievement-complete', status: 'active',
        targetCapacity: 2, activeTargetId: 'primary',
        targets: [
          { targetId: 'primary', building: 'Quarry', buildingId: 10, level: 1,
            status: 'ready', completesAt: '2026-07-26T22:00:00.000Z' },
        ],
      },
    },
  };
  assert.equal(buildingUtilizationJournalGate(state([
    { id: 10, name: 'Quarry', size: 1, category: 'production', busy: null },
  ]), NOW, { ownerDirective }), null);
  const blocked = buildingUtilizationJournalGate(state([
    { id: 10, name: 'Quarry', size: 1, category: 'production', busy: null },
    { id: 11, name: 'Farm', size: 1, category: 'production', busy: null },
  ]), NOW, { ownerDirective });
  assert.deepEqual(blocked.reservedIdleBuildings.map(row => row.buildingId), [10]);
  assert.deepEqual(blocked.idleBuildings.map(row => row.buildingId), [11]);
});

test('a completed but uncollected job cannot masquerade as occupied', () => {
  const gate = buildingUtilizationJournalGate(state([
    {
      id: 1,
      name: 'Mill',
      category: 'production',
      busy: { type: 'production', endsAt: '2026-07-26T22:59:00.000Z' },
    },
    {
      id: 2,
      name: 'Grocery store',
      category: 'sales',
      busy: { type: 'sale', endsAt: '2026-07-26T23:05:00.000Z' },
    },
  ]), NOW);
  assert.deepEqual(gate.completedBuildings.map(row => row.buildingId), [1]);
  assert.equal(gate.requiredActions[0].tool, 'collect');
});

test('a job that completed after capture but before the gate runs is still collect-required', () => {
  const gate = buildingUtilizationJournalGate(state([{
    id: 1,
    name: 'Mill',
    category: 'production',
    busy: { type: 'production', endsAt: '2026-07-26T22:59:45.000Z' },
  }]), NOW);
  assert.deepEqual(gate.completedBuildings.map(row => row.buildingId), [1]);
  assert.equal(gate.requiredActions[0].tool, 'collect');
});

test('an invalid gate clock cannot clear utilization evidence', () => {
  const result = buildingUtilizationJournalGate(state([]), Number.NaN);
  assert.equal(result.ok, false);
  assert.equal(result.requiredTool, 'refresh_state');
});

// Regression (2026-08-02): the runtime refuses production on an idle level-1 extraction site while
// the Prospector campaign runs, so that it stays scrappable. But enrolment is capped (3 targets),
// and this gate counted every unenrolled idle Quarry as a no-voluntary-idle failure — leaving the
// wake with no legal move at all: it could neither work them nor close the journal. Idle campaign
// capacity is reserved, not a failure.
test('idle level-1 extraction sites are reserved while the campaign runs', () => {
  const buildings = [
    { id: 10, name: 'Quarry', size: 1, category: 'production', busy: null },
    { id: 11, name: 'Quarry', size: 1, category: 'production', busy: null },
    { id: 12, name: 'Mill', size: 3, category: 'production', busy: null },
  ];
  const activeCampaign = { prospectorExperiment: { campaign: { status: 'active' } } };

  const gate = buildingUtilizationJournalGate(state(buildings), NOW, {
    ownerDirective: activeCampaign,
  });
  // The Mill is still a genuine idle failure; the Quarries are not.
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.idleBuildings.map(row => row.buildingId), [12]);
  assert.deepEqual(gate.reservedIdleBuildings.map(row => row.buildingId).sort(), [10, 11]);

  // With every non-campaign building busy, the wake can close even with idle Quarries.
  const onlyQuarriesIdle = buildingUtilizationJournalGate(state([
    { id: 10, name: 'Quarry', size: 1, category: 'production', busy: null },
    { id: 11, name: 'Quarry', size: 1, category: 'production', busy: null },
    { id: 12, name: 'Mill', size: 3, category: 'production', busy: { type: 'production' } },
  ]), NOW, { ownerDirective: activeCampaign });
  assert.equal(onlyQuarriesIdle, null,
    'idle campaign capacity alone must not block the journal');

  // Without an active campaign an idle Quarry is an ordinary idle failure again.
  const noCampaign = buildingUtilizationJournalGate(state(buildings), NOW, {
    ownerDirective: { prospectorExperiment: { campaign: { status: 'complete' } } },
  });
  assert.equal(noCampaign.ok, false);
  assert.deepEqual(noCampaign.idleBuildings.map(row => row.buildingId).sort(), [10, 11, 12]);
});
