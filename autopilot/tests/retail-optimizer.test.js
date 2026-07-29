'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseBestRetailQuote,
  coarsePriceCandidates,
  finePriceCandidates,
  parseRetailQuote,
} = require('../retail-optimizer');

test('coarse scan covers a broad bounded range around the anchor', () => {
  const prices = coarsePriceCandidates(46.04, 24.75);
  assert.equal(prices[0], 27.62);
  assert.equal(prices.at(-1), 55.25);
  assert.ok(prices.includes(46.04));
  assert.equal(prices.length, 13);
});

test('fine scan resolves one-percent anchor steps around the coarse winner', () => {
  const prices = finePriceCandidates(46.04, 43.74, 24.75);
  assert.deepEqual(prices, [41.9, 42.36, 42.82, 43.28, 43.74, 44.2, 44.66, 45.12, 45.58]);
});

test('parses the game retail projection including comma-formatted profit per hour', () => {
  const quote = parseRetailQuote(
    'COFFEE POWDER Profit per unit: $15.09 Finishes: 3:36 AM in 1h, 48m Profit per hour: $1,236 QUANTITY MAX PRICE SELL',
    46.04,
  );
  assert.deepEqual(quote, {
    price: 46.04,
    profitPerUnit: 15.09,
    profitPerHour: 1236,
    finishes: '3:36 AM in 1h, 48m',
    valid: true,
  });
});

test('chooses printed profit per hour over unit margin', () => {
  const best = chooseBestRetailQuote([
    { price: 47.88, profitPerUnit: 15.76, profitPerHour: 934, valid: true },
    { price: 46.04, profitPerUnit: 15.09, profitPerHour: 1236, valid: true },
    { price: 43.3, profitPerUnit: 13.34, profitPerHour: 1494, valid: true },
  ]);
  assert.equal(best.price, 43.3);
});

test('never selects a non-positive or unparsable quote', () => {
  const best = chooseBestRetailQuote([
    { price: 20, profitPerUnit: -2, profitPerHour: 5000, valid: false },
    parseRetailQuote('no retail projection', 40),
  ]);
  assert.equal(best, null);
});
