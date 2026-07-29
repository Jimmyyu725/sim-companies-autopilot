'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAssetSlug,
  validateExchangePostSubmit,
  validateExchangeUiReview,
} = require('../exchange-ui-verification.js');

function exactReview() {
  return {
    expectedSlug: 'power',
    expectedKind: 1,
    expectedQty: 800,
    expectedPrice: 0.28,
    expectedReserve: 200,
    selectedProduct: { requestedSlug: 'power', actualSlug: 'power', exact: true, boundToForm: true },
    selectedLot: { index: 0, available: 1000, unitCost: 0.17, stillSelected: true, costBound: true },
    inventory: { status: 200, kind: 1, availableTotal: 1000 },
    transport: { perUnit: 0, available: 108 },
    inputs: { quantityRaw: '800', quantity: 800, priceRaw: '0.28', price: 0.28 },
    economics: { estimatedProfit: 123.45 },
    confirm: { found: true, unique: true, disabled: false, ariaDisabled: false, pointerDisabled: false },
  };
}

test('asset normalization matches only the exact base slug', () => {
  assert.equal(normalizeAssetSlug('/static/power.8df7bb28.png'), 'power');
  assert.equal(normalizeAssetSlug('https://cdn.example/resources/coffee-ground.a1b2c3d4.webp?x=1'), 'coffee-ground');
  assert.equal(normalizeAssetSlug('/static/superpower.8df7bb28.png'), 'superpower');
  assert.notEqual(normalizeAssetSlug('/static/superpower.8df7bb28.png'), 'power');
});

test('pre-submit review accepts an exact product, form, lot, profit, and unique button', () => {
  assert.deepEqual(validateExchangeUiReview(exactReview()), { ok: true, failures: [] });
});

test('pre-submit review remains self-contained when injected into the browser page', () => {
  const isolated = Function(`"use strict"; return (${validateExchangeUiReview.toString()})(arguments[0]);`);
  assert.deepEqual(isolated(exactReview()), { ok: true, failures: [] });
});

test('pre-submit review fails closed for every mutable form identity', () => {
  const cases = [
    ['product', review => { review.selectedProduct.actualSlug = 'superpower'; }],
    ['form product', review => { review.selectedProduct.boundToForm = false; }],
    ['quantity', review => { review.inputs.quantity = 799; }],
    ['price', review => { review.inputs.price = 0.27; }],
    ['lot size', review => { review.selectedLot.available = 799; }],
    ['lot identity', review => { review.selectedLot.stillSelected = false; }],
    ['lot cost', review => { review.selectedLot.costBound = false; }],
    ['live reserve', review => { review.inventory.availableTotal = 999; }],
    ['live inventory source', review => { review.inventory.status = 500; }],
    ['missing reserve', review => { review.expectedReserve = null; }],
    ['transport', review => { review.transport.perUnit = 1; review.transport.available = 799; }],
    ['missing transport cost', review => { review.transport.perUnit = null; }],
    ['missing transport stock', review => { review.transport.available = null; }],
    ['profit', review => { review.economics.estimatedProfit = 0; }],
    ['button ambiguity', review => { review.confirm.unique = false; }],
    ['aria disabled', review => { review.confirm.ariaDisabled = true; }],
    ['pointer disabled', review => { review.confirm.pointerDisabled = true; }],
  ];
  for (const [label, mutate] of cases) {
    const review = exactReview();
    mutate(review);
    assert.equal(validateExchangeUiReview(review).ok, false, label);
  }
});

test('post-submit proof requires both form closure and authoritative inventory reduction', () => {
  const exact = {
    status: 200,
    beforeAvailable: 1000,
    afterAvailable: 200,
    expectedQty: 800,
    formClosed: true,
  };
  const accepted = validateExchangePostSubmit(exact);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.availableDecrease, 800);
  assert.equal(accepted.inventoryReduced, true);

  assert.equal(validateExchangePostSubmit({ ...exact, status: 429 }).ok, false);
  assert.equal(validateExchangePostSubmit({ ...exact, afterAvailable: 201 }).ok, false);
  assert.equal(validateExchangePostSubmit({ ...exact, afterAvailable: 199 }).ok, false);
  assert.equal(validateExchangePostSubmit({ ...exact, afterAvailable: null }).ok, false);
  assert.equal(validateExchangePostSubmit({ ...exact, beforeAvailable: null }).ok, false);
  assert.equal(validateExchangePostSubmit({ ...exact, formClosed: false }).ok, false);
});
