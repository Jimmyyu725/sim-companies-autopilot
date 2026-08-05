#!/usr/bin/env node
'use strict';

// Read-only exchange-sale inspector. It requires a fresh deterministic surplus plan before it
// touches Chrome, fetches one live sell book, and fills the game's exchange form without ever
// passing --submit to the UI driver. Run under the shared browser lock:
//   flock -w 90 .tick.lock node autopilot/inspect-exchange-sale.js '{"kind":1,"qty":null}'

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const cdp = require(path.join(__dirname, '..', 'shared', 'cdp.js'));
const {
  DEFAULT_EXCHANGE_FEE_RATE,
  buildSaleQuote,
  parseInspectExchangeArgs,
  resourceSlug,
  summarizeBook,
  summarizeCachedBook,
  summarizeUiDryRun,
  validateSurplusPlan,
} = require('./exchange-sale-helpers.js');
const { calculateCoffeeReservePolicy } = require('./coffee-reserve-policy.js');
const { readInspectionRateCache } = require('./inspection-rate-cache.js');
const { writeInspectionArtifact } = require('./exchange-sale-inspection-store.js');

const SIM = path.dirname(__dirname);
const SHARED = path.join(SIM, 'shared');
const STATE_FILE = path.join(__dirname, '.state.json');
const DEFS_FILE = path.join(SHARED, 'facts', 'defs.json');
const FACTS_FILE = path.join(SHARED, 'facts', 'game-facts.json');
const NAMES_FILE = path.join(SHARED, 'price-tracker', 'data', 'names.json');
const BOOK_CACHE_FILE = path.join(SHARED, 'price-tracker', 'data', 'book-state.json');
const UI_DRIVER = path.join(__dirname, 'actions', 'sell-exchange-ui.js');
const INSPECTION_CACHE_FILE = path.join(__dirname, '.exchange-sale-inspections.json');
const RATE_CACHE_FILE = path.join(__dirname, '.inspection-rates.json');
const INSPECTION_VALIDITY_MS = 5 * 60e3;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function buildReserveAuthorization({
  state,
  kind,
  currentPolicy,
  facts,
  inspectionCache,
  nowMs,
  validityMs = INSPECTION_VALIDITY_MS,
} = {}) {
  const blocked = (reason, details = {}) => ({ ok: false, failClosed: true, ...details, reason });
  const numericKind = Number(kind);
  const currentReserve = Number(currentPolicy?.reserve);
  const currentSellable = Number(currentPolicy?.sellable);
  const stock = Number(currentPolicy?.stock?.amount);
  const horizonHours = Number(state?.surplusPlan?.horizonHours);
  const bufferPct = Number(state?.surplusPlan?.bufferPct);
  const startMs = Number(nowMs);
  const durationMs = Number(validityMs);
  if (currentPolicy?.ok !== true || !Number.isSafeInteger(numericKind) || numericKind <= 0 ||
      !Number.isFinite(currentReserve) || currentReserve < 0 ||
      !Number.isFinite(currentSellable) || currentSellable < 0 ||
      !Number.isFinite(stock) || stock < 0 || !Number.isFinite(startMs) ||
      !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > INSPECTION_VALIDITY_MS) {
    return blocked('current reserve authorization inputs are incomplete or invalid');
  }
  if (Math.abs(horizonHours - 24) > 1e-9 || Math.abs(bufferPct - 0.10) > 1e-9) {
    return blocked('exchange sales require the verified 24-hour Coffee reserve plus 10% buffer');
  }

  const expiresMs = startMs + durationMs;
  const projectionAt = projectionMs => calculateCoffeeReservePolicy({
    state,
    inspectionCache,
    facts,
    horizonHours,
    bufferPct,
    nowMs: projectionMs,
  });
  const atInspection = projectionAt(startMs);
  const atExpiry = projectionAt(expiresMs);
  const itemAt = (projection, label) => {
    const item = projection?.items?.[String(numericKind)] || projection?.items?.[numericKind] || null;
    const reserve = Number(item?.reserve);
  // Not the whole-plan flag. PR #67 removed it from the journal gate and the sale path after four
  // units of unpriceable construction leftovers withheld a fully priced 67,293-unit water surplus;
  // this is the same veto, one layer down, and it kept the sale blocked anyway. The per-item check
  // below already fails closed, and calculateCoffeeReservePolicy marks every item unknown on each of
  // its early-bail paths, so nothing the flag caught goes uncaught.
    if (item?.status !== 'ok' || !Number.isFinite(reserve) || reserve < 0) {
      const requiredBuildingIds = Array.isArray(projection?.millCapacity?.missingBuildingIds)
        ? [...new Set(projection.millCapacity.missingBuildingIds
          .map(Number)
          .filter(buildingId => Number.isSafeInteger(buildingId) && buildingId > 0))]
          .sort((left, right) => left - right)
        : [];
      return { ok: false, reason: `${label} reserve projection is incomplete`, requiredBuildingIds };
    }
    return { ok: true, reserve };
  };
  // Both RESERVE_RATE_EVIDENCE_* codes tell the caller to go and inspect the named Mills. When the
  // projection is incomplete for a reason that names no Mill, that instruction cannot be carried
  // out, and noteUtilityInspection has no classification for it either — it lands on 'failed', which
  // is terminal, so the wake retried the same refusal until it ran out of rounds on 2026-08-05
  // 04:04Z. A distinct code lets the caller record it as a hold instead of chasing a building that
  // was never missing.
  const rateFailureCode = (item, whenNamed) =>
    (item.requiredBuildingIds?.length ? whenNamed : 'RESERVE_RATE_EVIDENCE_UNNAMEABLE');
  const inspectionItem = itemAt(atInspection, 'inspection-time');
  if (!inspectionItem.ok) return blocked(inspectionItem.reason, {
    failureCode: rateFailureCode(inspectionItem, 'RESERVE_RATE_EVIDENCE_INCOMPLETE'),
    requiredBuildingIds: inspectionItem.requiredBuildingIds,
  });
  const expiryItem = itemAt(atExpiry, 'expiry-time');
  if (!expiryItem.ok) return blocked(expiryItem.reason, {
    failureCode: rateFailureCode(expiryItem, 'RESERVE_RATE_EVIDENCE_EXPIRES'),
    requiredBuildingIds: expiryItem.requiredBuildingIds,
  });

  // With no future Coffee Powder modifier start allowed by the policy, the moving-horizon
  // projection is constant or linear between these endpoints. Their maximum therefore covers
  // every possible confirmation instant, including a slowdown expiring during the interval.
  const reserve = Math.max(currentReserve, inspectionItem.reserve, expiryItem.reserve);
  const sellable = Math.max(0, Math.floor(Math.min(currentSellable, stock - reserve)));
  const reserveValidUntil = new Date(expiresMs).toISOString();
  return {
    ok: true,
    reserve,
    sellable,
    reserveValidUntil,
    policy: {
      ...currentPolicy,
      reserve,
      sellable,
      reserveValidUntil,
      reserveProjection: {
        method: 'maximum over plan capture, inspection time, and artifact expiry',
        planCapture: currentReserve,
        atInspection: inspectionItem.reserve,
        atExpiry: expiryItem.reserve,
      },
    },
  };
}

function inspectionArtifact(result) {
  const inspectedMs = Date.parse(result.inspectedAt);
  const reserveValidUntilMs = Date.parse(result.policy?.reserveValidUntil);
  const expiresMs = Number.isFinite(reserveValidUntilMs)
    ? reserveValidUntilMs
    : (Number.isFinite(inspectedMs) ? inspectedMs + INSPECTION_VALIDITY_MS : null);
  const reserve = result.quote?.reserve ?? result.policy?.reserve ?? null;
  const reserveProjection = result.policy?.reserveProjection ?? null;
  const projectionValues = [
    reserveProjection?.planCapture,
    reserveProjection?.atInspection,
    reserveProjection?.atExpiry,
  ];
  const authorizationComplete = reserve != null && Number.isFinite(Number(reserve)) && Number(reserve) >= 0 &&
    projectionValues.every(value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0) &&
    Number(reserve) === Math.max(...projectionValues.map(Number)) && Number.isFinite(inspectedMs) &&
    Number.isFinite(expiresMs) && expiresMs > inspectedMs && expiresMs - inspectedMs <= INSPECTION_VALIDITY_MS;
  return {
    schemaVersion: 4,
    inspectionId: result.inspectionId || randomUUID(),
    ok: result.ok === true && result.uiQuote?.ok === true && authorizationComplete,
    readOnly: true,
    submitted: false,
    inspectedAt: result.inspectedAt || new Date().toISOString(),
    expiresAt: Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null,
    kind: result.request?.kind ?? null,
    name: result.resource?.name ?? null,
    imageSlug: result.resource?.imageSlug ?? null,
    requestedQty: result.request?.qty ?? null,
    effectiveQty: result.quote?.quantity ?? null,
    maxSafeQty: result.quote?.maxSafeQty ?? null,
    stateAsOf: result.policy?.stateAsOf ?? null,
    planAsOf: result.policy?.planAsOf ?? null,
    stock: result.quote?.stock ?? result.policy?.stock?.amount ?? null,
    reserve,
    reserveProjection,
    sellableAfterReserve: result.quote?.sellableAfterReserve ?? result.policy?.sellable ?? null,
    bestAsk: result.book?.live?.bestAsk ?? null,
    bookAsOf: result.book?.live?.asOf ?? null,
    bookFreshness: result.book?.live?.freshness ?? null,
    gross: result.quote?.gross ?? null,
    feeRate: result.quote?.feeRate ?? null,
    fee: result.quote?.fee ?? null,
    netBeforeSourceCost: result.quote?.netBeforeSourceCost ?? null,
    transport: result.quote?.transport ?? null,
    transportPerUnit: result.quote?.transport?.transportPerUnit ?? null,
    uiDryRun: {
      ok: result.uiQuote?.ok === true,
      status: result.uiQuote?.status || 'NOT_ATTEMPTED',
    },
    // These are values re-read from the actual game form, not values inferred from the quote.
    // A later confirmation must match them exactly and must keep the same exact product/lot proof.
    uiInputs: result.uiQuote?.actualInputs || null,
    uiProduct: result.uiQuote?.selectedProduct || null,
    uiLot: result.uiQuote?.selectedLot || null,
    qualityChoices: Array.isArray(result.uiQuote?.qualityChoices)
      ? result.uiQuote.qualityChoices
      : [],
    uiEconomics: result.uiQuote?.economics || null,
    reason: result.reason || result.error || null,
  };
}

function print(result) {
  const artifact = inspectionArtifact(result);
  writeInspectionArtifact(INSPECTION_CACHE_FILE, artifact);
  console.log(JSON.stringify(result));
}

async function main() {
  const args = parseInspectExchangeArgs(process.argv[2], process.argv[3]);
  const nowMs = Date.now();
  const inspectedAt = new Date(nowMs).toISOString();
  const state = readJson(STATE_FILE);
  const defs = readJson(DEFS_FILE, { resources: {} });
  const facts = readJson(FACTS_FILE, { mechanics: {} });
  const names = readJson(NAMES_FILE, {});
  const bookCache = readJson(BOOK_CACHE_FILE, { books: {} });
  const resource = defs?.resources?.[args.kind] || null;
  const name = names?.[args.kind] || null;
  const cachedBook = summarizeCachedBook(args.kind, bookCache?.books?.[args.kind], nowMs);

  const base = {
    ok: false,
    readOnly: true,
    submitted: false,
    inspectedAt,
    request: args,
    resource: {
      kind: args.kind,
      name,
      imageSlug: resourceSlug(resource || {}),
      exchangeTradable: resource?.isExchangeTradable === true,
    },
    sources: {
      state: 'autopilot/.state.json',
      definitions: 'shared/facts/defs.json',
      mechanics: 'shared/facts/game-facts.json',
      cachedBook: 'shared/price-tracker/data/book-state.json',
      liveBook: `/api/v3/market/0/${args.kind}/`,
    },
    book: { live: null, cached: cachedBook, selected: null },
    policy: null,
    quote: null,
    uiQuote: { status: 'NOT_ATTEMPTED', submitted: false, mutationAttempted: false },
  };

  if (!state) return print({ ...base, failClosed: true, reason: '.state.json is missing or invalid' });
  if (!resource) return print({ ...base, failClosed: true, reason: 'resource definition is missing' });
  if (resource.isExchangeTradable !== true) {
    return print({ ...base, failClosed: true, reason: 'resource is not exchange tradable' });
  }
  if (!resourceSlug(resource)) {
    return print({ ...base, failClosed: true, reason: 'resource image slug is missing; UI tile cannot be selected safely' });
  }

  const currentPolicy = validateSurplusPlan({ state, kind: args.kind, resource, nowMs });
  base.policy = currentPolicy;
  if (!currentPolicy.ok) {
    return print({ ...base, failClosed: true, reason: currentPolicy.reason });
  }
  const authorization = buildReserveAuthorization({
    state,
    kind: args.kind,
    currentPolicy,
    facts,
    inspectionCache: readInspectionRateCache(RATE_CACHE_FILE),
    nowMs,
  });
  if (!authorization.ok) {
    return print({
      ...base,
      failClosed: true,
      failureCode: authorization.failureCode || null,
      requiredBuildingIds: authorization.requiredBuildingIds || [],
      reason: authorization.reason,
    });
  }
  const policy = authorization.policy;
  base.policy = policy;

  const configuredFee = Number(facts?.mechanics?.exchange_fee);
  if (!Number.isFinite(configuredFee) || Math.abs(configuredFee - DEFAULT_EXCHANGE_FEE_RATE) > 1e-9) {
    return print({
      ...base,
      failClosed: true,
      reason: 'measured exchange fee is missing or differs from the required 4% fee',
      measuredFeeRate: Number.isFinite(configuredFee) ? configuredFee : null,
    });
  }

  let liveRaw;
  try {
    await cdp.connect();
    liveRaw = await cdp.evaluate(String.raw`
      const endpoint = ${JSON.stringify(`/api/v3/market/0/${args.kind}/`)};
      try {
        const result = await api(endpoint);
        return { status: result.status, rows: result.status === 200 && Array.isArray(result.json) ? result.json : null };
      } catch (error) {
        return { status: 'ERROR', error: String(error.message || error), rows: null };
      }
    `);
  } catch (error) {
    liveRaw = { status: 'ERROR', error: String(error.message || error), rows: null };
  } finally {
    try { cdp.close(); } catch (_) {}
  }

  const liveAsOf = liveRaw?.status === 200 ? new Date().toISOString() : null;
  const liveBook = summarizeBook(args.kind, liveRaw?.rows, {
    source: `/api/v3/market/0/${args.kind}/`,
    asOf: liveAsOf,
    nowMs: Date.now(),
    status: liveRaw?.status ?? 'UNKNOWN',
  });
  if (liveRaw?.error) liveBook.error = String(liveRaw.error).slice(0, 300);
  base.book.live = liveBook;
  base.book.selected = liveBook.status === 200 && liveBook.freshness === 'FRESH' ? 'live' : null;

  const quote = buildSaleQuote({
    kind: args.kind,
    requestedQty: args.qty,
    state,
    resource,
    policy,
    book: liveBook,
    feeRate: configuredFee,
  });
  base.quote = quote;
  if (!quote.ok) {
    return print({ ...base, failClosed: true, reason: quote.reason });
  }

  let uiRaw;
  try {
    // Deliberately omit --submit. The UI driver only fills and reads the form in this mode.
    const output = execFileSync(process.execPath, [
      UI_DRIVER,
      resourceSlug(resource),
      String(quote.quantity),
      String(quote.price),
      JSON.stringify({
        kind: args.kind,
        reserve: policy.reserve,
        reserveValidUntil: policy.reserveValidUntil,
        transportPerUnit: quote.transport?.transportPerUnit,
        lotIndex: null,
        lotQuality: null,
      }),
    ], { cwd: SIM, timeout: 120000, encoding: 'utf8' });
    uiRaw = JSON.parse(output.trim());
  } catch (error) {
    const stdout = String(error?.stdout || '').trim();
    try { uiRaw = JSON.parse(stdout); }
    catch (_) { uiRaw = { ok: false, reason: String(error.message || error).slice(0, 300) }; }
  }
  const uiQuote = summarizeUiDryRun(uiRaw);
  print({
    ...base,
    ok: uiQuote.ok,
    failClosed: !uiQuote.ok,
    reason: uiQuote.ok ? null : uiQuote.reason || 'UI dry-run form is not ready',
    uiQuote,
  });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    try { cdp.close(); } catch (_) {}
    print({
      ok: false,
      failClosed: true,
      readOnly: true,
      submitted: false,
      error: String(error.message || error),
    });
    process.exit(0);
  });
}

module.exports = { buildReserveAuthorization, inspectionArtifact };
