'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCurrentMemory, validateCurrentMemory, writeCurrentMemory } = require('../current-memory.js');

const state = {
  t: '2026-07-26T04:00:00.000Z',
  money: 38107,
  bonds: { principalOutstanding: 90000 },
  slotCapacity: 10,
  usedSlots: 7,
  freeSlots: 3,
};
const alarm = { atIso: '2026-07-26T05:00:00.000Z' };
const input = {
  stateAsOf: state.t,
  cash: 38107,
  debtPrincipal: 90000,
  slots: { capacity: 10, used: 7, free: 3 },
  done: ['Collected completed production.'],
  blockers: [],
  plan: ['Reassess the idle Mill.'],
  reviews: {
    warehouse: 'Reviewed every captured product kind.',
    upgradeAndDebt: 'Upgrade merit will be ranked at the next idle Mill window before financing.',
    utilitySurplus: 'Retain the measured chain reserve and price excess utilities before sale.',
    longTerm: 'Coffee remains the operating baseline pending a verified industry review.',
  },
  nextDecisionAt: alarm.atIso,
};

test('accepts a current checkpoint tied to live state and alarm', () => {
  const result = validateCurrentMemory(input, state, alarm, new Date('2026-07-26T04:01:00.000Z'));
  assert.equal(result.ok, true);
  assert.equal(result.value.cash, 38107);
  assert.deepEqual(result.value.slots, { capacity: 10, used: 7, free: 3 });
  assert.equal(result.value.schemaVersion, 2);
  assert.equal(result.value.updatedAt, '2026-07-26T04:01:00.000Z');
});

test('rejects hallucinated cash, debt, or alarm time', () => {
  assert.equal(validateCurrentMemory({ ...input, cash: 1 }, state, alarm).ok, false);
  assert.equal(validateCurrentMemory({ ...input, debtPrincipal: 0 }, state, alarm).ok, false);
  assert.equal(validateCurrentMemory({ ...input, slots: { capacity: 6, used: 7, free: 0 } }, state, alarm).ok, false);
  assert.equal(validateCurrentMemory({ ...input, nextDecisionAt: '2026-07-26T06:00:00.000Z' }, state, alarm).ok, false);
});

test('preserves unknown numeric sources as null rather than zero', () => {
  const unknownState = {
    t: state.t,
    money: null,
    bonds: { principalOutstanding: null },
    slotCapacity: null,
    usedSlots: null,
    freeSlots: null,
  };
  const unknownInput = {
    ...input,
    cash: null,
    debtPrincipal: null,
    slots: { capacity: null, used: null, free: null },
  };
  const result = validateCurrentMemory(unknownInput, unknownState, alarm);
  assert.equal(result.ok, true);
  assert.equal(result.value.cash, null);
  assert.equal(result.value.debtPrincipal, null);
  assert.equal(validateCurrentMemory({ ...unknownInput, cash: 0, debtPrincipal: 0 }, unknownState, alarm).ok, false);
  assert.equal(validateCurrentMemory(unknownInput, { ...unknownState, money: false }, alarm).ok, true);
});

test('rejects a parseable but structurally incomplete schema-two checkpoint', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-current-'));
  const file = path.join(directory, 'CURRENT.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, cash: 1 }));
  assert.equal(readCurrentMemory(file), null);

  const checked = validateCurrentMemory(input, state, alarm, new Date('2026-07-26T04:01:00.000Z'));
  writeCurrentMemory(file, checked.value);
  assert.deepEqual(readCurrentMemory(file), checked.value);
});
