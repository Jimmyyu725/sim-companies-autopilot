'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  buildMillBatchPolicy,
  buildProductionPolicyPagePrelude,
  capQuantityForDuration,
  capQuantityForSeconds,
  evaluateBridgeUtilitySurplusGuard,
  evaluateMillBatchGuard,
  maxProductionHoursForLevel,
  parseProductionCheckpoint,
  resolveProductionResourceIdentity,
  resolveTargetHours,
} = require('../production-policy.js');

test('serialized page helpers retain the duration-to-seconds lexical dependency', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(buildProductionPolicyPagePrelude(), context);
  assert.equal(vm.runInContext(
    'window.__capQuantityForDuration(10000, 12000, 3)',
    context,
  ), 9000);
  assert.equal(vm.runInContext(
    'window.__capQuantityForSeconds(10, 1995, 1800)',
    context,
  ), 9);
});

test('company level determines the maximum long-horizon batch', () => {
  assert.equal(maxProductionHoursForLevel(9), null);
  assert.equal(maxProductionHoursForLevel(10), 24);
  assert.equal(maxProductionHoursForLevel(14), 24);
  assert.equal(maxProductionHoursForLevel(15), 48);
  assert.equal(maxProductionHoursForLevel(30), 48);
  assert.equal(maxProductionHoursForLevel(null), null);
});

test('requested duration remains flexible below the level maximum', () => {
  assert.equal(resolveTargetHours(null, 12), null);
  assert.equal(resolveTargetHours(6, 12), 6);
  assert.equal(resolveTargetHours(24, 12), 24);
  assert.equal(resolveTargetHours(48, 12), 24);
  assert.equal(resolveTargetHours(48, 15), 48);
});

test('unknown level cannot authorize a duration override', () => {
  assert.equal(resolveTargetHours(24, undefined), null);
  assert.equal(resolveTargetHours(0, 12), null);
});

test('quantity and duration constrain the order without inflating demand', () => {
  assert.equal(capQuantityForDuration(8000, 10560, 3), 8000);
  assert.equal(capQuantityForDuration(10000, 12000, 3), 9000);
  assert.equal(capQuantityForDuration(10000, 86400, 24), 10000);
  assert.equal(capQuantityForDuration(10000, 172800, 24), 5000);
  assert.equal(capQuantityForDuration(10000, null, 24), 10000);
  assert.equal(capQuantityForSeconds(10, 1995, 1800), 9);
});

test('absolute production checkpoints reserve a minute and stay within the next wake window', () => {
  const nowMs = Date.parse('2026-07-26T06:40:00.000Z');
  const valid = parseProductionCheckpoint('2026-07-26T07:11:00.000Z', nowMs);
  assert.equal(valid.ok, true);
  assert.equal(valid.usableSeconds, 1800);
  assert.equal(valid.bufferSeconds, 60);
  assert.equal(parseProductionCheckpoint('2026-07-26T06:41:00.000Z', nowMs).ok, false);
  assert.equal(parseProductionCheckpoint('2026-07-26T06:45:59.000Z', nowMs).ok, true);
  assert.equal(parseProductionCheckpoint('2026-07-26T11:00:00.000Z', nowMs).ok, false);
  assert.equal(parseProductionCheckpoint('not-a-time', nowMs).ok, false);
});

test('a short upgrade bridge uses the explicit checkpoint instead of disabling Mill protection', () => {
  const nowMs = Date.parse('2026-07-26T06:40:00.000Z');
  const state = {
    t: new Date(nowMs).toISOString(),
    stock: [{ kind: 118, amount: 1000, known: true }],
    buildings: [{ id: 42, name: 'Mill', kindLetter: 'i', size: 1, busy: null }],
  };
  const policy = buildMillBatchPolicy(
    state,
    42,
    1,
    nowMs,
    'COFFEE POWDER',
    '2026-07-26T07:11:00.000Z',
  );
  assert.equal(policy.enabled, true);
  assert.equal(policy.reason, 'explicit-production-checkpoint');
  assert.equal(policy.desiredDurationSeconds, 1800);
  assert.equal(policy.minimumDurationSeconds, 1350);
  assert.equal(evaluateMillBatchGuard({
    name: 'COFFEE POWDER', effectiveQty: 9, observedSeconds: 1796,
    labor: 202, cash: 16279, minCashAfter: 5000, policy,
  }).ok, true);

  const discrete = buildMillBatchPolicy(
    state,
    42,
    1,
    nowMs,
    'COFFEE POWDER',
    '2026-07-26T06:45:59.000Z',
  );
  const oneUnit = evaluateMillBatchGuard({
    name: 'COFFEE POWDER', effectiveQty: 1, observedSeconds: 199,
    labor: 23, cash: 16279, minCashAfter: 5000, policy: discrete,
  });
  assert.equal(discrete.desiredDurationSeconds, 299);
  assert.equal(oneUnit.ok, true);
  assert.equal(oneUnit.constrainedBy, 'checkpoint-whole-unit');
});

test('Mill fallback horizon follows the next construction checkpoint', () => {
  const nowMs = Date.parse('2026-07-26T06:40:00.000Z');
  const state = {
    t: new Date(nowMs).toISOString(),
    stock: [{ kind: 118, amount: 16747, known: true }],
    buildings: [
      { id: 55042846, name: 'Mill', kindLetter: 'i', size: 1, busy: null },
      {
        id: 55129947,
        name: 'Mill',
        kindLetter: 'i',
        size: 2,
        busy: { type: 'construction', endsAt: '2026-07-26T09:34:00.000Z' },
      },
    ],
  };

  const checkpointPolicy = buildMillBatchPolicy(state, 55042846, null, nowMs);
  assert.equal(checkpointPolicy.enabled, true);
  assert.equal(checkpointPolicy.desiredDurationSeconds, 10440);
  assert.equal(checkpointPolicy.minimumDurationSeconds, 7830);
  assert.equal(checkpointPolicy.inputCapQty, 1674);
  assert.equal(checkpointPolicy.reason, 'next-mill-construction-checkpoint');

  const oneHourPolicy = buildMillBatchPolicy(state, 55042846, 1, nowMs);
  assert.equal(oneHourPolicy.desiredDurationSeconds, 3600);
  assert.equal(oneHourPolicy.minimumDurationSeconds, 2700);
});

test('Mill policy disables itself for stale state, non-Mills, and imminent checkpoints', () => {
  const nowMs = Date.parse('2026-07-26T06:40:00.000Z');
  const base = {
    t: new Date(nowMs).toISOString(),
    stock: [],
    buildings: [{ id: 1, name: 'Farm', kindLetter: 'P', busy: null }],
  };
  assert.equal(buildMillBatchPolicy(base, 1, null, nowMs).enabled, false);
  assert.equal(buildMillBatchPolicy({ ...base, t: '2026-07-26T06:00:00.000Z' }, 1, null, nowMs).enabled, false);

  const imminent = {
    ...base,
    buildings: [
      { id: 2, name: 'Mill', kindLetter: 'i', busy: null },
      { id: 3, name: 'Mill', kindLetter: 'i', busy: { type: 'construction', endsAt: '2026-07-26T06:44:00.000Z' } },
    ],
  };
  assert.equal(buildMillBatchPolicy(imminent, 2, null, nowMs).enabled, false);
});

test('stale or missing state keeps a conservative Coffee Powder micro-batch guard', () => {
  const nowMs = Date.parse('2026-07-26T06:40:00.000Z');
  const stale = {
    t: '2026-07-26T06:00:00.000Z',
    stock: [{ kind: 118, amount: 10 }],
    buildings: [{ id: 2, name: 'Mill', kindLetter: 'i', busy: null }],
  };
  const stalePolicy = buildMillBatchPolicy(stale, 2, null, nowMs, 'COFFEE POWDER');
  assert.equal(stalePolicy.enabled, true);
  assert.equal(stalePolicy.reason, 'stale-state-default-one-hour-fallback');
  assert.equal(stalePolicy.desiredDurationSeconds, 3600);
  assert.equal(stalePolicy.inputCapQty, null);
  const guarded = evaluateMillBatchGuard({
    name: 'COFFEE POWDER',
    effectiveQty: 3,
    observedSeconds: 598,
    labor: null,
    cash: null,
    minCashAfter: 5000,
    policy: stalePolicy,
  });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.suggestedQty, 19);

  const missingPolicy = buildMillBatchPolicy(null, 999, 1, nowMs, 'coffee powder');
  assert.equal(missingPolicy.enabled, true);
  assert.equal(missingPolicy.desiredDurationSeconds, 3600);
});

test('a state too far in the future cannot authorize live Mill input evidence', () => {
  const nowMs = Date.parse('2026-07-26T06:40:00.000Z');
  const future = {
    t: '2026-07-26T06:40:31.000Z',
    stock: [{ kind: 118, amount: 1000, availableAmount: 1000, blockedAmount: 0, known: true }],
    buildings: [{ id: 2, name: 'Mill', kindLetter: 'i', busy: null }],
  };
  const policy = buildMillBatchPolicy(future, 2, null, nowMs, 'COFFEE POWDER');
  assert.equal(policy.reason, 'stale-state-default-one-hour-fallback');
  assert.equal(policy.inputCapQty, null);
  assert.equal(policy.stateAgeSeconds, -31);
});

test('Mill input capacity excludes Coffee Beans blocked in exchange listings', () => {
  const nowMs = Date.parse('2026-07-26T06:40:00.000Z');
  const state = {
    t: new Date(nowMs).toISOString(),
    stock: [{
      kind: 118,
      amount: 1000,
      availableAmount: 200,
      blockedAmount: 800,
      known: true,
    }],
    buildings: [{ id: 2, name: 'Mill', kindLetter: 'i', busy: null }],
  };
  const policy = buildMillBatchPolicy(state, 2, null, nowMs, 'COFFEE POWDER');
  assert.equal(policy.inputCapQty, 20);
});

test('three-unit Coffee Powder preview is rejected with a feasible useful quantity', () => {
  const result = evaluateMillBatchGuard({
    name: 'COFFEE POWDER',
    effectiveQty: 3,
    observedSeconds: 598,
    labor: 68,
    cash: 8494,
    minCashAfter: 5000,
    policy: {
      enabled: true,
      desiredDurationSeconds: 4380,
      minimumDurationSeconds: 3285,
      inputCapQty: 1674,
      reason: 'next-mill-construction-checkpoint',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.preview, true);
  assert.equal(result.microBatchGuard, true);
  assert.equal(result.suggestedQty, 22);
  assert.equal(result.observedDurationSeconds, 598);
});

test('useful batches pass and hard input or cash constraints do not force impossible growth', () => {
  const policy = {
    enabled: true,
    desiredDurationSeconds: 3600,
    minimumDurationSeconds: 2700,
    inputCapQty: 100,
  };
  assert.equal(evaluateMillBatchGuard({
    name: 'Coffee powder', effectiveQty: 18, observedSeconds: 3588,
    labor: 408, cash: 8494, minCashAfter: 5000, policy,
  }).ok, true);

  const constrained = evaluateMillBatchGuard({
    name: 'Coffee powder', effectiveQty: 4, observedSeconds: 797,
    labor: 91, cash: 5100, minCashAfter: 5000,
    policy,
  });
  assert.equal(constrained.ok, true);
  assert.equal(constrained.constrainedBy, 'cash');

  assert.equal(evaluateMillBatchGuard({
    name: 'Coffee beans', effectiveQty: 3, observedSeconds: 598,
    labor: 68, cash: 8494, minCashAfter: 5000, policy,
  }).ok, true);
});

test('production identity falls back from dialog names to the exchange kind and exact image slug', () => {
  let fallbackName = null;
  const sand = resolveProductionResourceIdentity({
    name: 'SAND',
    knownKinds: { 'COFFEE POWDER': 119 },
    lookupKind: (name) => { fallbackName = name; return 44; },
    resources: {
      44: { dbLetter: 44, image: 'images/resources/sand.png' },
      119: { dbLetter: 119, image: 'images/resources/coffee-ground.png' },
    },
  });
  assert.equal(fallbackName, 'SAND');
  assert.deepEqual(sand, {
    ok: true,
    name: 'SAND',
    kind: 44,
    kindSource: 'exchange-name-fallback',
    resourceSlug: 'sand',
  });

  const coffee = resolveProductionResourceIdentity({
    name: 'Coffee powder',
    knownKinds: { 'COFFEE POWDER': 119 },
    lookupKind: () => { throw new Error('fallback must not run'); },
    resources: { 119: { dbLetter: 119, image: 'images/resources/coffee-ground.png' } },
  });
  assert.equal(coffee.ok, true);
  assert.equal(coffee.kindSource, 'known-dialog-map');
  assert.equal(coffee.resourceSlug, 'coffee-ground');
});

test('production identity fails closed for missing or non-unique image evidence', () => {
  assert.equal(resolveProductionResourceIdentity({
    name: 'Sand', knownKinds: {}, lookupKind: () => null, resources: {},
  }).ok, false);
  const duplicate = resolveProductionResourceIdentity({
    name: 'Sand',
    knownKinds: {},
    lookupKind: () => 44,
    resources: {
      44: { dbLetter: 44, image: 'images/resources/sand.png' },
      999: { dbLetter: 999, image: 'images/resources/sand.png' },
    },
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /not uniquely bound/);
});

function bridgeState(nowMs, { power = 0, water = 0, complete = true } = {}) {
  const capturedAt = new Date(nowMs).toISOString();
  const item = (kind, sellable) => ({
    kind,
    status: 'ok',
    sellable,
    evidence: { stockAsOf: capturedAt },
  });
  return {
    t: capturedAt,
    sources: {
      surplusPlan: { status: 'ok', asOf: capturedAt },
    },
    surplusPlan: {
      complete,
      status: complete ? 'ok' : 'incomplete',
      asOf: capturedAt,
      items: { 1: item(1, power), 2: item(2, water) },
    },
  };
}

test('current reserve-safe Power sellable zero rejects a Sand bridge before UI with suggestedQty zero', () => {
  const nowMs = Date.parse('2026-07-27T10:15:43.841Z');
  const result = evaluateBridgeUtilitySurplusGuard({
    name: 'SAND',
    kind: 44,
    qty: 100,
    finishBefore: '2026-07-27T10:45:43.841Z',
    state: bridgeState(nowMs, { power: 0, water: 0 }),
    facts: { resources: { 44: { kind: 44, recipe: { 1: 2 } } } },
    nowMs,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failClosed, true);
  assert.equal(result.suggestedQty, 0);
  assert.equal(result.utilityRequirements[0].kind, 1);
  assert.equal(result.utilityRequirements[0].requestedUnits, 200);
  assert.equal(result.utilityRequirements[0].verifiedSellable, 0);
  assert.match(result.reason, /no browser was opened/);
});

test('bridge utility guard caps by the tightest verified Power or Water surplus', () => {
  const nowMs = Date.parse('2026-07-27T10:15:43.841Z');
  const common = {
    name: 'TEST PRODUCT',
    kind: 999,
    finishBefore: '2026-07-27T10:45:43.841Z',
    state: bridgeState(nowMs, { power: 20, water: 21 }),
    facts: { resources: { 999: { kind: 999, recipe: { 1: 2, 2: 3 } } } },
    nowMs,
  };
  const rejected = evaluateBridgeUtilitySurplusGuard({ ...common, qty: 8 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.suggestedQty, 7);
  assert.deepEqual(rejected.utilityRequirements.map(row => row.maxOutputQty), [10, 7]);
  const allowed = evaluateBridgeUtilitySurplusGuard({ ...common, qty: 7 });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.suggestedQty, 7);
});

test('bridge utility evidence is fresh and state-tied, while Coffee-chain production bypasses it', () => {
  const nowMs = Date.parse('2026-07-27T10:15:43.841Z');
  const stale = bridgeState(nowMs - 301000, { power: 100 });
  const facts = { resources: { 44: { kind: 44, recipe: { 1: 2 } } } };
  const staleResult = evaluateBridgeUtilitySurplusGuard({
    name: 'SAND', kind: 44, qty: 1, finishBefore: '2026-07-27T10:45:43.841Z',
    state: stale, facts, nowMs,
  });
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.suggestedQty, 0);

  const untied = bridgeState(nowMs, { power: 100 });
  untied.sources.surplusPlan.asOf = '2026-07-27T10:15:42.841Z';
  assert.equal(evaluateBridgeUtilitySurplusGuard({
    name: 'SAND', kind: 44, qty: 1, finishBefore: '2026-07-27T10:45:43.841Z',
    state: untied, facts, nowMs,
  }).ok, false);

  const unknownSellable = bridgeState(nowMs, { power: 100 });
  unknownSellable.surplusPlan.items[1].sellable = null;
  const unknownResult = evaluateBridgeUtilitySurplusGuard({
    name: 'SAND', kind: 44, qty: 1, finishBefore: '2026-07-27T10:45:43.841Z',
    state: unknownSellable, facts, nowMs,
  });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.reason, /not exactly verified/);

  const coffeeChain = evaluateBridgeUtilitySurplusGuard({
    name: 'SEEDS', kind: 66, qty: 100, finishBefore: '2026-07-27T10:45:43.841Z',
    state: null, facts: null, nowMs,
  });
  assert.equal(coffeeChain.ok, true);
  assert.equal(coffeeChain.coffeeChain, true);
});
