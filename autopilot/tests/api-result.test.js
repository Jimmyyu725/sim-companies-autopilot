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

// Regression (2026-08-01): a failed pointer must describe the container it was applied to. The
// model probed `/data` on the achievements endpoint (a root ARRAY) on consecutive wakes and
// `/data/4` on buildings, because "pointer segment not found" alone taught it nothing.
test('failed pointer reports the container shape so one wrong guess is enough', () => {
  const arrayRoot = formatApiResponse({
    ok: true, path: '/api/v2/companies/me/achievements/', status: 200,
    fetchedAt: 't', data: [{ name: 'Prospector', stars: 1 }, { name: 'Tycoon', stars: 0 }],
  }, { pointer: '/data' });
  assert.equal(arrayRoot.ok, false);
  assert.equal(arrayRoot.shapeHint.containerType, 'array');
  assert.equal(arrayRoot.shapeHint.length, 2);
  assert.match(arrayRoot.shapeHint.hint, /ARRAY/);

  const objectRoot = formatApiResponse({
    ok: true, path: '/api/test/', status: 200, fetchedAt: 't',
    data: { alpha: 1, beta: { nested: true } },
  }, { pointer: '/data/4' });
  assert.equal(objectRoot.ok, false);
  assert.deepEqual(objectRoot.shapeHint.keys, ['alpha', 'beta']);
  assert.equal(objectRoot.shapeHint.containerType, 'object');

  // A pointer that fails one level deep describes THAT level, not the root.
  const nested = formatApiResponse({
    ok: true, path: '/api/test/', status: 200, fetchedAt: 't',
    data: { rows: [{ id: 1 }] },
  }, { pointer: '/rows/data' });
  assert.equal(nested.shapeHint.containerType, 'array');
  assert.equal(nested.shapeHint.length, 1);

  // A successful pointer is unchanged.
  const success = formatApiResponse({
    ok: true, path: '/api/test/', status: 200, fetchedAt: 't',
    data: [{ id: 7 }],
  }, { pointer: '/0/id' });
  assert.equal(success.ok, true);
  assert.equal(success.data, 7);
});
