'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSaleQuote,
  parseInspectExchangeArgs,
  summarizeBook,
  summarizeCachedBook,
  summarizeUiDryRun,
  validateSurplusPlan,
} = require('../exchange-sale-helpers.js');

const NOW = Date.parse('2026-07-26T20:30:00.000Z');

function stateFixture(kind = 1, amount = 10000, reserve = 2000) {
  const asOf = new Date(NOW - 60e3).toISOString();
  return {
    t: asOf,
    warehouse: { complete: true, allPositiveProductsIncluded: true },
    stock: [
      { kind, name: kind === 1 ? 'power' : 'grapes', amount, known: true },
      { kind: 13, name: 'transport', amount: 108, known: true },
    ],
    surplusPlan: {
      complete: true,
      status: 'ok',
      stateAsOf: asOf,
      asOf,
      horizonHours: 24,
      items: { [kind]: { kind, reserve, eligible: true, reason: '24h reserve plus buffer' } },
    },
  };
}

test('arguments accept a nullable quantity and reject fractional exchange units', () => {
  assert.deepEqual(parseInspectExchangeArgs('{"kind":1,"qty":null}'), { kind: 1, qty: null });
  assert.deepEqual(parseInspectExchangeArgs('5', '108'), { kind: 5, qty: 108 });
  assert.throws(() => parseInspectExchangeArgs({ kind: 1, qty: 1.5 }), /positive integer/);
});

test('surplus inspection fails closed without a fresh complete state-tied plan', () => {
  const resource = { image: 'images/resources/power.png', transportation: 0 };
  const good = validateSurplusPlan({ state: stateFixture(), kind: 1, resource, nowMs: NOW });
  assert.equal(good.ok, true);
  assert.equal(good.stock.amount, 10000);
  assert.equal(good.reserve, 2000);
  assert.equal(good.sellable, 8000);

  const missing = stateFixture();
  delete missing.surplusPlan;
  assert.equal(validateSurplusPlan({ state: missing, kind: 1, resource, nowMs: NOW }).failClosed, true);

  const detached = stateFixture();
  detached.surplusPlan.stateAsOf = '2026-07-26T20:28:00.000Z';
  assert.match(validateSurplusPlan({ state: detached, kind: 1, resource, nowMs: NOW }).reason,
    /not tied to the latest state/);
});

test('surplus validation uses available stock and excludes blocked exchange lots', () => {
  const state = stateFixture();
  state.stock[0].availableAmount = 8000;
  state.stock[0].blockedAmount = 2000;
  state.surplusPlan.items[1].sellable = 6000;
  const policy = validateSurplusPlan({
    state,
    kind: 1,
    resource: { image: 'images/resources/power.png', transportation: 0 },
    nowMs: NOW,
  });
  assert.equal(policy.stock.totalAmount, 10000);
  assert.equal(policy.stock.amount, 8000);
  assert.equal(policy.stock.blockedAmount, 2000);
  assert.equal(policy.sellable, 6000);
});

test('book summary sorts asks, aggregates the best level, and labels stale cache', () => {
  const live = summarizeBook(1, [
    { id: 2, quantity: 20, price: 0.29 },
    { id: 1, quantity: 10, price: 0.28 },
    { id: 3, quantity: 5, price: 0.28 },
  ], { source: '/api/v3/market/0/1/', asOf: new Date(NOW).toISOString(), nowMs: NOW });
  assert.equal(live.bestAsk, 0.28);
  assert.equal(live.bestAskQuantity, 15);
  assert.equal(live.visibleQuantity, 35);
  assert.equal(live.freshness, 'FRESH');

  const cached = summarizeCachedBook(1, { t: NOW / 1000 - 700, full: false, o: { a: [10, 0.3] } }, NOW);
  assert.equal(cached.freshness, 'STALE_OR_UNKNOWN');
  assert.equal(cached.ageSeconds, 700);
  const malformed = summarizeCachedBook(1, {
    t: NOW / 1000,
    full: false,
    o: { broken: null, valid: [10, 0.31] },
  }, NOW);
  assert.equal(malformed.bestAsk, 0.31);
  assert.equal(malformed.visibleRows, 1);
});

test('zero-transport utilities quote the reserve-safe maximum with a 4% fee', () => {
  const state = stateFixture();
  const resource = { image: 'images/resources/power.png', transportation: 0 };
  const policy = validateSurplusPlan({ state, kind: 1, resource, nowMs: NOW });
  const book = summarizeBook(1, [{ quantity: 50000, price: 0.28 }], {
    source: '/api/v3/market/0/1/', asOf: new Date(NOW).toISOString(), nowMs: NOW,
  });
  const quote = buildSaleQuote({ kind: 1, requestedQty: null, state, resource, policy, book, feeRate: 0.04 });
  assert.equal(quote.ok, true);
  assert.equal(quote.quantity, 8000);
  assert.equal(quote.transport.transportNeeded, 0);
  assert.equal(quote.transport.maxByTransport, null);
  assert.equal(quote.gross, 2240);
  assert.equal(quote.fee, 89.6);
  assert.equal(quote.netBeforeSourceCost, 2150.4);
});

test('transport-consuming goods cap the optional quote and reject an unsafe request', () => {
  const state = stateFixture(5, 779, 100);
  const resource = { image: 'images/resources/grapes.png', transportation: 1 };
  const policy = validateSurplusPlan({ state, kind: 5, resource, nowMs: NOW });
  const book = summarizeBook(5, [{ quantity: 300, price: 3.2 }], {
    source: '/api/v3/market/0/5/', asOf: new Date(NOW).toISOString(), nowMs: NOW,
  });
  assert.equal(buildSaleQuote({ kind: 5, requestedQty: null, state, resource, policy, book }).quantity, 108);
  const blocked = buildSaleQuote({ kind: 5, requestedQty: 109, state, resource, policy, book });
  assert.equal(blocked.failClosed, true);
  assert.equal(blocked.maxSafeQty, 108);
});

test('UI result is accepted only when the driver stayed unarmed and found an enabled confirm', () => {
  const ready = summarizeUiDryRun({
    ok: true,
    armed: false,
    submitted: false,
    confirmFound: 'SELL',
    validation: { ok: true, failures: [] },
    verification: {
      selectedProduct: { requestedSlug: 'power', actualSlug: 'power', exact: true },
      selectedLot: { index: 0, available: 500, inspectedAvailable: 500, stillSelected: true },
      inputs: { quantityRaw: '100', quantity: 100, priceRaw: '0.27', price: 0.27 },
      economics: {
        totalRevenue: 27,
        sourceCost: 16.13,
        transportationCost: 0,
        exchangeFee: 2,
        estimatedProfit: 8.87,
      },
    },
    qualityChoices: [
      { index: 0, available: 500, quality: 0, rowText: '500 $0.16' },
      { index: 1, available: 20, quality: 2, rowText: '20 $0.28' },
    ],
    dump: { inputs: [{ name: 'quantity', val: '100' }], buttons: [{ t: 'SELL', dis: false }],
      text: 'Total revenue $27 Source cost (-) $16.13 Transportation cost $0 Exchange fees (4%) (-) $2 Estimated profit $8.87' },
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, 'READY_TO_REVIEW');
  assert.equal(ready.submitted, false);
  assert.equal(ready.qualitySelection.selectedAvailable, 500);
  assert.deepEqual(ready.economics, {
    totalRevenue: 27,
    sourceCost: 16.13,
    transportationCost: 0,
    exchangeFee: 2,
    estimatedProfit: 8.87,
    source: 'game exchange-sale form',
  });
  assert.deepEqual(ready.actualInputs, {
    quantityRaw: '100', quantity: 100, priceRaw: '0.27', price: 0.27,
  });
  assert.equal(ready.selectedProduct.actualSlug, 'power');
  assert.equal(ready.selectedLot.available, 500);
  assert.deepEqual(ready.qualityChoices.map(choice => choice.available), [500, 20]);
  assert.equal(summarizeUiDryRun({ ok: true, armed: true }).ok, false);

  const missingButton = summarizeUiDryRun({
    ok: true,
    armed: false,
    submitted: false,
    confirmFound: 'SELL',
    validation: { ok: true, failures: [] },
    verification: ready.verification || {
      selectedProduct: { requestedSlug: 'power', actualSlug: 'power', exact: true },
      selectedLot: { index: 0, available: 500, stillSelected: true },
      inputs: { quantity: 100, price: 0.27 },
    },
    dump: { buttons: [], inputs: [], text: '' },
  });
  assert.equal(missingButton.ok, false);
  assert.equal(missingButton.status, 'FORM_NOT_READY');

  const mutated = summarizeUiDryRun({
    ok: true,
    armed: false,
    submitted: false,
    mutationAttempted: true,
    validation: { ok: true, failures: [] },
    verification: { selectedProduct: {}, selectedLot: {}, inputs: {} },
    confirmFound: 'SELL',
    dump: { buttons: [{ t: 'SELL', dis: false }] },
  });
  assert.equal(mutated.ok, false);
  assert.equal(mutated.mutationAttempted, true);
});

test('UI lot refusal preserves every quality choice for a smaller retry', () => {
  const refusal = summarizeUiDryRun({
    ok: false,
    armed: false,
    step: 'quality',
    reason: 'no single quality lot can satisfy qty',
    selectedProduct: { requestedSlug: 'water', actualSlug: 'water', exact: true },
    qualityChoices: [
      { index: 0, available: 80, quality: 0, rowText: '80 $0.35' },
      { index: 1, available: 20, quality: 1, rowText: '20 $0.38' },
    ],
  });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.selectedProduct.actualSlug, 'water');
  assert.deepEqual(refusal.qualityChoices.map(choice => choice.available), [80, 20]);
});
