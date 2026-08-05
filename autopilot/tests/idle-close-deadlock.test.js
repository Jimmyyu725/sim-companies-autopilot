'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildingUtilizationJournalGate } = require('../building-utilization-policy.js');
const { FailureBudget } = require('../failure-budget.js');

// Regression, 2026-08-05 02:47. Two rules that are each correct deadlocked against each other: the
// close gate refuses to finish while a building is idle, and the FailureBudget refuses the sell that
// would un-idle it after two real failures. Grocery 55692959 sat idle with 30 Coffee Powder the
// retail scan could not price, and the wake spent 373 model requests, 59.8M tokens and $15.85
// cycling refresh_state -> set_alarm -> finish -> refused, until the 45-minute wall clock killed it
// (rc=124). The round ceiling used to bound this; it had been removed hours earlier.
//
// Every assertion below runs unconditionally. An earlier version of this file guarded the
// interesting cases with `if (block === null) return`, and the fixture was missing
// state.sources.buildings, so the inspector bailed before reaching the code under test and two
// tests passed without exercising anything.

const NOW = Date.parse('2026-08-05T08:00:00.000Z');
const ISO = new Date(NOW).toISOString();

function stateWith(...buildings) {
  return {
    t: ISO,
    sources: { buildings: { status: 'ok', asOf: ISO } },
    buildings,
  };
}
const idleGrocery = () =>
  ({ id: 55692959, name: 'Grocery store', kindLetter: 'r', category: 'sales', busy: null });
const idleMill = () =>
  ({ id: 55697470, name: 'Mill', kindLetter: 'i', category: 'production', busy: null });
const busyMill = () => ({
  id: 55765094, name: 'Mill', kindLetter: 'i', category: 'production',
  busy: { type: 'production', endsAt: new Date(NOW + 3600e3).toISOString() },
});

test('an idle building blocks the close while its remedy is still available', () => {
  const block = buildingUtilizationJournalGate(stateWith(idleGrocery(), busyMill()), NOW, {});
  assert.ok(block, 'an idle sales building must block the close');
  assert.equal(block.guard, true);
  assert.match(block.reason, /confirmed idle/u);
  assert.deepEqual(block.idleBuildings.map(b => b.buildingId), [55692959]);
  assert.deepEqual(block.requiredActions, [
    { buildingId: 55692959, tool: 'sell', checkpointField: null },
  ]);
});

test('a remedy the failure budget has closed releases the close', () => {
  const block = buildingUtilizationJournalGate(stateWith(idleGrocery(), busyMill()), NOW,
    { exhaustedActions: new Set(['sell:55692959']) });
  assert.equal(block, null,
    'with the only remedy closed by the failure budget, the gate must let the wake finish');
});

test('an array of exhausted keys is accepted as well as a Set', () => {
  const block = buildingUtilizationJournalGate(stateWith(idleGrocery(), busyMill()), NOW,
    { exhaustedActions: ['sell:55692959'] });
  assert.equal(block, null);
});

test('a closed remedy for one building does not excuse another that is actionable', () => {
  const block = buildingUtilizationJournalGate(stateWith(idleGrocery(), idleMill(), busyMill()), NOW,
    { exhaustedActions: new Set(['sell:55692959']) });
  assert.ok(block, 'the still-actionable Mill must keep the gate closed');
  assert.deepEqual(block.requiredActions, [
    { buildingId: 55697470, tool: 'produce', checkpointField: 'finishBefore' },
  ], 'the gate must not demand an action the failure budget refuses');
  assert.deepEqual(block.blockedIdleBuildings.map(b => b.buildingId), [55692959]);
});

test('the wrong action name does not release a building', () => {
  // sell:55692959 is what the budget stores for a sales building. produce:55692959 is not.
  const block = buildingUtilizationJournalGate(stateWith(idleGrocery(), busyMill()), NOW,
    { exhaustedActions: new Set(['produce:55692959']) });
  assert.ok(block, 'only the remedy this building actually needs may release it');
});

test('the exhausted key format matches what the budget stores and refuses', () => {
  const budget = new FailureBudget(2);
  budget.record('sell:55692959', { ok: false });
  assert.equal(budget.exhausted().size, 0, 'one failure is not exhaustion');
  budget.record('sell:55692959', { ok: false });
  assert.deepEqual([...budget.exhausted()], ['sell:55692959']);
  assert.ok(budget.before('sell:55692959')?.failureBudgetOpen,
    'the key the gate reads must be the key the budget refuses');

  // End to end: the key the budget produced releases the gate.
  assert.equal(
    buildingUtilizationJournalGate(stateWith(idleGrocery(), busyMill()), NOW,
      { exhaustedActions: budget.exhausted() }),
    null,
  );
});

test('a doNotRetry failure exhausts the key immediately', () => {
  const budget = new FailureBudget(2);
  budget.record('sell:55692959', { ok: false, doNotRetry: true });
  assert.deepEqual([...budget.exhausted()], ['sell:55692959']);
});

test('a later success reopens the key', () => {
  const budget = new FailureBudget(2);
  budget.record('sell:55692959', { ok: false });
  budget.record('sell:55692959', { ok: false });
  assert.equal(budget.exhausted().size, 1);
  budget.record('sell:55692959', { ok: true });
  assert.equal(budget.exhausted().size, 0, 'a success must clear the block, not latch it');
});

test('an uncollected completed job still blocks the close', () => {
  // collect is a single supporter-button click that does not depend on a market price, so it never
  // earns the escape a priced sale can.
  const completed = {
    id: 55765098, name: 'Mill', kindLetter: 'i', category: 'production',
    busy: { type: 'production', endsAt: new Date(NOW - 60e3).toISOString() },
  };
  const block = buildingUtilizationJournalGate(stateWith(completed, busyMill()), NOW,
    { exhaustedActions: new Set(['sell:55692959', 'produce:55765098', 'collect:55765098']) });
  assert.ok(block, 'a completed uncollected job must still block the close');
  assert.ok(block.requiredActions.some(a => a.tool === 'collect'));
});
