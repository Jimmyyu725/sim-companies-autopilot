'use strict';

const assert = require('assert');
const { validateFreshSaleInspection, validateFreshSurplus } = require('../exchange-sale-safety.js');

const now = Date.parse('2026-07-26T20:10:00.000Z');
const state = {
  t: '2026-07-26T20:09:00.000Z',
  sources: { stock: { status: 'ok', asOf: '2026-07-26T20:09:00.000Z' } },
  warehouse: { complete: true, allPositiveProductsIncluded: true },
  stock: [
    { kind: 1, name: 'power', amount: 1000, known: true },
    { kind: 5, name: 'grapes', amount: 300, known: true },
    { kind: 13, name: 'transport', amount: 108, known: true },
  ],
  surplusPlan: {
    asOf: '2026-07-26T20:09:00.000Z',
    complete: true,
    status: 'ok',
    items: {
      '1': { kind: 1, stock: 1000, reserve: 200, sellable: 800, transportPerUnit: 0 },
      '5': { kind: 5, stock: 300, reserve: 0, sellable: 300, transportPerUnit: 1 },
    },
  },
};

assert.equal(validateFreshSurplus(state, 1, 800, now).ok, true);
assert.equal(validateFreshSurplus(state, 1, 801, now).ok, false);
assert.equal(validateFreshSurplus(state, 1, 1.5, now).ok, false);

const grapes = validateFreshSurplus(state, 5, 108, now);
assert.equal(grapes.ok, true);
assert.equal(grapes.maxByTransport, 108);
assert.equal(validateFreshSurplus(state, 5, 109, now).ok, false);

const changed = structuredClone(state);
changed.stock[0].amount = 999;
assert.match(validateFreshSurplus(changed, 1, 10, now).reason, /stock changed/);

const incomplete = structuredClone(state);
incomplete.surplusPlan.complete = false;
assert.match(validateFreshSurplus(incomplete, 1, 10, now).reason, /missing or incomplete/);

const detachedPlan = structuredClone(state);
detachedPlan.surplusPlan.asOf = '2026-07-26T20:08:00.000Z';
assert.match(validateFreshSurplus(detachedPlan, 1, 10, now).reason, /not tied/);

const blockedTransport = structuredClone(state);
blockedTransport.stock[2].availableAmount = 8;
blockedTransport.stock[2].blockedAmount = 100;
assert.equal(validateFreshSurplus(blockedTransport, 5, 8, now).ok, true);
assert.match(validateFreshSurplus(blockedTransport, 5, 9, now).reason, /exceeds verified sellable/);

const stale = structuredClone(state);
stale.t = '2026-07-26T20:00:00.000Z';
assert.match(validateFreshSurplus(stale, 1, 10, now).reason, /state is stale/);

const artifact = {
  schemaVersion: 4,
  inspectionId: '123e4567-e89b-12d3-a456-426614174000',
  ok: true,
  readOnly: true,
  submitted: false,
  inspectedAt: '2026-07-26T20:09:30.000Z',
  expiresAt: '2026-07-26T20:14:30.000Z',
  kind: 1,
  imageSlug: 'power',
  effectiveQty: 800,
  bestAsk: 0.28,
  bookFreshness: 'FRESH',
  feeRate: 0.04,
  stateAsOf: state.t,
  planAsOf: state.surplusPlan.asOf,
  uiDryRun: { ok: true },
  uiInputs: { quantityRaw: '800', quantity: 800, priceRaw: '0.28', price: 0.28 },
  uiProduct: { requestedSlug: 'power', actualSlug: 'power', exact: true },
  uiLot: { index: 0, available: 1000, inspectedAvailable: 1000, unitCost: 0.17, stillSelected: true, costBound: true },
  uiEconomics: { estimatedProfit: 123.45 },
  reserve: 200,
  reserveProjection: { planCapture: 200, atInspection: 200, atExpiry: 200 },
  transportPerUnit: 0,
};
assert.equal(validateFreshSaleInspection(artifact, state, 1, 800, 0.28, now).ok, true);
const legacyArtifact = structuredClone(artifact);
delete legacyArtifact.schemaVersion;
assert.match(validateFreshSaleInspection(legacyArtifact, state, 1, 800, 0.28, now).reason,
  /successful read-only exchange inspection/);
const priorSchemaArtifact = structuredClone(artifact);
priorSchemaArtifact.schemaVersion = 3;
assert.match(validateFreshSaleInspection(priorSchemaArtifact, state, 1, 800, 0.28, now).reason,
  /successful read-only exchange inspection/);
assert.match(validateFreshSaleInspection(artifact, state, 1, 799, 0.28, now).reason, /kind\/quantity/);
assert.match(validateFreshSaleInspection(artifact, state, 1, 800, 0.27, now).reason, /price/);
assert.match(validateFreshSaleInspection(artifact, state, 1, 800, 0.28,
  Date.parse('2026-07-26T20:15:00.000Z')).reason, /expired/);

const excessiveValidity = structuredClone(artifact);
excessiveValidity.expiresAt = '2026-07-26T20:15:30.001Z';
assert.match(validateFreshSaleInspection(excessiveValidity, state, 1, 800, 0.28, now).reason,
  /expired/);

const futureState = structuredClone(state);
futureState.t = '2026-07-27T20:09:00.000Z';
futureState.surplusPlan.asOf = futureState.t;
assert.match(validateFreshSurplus(futureState, 1, 1, now).reason, /stale/);

const wrongUiQty = structuredClone(artifact);
wrongUiQty.uiInputs.quantity = 799;
assert.match(validateFreshSaleInspection(wrongUiQty, state, 1, 800, 0.28, now).reason,
  /actual inspected UI input/);

const wrongUiPrice = structuredClone(artifact);
wrongUiPrice.uiInputs.price = 0.27;
assert.match(validateFreshSaleInspection(wrongUiPrice, state, 1, 800, 0.28, now).reason,
  /actual inspected UI input/);

const wrongProduct = structuredClone(artifact);
wrongProduct.uiProduct.actualSlug = 'superpower';
assert.match(validateFreshSaleInspection(wrongProduct, state, 1, 800, 0.28, now).reason,
  /target resource slug/);

const smallLot = structuredClone(artifact);
smallLot.uiLot.available = 799;
assert.match(validateFreshSaleInspection(smallLot, state, 1, 800, 0.28, now).reason,
  /quality lot/);

const wrongReserve = structuredClone(artifact);
wrongReserve.reserve = 199;
assert.match(validateFreshSaleInspection(wrongReserve, state, 1, 800, 0.28, now).reason,
  /reserve or Transport/);

const missingProjection = structuredClone(artifact);
delete missingProjection.reserveProjection;
assert.match(validateFreshSaleInspection(missingProjection, state, 1, 800, 0.28, now).reason,
  /reserve or Transport/);

const missingReserve = structuredClone(artifact);
missingReserve.reserve = null;
assert.match(validateFreshSaleInspection(missingReserve, state, 1, 800, 0.28, now).reason,
  /reserve or Transport/);

const missingTransport = structuredClone(artifact);
missingTransport.transportPerUnit = null;
assert.match(validateFreshSaleInspection(missingTransport, state, 1, 800, 0.28, now).reason,
  /reserve or Transport/);

const inflatedUnsafeReserve = structuredClone(artifact);
inflatedUnsafeReserve.reserve = 201;
inflatedUnsafeReserve.reserveProjection.atExpiry = 201;
assert.match(validateFreshSaleInspection(inflatedUnsafeReserve, state, 1, 800, 0.28, now).reason,
  /reserve or Transport/);

const conservativeArtifact = structuredClone(artifact);
conservativeArtifact.effectiveQty = 799;
conservativeArtifact.uiInputs.quantityRaw = '799';
conservativeArtifact.uiInputs.quantity = 799;
conservativeArtifact.reserve = 201;
conservativeArtifact.reserveProjection.atExpiry = 201;
assert.equal(validateFreshSaleInspection(conservativeArtifact, state, 1, 799, 0.28, now).ok, true);

console.log('exchange-sale-safety tests passed');
