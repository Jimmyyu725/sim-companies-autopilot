'use strict';

const DEFAULT_MARKET_KINDS = Object.freeze([1, 2, 66, 118, 119]);

function normalizeMarketKinds(input) {
  const values = Array.isArray(input) && input.length ? input : DEFAULT_MARKET_KINDS;
  return [...new Set(values.map(Number).filter(value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000))].slice(0, 5);
}

function finiteField(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function signedAgeSeconds(value, nowMs = Date.now()) {
  const asOfMs = Date.parse(value);
  return Number.isFinite(asOfMs) ? Math.round((nowMs - asOfMs) / 1000) : null;
}

function freshOkSource(source, nowMs, maxAgeSeconds = 180) {
  if (!source || source.status !== 'ok') return false;
  const age = signedAgeSeconds(source.asOf, nowMs);
  return age !== null && age >= -30 && age <= maxAgeSeconds;
}

function summarizeStateAuthority(state, nowMs = Date.now()) {
  const stateAgeSeconds = signedAgeSeconds(state?.t, nowMs);
  const timestampFresh = stateAgeSeconds !== null && stateAgeSeconds >= -30 && stateAgeSeconds <= 180;
  const coreSourcesFresh = ['auth', 'buildings', 'stock']
    .every(key => freshOkSource(state?.sources?.[key], nowMs));
  const warehouseComplete = state?.warehouse?.complete === true
    && state?.warehouse?.allPositiveProductsIncluded === true;
  return {
    stateAgeSeconds,
    stateFreshness: timestampFresh && coreSourcesFresh && warehouseComplete ? 'FRESH' : 'STALE',
    coreSourcesFresh,
    warehouseComplete,
  };
}

function compactStatement(source, result) {
  if (!result || result.status !== 200 || !result.json || typeof result.json !== 'object') {
    return { source, status: result?.status ?? 'UNKNOWN', value: 'UNKNOWN' };
  }
  if (Array.isArray(result.json)) {
    const value = result.json.slice(-20).map(row => Object.fromEntries(
      Object.entries(row || {}).filter(([, entry]) =>
        entry == null || ['string', 'number', 'boolean'].includes(typeof entry)),
    ));
    return { source, status: 200, asOf: value.at(-1)?.date || null, value };
  }
  const value = {};
  for (const [key, entry] of Object.entries(result.json)) {
    if (entry == null || ['string', 'number', 'boolean'].includes(typeof entry)) value[key] = entry;
  }
  return { source, status: 200, asOf: result.json.date || null, value };
}

function summarizeBondOfferForm(raw = {}) {
  const amount = finiteField(raw.offerAmountField);
  const interest = finiteField(raw.offerInterestField);
  return {
    source: raw.source || 'UNKNOWN',
    status: raw.status ?? 'UNKNOWN',
    // Absent below company level 10. When it is absent the offer fields below are legitimately
    // UNKNOWN, and that is not an evidence gap — there is no offer to read.
    offerFormAvailable: raw.offerFormAvailable === true,
    rating: raw.rating || 'UNKNOWN',
    unsoldOfferAmountDollars: Number.isFinite(amount) && amount >= 0 ? amount : 'UNKNOWN',
    offerInterestPctPerDay: Number.isFinite(interest) && interest > 0 ? interest : 'UNKNOWN',
    representsOutstandingDebt: false,
    outstandingPrincipalSource: 'state.bonds.principalOutstanding',
    note: 'This form adjusts the current unsold bond offer. A zero offer amount does not mean zero outstanding debt and cannot conflict with sold bonds or bondsPayable.',
  };
}

function summarizeBookRows(kind, rows, asOf, source, status = 200) {
  if (!Array.isArray(rows)) return { kind, source, status, value: 'UNKNOWN' };
  const normalized = rows.map(row => Array.isArray(row)
    ? (row.length >= 3
      ? { quantity: Number(row[1]), price: Number(row[2]) }
      : { quantity: Number(row[0]), price: Number(row[1]) })
    : { quantity: Number(row.quantity), price: Number(row.price) })
    .filter(row => Number.isSafeInteger(row.quantity) && row.quantity > 0
      && Number.isFinite(row.price) && row.price > 0);
  normalized.sort((a, b) => a.price - b.price);
  const invalidRows = rows.length - normalized.length;
  return {
    kind,
    source,
    status: rows.length > 0 && normalized.length === 0 ? 'INVALID' : status,
    asOf,
    inputRows: rows.length,
    invalidRows,
    visibleRows: normalized.length,
    bestAsk: normalized[0]?.price ?? null,
    top5Quantity: normalized.slice(0, 5).reduce((sum, row) => sum + row.quantity, 0),
    top20Quantity: normalized.slice(0, 20).reduce((sum, row) => sum + row.quantity, 0),
    visibleQuantity: normalized.reduce((sum, row) => sum + row.quantity, 0),
  };
}

function summarizeCachedBook(kind, cached, nowMs = Date.now()) {
  if (!cached || !cached.o || typeof cached.o !== 'object' || Array.isArray(cached.o)) {
    return { kind, source: `price-tracker:/api/v3/market/0/${kind}/`, status: 'UNKNOWN', value: 'UNKNOWN' };
  }
  const rows = Object.values(cached.o).map(row => Array.isArray(row)
    ? { quantity: row[0], price: row[1] }
    : { quantity: NaN, price: NaN });
  const asOfMs = Number(cached.t) * 1000;
  const asOfDate = Number.isFinite(asOfMs) ? new Date(asOfMs) : null;
  const asOf = asOfDate && Number.isFinite(asOfDate.getTime()) ? asOfDate.toISOString() : null;
  const summary = summarizeBookRows(kind, rows, asOf,
    `price-tracker:/api/v3/market/0/${kind}/`, 200);
  summary.ageSeconds = asOf ? Math.round((nowMs - asOfMs) / 1000) : null;
  summary.freshness = summary.status === 200 && summary.ageSeconds != null
    && summary.ageSeconds >= -30 && summary.ageSeconds <= 600 ? 'FRESH' : 'STALE';
  summary.bookCapped = Boolean(cached.full);
  return summary;
}

module.exports = {
  DEFAULT_MARKET_KINDS,
  compactStatement,
  freshOkSource,
  normalizeMarketKinds,
  signedAgeSeconds,
  summarizeBondOfferForm,
  summarizeBookRows,
  summarizeCachedBook,
  summarizeStateAuthority,
};
