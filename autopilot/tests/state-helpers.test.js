'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ageSeconds,
  aggregateStock,
  calculateSlots,
  deriveBondFaceValue,
  normalizeProductionModifiers,
  parseBuilding,
  slotCapacityForLevel,
  stockSourceIsComplete,
  summarizeBonds,
  summarizeVolumeRows,
  toEpochMs,
  withExplicitStockKinds,
} = require('../state-helpers');

test('normalizes both wrapped and legacy-array production modifier payloads', () => {
  const now = Date.parse('2026-07-26T20:00:00.000Z');
  const rows = [{
    kind: 119,
    speedModifier: -23,
    since: '2026-07-06T00:00:00.000Z',
    until: '2026-07-27T00:00:00.000Z',
  }, {
    kind: 118,
    speedModifier: 21,
    since: '2026-07-13T00:00:00.000Z',
    until: '2026-08-03T00:00:00.000Z',
  }];
  const expected = [{
    realm: 0,
    kind: 119,
    pct: -23,
    since: '2026-07-06T00:00:00.000Z',
    until: '2026-07-27T00:00:00.000Z',
  }, {
    realm: 0,
    kind: 118,
    pct: 21,
    since: '2026-07-13T00:00:00.000Z',
    until: '2026-08-03T00:00:00.000Z',
  }];
  assert.deepEqual(normalizeProductionModifiers({ resourceProductionModifiers: rows }, now), {
    ok: true, modifiers: expected,
  });
  assert.deepEqual(normalizeProductionModifiers(rows, now), { ok: true, modifiers: expected });

  const scheduled = normalizeProductionModifiers({ resourceProductionModifiers: [{
    realm: 0,
    kind: 119,
    speedModifier: 10,
    since: '2026-07-27T00:00:00.000Z',
    until: '2026-07-28T00:00:00.000Z',
  }, {
    realm: 0,
    kind: 119,
    speedModifier: -10,
    since: '2026-07-24T00:00:00.000Z',
    until: '2026-07-25T00:00:00.000Z',
  }] }, now);
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.modifiers.length, 2);
});

test('modifier normalization fails closed on an unknown shape or malformed row', () => {
  const now = Date.parse('2026-07-26T20:00:00.000Z');
  assert.equal(normalizeProductionModifiers({}, now).ok, false);
  assert.equal(normalizeProductionModifiers({ resourceProductionModifiers: [{ kind: 119 }] }, now).ok, false);
});

test('parses production, sale, and construction busy records from live API shapes', () => {
  const production = parseBuilding({
    id: 1,
    name: 'Farm',
    kind: 'P',
    size: 3,
    category: 'production',
    freeAndLocked: true,
    busy: {
      id: 10,
      started: '2026-07-25T03:30:10.000Z',
      duration: 3600,
      category: 'r',
      resource: {
        kind: 66,
        name: 'Seeds',
        amount: 10000,
        amountAvailableNow: 25,
      },
    },
  });
  assert.equal(production.busy.type, 'production');
  assert.deepEqual(production.activity, { status: 'known', busy: true, type: 'production' });
  assert.equal(production.freeAndLocked, true);
  assert.equal(production.busy.makingKind, 66);
  assert.equal(production.busy.makingName, 'Seeds');
  assert.equal(production.busy.amount, 10000);
  assert.equal(production.busy.remainingOrUncollectedAmount, 10000);
  assert.equal(production.busy.amountSemantics, 'live-remaining-or-uncollected');
  assert.equal(production.busy.endsAt, '2026-07-25T04:30:10.000Z');

  const sale = parseBuilding({
    id: 2,
    name: 'Grocery store',
    kind: 'G',
    size: 2,
    category: 'sales',
    busy: {
      id: 11,
      started: '2026-07-25T03:30:10.000Z',
      duration: 1800,
      category: 's',
      sales_order: {
        kind: 7,
        name: 'Steak',
        amount: 140,
        price: 57.9,
        profitAvailableNow: 500,
      },
    },
  });
  assert.equal(sale.busy.type, 'sale');
  assert.equal(sale.busy.makingKind, 7);
  assert.equal(sale.busy.amount, 140);
  assert.equal(sale.busy.remainingOrUncollectedAmount, null);
  assert.equal(sale.busy.amountSemantics, 'sales-order-remaining');
  assert.equal(sale.busy.price, 57.9);

  const construction = parseBuilding({
    id: 3,
    name: 'Water reservoir',
    kind: 'W',
    size: 1,
    category: 'production',
    busy: {
      id: 12,
      started: '2026-07-25T03:30:10.000Z',
      duration: 7200,
      category: 'b',
      expanding: true,
    },
  });
  assert.equal(construction.busy.type, 'construction');
  assert.equal(construction.busy.makingKind, null);

  const missingDuration = parseBuilding({
    id: 4,
    name: 'Mill',
    category: 'production',
    busy: { started: '2026-07-25T03:30:10.000Z', resource: { kind: 119, amount: 1 } },
  });
  assert.equal(missingDuration.busy.endsAt, null);

  const missingBusyEvidence = parseBuilding({ id: 5, name: 'Mill', category: 'production' });
  assert.equal(missingBusyEvidence.busy, undefined);
  assert.deepEqual(missingBusyEvidence.activity, { status: 'unknown', busy: null, type: 'unknown' });
  assert.equal(parseBuilding({ id: 6, busy: false }).busy, undefined);
});

test('derives regular construction slots without counting a seasonal market', () => {
  const buildings = [
    ...Array.from({ length: 6 }, (_, index) => ({ id: index, category: 'production' })),
    { id: 99, category: 'seasonal', freeAndLocked: true },
  ];
  assert.deepEqual(calculateSlots(buildings, 11), { capacity: 6, used: 6, free: 0 });
  assert.deepEqual(calculateSlots(buildings.slice(0, 5), 11), { capacity: 6, used: 5, free: 1 });
  assert.deepEqual(calculateSlots(buildings.slice(0, 5), 11, undefined, 8), { capacity: 8, used: 5, free: 3 });
  assert.deepEqual(calculateSlots(buildings, 12, undefined, 6, 4), { capacity: 10, used: 6, free: 4 });
  assert.deepEqual(calculateSlots([
    { id: 1, category: 'Seasonal' },
    { id: 2, category: 'production' },
  ], 12, undefined, 6.5, 1.5), { capacity: 6, used: 1, free: 5 });
  assert.deepEqual(calculateSlots([], 12, null), { capacity: 6, used: 0, free: 6 });
  assert.equal(slotCapacityForLevel(null), null);
  assert.equal(slotCapacityForLevel(''), null);
  assert.equal(slotCapacityForLevel(false), null);
  assert.equal(slotCapacityForLevel(0), 4);
});

test('aggregates quality lots of the same resource kind', () => {
  const stock = aggregateStock([
    { kind: 2, amount: 2063 },
    { kind: 2, amount: 68 },
    { kind: 1, amount: 171 },
  ], { 1: 'power', 2: 'water' }, { 1: 0.27, 2: 0.379 });
  const water = stock.find((entry) => entry.kind === 2);
  assert.equal(water.amount, 2131);
  assert.equal(water.availableAmount, 2131);
  assert.equal(water.blockedAmount, 0);
  assert.equal(water.lots, 2);
  const blocked = aggregateStock([
    { kind: 1, amount: 100, blocked: false },
    { kind: 1, amount: 25, blocked: true },
  ], { 1: 'power' }, { 1: 0.27 })[0];
  assert.equal(blocked.amount, 125);
  assert.equal(blocked.availableAmount, 100);
  assert.equal(blocked.blockedAmount, 25);
  assert.equal(blocked.availableLots, 1);
  assert.equal(blocked.blockedLots, 1);
  assert.deepEqual(aggregateStock([
    { kind: 1, amount: null },
    { kind: 2, amount: '' },
    { kind: 3, amount: false },
  ]), []);
});

test('explicit mission stock distinguishes a known zero from an unknown source', () => {
  const stock = aggregateStock([{ kind: 2, amount: 10 }], { 1: 'power', 2: 'water' }, { 1: 0.2, 2: 0.3 });
  assert.deepEqual(withExplicitStockKinds(stock, [1, 2], { 1: 'power', 2: 'water' }, { 1: 0.2, 2: 0.3 }), [
    { kind: 1, name: 'power', amount: 0, availableAmount: 0, blockedAmount: 0, lots: 0,
      availableLots: 0, blockedLots: 0, exchPrice: 0.2, known: true },
    { kind: 2, name: 'water', amount: 10, availableAmount: 10, blockedAmount: 0, lots: 1,
      availableLots: 1, blockedLots: 0, exchPrice: 0.3, known: true },
  ]);
  assert.equal(withExplicitStockKinds(stock, [1, 2], {}, {}, false), null);
  assert.equal(ageSeconds('2026-07-25T00:00:00.000Z', Date.parse('2026-07-25T00:00:10.000Z')), 10);
  assert.equal(ageSeconds('2026-07-25T00:00:31.000Z', Date.parse('2026-07-25T00:00:00.000Z')), -31);
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs(''), null);
  assert.equal(stockSourceIsComplete([{ kind: 1, amount: 0 }]), true);
  for (const amount of [null, '', undefined, false]) {
    assert.equal(stockSourceIsComplete([{ kind: 1, amount }]), false);
  }
});

test('uses t0/t1 and prorates rotating volume intervals into a true one-hour window', () => {
  const nowMs = 7200 * 1000;
  const summary = summarizeVolumeRows([
    { t0: 1800, t1: 5400, u: { 2: 100 } },
    { t0: 5400, t1: 7200, u: { 2: 20 } },
    { t0: 0, t1: 1800, u: { 2: 999 } },
  ], {
    nowMs,
    windowMs: 3600e3,
    names: { 2: 'water' },
    includeKinds: [2],
  });
  assert.equal(summary.byName.water, 70);
  assert.equal(summary.sourceRows, 2);
});

test('uses per-kind volume interval starts and never coerces string units', () => {
  const nowMs = 7200 * 1000;
  const summary = summarizeVolumeRows([
    {
      t0: 1800,
      t1: 5400,
      t0ByKind: { 2: 3600 },
      u: { 2: 100 },
    },
    { t0: 5400, t1: 7200, u: { 2: 20 } },
    { t0: 5400, t1: 7200, u: { 2: '999' } },
  ], {
    nowMs,
    windowMs: 3600e3,
    names: { 2: 'water' },
    includeKinds: [2],
  });
  assert.equal(summary.byName.water, 120);
  assert.equal(summary.sourceRows, 2);
});

test('converts bond units into principal using verified cashflow denomination', () => {
  const recent = {
    data: [{
      category: 'n',
      descriptionKey: '1-bondsales',
      money: 30000,
      details: { amount: 6 },
    }],
  };
  assert.equal(deriveBondFaceValue(recent), 5000);
  assert.deepEqual(
    summarizeBonds(
      [{ id: 1, amount: 6, interest: 0.5 }],
      recent,
      { date: '2026-07-25T01:18:52.000Z', bondsPayable: 0 },
    ),
    {
      status: 'conflict',
      reconciled: false,
      faceValue: 5000,
      unitsSold: 6,
      principalOutstanding: 30000,
      principalSource: 'sold-units',
      balanceSheetPayable: 0,
      balanceSheetAsOf: '2026-07-25T01:18:52.000Z',
      dailyInterest: 150,
      records: [{
        id: 1,
        units: 6,
        principal: 30000,
        interestPctPerDay: 0.5,
        purchasedAt: null,
      }],
      consistencyWarning: 'sold-unit principal $30000 differs from balance-sheet bondsPayable $0; check statement dates',
      offerFormExcluded: true,
      note: 'Outstanding principal comes from sold bond units and the balance sheet only. Sold API amount is units, so principal = units × $5000. The HQ/API bond offer amount is an unsold offer setting, never outstanding debt.',
    },
  );
});

test('does not infer bond denomination from unrelated category-n cashflow', () => {
  const unrelated = {
    data: [{
      category: 'n',
      descriptionKey: 'other-event',
      description: 'Unrelated transaction',
      money: 1234,
      details: { amount: 2 },
    }],
  };
  assert.equal(deriveBondFaceValue(unrelated), 5000);
});

test('reports unknown principal when both live bond sources are unavailable', () => {
  const summary = summarizeBonds(null, null, null);
  assert.equal(summary.status, 'unavailable');
  assert.equal(summary.reconciled, false);
  assert.equal(summary.principalOutstanding, null);
  assert.equal(summary.principalSource, null);
  assert.equal(summary.dailyInterest, null);

  for (const bondsPayable of [null, '', undefined]) {
    const missingBalance = summarizeBonds(null, null, { bondsPayable });
    assert.equal(missingBalance.status, 'unavailable');
    assert.equal(missingBalance.principalOutstanding, null);
    assert.equal(missingBalance.balanceSheetPayable, null);
  }
  assert.equal(summarizeBonds(null, null, { bondsPayable: 0 }).principalOutstanding, 0);
});

test('does not report zero interest when outstanding debt lacks sold-rate evidence', () => {
  const balanceOnly = summarizeBonds(null, null, {
    date: '2026-07-26T01:21:35Z',
    bondsPayable: 90000,
  });
  assert.equal(balanceOnly.principalOutstanding, 90000);
  assert.equal(balanceOnly.dailyInterest, null);

  const missingRate = summarizeBonds([
    { id: 1, amount: 6, interest: null },
  ], null, { date: '2026-07-26T01:21:35Z', bondsPayable: 30000 });
  assert.equal(missingRate.principalOutstanding, 30000);
  assert.equal(missingRate.dailyInterest, null);
});

test('reconciles sold units with balance-sheet payable without consulting the offer form', () => {
  const summary = summarizeBonds([
    { id: 1, amount: 6, interest: 0.5 },
    { id: 2, amount: 12, interest: 0.5 },
  ], null, { date: '2026-07-26T01:21:35Z', bondsPayable: 90000 });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.reconciled, true);
  assert.equal(summary.unitsSold, 18);
  assert.equal(summary.principalOutstanding, 90000);
  assert.equal(summary.balanceSheetPayable, 90000);
  assert.equal(summary.dailyInterest, 450);
  assert.equal(summary.consistencyWarning, null);
  assert.equal(summary.offerFormExcluded, true);
});
