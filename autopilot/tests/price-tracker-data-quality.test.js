'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  aggregateVolumeRecords,
  appendJsonlBoundedAtomic,
  diffOrderBooks,
  downsample,
  normalizeBookState,
  normalizeNameMap,
  normalizeOrderRows,
  normalizePriceSnapshot,
  normalizeTickerRows,
  selectPriceSamples,
  suspiciousBookCollapse,
} = require('../../shared/price-tracker/data-quality.js');

function tickerRow(kind, price = kind, image = `/img/product-${kind}.png`) {
  return { kind, price, image };
}

test('ticker validation rejects partial, duplicate, and malformed authority', () => {
  assert.equal(normalizeTickerRows([
    tickerRow(1), tickerRow(2),
  ], { minimumKinds: 2, expectedKinds: [1, 2, 3] }).ok, false);

  assert.match(normalizeTickerRows([
    tickerRow(1), tickerRow(1),
  ], { minimumKinds: 2 }).reason, /duplicate/);

  assert.match(normalizeTickerRows([
    tickerRow(1), tickerRow(2, null),
  ], { minimumKinds: 2 }).reason, /invalid price/);
});

test('sold-out ticker rows remain catalog members but never become string prices', () => {
  const result = normalizeTickerRows([
    tickerRow(1, 2.5), tickerRow(2, 'sold out'),
  ], { minimumKinds: 2, expectedKinds: [1, 2] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.prices, { 1: 2.5 });
  assert.deepEqual(result.unpriced, [2]);
  assert.equal(result.catalogSize, 2);
});

test('name maps reject non-canonical duplicate-like keys and unsafe labels', () => {
  assert.equal(normalizeNameMap({ 1: 'power', '01': 'duplicate' }).ok, false);
  assert.equal(normalizeNameMap({ 1: '<img src=x>' }).ok, false);
  assert.deepEqual(normalizeNameMap({ 1: ' power ' }).names, { 1: 'power' });
});

test('order-book validation rejects duplicate ids, null coercion, and unsorted partial data', () => {
  assert.equal(normalizeOrderRows([[1, 10, 2], [1, 5, 3]]).ok, false);
  assert.equal(normalizeOrderRows([[1, null, 2]]).ok, false);
  assert.equal(normalizeOrderRows([[1, 10, 3], [2, 5, 2]]).ok, false);
  assert.equal(normalizeOrderRows(Array.from({ length: 201 }, (_, i) => [i + 1, 1, i + 1])).ok, false);
  assert.equal(normalizeOrderRows([[1, 10, 2], [2, 5, 3]]).ok, true);
});

test('book-state normalization keeps only exact authoritative snapshots', () => {
  const state = normalizeBookState({
    cursor: -1,
    t: 100,
    books: {
      1: { t: 90, full: false, top: 2, last: 3, o: { 10: [4, 2], 11: [5, 3] } },
      2: { t: 90, full: false, top: 0, last: 3, o: { 12: [4, 3] } },
    },
  });
  assert.equal(state.cursor, 0);
  assert.deepEqual(Object.keys(state.books), ['1']);
  assert.equal(suspiciousBookCollapse({ full: true, o: Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [i + 1, [1, i + 1]]),
  ) }, Array.from({ length: 50 })), true);
});

test('book diffs reject identity price changes and separate cap ambiguity', () => {
  const previous = {
    full: true,
    o: { 1: [10, 2], 2: [5, 9] },
  };
  assert.equal(diffOrderBooks(previous, [[1, 8, 3]], {
    currentFull: false,
    currentHigh: 3,
  }).ok, false);

  const result = diffOrderBooks(previous, [[1, 8, 2]], {
    currentFull: true,
    currentHigh: 8,
  });
  assert.deepEqual(result, { ok: true, units: 2, value: 4, ambiguousUnits: 5 });
});

test('price reader scans past appended old/bad rows and strips legacy sold-out strings', () => {
  const text = [
    JSON.stringify({ t: 990, p: { 1: 2, 2: 'sold out' } }),
    '{bad json',
    JSON.stringify({ t: 1, p: { 1: 1, 2: 2 } }), // Appended old row must not cause an early break.
    JSON.stringify({ t: 2000, p: { 1: 9, 2: 9 } }),
  ].join('\n');
  const result = selectPriceSamples(text, {
    cutoff: 900,
    now: 1000,
    expectedKinds: [1, 2],
  });
  assert.equal(result.invalidLines, 1);
  assert.deepEqual(result.samples, [{ t: 990, p: { 1: 2 }, unpriced: [2], catalogSize: 2 }]);
});

test('price reader deduplicates timestamps and rejects partial catalog rows', () => {
  const text = [
    JSON.stringify({ t: 990, p: { 1: 1, 2: 2 } }),
    JSON.stringify({ t: 990, p: { 1: 3, 2: 4 } }),
    JSON.stringify({ t: 995, p: { 1: 5 } }),
  ].join('\n');
  const result = selectPriceSamples(text, {
    cutoff: 900,
    now: 1000,
    expectedKinds: [1, 2],
  });
  assert.equal(result.duplicateTimestamps, 1);
  assert.equal(result.invalidLines, 1);
  assert.deepEqual(result.samples.map(row => row.p), [{ 1: 3, 2: 4 }]);
});

test('volume reader rejects strings, ignores duplicate intervals, and prorates per-kind spans', () => {
  const valid = {
    t0: 800,
    t1: 1000,
    t0ByKind: { 1: 900, 2: 800 },
    u: { 1: 10, 2: 10 },
    v: { 1: 20, 2: 40 },
    amb: { 2: 4 },
    kinds: 2,
    fail: [],
  };
  const invalidString = { ...valid, t0: 810, t1: 1010, u: { 1: '10' } };
  const oldAppended = { t0: 1, t1: 2, u: { 1: 1 }, v: { 1: 2 }, amb: {}, kinds: 1, fail: [] };
  const text = [valid, valid, invalidString, oldAppended].map(JSON.stringify).join('\n');
  const result = aggregateVolumeRecords(text, { cutoff: 950, now: 1000 });
  assert.equal(result.invalidLines, 1);
  assert.equal(result.duplicateIntervals, 1);
  assert.equal(result.intervals, 1);
  assert.deepEqual(result.u, { 1: 5, 2: 2.5 });
  assert.deepEqual(result.v, { 1: 10, 2: 10 });
  assert.deepEqual(result.amb, { 2: 1 });
});

test('downsample never exceeds its cap and preserves both endpoints', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ t: i }));
  const sampled = downsample(rows, 200);
  assert.equal(sampled.length, 200);
  assert.equal(sampled[0], rows[0]);
  assert.equal(sampled.at(-1), rows.at(-1));
});

test('bounded JSONL rewrite is atomic, bounded, ordered, and cleans bad history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-tracker-quality-'));
  const file = path.join(directory, 'prices.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ t: 2, p: { 1: 2 } }),
    '{bad json',
    JSON.stringify({ t: 1, p: { 1: 1 } }),
  ].join('\n') + '\n');

  const result = appendJsonlBoundedAtomic(file, { t: 3, p: { 1: 3 } }, {
    keep: 2,
    normalize: normalizePriceSnapshot,
    timestamp: row => row.t,
  });
  assert.equal(result.droppedInvalid, 1);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).map(row => row.t), [2, 3]);
  assert.deepEqual(fs.readdirSync(directory), ['prices.jsonl']);

  assert.throws(() => appendJsonlBoundedAtomic(file, { t: 2, p: { 1: 4 } }, {
    keep: 2,
    normalize: normalizePriceSnapshot,
    timestamp: row => row.t,
  }), /non-monotonic/);
});
