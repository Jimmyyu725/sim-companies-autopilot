'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFreshSurplus } = require('../exchange-sale-safety.js');

// Regression (2026-08-02): the owner dismantled the Coffee chain for an all-Quarry experience loop
// and instructed a full liquidation. The surplus plan exists to reserve Coffee inputs, so with the
// chain gone it could no longer be built and every exchange sale was refused — the guard blocked the
// exact instruction it had been given. Under an owner liquidation the plan requirement yields;
// nothing else does.
const now = Date.parse('2026-08-02T07:30:00.000Z');
const liquidationState = {
  t: '2026-08-02T07:29:30.000Z',
  warehouse: { complete: true, sourceRows: 14, positiveProductKinds: 10, allPositiveProductsIncluded: true },
  sources: { stock: { status: 'ok', asOf: '2026-08-02T07:29:30.000Z', source: '/api/v3/resources/900100/' } },
  stock: [{ kind: 1, name: 'power', amount: 8621, availableAmount: 8621, blockedAmount: 0, known: true }],
  // surplusPlan deliberately absent — the Coffee chain no longer exists to reserve for
};

test('without the owner directive a missing surplus plan still refuses the sale', () => {
  const result = validateFreshSurplus(liquidationState, 1, 100, now);
  assert.equal(result.ok, false);
  assert.match(result.reason, /surplus plan/);
});

test('Transport is never sellable, liquidation or not', () => {
  const result = validateFreshSurplus(liquidationState, 13, 10, now, { ownerLiquidation: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Transport/);
});

test('liquidation is still bounded by the reconciled available amount', () => {
  const over = validateFreshSurplus(liquidationState, 1, 99999, now, { ownerLiquidation: true });
  assert.equal(over.ok, false);
});

test('owner liquidation sells against reconciled stock with no surplus plan', () => {
  const result = validateFreshSurplus(liquidationState, 1, 8621, now, { ownerLiquidation: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.safeSellable, 8621);
  assert.equal(result.reserve, 0);
  assert.equal(result.ownerLiquidation, true);
});
