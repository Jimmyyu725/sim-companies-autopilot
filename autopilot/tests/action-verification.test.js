'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  bondOfferMatches,
  capturedCashSnapshot,
  buildingHasRobotSpecialization,
  buildingHasBusyResource,
  evaluateSpendGuard,
  explicitFiniteNumber,
  parseExplicitCurrency,
  planMarketPurchase,
  quoteFixedMarketPurchase,
  validateRebuildIdleEvidence,
  verifyBuildingRemoved,
  verifyBuildingRebuildStarted,
  verifyBuildingUpgradeStarted,
  verifyCollectionResult,
  verifyNewBuildingStarted,
} = require('../action-verification');
const { validateActionParams } = require('../action-contracts');

test('explicit finite parser never turns missing values into zero', () => {
  assert.equal(explicitFiniteNumber(null), null);
  assert.equal(explicitFiniteNumber(''), null);
  assert.equal(explicitFiniteNumber('0'), 0);
  assert.equal(explicitFiniteNumber('not-a-number'), null);
});

test('currency parser rejects a missing labor quote instead of turning it into zero', () => {
  assert.equal(parseExplicitCurrency(null), null);
  assert.equal(parseExplicitCurrency(''), null);
  assert.equal(parseExplicitCurrency(false), null);
  assert.equal(parseExplicitCurrency('$1,234.50'), 1234.5);
  assert.equal(parseExplicitCurrency('0'), 0);
});

test('captured cash fallback rejects unknown, stale, and materially future state', () => {
  const now = Date.parse('2026-07-27T03:00:00.000Z');
  assert.equal(capturedCashSnapshot({
    t: '2026-07-27T02:58:00.000Z', money: 1234,
  }, now).value, 1234);
  assert.equal(capturedCashSnapshot({
    t: '2026-07-27T02:00:00.000Z', money: 1234,
  }, now).value, null);
  assert.equal(capturedCashSnapshot({
    t: '2026-07-27T04:00:00.000Z', money: 1234,
  }, now).value, null);
  assert.equal(capturedCashSnapshot({
    t: '2026-07-27T03:00:00.000Z', money: null,
  }, now).value, null);
});

test('market planner never buys one unit when one unit exceeds maxSpend', () => {
  const result = planMarketPurchase([{ price: 13, quantity: 100 }], 10, 13);
  assert.equal(result.ok, false);
  assert.equal(result.quantity, 0);
});

test('market planner treats ask as a hard ceiling and ignores worse book levels', () => {
  const result = planMarketPurchase([
    { price: 10, quantity: 3 },
    { price: 11, quantity: 100 },
  ], 100, 10);
  assert.deepEqual(result, {
    ok: true,
    quantity: 3,
    estimatedCost: 30,
    topAsk: 10,
    priceCeiling: 10,
    highestFillPrice: 10,
  });
  assert.equal(planMarketPurchase([{ price: 11, quantity: 10 }], 100, 10).ok, false);
});

test('market planner defaults to the current best ask and remains within budget', () => {
  const result = planMarketPurchase([
    { price: 0.28, quantity: 5000 },
    { price: 0.29, quantity: 5000 },
  ], 1000, null);
  assert.equal(result.ok, true);
  assert.equal(result.quantity, 3571);
  assert.equal(result.highestFillPrice, 0.28);
  assert.ok(result.estimatedCost <= 1000);
});

test('fixed-quantity submit quote fails closed when price or depth moves', () => {
  assert.deepEqual(quoteFixedMarketPurchase([
    { price: 10, quantity: 3 },
    { price: 11, quantity: 2 },
  ], 5, 52, 11), {
    ok: true, quantity: 5, estimatedCost: 52, priceCeiling: 11, highestFillPrice: 11,
  });
  assert.equal(quoteFixedMarketPurchase([{ price: 11, quantity: 5 }], 5, 55, 10).ok, false);
  assert.equal(quoteFixedMarketPurchase([{ price: 10, quantity: 4 }], 5, 100, 10).ok, false);
  assert.equal(quoteFixedMarketPurchase([{ price: 11, quantity: 5 }], 5, 50, 11).ok, false);
});

test('busy-resource proof is scoped to the exact building and supports API aliases', () => {
  const buildings = [
    { id: 1, busy: null },
    { id: 2, busy: { resource: { kind: 119, name: 'Coffee ground' } } },
  ];
  assert.equal(buildingHasBusyResource(buildings, 1, 'COFFEE POWDER', 119), false);
  assert.equal(buildingHasBusyResource(buildings, 2, 'COFFEE POWDER', 119), true);
  assert.equal(buildingHasBusyResource(buildings, 2, 'GRAPES', 5), false);
  assert.equal(buildingHasBusyResource([
    { id: 3, busy: { resource: { name: 'Coffee ground' } } },
  ], 3, 'COFFEE POWDER'), true);
});

test('live construction spend must re-satisfy maxCost and the cash reserve', () => {
  assert.equal(evaluateSpendGuard(null, 100, 1000, 500).ok, false);
  assert.equal(evaluateSpendGuard('', 100, 1000, 500).ok, false);
  assert.equal(evaluateSpendGuard(101, 100, 1000, 500).ok, false);
  assert.match(evaluateSpendGuard(101, 100, 1000, 500).reason, /exceeds maxCost/);
  assert.equal(evaluateSpendGuard(400, 500, 800, 500).ok, false);
  assert.match(evaluateSpendGuard(400, 500, 800, 500).reason, /below reserve/);
  assert.deepEqual(evaluateSpendGuard(400, 500, 1000, 500), { ok: true, cashAfter: 600 });
});

test('bond success requires an independently read persisted offer', () => {
  assert.equal(bondOfferMatches({
    unsoldOfferAmountDollars: null,
    offerInterestPctPerDay: 0.5,
  }, 0, 0.5), false);
  const current = {
    unsoldOfferAmountDollars: 190000,
    offerInterestPctPerDay: 0.5,
  };
  assert.equal(bondOfferMatches(current, 190000, 0.5), true);
  assert.equal(bondOfferMatches({ ...current, unsoldOfferAmountDollars: 0 }, 190000, 0.5), false);
});

test('irreversible scrap succeeds only when the exact prior building disappears', () => {
  const before = [{ id: 10 }, { id: 11 }];
  assert.deepEqual(verifyBuildingRemoved(before, [{ id: 11 }], 10), { ok: true });
  assert.equal(verifyBuildingRemoved(before, before, 10).ok, false);
  assert.equal(verifyBuildingRemoved([{ id: 11 }], [], 10).ok, false);
  assert.equal(verifyBuildingRemoved(null, [], 10).ok, false);
});

test('rebuild proof requires the exact idle L1 target to enter reconstruction', () => {
  const observedAt = new Date().toISOString();
  const before = [
    { id: 10, name: 'Quarry', size: 1, busy: null },
    { id: 11, name: 'Farm', size: 2, busy: null },
  ];
  const idleEvidence = {
    status: 'validated', source: 'authoritative-api', buildingId: 10,
    buildingName: 'Quarry', level: 1, observedAt,
  };
  assert.deepEqual(verifyBuildingRebuildStarted(before, [
    { id: 10, name: 'Quarry', size: 1, busy: { category: 'construction' } },
    before[1],
  ], 10, idleEvidence), { ok: true, buildingId: 10, replacedBuildingId: 10 });
  assert.deepEqual(verifyBuildingRebuildStarted(before, [
    before[1],
    { id: 12, name: 'Quarry', size: 1, busy: { category: 'construction' } },
  ], 10, idleEvidence), { ok: true, buildingId: 12, replacedBuildingId: 10 });
  assert.deepEqual(verifyBuildingRebuildStarted(before, [
    before[1],
    { id: 12, name: 'Quarry', size: 1, busy: {
      category: 'construction', endsAt: '2026-07-27T18:35:07.398Z',
    } },
  ], 10, idleEvidence), {
    ok: true,
    buildingId: 12,
    replacedBuildingId: 10,
    completesAt: '2026-07-27T18:35:07.398Z',
  });
  assert.equal(verifyBuildingRebuildStarted(before, before, 10, idleEvidence).ok, false);
  assert.equal(verifyBuildingRebuildStarted([
    { id: 10, name: 'Quarry', size: 1, busy: { category: 'production' } },
  ], [{ id: 10, name: 'Quarry', size: 1, busy: { category: 'construction' } }], 10,
  idleEvidence).ok, false);
  assert.equal(verifyBuildingRebuildStarted(before, [
    { id: 10, name: 'Quarry', size: 1, busy: { category: 'production' } },
    before[1],
  ], 10, idleEvidence).ok, false);
  assert.equal(verifyBuildingRebuildStarted(before, [
    before[1],
    { id: 12, name: 'Mine', size: 1, busy: { category: 'construction' } },
  ], 10, idleEvidence).ok, false);
});

test('page-derived rebuild idle evidence is exact, fresh, and cannot override API busy', () => {
  const now = Date.parse('2026-07-27T09:30:00.000Z');
  const building = { id: 10, name: 'Quarry', size: 1 };
  const evidence = {
    source: 'page-derived', buildingId: 10, buildingName: 'Quarry', level: 1,
    observedAt: '2026-07-27T09:29:45.000Z', path: '/b/10/',
    construction: false, orderBusy: false, collectible: false, orderAvailable: true,
    rebuildOpenerCount: 1, rebuildOpenerEnabled: true,
  };
  assert.equal(validateRebuildIdleEvidence(building, evidence, now).ok, true);
  assert.equal(validateRebuildIdleEvidence({ ...building, busy: { category: 'production' } },
    evidence, now).ok, false);
  assert.equal(validateRebuildIdleEvidence(building, { ...evidence, path: '/b/11/' }, now).ok, false);
  assert.equal(validateRebuildIdleEvidence(building, { ...evidence, construction: true }, now).ok, false);
  assert.equal(validateRebuildIdleEvidence(building, {
    ...evidence, observedAt: '2026-07-27T09:28:00.000Z',
  }, now).ok, false);
});

test('robot installation proof is scoped to building and specialization kind', () => {
  const buildings = [
    { id: 20, robotsSpecialization: null },
    { id: 21, robotsSpecialization: 119 },
  ];
  assert.equal(buildingHasRobotSpecialization(buildings, 20, 'Coffee powder', 119), false);
  assert.equal(buildingHasRobotSpecialization(buildings, 21, 'Coffee powder', 119), true);
  assert.equal(buildingHasRobotSpecialization(buildings, 21, 'Grapes', 5), false);
});

test('build proof requires one exact new building in construction', () => {
  const before = [{ id: 1, name: 'Farm', busy: null }];
  assert.deepEqual(verifyNewBuildingStarted(before, [
    ...before,
    { id: 2, name: 'Quarry', busy: { category: 'construction' } },
  ], 'Quarry'), { ok: true, buildingId: 2 });
  assert.equal(verifyNewBuildingStarted(before, [...before, { id: 2, name: 'Quarry', busy: null }], 'Quarry').ok, false);
  assert.equal(verifyNewBuildingStarted(before, [
    ...before,
    { id: null, name: 'Quarry', busy: { category: 'construction' } },
  ], 'Quarry').ok, false);
  assert.equal(verifyNewBuildingStarted(before, before, 'Quarry').ok, false);
});

test('upgrade proof requires the exact target level to increase and become busy', () => {
  const before = [{ id: 1, size: 2, busy: null }, { id: 2, size: 2, busy: null }];
  assert.deepEqual(verifyBuildingUpgradeStarted(before, [
    { id: 1, size: 3, busy: { category: 'construction' } },
    { id: 2, size: 2, busy: null },
  ], 1), { ok: true, fromLevel: 2, toLevel: 3 });
  assert.equal(verifyBuildingUpgradeStarted(before, [
    { id: 1, size: 2, busy: null },
    { id: 2, size: 3, busy: { category: 'construction' } },
  ], 1).ok, false);
  assert.equal(verifyBuildingUpgradeStarted([{ id: 1, size: null, busy: null }], [
    { id: 1, size: 3, busy: { category: 'construction' } },
  ], 1).ok, false);
});

test('collection proof ties a production transition to the exact building and aggregate stock', () => {
  const before = {
    buildings: [{
      id: 1,
      busy: { id: 101, resource: { kind: 119, amountAvailableNow: 10 } },
    }],
    resources: [
      { kind: 119, quality: 0, amount: 90 },
      { kind: 119, quality: 1, amount: 10 },
    ],
    money: 1000,
  };
  const after = {
    buildings: [{
      id: 1,
      busy: { id: 101, resource: { kind: 119, amountAvailableNow: 0 } },
    }],
    resources: [
      { kind: 119, quality: 0, amount: 95 },
      { kind: 119, quality: 1, amount: 15 },
    ],
    money: 1000,
  };
  const result = verifyCollectionResult(before, after, [1]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.resourceKinds, [119]);
});

test('collection proof cannot substitute another building transition for the clicked target', () => {
  const before = {
    buildings: [
      { id: 1, busy: { id: 101, resource: { kind: 119, amountAvailableNow: 10 } } },
      { id: 2, busy: { id: 102, resource: { kind: 119, amountAvailableNow: 10 } } },
    ],
    resources: [{ kind: 119, amount: 100 }],
    money: 1000,
  };
  const after = {
    buildings: [
      { id: 1, busy: { id: 101, resource: { kind: 119, amountAvailableNow: 10 } } },
      { id: 2, busy: { id: 102, resource: { kind: 119, amountAvailableNow: 0 } } },
    ],
    resources: [{ kind: 119, amount: 110 }],
    money: 1000,
  };
  assert.equal(verifyCollectionResult(before, after, [1]).ok, false);
});

test('collection proof supports multiple exact buildings producing the same resource kind', () => {
  const before = {
    buildings: [
      { id: 1, busy: { id: 101, resource: { kind: 119, amountAvailableNow: 5 } } },
      { id: 2, busy: { id: 102, resource: { kind: 119, amountAvailableNow: 7 } } },
    ],
    resources: [{ kind: 119, amount: 100 }],
    money: 1000,
  };
  const after = {
    buildings: [
      { id: 1, busy: { id: 101, resource: { kind: 119, amountAvailableNow: 0 } } },
      { id: 2, busy: { id: 102, resource: { kind: 119, amountAvailableNow: 0 } } },
    ],
    resources: [{ kind: 119, amount: 112 }],
    money: 1000,
  };
  assert.equal(verifyCollectionResult(before, after, [1, 2]).ok, true);
});

test('collection proof accepts an exact canFetch reset when zero availability is omitted', () => {
  const before = {
    buildings: [{ id: 1, busy: { id: 101, canFetch: true, resource: { kind: 119 } } }],
    resources: [{ kind: 119, amount: 100 }],
    money: 1000,
  };
  const after = {
    buildings: [{ id: 1, busy: { id: 101, canFetch: false, resource: { kind: 119 } } }],
    resources: [{ kind: 119, amount: 110 }],
    money: 1000,
  };
  assert.equal(verifyCollectionResult(before, after, [1]).ok, true);
});

test('retail collection requires both the exact profit transition and higher company cash', () => {
  const before = {
    buildings: [{
      id: 3,
      busy: { id: 103, sales_order: { kind: 5, profitAvailableNow: 100 } },
    }],
    resources: [],
    money: 1000,
  };
  const after = {
    buildings: [{
      id: 3,
      busy: { id: 103, sales_order: { kind: 5, profitAvailableNow: 0 } },
    }],
    resources: [],
    money: 1100,
  };
  assert.equal(verifyCollectionResult(before, after, [3]).ok, true);
  assert.equal(verifyCollectionResult(before, { ...after, money: 1000 }, [3]).ok, false);
});

test('completed construction collection is proven by the exact job disappearing', () => {
  const before = {
    buildings: [{ id: 4, busy: { id: 104, category: 'b', canFetch: true } }],
    resources: [],
    money: 1000,
  };
  const after = {
    buildings: [{ id: 4, busy: null }],
    resources: [],
    money: 1000,
  };
  assert.equal(verifyCollectionResult(before, after, [4]).ok, true);
});

test('collection proof fails closed on unchanged stock, ambiguous IDs, or missing snapshots', () => {
  const before = {
    buildings: [{
      id: 1,
      busy: { id: 101, resource: { kind: 119, amountAvailableNow: 10 } },
    }],
    resources: [{ kind: 119, amount: 100 }],
    money: 1000,
  };
  const after = {
    buildings: [{
      id: 1,
      busy: { id: 101, resource: { kind: 119, amountAvailableNow: 0 } },
    }],
    resources: [{ kind: 119, amount: 100 }],
    money: 1000,
  };
  assert.equal(verifyCollectionResult(before, after, [1]).ok, false);
  assert.equal(verifyCollectionResult(before, after, [1, 1]).ok, false);
  assert.equal(verifyCollectionResult(before, null, [1]).ok, false);
  assert.equal(verifyCollectionResult({
    ...before,
    resources: [{ kind: 119, amount: null }],
  }, after, [1]).ok, false);
  assert.equal(verifyCollectionResult({
    ...before,
    buildings: [...before.buildings, { ...before.buildings[0] }],
  }, after, [1]).ok, false);
  assert.equal(verifyCollectionResult({
    ...before,
    buildings: [{
      id: 1,
      busy: { id: 101, canFetch: false, resource: { kind: 119, amountAvailableNow: 0 } },
    }],
  }, {
    ...after,
    buildings: [{ id: 1, busy: null }],
    resources: [{ kind: 119, amount: 110 }],
  }, [1]).ok, false);
});

test('robots buying requires explicit bounded spend fields', () => {
  const base = {
    buildingId: 1,
    specialization: 'COFFEE POWDER',
    confirm: true,
    buyMissing: true,
    maxCost: 1000,
    minCashAfter: 500,
  };
  assert.equal(validateActionParams('robots', base).ok, true);
  assert.equal(validateActionParams('robots', { ...base, maxCost: null }).ok, true);
  assert.equal(validateActionParams('robots', { ...base, minCashAfter: 499 }).ok, false);
});

test('exchange sale quantities must be positive integers before inspection consumption', () => {
  assert.equal(validateActionParams('exchange_sell', {
    name: 'power', qty: 1, price: 0.28, confirm: false,
  }).ok, true);
  assert.equal(validateActionParams('exchange_sell', {
    name: 'power', qty: 1.5, price: 0.28, confirm: false,
  }).ok, false);
});

test('buy reserve override is internal and cannot go below $500', () => {
  assert.equal(validateActionParams('buy', {
    kind: 1, maxSpend: 100, ask: null, minCashAfter: 500,
  }).ok, true);
  assert.equal(validateActionParams('buy', {
    kind: 1, maxSpend: 100, ask: null, minCashAfter: 499,
  }).ok, false);
});

test('malformed action JSON returns one structured refusal without browser access', () => {
  const act = path.join(__dirname, '..', 'act.js');
  const child = spawnSync(process.execPath, [act, 'collect', '{'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.ok, false);
  assert.equal(result.guard, true);
  assert.match(result.reason, /not valid JSON/);
  assert.equal(child.stderr, '');
});

test('all evaluated action fragments compile as async function bodies', () => {
  const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
  const actionDir = path.join(__dirname, '..', 'actions');
  const standalone = new Set(['contract-send.js', 'sell-exchange-ui.js']);
  for (const name of fs.readdirSync(actionDir).filter(name => name.endsWith('.js'))) {
    if (standalone.has(name)) continue;
    const source = fs.readFileSync(path.join(actionDir, name), 'utf8');
    assert.doesNotThrow(() => new AsyncFunction(source), name);
  }
});
