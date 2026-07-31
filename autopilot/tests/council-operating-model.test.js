'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCouncilDecisionModel,
  buildCoffeeOperatingModel,
  parseDurationHours,
  retailEvidenceFromState,
  selectPortfolioBuildings,
} = require('../council-operating-model.js');
const { boundedRetailPrices } = require('../inspect-retail-curve.js');

const NOW = '2026-07-31T15:26:32.430Z';
const facts = {
  resources: {
    1: { recipe: {} },
    2: { recipe: { 1: 0.2 } },
    66: { recipe: { 2: 0.1 } },
    118: { recipe: { 2: 0.5, 66: 1 } },
    119: { recipe: { 118: 10 } },
  },
};

const buildings = [
  { id: 10, name: 'Water reservoir', size: 1, busy: { type: 'production', makingKind: 2 } },
  { id: 11, name: 'Power plant', size: 1, busy: { type: 'production', makingKind: 1 } },
  { id: 12, name: 'Mill', size: 3, busy: { type: 'production', makingKind: 119 } },
  { id: 13, name: 'Mill', size: 3, busy: { type: 'production', makingKind: 119 } },
  { id: 14, name: 'Mill', size: 3, busy: { type: 'production', makingKind: 119 } },
  { id: 15, name: 'Farm', size: 3, busy: { type: 'production', makingKind: 118 } },
  { id: 16, name: 'Farm', size: 2, busy: { type: 'production', makingKind: 66 } },
  { id: 17, name: 'Grocery store', size: 2, busy: {
    type: 'sale', makingKind: 119, amount: 3000, remainingProfit: 51072, price: 38.4,
    endsAt: '2026-07-31T23:27:17.093Z', amountSemantics: 'sales-order-remaining',
  } },
  { id: 18, name: 'Quarry', size: 1, busy: null },
];

const state = {
  t: NOW,
  freeSlots: 3,
  buildings,
  stock: [1, 2, 66, 118, 119].map(kind => ({ kind, availableAmount: 1000 + kind })),
};

function product(kind, productionPerHour, modifier = { status: 'none' }) {
  return { kind, name: `kind ${kind}`, productionPerHour, modifier };
}

const inspections = [
  { ok: true, buildingId: 10, name: 'Water reservoir', level: 1, products: [product(2, 1676.73)] },
  { ok: true, buildingId: 11, name: 'Power plant', level: 1, products: [product(1, 2646.33)] },
  { ok: true, buildingId: 12, name: 'Mill', level: 3, products: [product(119, 71.01)] },
  { ok: true, buildingId: 13, name: 'Mill', level: 3, products: [product(119, 71.01)] },
  { ok: true, buildingId: 14, name: 'Mill', level: 3, products: [product(119, 71.01)] },
  { ok: true, buildingId: 15, name: 'Farm', level: 3,
    currentJob: { makingKind: 118 }, products: [
      product(66, 2751.43),
      product(118, 1543.55, { status: 'active', direction: 'increased', percent: 21,
        expiresAt: '2026-08-03T00:00:00.000Z' }),
    ] },
  { ok: true, buildingId: 16, name: 'Farm', level: 2,
    currentJob: { makingKind: 66 }, products: [
      product(66, 1834.29),
      product(118, 1029.03, { status: 'active', direction: 'increased', percent: 21,
        expiresAt: '2026-08-03T00:00:00.000Z' }),
    ] },
  { ok: true, buildingId: 17, name: 'Grocery store', level: 2, products: [] },
];

test('Council portfolio selection includes the focus plus every Coffee-chain building', () => {
  const selected = selectPortfolioBuildings(state, 18);
  assert.equal(selected[0].buildingId, 18);
  assert.equal(selected.length, 9);
  assert.deepEqual(new Set(selected.slice(1).map(row => row.buildingId)),
    new Set([10, 11, 12, 13, 14, 15, 16, 17]));
});

test('active Grocery order yields an exact current retail point', () => {
  const evidence = retailEvidenceFromState(state);
  assert.equal(evidence.status, 'ACTIVE_ORDER');
  assert.equal(evidence.activeOrder.price, 38.4);
  assert.equal(evidence.activeOrder.profitPerUnit, 17.024);
  assert(evidence.activeOrder.unitsPerHour > 374);
  assert(evidence.activeOrder.unitsPerHour < 375);
});

test('idle Grocery curve derives units per hour from the form profit projection', () => {
  const idle = {
    ...state,
    buildings: state.buildings.map(building => building.id === 17 ? { ...building, busy: null } : building),
  };
  const evidence = retailEvidenceFromState(idle, {
    status: 'LIVE_CURVE', source: '/b/17/',
    best: { price: 40, profitPerUnit: 20, profitPerHour: 5000 },
    tested: [],
  });
  assert.equal(evidence.status, 'LIVE_CURVE');
  assert.equal(evidence.curve.best.unitsPerHour, 250);
});

test('Coffee model identifies the joint Farm allocation bottleneck and modifier expiry risk', () => {
  const model = buildCoffeeOperatingModel({ state, inspections, facts });
  assert.equal(model.status, 'COMPLETE');
  assert.deepEqual(model.missingPortfolioBuildingIds, []);
  assert(model.current.bottlenecks.includes('FARM_SEEDS_BEANS_BALANCE'));
  assert(model.current.sustainablePowderPerHour > 164);
  assert(model.current.sustainablePowderPerHour < 165);
  assert(model.current.mills.powderPerHour > model.current.sustainablePowderPerHour);
  assert(model.current.utilities.waterBoundBeansPerHour > model.current.sustainableBeansPerHour);
  assert(model.current.utilities.powerBoundBeansPerHour > model.current.sustainableBeansPerHour);
  assert(model.afterKnownProductionModifiers.sustainablePowderPerHour <
    model.current.sustainablePowderPerHour);
  assert.equal(model.modifierExpiries[0].kind, 118);
});

test('candidate comparison quantifies slot, downtime, incremental profit, and payback', () => {
  const model = buildCouncilDecisionModel({
    state,
    inspections,
    facts,
    candidates: [
      { optionId: 'hold', action: 'hold', terms: {}, preview: { ok: true, dry: true } },
      { optionId: 'build_farm', action: 'build', terms: { building: 'farm' },
        preview: { ok: true, dry: true, quoted: 7704, cashAfter: 100000 } },
      { optionId: 'upgrade_farm', action: 'upgrade', terms: { buildingId: 15 },
        preview: { ok: true, dry: true, cashCost: 23152, cashAfter: 85000, downtime: '3:00h' } },
    ],
  });
  const [hold, build, upgrade] = model.candidateComparison;
  assert.equal(hold.evidenceStatus, 'MEASURED_BASELINE');
  assert.equal(hold.cashCost, null);
  assert.equal(hold.incrementalRetailContributionPerHour, 0);
  assert.equal(build.slotDelta, 1);
  assert.equal(upgrade.slotDelta, 0);
  assert.equal(build.freeSlotsAfter, 2);
  assert.equal(build.slotFeasible, true);
  assert.equal(build.incrementalRetailPowderPerHour, upgrade.incrementalRetailPowderPerHour);
  assert(build.incrementalRetailContributionPerHour > 0);
  assert.equal(build.incrementalContributionPerAddedSlotHour,
    build.incrementalRetailContributionPerHour);
  assert.equal(upgrade.incrementalContributionPerAddedSlotHour, null);
  assert.equal(build.downtimeLostProfit, null);
  assert(upgrade.downtimeLostProfit > 0);
  assert(build.paybackHours < upgrade.paybackHours);
});

test('missing one owned building keeps the operating model partial instead of undercounting it', () => {
  const missingMill = inspections.filter(inspection => inspection.buildingId !== 14);
  const model = buildCoffeeOperatingModel({ state, inspections: missingMill, facts });
  assert.equal(model.status, 'PARTIAL');
  assert.deepEqual(model.missingPortfolioBuildingIds, [14]);
});

test('retail curve uses a bounded deterministic scan and duration parser handles game format', () => {
  assert.deepEqual(boundedRetailPrices(40), [28, 34, 38, 40, 42, 46, 52]);
  assert.equal(parseDurationHours('3:00h'), 3);
  assert.equal(parseDurationHours('1:30h'), 1.5);
  assert.equal(parseDurationHours('24h'), 24);
  assert.equal(parseDurationHours(null), null);
});
