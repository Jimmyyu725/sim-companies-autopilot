'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateCoffeeReservePolicy } = require('../coffee-reserve-policy.js');
const { buildReserveAuthorization, inspectionArtifact } = require('../inspect-exchange-sale.js');

test('inspection artifact persists actual form, product, lot, choices, and economics', () => {
  const result = {
    ok: true,
    inspectedAt: '2026-07-26T20:09:30.000Z',
    request: { kind: 1, qty: 800 },
    resource: { name: 'power', imageSlug: 'power' },
    policy: {
      stateAsOf: '2026-07-26T20:09:00.000Z',
      planAsOf: '2026-07-26T20:09:00.000Z',
      reserveValidUntil: '2026-07-26T20:14:30.000Z',
      reserve: 203,
      reserveProjection: { planCapture: 200, atInspection: 201, atExpiry: 203 },
    },
    quote: { quantity: 800, price: 0.28, maxSafeQty: 800, reserve: 203, feeRate: 0.04 },
    book: { live: { bestAsk: 0.28, freshness: 'FRESH' } },
    uiQuote: {
      ok: true,
      status: 'READY_TO_REVIEW',
      actualInputs: { quantityRaw: '800', quantity: 800, priceRaw: '0.28', price: 0.28 },
      selectedProduct: { requestedSlug: 'power', actualSlug: 'power', exact: true },
      selectedLot: { index: 0, available: 1000, unitCost: 0.16, stillSelected: true, costBound: true },
      qualityChoices: [{ index: 0, available: 1000, quality: 0, unitCost: 0.16, rowText: '1000 $0.16' }],
      economics: { estimatedProfit: 123.45 },
    },
  };
  const artifact = inspectionArtifact(result);
  assert.equal(artifact.schemaVersion, 4);
  assert.match(artifact.inspectionId, /^[0-9a-f-]{36}$/i);
  assert.equal(artifact.imageSlug, 'power');
  assert.equal(artifact.uiInputs.quantity, 800);
  assert.equal(artifact.uiInputs.price, 0.28);
  assert.equal(artifact.uiProduct.actualSlug, 'power');
  assert.equal(artifact.uiLot.available, 1000);
  assert.equal(artifact.uiLot.unitCost, 0.16);
  assert.equal(artifact.qualityChoices[0].quality, 0);
  assert.equal(artifact.uiEconomics.estimatedProfit, 123.45);
  assert.equal(artifact.ok, true);
  assert.equal(artifact.expiresAt, '2026-07-26T20:14:30.000Z');
  assert.equal(artifact.reserveProjection.atExpiry, 203);
});

test('reserve authorization covers a slowdown expiry through the artifact deadline', () => {
  const nowMs = Date.parse('2026-07-26T20:10:00.000Z');
  const expiresAt = '2026-07-26T21:10:00.000Z';
  const facts = {
    resources: {
      1: { recipe: {}, transportation: 0 },
      2: { recipe: { 1: 0.2 }, transportation: 0 },
      13: { recipe: {}, transportation: 0 },
      66: { recipe: { 2: 0.1 }, transportation: 0.1 },
      118: { recipe: { 2: 0.5, 66: 1 }, transportation: 0.1 },
      119: { recipe: { 118: 10 }, transportation: 1 },
    },
  };
  const state = {
    t: new Date(nowMs).toISOString(),
    warehouse: { complete: true, allPositiveProductsIncluded: true },
    sources: {
      stock: { status: 'ok', asOf: new Date(nowMs).toISOString() },
      modifiers: { status: 'ok', asOf: new Date(nowMs).toISOString() },
    },
    modifiers: [{
      realm: 0, kind: 119, pct: -23,
      since: '2026-07-26T19:00:00.000Z', until: expiresAt,
    }],
    buildings: [{ id: 101, name: 'Mill', kindLetter: 'i', size: 2, busy: null }],
    stock: [1, 2, 13, 66, 118, 119].map(kind => ({
      kind, name: `kind ${kind}`, amount: kind === 13 ? 100 : 10000, known: true,
    })),
    surplusPlan: { horizonHours: 24, bufferPct: 0.10 },
  };
  const inspectionCache = [{
    ok: true,
    inspectedAt: '2026-07-26T20:05:00.000Z',
    buildingId: 101,
    level: 2,
    source: '/b/101/',
    products: [{
      kind: 119,
      productionPerHour: 77,
      modifier: { status: 'active', direction: 'decreased', percent: 23, expiresAt },
    }],
  }];
  const current = calculateCoffeeReservePolicy({
    state, inspectionCache, facts, horizonHours: 24, bufferPct: 0.10, nowMs,
  });
  const currentItem = current.items[1];
  const authorization = buildReserveAuthorization({
    state,
    kind: 1,
    currentPolicy: {
      ok: true,
      reserve: currentItem.reserve,
      sellable: currentItem.sellable,
      stock: { amount: currentItem.stock },
    },
    facts,
    inspectionCache,
    nowMs,
  });
  assert.equal(authorization.ok, true);
  assert.ok(authorization.policy.reserveProjection.atExpiry >
    authorization.policy.reserveProjection.atInspection);
  assert.equal(authorization.reserve, authorization.policy.reserveProjection.atExpiry);
  assert.equal(authorization.reserveValidUntil, '2026-07-26T20:15:00.000Z');

  const staleAtExpiry = structuredClone(inspectionCache);
  staleAtExpiry[0].inspectedAt = '2026-07-26T19:59:59.000Z';
  const staleAuthorization = buildReserveAuthorization({
    state,
    kind: 1,
    currentPolicy: {
      ok: true,
      reserve: currentItem.reserve,
      sellable: currentItem.sellable,
      stock: { amount: currentItem.stock },
    },
    facts,
    inspectionCache: staleAtExpiry,
    nowMs,
  });
  assert.match(staleAuthorization.reason, /expiry-time reserve projection/);
  assert.equal(staleAuthorization.failureCode, 'RESERVE_RATE_EVIDENCE_EXPIRES');
  assert.deepEqual(staleAuthorization.requiredBuildingIds, [101]);
});
