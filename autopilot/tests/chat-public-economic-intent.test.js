'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  deriveProactivePublicIntents,
  verifyProactivePublicIntent,
} = require('../chat/public-economic-intent.js');

const NOW = Date.parse('2026-07-27T16:00:00.000Z');
const AS_OF = '2026-07-27T15:59:30.000Z';
const CATALOG = Object.freeze({
  schemaVersion: 1,
  trust: 'internal-verified',
  entries: Object.freeze([
    Object.freeze({ kind: 2, name: 'Water' }),
    Object.freeze({ kind: 110, name: 'tools' }),
  ]),
});

function baseSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    snapshotId: 'bs1:public-intent-offline',
    observedAt: AS_OF,
    inventory: [{
      status: 'ok', observedAt: AS_OF, kind: 110, quality: 0,
      onHandAmount: 1_500, blockedAmount: 100, reserveAmount: 400, unitCost: 7,
    }],
    markets: [
      { status: 'unknown', kind: 999 },
      { status: 'ok', observedAt: AS_OF, kind: 110, quality: 0, marketPrice: 10 },
      { status: 'ok', observedAt: AS_OF, kind: 2, quality: 0, marketPrice: 0.4 },
    ],
    economics: [
      { status: 'unknown', kind: 999 },
      {
        status: 'ok', observedAt: AS_OF, kind: 110, quality: 0,
        contractFeeRate: 0, fixedCost: 0, alternativeSellNetPerUnit: 8,
      },
      {
        status: 'ok', observedAt: AS_OF, kind: 2, quality: 0,
        contractFeeRate: 0, fixedCost: 0,
        buyUseValuePerUnit: 0.5, buyNeedAmount: 10_000, warehouseFreeAmount: 20_000,
      },
    ],
    transport: {
      status: 'ok', observedAt: AS_OF, availableAmount: 100_000,
      entries: [
        { kind: 2, unitsPerItem: 0, opportunityCostPerUnit: 0 },
        { kind: 110, unitsPerItem: 0, opportunityCostPerUnit: 0 },
      ],
    },
    finance: {
      status: 'ok', observedAt: AS_OF, cashAvailable: 50_000, cashReserve: 5_000,
    },
    ...overrides,
  };
}

test('derives a zero-inventory BUY from market/economics/transport/finance evidence', () => {
  const intents = deriveProactivePublicIntents(baseSnapshot(), {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW,
  });
  const buy = intents.find(intent => intent.terms.ourSide === 'buy'
    && intent.terms.resourceKind === 2);
  assert.ok(buy);
  assert.equal(buy.terms.quantity, 10_000);
  assert.equal(buy.terms.unitPrice, '0.4');
  assert.equal(buy.offer.source.trust, 'internal-business-intent');
  assert.equal(buy.evidenceRefs.includes('/businessSnapshot/inventory/0'), false);
  assert.equal(buy.evidenceRefs.includes('/businessSnapshot/markets/2'), true);
  assert.equal(buy.evidenceRefs.includes('/businessSnapshot/economics/2'), true);
  assert.equal(buy.evidenceRefs.includes('/businessSnapshot/finance'), true);
});

test('SELL keeps reserve evidence and non-built-in catalog names are usable', () => {
  const intents = deriveProactivePublicIntents(baseSnapshot(), {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW,
  });
  const sell = intents.find(intent => intent.terms.ourSide === 'sell'
    && intent.terms.resourceKind === 110);
  assert.ok(sell);
  assert.equal(sell.terms.quantity, 1_000);
  assert.equal(sell.offer.resource.name, 'tools');
  assert.equal(sell.evidenceRefs.includes('/businessSnapshot/inventory/0'), true);
  const verified = verifyProactivePublicIntent(sell, baseSnapshot(), {
    trustedResourceCatalog: CATALOG, now: NOW,
  });
  assert.equal(verified.intentId, sell.intentId);
});

test('duplicate exact rows fail closed and evidence refs retain raw array indexes', () => {
  const duplicate = baseSnapshot();
  duplicate.markets.push({ ...duplicate.markets[2] });
  const intents = deriveProactivePublicIntents(duplicate, {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW,
  });
  assert.equal(intents.some(intent => intent.terms.resourceKind === 2), false);
  const clean = deriveProactivePublicIntents(baseSnapshot(), {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW,
  });
  assert.equal(clean.some(intent => intent.evidenceRefs.includes('/businessSnapshot/markets/2')), true);
  assert.equal(clean.some(intent => intent.evidenceRefs.includes('/businessSnapshot/markets/1')), true);
});

test('stale or tampered business intents cannot be re-verified', () => {
  const [intent] = deriveProactivePublicIntents(baseSnapshot(), {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW,
  });
  assert.ok(intent);
  assert.throws(() => verifyProactivePublicIntent({
    ...intent,
    terms: { ...intent.terms, quantity: intent.terms.quantity + 1 },
  }, baseSnapshot(), {
    trustedResourceCatalog: CATALOG, now: NOW,
  }), /does not match/u);
  assert.deepEqual(deriveProactivePublicIntents(baseSnapshot(), {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW + 10 * 60 * 1000,
  }), []);
});

test('one exact product never advertises both BUY and SELL in the same cycle', () => {
  const value = baseSnapshot();
  value.economics[1] = {
    ...value.economics[1],
    buyUseValuePerUnit: 15,
    buyNeedAmount: 500,
    warehouseFreeAmount: 10_000,
  };
  const tools = deriveProactivePublicIntents(value, {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW,
  }).filter(intent => intent.terms.resourceKind === 110 && intent.terms.quality === 0);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].terms.ourSide, 'buy');
});

test('missing production economics stays UNKNOWN and yields zero candidates', () => {
  const value = baseSnapshot();
  delete value.economics[2].contractFeeRate;
  assert.equal(deriveProactivePublicIntents(value, {
    roomId: 'Sales', trustedResourceCatalog: CATALOG, now: NOW,
  }).some(intent => intent.terms.resourceKind === 2), false);
});
