'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compactStatement,
  normalizeMarketKinds,
  summarizeBondOfferForm,
  summarizeBookRows,
  summarizeCachedBook,
  summarizeStateAuthority,
} = require('../council-evidence-helpers.js');

test('labels a zero bond offer as offer configuration rather than outstanding debt', () => {
  const result = summarizeBondOfferForm({
    source: '/headquarters/finance/',
    status: 200,
    rating: 'B+',
    offerAmountField: '0',
    offerInterestField: '0.5',
  });
  assert.equal(result.unsoldOfferAmountDollars, 0);
  assert.equal(result.offerInterestPctPerDay, 0.5);
  assert.equal(result.representsOutstandingDebt, false);
  assert.equal(result.outstandingPrincipalSource, 'state.bonds.principalOutstanding');
  assert.match(result.note, /does not mean zero outstanding debt/);
  assert.equal(summarizeBondOfferForm({ offerAmountField: null }).unsoldOfferAmountDollars, 'UNKNOWN');
});

test('market kinds are bounded, unique, and default to the coffee chain', () => {
  assert.deepEqual(normalizeMarketKinds(null), [1, 2, 66, 118, 119]);
  assert.deepEqual(normalizeMarketKinds([119, 119, 2, -1, 66, 118, 1, 5]), [119, 2, 66, 118, 1]);
  assert.deepEqual(normalizeMarketKinds([Number.MAX_SAFE_INTEGER + 1, 119]), [119]);
});

test('non-200 statements become UNKNOWN instead of guessed values', () => {
  assert.deepEqual(compactStatement('/api/test/', { status: 404, json: null }), {
    source: '/api/test/', status: 404, value: 'UNKNOWN',
  });
  assert.deepEqual(compactStatement('/api/test/', { status: 200, json: { date: 'x', cash: 10, nested: { ignored: true } } }), {
    source: '/api/test/', status: 200, asOf: 'x', value: { date: 'x', cash: 10 },
  });
});

test('order books expose bounded depth and stale cache metadata', () => {
  const direct = summarizeBookRows(119, [
    { quantity: 20, price: 41 }, { quantity: 10, price: 40 }, { quantity: 5, price: 42 },
  ], '2026-07-25T00:00:00Z', '/api/book');
  assert.equal(direct.bestAsk, 40);
  assert.equal(direct.top5Quantity, 35);
  const cached = summarizeCachedBook(119, {
    t: 1000, full: false, o: { a: [10, 40], b: [20, 41] },
  }, 1000 * 1000 + 700 * 1000);
  assert.equal(cached.ageSeconds, 700);
  assert.equal(cached.freshness, 'STALE');
  assert.equal(cached.visibleQuantity, 30);
  assert.equal(cached.bestAsk, 40);
});

test('future or malformed cached books cannot masquerade as fresh authority', () => {
  const future = summarizeCachedBook(119, {
    t: 2000, full: false, o: { valid: [10, 40], malformed: { quantity: 20, price: 39 } },
  }, 1000 * 1000);
  assert.equal(future.ageSeconds, -1000);
  assert.equal(future.freshness, 'STALE');
  assert.equal(future.visibleRows, 1);
  assert.equal(future.invalidRows, 1);

  const invalid = summarizeBookRows(119, [
    { quantity: 0, price: 40 },
    { quantity: 10, price: 0 },
  ], '2026-07-25T00:00:00Z', '/api/book');
  assert.equal(invalid.status, 'INVALID');
  assert.equal(invalid.bestAsk, null);
});

test('state freshness requires current core sources and a complete warehouse', () => {
  const asOf = '2026-07-26T04:00:00.000Z';
  const state = {
    t: asOf,
    sources: Object.fromEntries(['auth', 'buildings', 'stock'].map(key => [key, { status: 'ok', asOf }])),
    warehouse: { complete: true, allPositiveProductsIncluded: true },
  };
  assert.equal(summarizeStateAuthority(state, Date.parse(asOf) + 60_000).stateFreshness, 'FRESH');
  assert.equal(summarizeStateAuthority(state, Date.parse(asOf) - 60_000).stateFreshness, 'STALE');
  assert.equal(summarizeStateAuthority({ ...state, warehouse: { complete: false } }, Date.parse(asOf)).stateFreshness, 'STALE');
  assert.equal(summarizeStateAuthority({
    ...state,
    sources: { ...state.sources, stock: { status: 'unknown', asOf } },
  }, Date.parse(asOf)).stateFreshness, 'STALE');
});
