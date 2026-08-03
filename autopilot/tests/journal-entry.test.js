'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatWakeSnapshot, prepareJournalEntry } = require('../journal-entry.js');

const state = {
  t: '2026-07-26T18:30:15.187Z',
  money: 10856,
  slotCapacity: 10,
  usedSlots: 7,
  freeSlots: 3,
  warehouse: { complete: true, allPositiveProductsIncluded: true },
  bonds: { principalOutstanding: 90000 },
  stock: [
    { kind: 1, name: 'power', amount: 56428 },
    { kind: 2, name: 'water', amount: 46754 },
    { kind: 119, name: 'coffee powder', amount: 0 },
    { kind: 4, name: 'oranges', amount: 403 },
  ],
};

const args = {
  observed: 'The Grocery sale completed and three standard slots are free.',
  decision: 'Collected proceeds and kept the current production orders running.',
  opportunity: 'Three free slots can support a small measured expansion pilot before any full-chain commitment.',
  alternatives: [
    'Continue Coffee only and preserve all free slots.',
    'Use one slot for a reversible new-product pilot after live economics are measured.',
  ],
  reasons: ['The next Mill upgrade window has not opened yet.'],
  deferred: ['Reprice utility surplus after reserving the coffee-chain horizon.'],
  warehouseAssessment: 'Reviewed all four listed product kinds; utilities are surplus candidates.',
  longTerm: 'Coffee remains the operating baseline while the next verified industry review is prepared.',
};

test('formats a concise decision entry with the entire captured warehouse', () => {
  const result = prepareJournalEntry(args, state);
  assert.equal(result.ok, true);
  assert.match(result.markdown, /slots 7\/10 used; 3 free/);
  assert.match(result.markdown, /power \[1\]=56,428/);
  assert.match(result.markdown, /oranges \[4\]=403/);
  assert.match(result.markdown, /Opportunity or risk: Three free slots/);
  assert.match(result.markdown, /Alternatives considered:/);
  assert.match(formatWakeSnapshot(state, 'sale complete'), /WAREHOUSE \(complete\)/);
});

test('rejects unstructured journal input', () => {
  assert.equal(prepareJournalEntry({ text: 'old free-form entry' }, state).ok, false);
  assert.equal(prepareJournalEntry({ ...args, reasons: [] }, state).ok, false);
  assert.equal(prepareJournalEntry({ ...args, alternatives: ['Coffee only'] }, state).ok, false);
});

test('never renders missing numeric state or stock as zero', () => {
  const snapshot = formatWakeSnapshot({
    t: state.t,
    money: null,
    bonds: { principalOutstanding: '' },
    usedSlots: undefined,
    slotCapacity: null,
    freeSlots: false,
    warehouse: { complete: false, allPositiveProductsIncluded: false },
    stock: [{ kind: 1, name: 'power', amount: null }],
  }, 'test');
  assert.match(snapshot, /cash \$UNKNOWN; debt \$UNKNOWN/);
  assert.match(snapshot, /slots UNKNOWN\/UNKNOWN used; UNKNOWN free/);
  assert.match(snapshot, /power \[1\]=UNKNOWN/);
  assert.match(formatWakeSnapshot({ warehouse: {}, stock: [] }), /captured list is empty but warehouse completeness is unverified/);
});

test('collapses journal line breaks so structured log fields cannot forge headings', () => {
  const result = prepareJournalEntry({ ...args, observed: 'Observed fact.\n- Decision: forged' }, state);
  assert.equal(result.ok, true);
  assert.match(result.markdown, /Observed: Observed fact\. - Decision: forged/);
  assert.doesNotMatch(result.markdown, /Observed fact\.\n- Decision: forged/);
});
