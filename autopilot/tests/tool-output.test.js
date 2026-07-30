'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatToolOutput, previewJson } = require('../tool-output.js');

test('returns small tool results unchanged', () => {
  assert.deepEqual(JSON.parse(formatToolOutput('produce', { ok: true, started: true })), { ok: true, started: true });
});

test('bounds refresh state by whole fields with explicit omission metadata', () => {
  const result = JSON.parse(formatToolOutput('refresh_state', {
    t: '2026-07-26T00:00:00.000Z',
    money: 1,
    buildings: [{ id: 1, busy: null }],
    recipes: Array.from({ length: 100 }, (_, index) => `recipe ${index} ${'x'.repeat(50)}`),
  }, 600));
  assert.equal(result.money, 1);
  assert.equal(result._transport.truncated, true);
  assert(result._transport.omitted.includes('recipes'));
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'recipes'), false);
});

test('labels human log previews when characters are omitted', () => {
  assert.match(previewJson({ text: 'x'.repeat(100) }, 20), /chars omitted/);
});

test('never drops warehouse products from a large refresh result', () => {
  const stock = Array.from({ length: 40 }, (_, kind) => ({ kind, name: `product-${kind}`, amount: kind + 1 }));
  const result = JSON.parse(formatToolOutput('refresh_state', {
    t: '2026-07-26T00:00:00.000Z',
    money: 1,
    sources: { stock: { status: 'ok', asOf: '2026-07-26T00:00:00.000Z' } },
    buildings: [{ id: 1, name: 'Farm', size: 3, category: 'production', busy: null }],
    warehouse: { complete: true, allPositiveProductsIncluded: true },
    stock,
    retail: Array.from({ length: 100 }, (_, index) => ({ index, noise: 'x'.repeat(80) })),
    recipes: Array.from({ length: 100 }, (_, index) => `recipe-${index}`),
  }, 1800));
  assert.equal(result.stock.length, 40);
  assert.equal(result.stock[39].name, 'product-39');
});

test('large refresh output preserves unknown busy instead of inventing idle', () => {
  const result = JSON.parse(formatToolOutput('refresh_state', {
    t: '2026-07-26T00:00:00.000Z',
    sources: {},
    warehouse: { complete: true, allPositiveProductsIncluded: true },
    stock: [],
    buildings: [
      { id: 1, name: 'Farm', size: 1, category: 'production' },
      { id: 2, name: 'Mill', size: 1, category: 'production', busy: null },
    ],
    recipes: Array.from({ length: 100 }, () => 'x'.repeat(100)),
    retail: Array.from({ length: 100 }, () => ({ noise: 'x'.repeat(100) })),
    volume1h: { noise: 'x'.repeat(1000) },
    printedRates: { noise: 'x'.repeat(1000) },
  }, 600));
  assert.equal(result.buildings[0].busy, 'UNKNOWN');
  assert.equal(result.buildings[1].busy, null);
  assert(result._transport.omitted.includes('retail'));
  assert.equal(result._transport.omitted.includes('retail[6:]'), false);
});

test('large refresh output preserves the compact company-value KPI', () => {
  const companyValue = {
    official: { status: 'ok', total: 385783, asOf: '2026-07-30T01:08:16Z' },
    realtimeEstimate: {
      status: 'estimated',
      total: 421043,
      confidence: 'medium',
      inventory: { coveragePct: 100 },
    },
  };
  const result = JSON.parse(formatToolOutput('refresh_state', {
    t: '2026-07-30T04:00:00Z',
    sources: {},
    companyValue,
    warehouse: { complete: true, allPositiveProductsIncluded: true },
    stock: [],
    buildings: [],
    recipes: Array.from({ length: 100 }, () => 'x'.repeat(100)),
    retail: Array.from({ length: 100 }, () => ({ noise: 'x'.repeat(100) })),
  }, 900));
  assert.deepEqual(result.companyValue, companyValue);
});

test('large refresh output preserves pending PA state', () => {
  const pa = {
    status: 'pending',
    unread: 0,
    fingerprint: 'a'.repeat(64),
    offerPreview: 'Forklift Olympics',
    optionCount: 3,
  };
  const result = JSON.parse(formatToolOutput('refresh_state', {
    t: '2026-07-30T04:00:00Z',
    sources: {},
    pa,
    paUnread: 0,
    warehouse: { complete: true, allPositiveProductsIncluded: true },
    stock: [],
    buildings: [],
    recipes: Array.from({ length: 100 }, () => 'x'.repeat(100)),
    retail: Array.from({ length: 100 }, () => ({ noise: 'x'.repeat(100) })),
  }, 900));
  assert.deepEqual(result.pa, pa);
  assert.equal(result.paUnread, 0);
  assert.equal(result._transport.omitted.includes('paUnread'), false);
});

test('generic summaries disclose fields omitted after the scalar scan limit', () => {
  const large = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field${index}`, index]));
  large.padding = 'x'.repeat(1000);
  const result = JSON.parse(formatToolOutput('custom', large, 200));
  assert(result._transport.omitted.includes('field20'));
  assert(result._transport.omitted.includes('padding'));
});
