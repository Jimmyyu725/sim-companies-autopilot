'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDurationSeconds,
  parseInspectArgs,
  parseProductionQuote,
} = require('../inspection-helpers.js');

test('inspection arguments require a paired product and quantity', () => {
  assert.deepEqual(parseInspectArgs({ buildingId: 123, product: null, qty: null }), {
    buildingId: 123, product: null, qty: null,
  });
  assert.deepEqual(parseInspectArgs({ buildingId: 123, product: 'Coffee powder', qty: 54 }), {
    buildingId: 123, product: 'Coffee powder', qty: 54,
  });
  assert.throws(() => parseInspectArgs({ buildingId: 123, product: 'Coffee powder', qty: null }));
  assert.throws(() => parseInspectArgs({ buildingId: 0, product: null, qty: null }));
});

test('production quote parses duration and money without mutating quantity', () => {
  const text = 'COFFEE POWDER Finishes: 7:32 PM (3h, 14s) Labor cost: $1,197 Unit cost: $27.57 REQUIREMENTS 540 QUANTITY PRODUCE';
  assert.equal(parseDurationSeconds(text), 10814);
  assert.deepEqual(parseProductionQuote(text), {
    durationSeconds: 10814,
    laborCost: 1197,
    unitCost: 27.57,
    requirements: '540',
    text,
  });
});
