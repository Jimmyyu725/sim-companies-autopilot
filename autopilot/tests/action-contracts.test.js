'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTION_NAMES,
  actionTargetKey,
  responsesActionTools,
  validateActionParams,
} = require('../action-contracts');
const { FailureBudget, isActionFailure } = require('../failure-budget');

test('publishes one typed tool per action with no extra fields', () => {
  const tools = responsesActionTools();
  assert.equal(tools.length, ACTION_NAMES.length);
  const produce = tools.find((tool) => tool.name === 'produce');
  assert.deepEqual(produce.parameters.required, ['buildingId', 'name', 'qty', 'targetHours', 'finishBefore']);
  assert.equal(produce.parameters.additionalProperties, false);
  assert.equal(produce.strict, true);
  assert.equal(Object.hasOwn(produce.parameters.properties, 'minCashAfter'), false);
  assert.equal(Object.hasOwn(produce.parameters.properties, 'ownerUpgradeAttemptVerified'), false);
  const buy = tools.find((tool) => tool.name === 'buy');
  assert.deepEqual(buy.parameters.required, ['kind', 'quantity', 'maxSpend', 'ask']);
  assert.deepEqual(buy.parameters.properties.quantity.type, ['integer', 'null']);
  const consult = tools.find((tool) => tool.name === 'pa_consult_guide');
  assert.deepEqual(consult.parameters.required,
    ['offerFingerprint', 'preliminaryChoice', 'rationale']);
});

test('accepts valid production parameters and rejects guessed field names', () => {
  assert.equal(validateActionParams('produce', {
    buildingId: 54959369,
    name: 'SEEDS',
    qty: 10000,
    targetHours: null,
    finishBefore: null,
  }).ok, true);
  const bad = validateActionParams('produce', {
    building: 'Farm',
    product: 66,
    quantity: 10000,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unknown field/);
});

test('rejects string booleans so "false" can never become a confirmed mutation', () => {
  const result = validateActionParams('scrap', { buildingId: 1, confirm: 'false' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /boolean/);
});

test('rebuild exposes only an exact building id and an explicit confirmation bit', () => {
  assert.deepEqual(validateActionParams('rebuild', { buildingId: 55258164, confirm: false }), {
    ok: true,
    params: { buildingId: 55258164, confirm: false },
  });
  assert.equal(validateActionParams('rebuild', { buildingId: 0, confirm: true }).ok, false);
  assert.equal(validateActionParams('rebuild', {
    buildingId: 55258164,
    building: 'Quarry',
    confirm: true,
  }).ok, false);
});

test('requires positive numeric quantities before browser access', () => {
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'SEEDS',
    qty: undefined,
    targetHours: null,
    finishBefore: null,
  }).ok, false);
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'SEEDS',
    qty: 0,
    targetHours: null,
    finishBefore: null,
  }).ok, false);
});

test('production duration is explicit and bounded', () => {
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'POWER',
    qty: 1200,
  }).ok, false);
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'POWER',
    qty: 1200,
    targetHours: 24,
    finishBefore: null,
  }).ok, true);
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'POWER',
    qty: 1200,
    targetHours: 72,
    finishBefore: null,
  }).ok, false);
});

test('production checkpoint must be explicit and parseable', () => {
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'COFFEE POWDER',
    qty: 9,
    targetHours: 1,
    finishBefore: '2026-07-26T23:22:50.000Z',
  }).ok, true);
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'COFFEE POWDER',
    qty: 9,
    targetHours: 1,
    finishBefore: 'later',
  }).ok, false);
  assert.equal(validateActionParams('produce', {
    buildingId: 1,
    name: 'COFFEE POWDER',
    qty: 9,
    targetHours: 1,
    finishBefore: '2026-07-26T23:22:50.000Z',
    ownerUpgradeAttemptVerified: true,
  }).ok, true);
});

test('failure budget opens after two real failures for the same target', () => {
  const budget = new FailureBudget(2);
  const key = actionTargetKey('produce', { buildingId: 1 });
  assert.equal(budget.before(key), null);
  assert.equal(budget.record(key, { ok: false, reason: 'card not found' }), 1);
  assert.equal(budget.record(key, { ok: false, reason: 'card not found' }), 2);
  assert.equal(budget.before(key).failureBudgetOpen, true);
  assert.equal(budget.before(actionTargetKey('produce', { buildingId: 2 })), null);
});

test('dry previews do not consume the failure budget', () => {
  assert.equal(isActionFailure({ ok: false, reason: 'dry run — not confirmed' }), false);
  assert.equal(isActionFailure({ ok: false, preview: true, reason: 'policy preview' }), false);
  const budget = new FailureBudget(2);
  const key = actionTargetKey('build', { building: 'Power plant' });
  budget.record(key, { ok: false, reason: 'dry run — not confirmed' });
  assert.equal(budget.before(key), null);
});

test('the same rejected Mill micro quantity is blocked before a second browser preview', () => {
  const budget = new FailureBudget(2);
  const key = actionTargetKey('produce', { buildingId: 1 });
  const qty3 = `${key}:qty:3`;
  const qty18 = `${key}:qty:18`;
  assert.equal(budget.before(key, qty3), null);
  budget.record(key, {
    ok: false,
    preview: true,
    microBatchGuard: true,
    requestedPreviewQty: 3,
  }, qty3);
  assert.equal(budget.before(key, qty3).repeatedPreviewOpen, true);
  assert.equal(budget.before(key, qty18), null);
  assert.equal(budget.before(key), null);
});

test('a confirmed success resets failures for that target', () => {
  const budget = new FailureBudget(2);
  const key = actionTargetKey('produce', { buildingId: 1 });
  budget.record(key, { ok: false, reason: 'temporary failure' });
  budget.record(key, { ok: true, started: true });
  budget.record(key, { ok: false, reason: 'later failure' });
  assert.equal(budget.before(key), null);
});

test('an ambiguous do-not-retry mutation opens the circuit immediately', () => {
  const budget = new FailureBudget(2);
  const key = actionTargetKey('pa_reply', {});
  assert.equal(budget.record(key, {
    ok: false,
    mutationAttempted: true,
    doNotRetry: true,
    outcome: 'UNKNOWN_AFTER_SINGLE_CLICK',
  }), 2);
  assert.equal(budget.before(key).failureBudgetOpen, true);
});

test('PA reply is fingerprint-bound and requires a guide reconciliation', () => {
  const fingerprint = 'a'.repeat(64);
  assert.equal(validateActionParams('pa_reply', {
    offerFingerprint: fingerprint,
    choice: 'Make it official',
    comparison: 'The independent choice agrees with the exact guide match.',
  }).ok, true);
  assert.equal(validateActionParams('pa_reply', {
    choice: 'Make it official',
  }).ok, false);
  assert.equal(validateActionParams('pa_consult_guide', {
    offerFingerprint: fingerprint,
    preliminaryChoice: 'Make it official',
    rationale: 'This appears to dominate the other displayed options.',
  }).ok, true);
});
