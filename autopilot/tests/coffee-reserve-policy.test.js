'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateCoffeeReservePolicy } = require('../coffee-reserve-policy.js');

const NOW = Date.parse('2026-07-26T20:10:00.000Z');
const facts = {
  resources: {
    1: { recipe: {}, transportation: 0 },
    2: { recipe: { 1: 0.2 }, transportation: 0 },
    5: { recipe: { 2: 4, 66: 1 }, transportation: 1 },
    13: { recipe: {}, transportation: 0 },
    66: { recipe: { 2: 0.1 }, transportation: 0.1 },
    118: { recipe: { 2: 0.5, 66: 1 }, transportation: 0.1 },
    119: { recipe: { 118: 10 }, transportation: 1 },
  },
};

function fixture({ rate = 10, inspectedAt = '2026-07-26T20:05:00.000Z', amounts = {} } = {}) {
  const defaults = { 1: 10000, 2: 10000, 5: 500, 13: 1, 66: 10000, 118: 10000, 119: 500 };
  const state = {
    t: new Date(NOW).toISOString(),
    warehouse: { complete: true, allPositiveProductsIncluded: true },
    sources: {
      stock: { status: 'ok', asOf: new Date(NOW).toISOString() },
      modifiers: { status: 'ok', asOf: new Date(NOW).toISOString() },
    },
    modifiers: [],
    buildings: [{ id: 101, name: 'Mill', kindLetter: 'i', size: 2, busy: null }],
    stock: Object.entries({ ...defaults, ...amounts }).map(([kind, amount]) => ({
      kind: Number(kind), name: `kind ${kind}`, amount, known: true,
    })),
  };
  const inspectionCache = [{
    ok: true,
    inspectedAt,
    buildingId: 101,
    level: 2,
    source: '/b/101/',
    products: [{ kind: 119, productionPerHour: rate, modifier: { status: 'none' } }],
  }];
  return { state, inspectionCache };
}

function setPowderModifier(input, { direction, percent, expiresAt, since = '2026-07-26T19:00:00.000Z' }) {
  input.inspectionCache[0].products[0].modifier = {
    status: 'active', direction, percent, expiresAt,
  };
  input.state.modifiers = [{
    realm: 0,
    kind: 119,
    pct: direction === 'increased' ? percent : -percent,
    since,
    until: expiresAt,
  }];
}

test('verified recipe reserves follow the 10/10/6/1.2 Coffee chain', () => {
  const input = fixture();
  const result = calculateCoffeeReservePolicy({ ...input, facts, horizonHours: 24, bufferPct: 0, nowMs: NOW });
  assert.equal(result.status, 'ok');
  assert.equal(result.millCapacity.powderPerHour, 10.005);
  assert.equal(result.items[119].reserve, 241);
  assert.equal(result.items[118].reserve, 2402);
  assert.equal(result.items[66].reserve, 2402);
  assert.equal(result.items[2].reserve, 1441);
  assert.equal(result.items[1].reserve, 289);
});

test('Power and Water sellable surplus is not capped by Transport', () => {
  const input = fixture();
  const result = calculateCoffeeReservePolicy({ ...input, facts, bufferPct: 0, nowMs: NOW });
  assert.equal(result.items[1].transportPerUnit, 0);
  assert.equal(result.items[1].maxByTransport, null);
  assert.equal(result.items[1].sellable, 9711);
  assert.equal(result.items[2].transportPerUnit, 0);
  assert.equal(result.items[2].sellable, 8559);
  assert.equal(result.items[5].transportPerUnit, 1);
  assert.equal(result.items[5].sellable, 1);
  assert.equal(result.items[66].maxByTransport, 10);
});

test('missing or stale per-Mill rate evidence fails closed', () => {
  const missing = fixture();
  missing.inspectionCache = [];
  const missingResult = calculateCoffeeReservePolicy({ ...missing, facts, nowMs: NOW });
  assert.equal(missingResult.complete, false);
  assert.equal(missingResult.status, 'unknown');
  assert.ok(Object.values(missingResult.items).every(item => item.sellable === 0));

  const stale = fixture({ inspectedAt: '2026-07-26T19:00:00.000Z' });
  const staleResult = calculateCoffeeReservePolicy({ ...stale, facts, nowMs: NOW });
  assert.equal(staleResult.status, 'unknown');
  assert.deepEqual(staleResult.millCapacity.missingBuildingIds, [101]);
  assert.ok(Object.values(staleResult.items).every(item => item.sellable === 0));
});

test('temporary slowdown expiry raises the reserve for the post-event baseline hours', () => {
  const input = fixture({ rate: 77 });
  setPowderModifier(input, {
    direction: 'decreased', percent: 23,
    expiresAt: '2026-07-26T21:10:00.000Z',
  });
  const result = calculateCoffeeReservePolicy({
    ...input, facts, horizonHours: 2, bufferPct: 0, nowMs: NOW,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.millCapacity.currentPowderPerHour, 77.005);
  assert.ok(Math.abs(result.millCapacity.projectedPowder - 177.0114935064935) < 1e-9);
  assert.ok(Math.abs(result.millCapacity.powderPerHour - 88.50574675324675) < 1e-9);
  assert.equal(result.items[119].reserve, 178);
  assert.equal(result.items[2].reserve, 1063);
  assert.equal(result.items[1].reserve, 213);
});

test('an expired slowdown uses the recovered baseline for the whole forward horizon', () => {
  const input = fixture({ rate: 77 });
  setPowderModifier(input, {
    direction: 'decreased', percent: 23,
    expiresAt: '2026-07-26T20:09:00.000Z',
  });
  const result = calculateCoffeeReservePolicy({
    ...input, facts, horizonHours: 2, bufferPct: 0, nowMs: NOW,
  });
  assert.equal(result.status, 'ok');
  assert.ok(Math.abs(result.millCapacity.projectedPowder - 200.012987012987) < 1e-9);
  assert.ok(Math.abs(result.millCapacity.powderPerHour - 100.0064935064935) < 1e-9);
  assert.ok(Math.abs(result.millCapacity.currentPowderPerHour - 100.0064935064935) < 1e-9);
});

test('temporary production increase is also split at its expiry', () => {
  const input = fixture({ rate: 121 });
  setPowderModifier(input, {
    direction: 'increased', percent: 21,
    expiresAt: '2026-07-26T21:10:00.000Z',
  });
  const result = calculateCoffeeReservePolicy({
    ...input, facts, horizonHours: 2, bufferPct: 0, nowMs: NOW,
  });
  assert.equal(result.status, 'ok');
  assert.ok(Math.abs(result.millCapacity.projectedPowder - 221.00913223140496) < 1e-9);
  assert.ok(Math.abs(result.millCapacity.powderPerHour - 110.50456611570248) < 1e-9);
});

test('missing modifier evidence fails closed even when a printed rate is fresh', () => {
  const input = fixture();
  delete input.inspectionCache[0].products[0].modifier;
  const result = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.millCapacity.missingBuildingIds, [101]);
  assert.ok(Object.values(result.items).every(item => item.sellable === 0));
});

test('unknown or detached modifier API evidence fails closed', () => {
  const unknown = fixture();
  unknown.state.sources.modifiers.status = 'unknown';
  assert.equal(calculateCoffeeReservePolicy({ ...unknown, facts, nowMs: NOW }).status, 'unknown');

  const detached = fixture();
  detached.state.sources.modifiers.asOf = '2026-07-26T20:09:00.000Z';
  assert.equal(calculateCoffeeReservePolicy({ ...detached, facts, nowMs: NOW }).status, 'unknown');
});

test('modifier API and Coffee Powder product-card evidence must match exactly', () => {
  const input = fixture({ rate: 121 });
  input.state.modifiers = [{
    realm: 0,
    kind: 119,
    pct: 21,
    since: '2026-07-26T19:00:00.000Z',
    until: '2026-07-26T21:10:00.000Z',
  }];
  assert.equal(calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW }).status, 'unknown');

  input.inspectionCache[0].products[0].modifier = {
    status: 'active', direction: 'decreased', percent: 21,
    expiresAt: '2026-07-26T21:10:00.000Z',
  };
  assert.equal(calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW }).status, 'unknown');
});

test('an active modifier that had already expired when inspected fails closed', () => {
  const input = fixture({ rate: 121, inspectedAt: '2026-07-26T20:05:00.000Z' });
  input.inspectionCache[0].products[0].modifier = {
    status: 'active', direction: 'increased', percent: 21,
    expiresAt: '2026-07-26T20:04:00.000Z',
  };
  input.state.modifiers = [{
    realm: 0, kind: 119, pct: 21,
    since: '2026-07-26T19:00:00.000Z', until: '2026-07-26T20:04:00.000Z',
  }];
  assert.equal(calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW }).status, 'unknown');
});

test('a Coffee Powder modifier starting after inspection requires a new printed rate', () => {
  const input = fixture();
  input.state.modifiers = [{
    realm: 0, kind: 119, pct: 21,
    since: '2026-07-26T20:30:00.000Z', until: '2026-07-27T20:30:00.000Z',
  }];
  assert.equal(calculateCoffeeReservePolicy({
    ...input, facts, horizonHours: 2, nowMs: NOW,
  }).status, 'unknown');
});

test('a modifier for another Mill product cannot change Coffee Powder reserve math', () => {
  const input = fixture();
  input.state.modifiers = [{
    realm: 0, kind: 133, pct: 21,
    since: '2026-07-26T19:00:00.000Z', until: '2026-07-27T00:00:00.000Z',
  }];
  input.inspectionCache[0].products.push({
    kind: 133,
    productionPerHour: 50,
    modifier: {
      status: 'active', direction: 'increased', percent: 21,
      expiresAt: '2026-07-27T00:00:00.000Z',
    },
  });
  const result = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW, bufferPct: 0 });
  assert.equal(result.status, 'ok');
  assert.equal(result.millCapacity.powderPerHour, 10.005);
  assert.equal(result.items[119].reserve, 241);
});

test('stock below reserve has zero surplus and zero sellable quantity', () => {
  const input = fixture({ amounts: { 1: 10, 2: 10, 66: 10, 118: 10 } });
  const result = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  for (const kind of [1, 2, 66, 118]) {
    assert.equal(result.items[kind].surplus, 0);
    assert.equal(result.items[kind].sellable, 0);
  }
});

test('active production amounts are not deducted from warehouse stock again', () => {
  const input = fixture({ amounts: { 118: 3000 } });
  input.state.buildings[0].busy = {
    type: 'production', makingKind: 119, remainingOrUncollectedAmount: 9999,
  };
  const result = calculateCoffeeReservePolicy({ ...input, facts, bufferPct: 0, nowMs: NOW });
  assert.equal(result.items[118].stock, 3000);
  assert.equal(result.items[118].reserve, 2402);
  assert.equal(result.items[118].sellable, 10);
});

test('blocked exchange lots remain visible in total stock but cannot be reserved or sold again', () => {
  const input = fixture({ amounts: { 1: 1000 } });
  const power = input.state.stock.find(row => row.kind === 1);
  power.availableAmount = 800;
  power.blockedAmount = 200;
  const result = calculateCoffeeReservePolicy({ ...input, facts, bufferPct: 0, nowMs: NOW });
  assert.equal(result.items[1].totalStock, 1000);
  assert.equal(result.items[1].blockedStock, 200);
  assert.equal(result.items[1].stock, 800);
  assert.equal(result.items[1].reserve, 289);
  assert.equal(result.items[1].sellable, 511);
});

test('warehouse completeness must be explicitly proven', () => {
  const input = fixture();
  delete input.state.warehouse.allPositiveProductsIncluded;
  const result = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  assert.equal(result.status, 'unknown');
  assert.ok(Object.values(result.items).every(item => item.sellable === 0));
});

test('warehouse stock provenance must be tied to the state capture', () => {
  const input = fixture();
  input.state.sources.stock.asOf = '2026-07-26T20:09:00.000Z';
  const result = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  assert.equal(result.status, 'unknown');
  assert.ok(Object.values(result.items).every(item => item.sellable === 0));
});

test('blocked stock without an explicit available amount fails closed', () => {
  const input = fixture();
  const power = input.state.stock.find(row => row.kind === 1);
  power.blockedAmount = 200;
  const result = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  assert.equal(result.status, 'unknown');
});

test('malformed or duplicate normalized stock rows fail closed', () => {
  const malformed = fixture();
  const power = malformed.state.stock.find(row => row.kind === 1);
  power.availableAmount = 900;
  power.blockedAmount = 200;
  const malformedResult = calculateCoffeeReservePolicy({ ...malformed, facts, nowMs: NOW });
  assert.equal(malformedResult.status, 'unknown');

  const duplicate = fixture();
  duplicate.state.stock.push({
    kind: 1, name: 'duplicate power', amount: 100, availableAmount: 100,
    blockedAmount: 0, known: true,
  });
  const duplicateResult = calculateCoffeeReservePolicy({ ...duplicate, facts, nowMs: NOW });
  assert.equal(duplicateResult.status, 'unknown');
});

test('every detected Mill requires a unique positive safe integer id', () => {
  const input = fixture();
  input.state.buildings.push({ id: null, name: 'Mill', kindLetter: 'i', size: 1, busy: null });
  const invalid = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  assert.equal(invalid.status, 'unknown');
  assert.equal(invalid.millCapacity.buildingIdentityValid, false);

  input.state.buildings[1].id = 101;
  const duplicate = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  assert.equal(duplicate.status, 'unknown');
  assert.deepEqual(duplicate.millCapacity.duplicateBuildingIds, [101]);
});

test('duplicate product kinds and a mismatched building source fail closed', () => {
  const duplicate = fixture();
  duplicate.inspectionCache[0].products.push({
    kind: 119, productionPerHour: 100, modifier: { status: 'none' },
  });
  assert.equal(calculateCoffeeReservePolicy({ ...duplicate, facts, nowMs: NOW }).status, 'unknown');

  const wrongSource = fixture();
  wrongSource.inspectionCache[0].source = '/b/999/';
  assert.equal(calculateCoffeeReservePolicy({ ...wrongSource, facts, nowMs: NOW }).status, 'unknown');
});

test('null or missing transportation facts cannot become zero-transport authorization', () => {
  for (const transportation of [null, undefined]) {
    const input = fixture();
    const invalidFacts = structuredClone(facts);
    invalidFacts.resources[5].transportation = transportation;
    const result = calculateCoffeeReservePolicy({ ...input, facts: invalidFacts, nowMs: NOW });
    assert.equal(result.status, 'unknown');
    assert.equal(result.items[5].status, 'unknown');
    assert.equal(result.items[5].sellable, 0);
  }
});

test('future inspection timestamps beyond the clock-skew allowance fail closed', () => {
  const input = fixture({ inspectedAt: '2026-07-26T20:10:31.000Z' });
  const result = calculateCoffeeReservePolicy({ ...input, facts, nowMs: NOW });
  assert.equal(result.status, 'unknown');
});

test('reserve rounding never subtracts an epsilon from the safety requirement', () => {
  const input = fixture({ rate: (1 + 5e-10) / 24 });
  const result = calculateCoffeeReservePolicy({
    ...input, facts, horizonHours: 24, bufferPct: 0, nowMs: NOW,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.items[119].reserve, 2);
});
