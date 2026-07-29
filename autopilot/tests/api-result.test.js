'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatApiResponse, selectJsonPointer } = require('../api-result.js');

test('selects JSON Pointer values', () => {
  assert.deepEqual(selectJsonPointer({ a: { 'b/c': 7 } }, '/a/b~1c'), { ok: true, value: 7 });
  assert.equal(selectJsonPointer({ a: 1 }, '/missing').ok, false);
  assert.equal(selectJsonPointer({ '~2': 1 }, '/~2').ok, false);
});

test('paginates arrays with explicit truncation metadata', () => {
  const result = formatApiResponse({
    ok: true,
    path: '/api/test/',
    status: 200,
    fetchedAt: '2026-07-25T00:00:00.000Z',
    data: Array.from({ length: 20 }, (_, id) => ({ id })),
  }, { offset: 5, limit: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.totalItems, 20);
  assert.equal(result.returnedItems, 3);
  assert.deepEqual(result.data.map(row => row.id), [5, 6, 7]);
});

test('never silently clips an oversized object', () => {
  const result = formatApiResponse({
    ok: true,
    path: '/api/test/',
    status: 200,
    fetchedAt: '2026-07-25T00:00:00.000Z',
    data: { rows: Array.from({ length: 100 }, (_, id) => ({ id, text: 'x'.repeat(100) })) },
  }, {}, 500);
  assert.equal(result.truncated, true);
  assert.equal(result.data, null);
  assert(result.objectSummary.keys.includes('rows'));
});

test('reports a missing selected value instead of silently returning an empty success', () => {
  const result = formatApiResponse({
    ok: true,
    path: '/api/test/',
    status: 204,
    data: undefined,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /undefined/);
});

test('bounds object-summary key and scalar scans', () => {
  const data = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`key${index}`, 'x'.repeat(500)]));
  const result = formatApiResponse({ ok: true, path: '/api/test/', status: 200, data }, {}, 500);
  assert.equal(result.objectSummary.totalKeys, 200);
  assert.equal(result.objectSummary.keys.length, 80);
  assert.equal(Object.keys(result.objectSummary.scalars).length, 20);
});
