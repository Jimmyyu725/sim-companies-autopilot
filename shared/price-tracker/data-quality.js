'use strict';

// Pure validation and crash-safe persistence helpers for price-tracker telemetry. Collector
// payloads are supporting evidence for the autopilot, so malformed or partial data must be
// discarded rather than coerced into zeroes, strings, or authoritative snapshots.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOLD_OUT = 'sold out';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalKind(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function positiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeNameMap(value, { minimumKinds = 1 } = {}) {
  if (!isPlainObject(value)) return { ok: false, reason: 'names must be an object' };
  const names = {};
  for (const [kindText, name] of Object.entries(value)) {
    const kind = canonicalKind(kindText);
    if (kind == null || String(kind) !== kindText) {
      return { ok: false, reason: `non-canonical kind key in names: ${kindText}` };
    }
    if (typeof name !== 'string' || !name.trim() || /[\u0000-\u001f\u007f<>&"'`]/.test(name)) {
      return { ok: false, reason: `invalid name for kind ${kind}` };
    }
    names[kind] = name.trim();
  }
  if (Object.keys(names).length < minimumKinds) {
    return { ok: false, reason: `names contains fewer than ${minimumKinds} kinds` };
  }
  return { ok: true, names };
}

function tickerName(image) {
  if (typeof image !== 'string' || !image.trim()) return null;
  const clean = image.split(/[?#]/, 1)[0];
  const base = clean.split('/').pop().replace(/\.png$/i, '').trim();
  const name = base.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return name && !/[\u0000-\u001f\u007f<>&"'`]/.test(name) ? name : null;
}

function normalizeTickerRows(rows, { expectedKinds = [], minimumKinds = 100 } = {}) {
  if (!Array.isArray(rows)) return { ok: false, reason: 'ticker must be an array' };
  const prices = {};
  const names = {};
  const unpriced = [];
  const seen = new Set();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!isPlainObject(row)) return { ok: false, reason: `ticker row ${index} is not an object` };
    const kind = canonicalKind(row.kind);
    if (kind == null) return { ok: false, reason: `ticker row ${index} has an invalid kind` };
    if (seen.has(kind)) return { ok: false, reason: `ticker contains duplicate kind ${kind}` };
    seen.add(kind);

    const name = tickerName(row.image);
    if (!name) return { ok: false, reason: `ticker kind ${kind} has an invalid image/name` };
    names[kind] = name;

    const price = positiveFiniteNumber(row.price);
    if (price != null) prices[kind] = price;
    else if (typeof row.price === 'string' && row.price.trim().toLowerCase() === SOLD_OUT) {
      unpriced.push(kind);
    } else {
      return { ok: false, reason: `ticker kind ${kind} has an invalid price` };
    }
  }

  if (seen.size < minimumKinds) {
    return { ok: false, reason: `ticker contains only ${seen.size} kinds; minimum is ${minimumKinds}` };
  }
  const expected = new Set();
  for (const value of expectedKinds || []) {
    const kind = canonicalKind(value);
    if (kind == null) return { ok: false, reason: 'expectedKinds contains an invalid kind' };
    expected.add(kind);
  }
  const missingExpected = [...expected].filter(kind => !seen.has(kind));
  if (missingExpected.length) {
    return {
      ok: false,
      reason: `ticker is missing ${missingExpected.length} previously known kinds`,
      missingExpected,
    };
  }
  if (!Object.keys(prices).length) return { ok: false, reason: 'ticker has no numeric prices' };

  return {
    ok: true,
    prices,
    names,
    unpriced: unpriced.sort((a, b) => a - b),
    catalogSize: seen.size,
  };
}

function normalizePriceSnapshot(record, { expectedKinds = [] } = {}) {
  if (!isPlainObject(record) || !Number.isSafeInteger(record.t) || record.t <= 0 ||
      !isPlainObject(record.p)) return null;
  const p = {};
  const seen = new Set();
  const unpriced = new Set();
  for (const [kindText, rawPrice] of Object.entries(record.p)) {
    const kind = canonicalKind(kindText);
    if (kind == null || String(kind) !== kindText || seen.has(kind)) return null;
    seen.add(kind);
    const price = positiveFiniteNumber(rawPrice);
    if (price != null) p[kind] = price;
    else if (typeof rawPrice === 'string' && rawPrice.trim().toLowerCase() === SOLD_OUT) {
      unpriced.add(kind); // Legacy collector representation; never expose it as a price.
    } else return null;
  }
  if (record.unpriced != null) {
    if (!Array.isArray(record.unpriced)) return null;
    for (const value of record.unpriced) {
      const kind = canonicalKind(value);
      if (kind == null || seen.has(kind) || unpriced.has(kind)) return null;
      seen.add(kind);
      unpriced.add(kind);
    }
  }
  if (!Object.keys(p).length) return null;
  if (record.catalogSize != null &&
      (!Number.isSafeInteger(record.catalogSize) || record.catalogSize !== seen.size)) return null;

  const expected = new Set();
  for (const value of expectedKinds || []) {
    const kind = canonicalKind(value);
    if (kind == null) return null;
    expected.add(kind);
  }
  if ([...expected].some(kind => !seen.has(kind))) return null;
  return {
    t: record.t,
    p,
    unpriced: [...unpriced].sort((a, b) => a - b),
    catalogSize: seen.size,
  };
}

function normalizeOrderRows(rows, { cap = 200 } = {}) {
  if (!Array.isArray(rows) || rows.length > cap) {
    return { ok: false, reason: 'order book is not an array or exceeds its row cap' };
  }
  const seen = new Set();
  const normalized = [];
  let previousPrice = -Infinity;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!Array.isArray(row) || row.length < 3) {
      return { ok: false, reason: `order row ${index} is malformed` };
    }
    const id = canonicalKind(row[0]);
    const quantity = positiveFiniteNumber(row[1]);
    const price = positiveFiniteNumber(row[2]);
    if (id == null || quantity == null || price == null) {
      return { ok: false, reason: `order row ${index} has invalid id, quantity, or price` };
    }
    if (seen.has(id)) return { ok: false, reason: `order book contains duplicate id ${id}` };
    if (price < previousPrice) return { ok: false, reason: 'order book is not price-ascending' };
    seen.add(id);
    previousPrice = price;
    normalized.push([id, quantity, price]);
  }
  return {
    ok: true,
    rows: normalized,
    full: normalized.length === cap,
    low: normalized.length ? normalized[0][2] : null,
    high: normalized.length ? normalized[normalized.length - 1][2] : null,
  };
}

function normalizeBookSnapshot(value, { cap = 200 } = {}) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.t) || value.t <= 0 ||
      typeof value.full !== 'boolean' || !isPlainObject(value.o)) return null;
  const orders = {};
  let low = Infinity;
  let high = -Infinity;
  for (const [idText, pair] of Object.entries(value.o)) {
    const id = canonicalKind(idText);
    if (id == null || String(id) !== idText || !Array.isArray(pair) || pair.length !== 2) return null;
    const quantity = positiveFiniteNumber(pair[0]);
    const price = positiveFiniteNumber(pair[1]);
    if (quantity == null || price == null) return null;
    orders[id] = [quantity, price];
    low = Math.min(low, price);
    high = Math.max(high, price);
  }
  const count = Object.keys(orders).length;
  if (count > cap || value.full !== (count === cap)) return null;
  const expectedLow = count ? low : null;
  const expectedHigh = count ? high : null;
  if (value.top !== expectedLow || value.last !== expectedHigh) return null;
  return { t: value.t, full: value.full, top: expectedLow, last: expectedHigh, o: orders };
}

function normalizeBookState(value, { cap = 200 } = {}) {
  const state = isPlainObject(value) ? value : {};
  const books = {};
  if (isPlainObject(state.books)) {
    for (const [kindText, snapshot] of Object.entries(state.books)) {
      const kind = canonicalKind(kindText);
      if (kind == null || String(kind) !== kindText) continue;
      const normalized = normalizeBookSnapshot(snapshot, { cap });
      if (normalized) books[kind] = normalized;
    }
  }
  return {
    t: Number.isSafeInteger(state.t) && state.t > 0 ? state.t : null,
    cursor: Number.isSafeInteger(state.cursor) && state.cursor >= 0 ? state.cursor : 0,
    books,
  };
}

function suspiciousBookCollapse(previous, currentRows, { cap = 200 } = {}) {
  const previousCount = Object.keys(previous?.o || {}).length;
  return previous?.full === true && previousCount === cap && currentRows.length < Math.floor(cap / 2);
}

function diffOrderBooks(previous, current, { currentFull, currentHigh } = {}) {
  const curr = new Map(current.map(row => [String(row[0]), row]));
  let units = 0;
  let value = 0;
  let ambiguousUnits = 0;
  for (const [id, pair] of Object.entries(previous.o)) {
    const [previousQuantity, previousPrice] = pair;
    const row = curr.get(id);
    if (row) {
      if (row[2] !== previousPrice) {
        return { ok: false, reason: `persisting order ${id} changed price` };
      }
      const delta = previousQuantity - row[1];
      if (delta > 0) {
        units += delta;
        value += delta * previousPrice;
      }
    } else if (previous.full && currentFull && currentHigh != null && previousPrice >= currentHigh) {
      ambiguousUnits += previousQuantity;
    } else {
      units += previousQuantity;
      value += previousQuantity * previousPrice;
    }
  }
  return { ok: true, units, value, ambiguousUnits };
}

function normalizeNumericMap(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [kindText, raw] of Object.entries(value)) {
    const kind = canonicalKind(kindText);
    const number = nonNegativeFiniteNumber(raw);
    if (kind == null || String(kind) !== kindText || number == null) return null;
    if (number > 0) out[kind] = number;
  }
  return out;
}

function normalizeVolumeRecord(record) {
  if (!isPlainObject(record) || !Number.isSafeInteger(record.t0) || !Number.isSafeInteger(record.t1) ||
      record.t0 <= 0 || record.t1 <= record.t0) return null;
  const u = normalizeNumericMap(record.u);
  const v = normalizeNumericMap(record.v);
  const amb = normalizeNumericMap(record.amb);
  if (!u || !v || !amb) return null;
  const unitKinds = Object.keys(u).sort();
  const valueKinds = Object.keys(v).sort();
  if (unitKinds.length !== valueKinds.length || unitKinds.some((kind, i) => kind !== valueKinds[i])) return null;

  const t0ByKind = {};
  if (record.t0ByKind != null) {
    if (!isPlainObject(record.t0ByKind)) return null;
    for (const [kindText, raw] of Object.entries(record.t0ByKind)) {
      const kind = canonicalKind(kindText);
      if (kind == null || String(kind) !== kindText || !Number.isSafeInteger(raw) ||
          raw < record.t0 || raw >= record.t1) return null;
      t0ByKind[kind] = raw;
    }
    const measuredKinds = new Set([...Object.keys(u), ...Object.keys(amb)]);
    if ([...measuredKinds].some(kind => !Object.prototype.hasOwnProperty.call(t0ByKind, kind))) return null;
  }
  const fail = [];
  if (record.fail != null) {
    if (!Array.isArray(record.fail)) return null;
    const seen = new Set();
    for (const value of record.fail) {
      const kind = canonicalKind(value);
      if (kind == null || seen.has(kind)) return null;
      seen.add(kind);
      fail.push(kind);
    }
  }
  const kinds = Number.isSafeInteger(record.kinds) && record.kinds >= 0 ? record.kinds : null;
  if (kinds == null) return null;
  return { t0: record.t0, t1: record.t1, t0ByKind, u, v, amb, kinds, fail };
}

function parseJsonLines(text, normalize) {
  const records = [];
  let invalidLines = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); } catch (_) { invalidLines++; continue; }
    const record = normalize(raw);
    if (!record) invalidLines++;
    else records.push(record);
  }
  return { records, invalidLines };
}

function selectPriceSamples(text, {
  cutoff,
  now,
  expectedKinds = [],
  maxFutureSkewSeconds = 30,
} = {}) {
  const parsed = parseJsonLines(text, row => normalizePriceSnapshot(row, { expectedKinds }));
  const byTimestamp = new Map();
  let duplicateTimestamps = 0;
  for (const row of parsed.records) {
    if (row.t < cutoff || row.t > now + maxFutureSkewSeconds) continue;
    if (byTimestamp.has(row.t)) duplicateTimestamps++;
    byTimestamp.set(row.t, row);
  }
  return {
    samples: [...byTimestamp.values()].sort((a, b) => a.t - b.t),
    invalidLines: parsed.invalidLines,
    duplicateTimestamps,
  };
}

function overlapShare(start, end, cutoff, now) {
  const overlap = Math.max(0, Math.min(end, now) - Math.max(start, cutoff));
  return overlap > 0 ? overlap / (end - start) : 0;
}

function aggregateVolumeRecords(text, { cutoff, now, maxFutureSkewSeconds = 30 } = {}) {
  const parsed = parseJsonLines(text, normalizeVolumeRecord);
  const out = { u: {}, v: {}, amb: {}, intervals: 0, prorated: true };
  const seenIntervals = new Set();
  let duplicateIntervals = 0;
  for (const row of parsed.records) {
    if (row.t1 > now + maxFutureSkewSeconds || row.t1 <= cutoff || row.t0 >= now) continue;
    const intervalKey = `${row.t0}:${row.t1}`;
    if (seenIntervals.has(intervalKey)) { duplicateIntervals++; continue; }
    seenIntervals.add(intervalKey);
    out.intervals++;
    for (const field of ['u', 'v', 'amb']) {
      for (const [kind, value] of Object.entries(row[field])) {
        const start = row.t0ByKind[kind] ?? row.t0;
        const share = overlapShare(start, row.t1, cutoff, now);
        if (share <= 0) continue;
        out[field][kind] = (out[field][kind] || 0) + value * share;
      }
    }
  }
  for (const field of ['u', 'v', 'amb']) {
    for (const [kind, value] of Object.entries(out[field])) {
      out[field][kind] = Math.round(value * 100) / 100;
    }
  }
  return { ...out, invalidLines: parsed.invalidLines, duplicateIntervals };
}

function downsample(rows, maxPoints) {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 2) throw new Error('maxPoints must be at least 2');
  if (rows.length <= maxPoints) return rows;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(rows[Math.round(i * (rows.length - 1) / (maxPoints - 1))]);
  }
  return out;
}

function atomicWriteFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o644);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    // Persist the directory entry as well as file contents so a power loss cannot resurrect the
    // previous name after a successful return on Linux.
    let directoryDescriptor = null;
    try {
      directoryDescriptor = fs.openSync(path.dirname(file), 'r');
      fs.fsyncSync(directoryDescriptor);
    } finally {
      if (directoryDescriptor != null) fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function atomicWriteJson(file, value) {
  atomicWriteFile(file, JSON.stringify(value));
}

function appendJsonlBoundedAtomic(file, record, {
  keep,
  normalize,
  timestamp,
} = {}) {
  if (!Number.isSafeInteger(keep) || keep <= 0 || typeof normalize !== 'function' ||
      typeof timestamp !== 'function') throw new Error('invalid bounded JSONL options');
  const normalizedNew = normalize(record);
  if (!normalizedNew) throw new Error('refusing to persist an invalid JSONL record');
  let existingText = '';
  try { existingText = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parsed = parseJsonLines(existingText, normalize);
  const byTimestamp = new Map();
  let duplicateTimestamps = 0;
  for (const existing of parsed.records) {
    const key = timestamp(existing);
    if (!Number.isFinite(key)) continue;
    if (byTimestamp.has(key)) duplicateTimestamps++;
    byTimestamp.set(key, existing);
  }
  const ordered = [...byTimestamp.values()].sort((left, right) => timestamp(left) - timestamp(right));
  const last = ordered.at(-1);
  if (last && timestamp(normalizedNew) <= timestamp(last)) {
    throw new Error('refusing to append a non-monotonic JSONL record');
  }
  const records = ordered.concat(normalizedNew).slice(-keep);
  atomicWriteFile(file, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  return { kept: records.length, droppedInvalid: parsed.invalidLines, droppedDuplicates: duplicateTimestamps };
}

module.exports = {
  SOLD_OUT,
  aggregateVolumeRecords,
  appendJsonlBoundedAtomic,
  atomicWriteFile,
  atomicWriteJson,
  canonicalKind,
  diffOrderBooks,
  downsample,
  normalizeBookSnapshot,
  normalizeBookState,
  normalizeNameMap,
  normalizeOrderRows,
  normalizePriceSnapshot,
  normalizeTickerRows,
  normalizeVolumeRecord,
  selectPriceSamples,
  suspiciousBookCollapse,
};
