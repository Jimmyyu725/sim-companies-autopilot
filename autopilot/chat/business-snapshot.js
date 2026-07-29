'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateFreshSaleInspection } = require('../exchange-sale-safety.js');
const { normalizePriceSnapshot } = require('../../shared/price-tracker/data-quality.js');

const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const DEFAULT_STATE_PATH = path.resolve(__dirname, '..', '.state.json');
const DEFAULT_INSPECTION_PATH = path.resolve(__dirname, '..', '.exchange-sale-inspections.json');
const DEFAULT_PRICE_HISTORY_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'shared',
  'price-tracker',
  'data',
  'prices.jsonl',
);
const DEFAULT_FACTS_PATH = path.resolve(__dirname, '..', '..', 'shared', 'facts', 'game-facts.json');
// shadow-worker's strict minimal DTO projector rejects arrays above 200 entries.
const MAX_ROWS = 200;
const MAX_JSON_FILE_BYTES = 1024 * 1024;
const MAX_PRICE_HISTORY_TAIL_BYTES = 1024 * 1024;
const MAX_PRICE_HISTORY_RECORDS = 512;
const MIN_COMPLETE_TICKER_KINDS = 100;
const PRICE_TRACKER_SOURCE = 'shared/price-tracker/data/prices.jsonl';

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveKind(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nearlyEqual(left, right, tolerance = 1e-9) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}

function timestampMilliseconds(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNow(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('now must be a Date or millisecond timestamp');
  return milliseconds;
}

function evidenceTime(value) {
  if (!plainObject(value)) return null;
  if (timestampMilliseconds(value.observedAt) != null) return value.observedAt;
  if (timestampMilliseconds(value.asOf) != null) return value.asOf;
  return null;
}

function freshness(value, nowMs, maxAgeMs, { requireStatus = true } = {}) {
  const observedAt = evidenceTime(value);
  const observedMs = timestampMilliseconds(observedAt);
  if (requireStatus && value?.status !== 'ok') return { ok: false, observedAt };
  if (observedMs == null) return { ok: false, observedAt: null };
  const ageMs = nowMs - observedMs;
  return {
    ok: ageMs >= -MAX_CLOCK_SKEW_MS && ageMs <= maxAgeMs,
    observedAt,
    ageMs,
  };
}

function stateFreshness(state, nowMs, maxAgeMs) {
  if (!plainObject(state)) return { ok: false, observedAt: null };
  return freshness({ observedAt: state.t }, nowMs, maxAgeMs, { requireStatus: false });
}

function sourceFreshness(state, sourceName, nowMs, maxAgeMs) {
  return freshness(state?.sources?.[sourceName], nowMs, maxAgeMs);
}

function earliestTimestamp(values) {
  const entries = values
    .map(value => ({ value, milliseconds: timestampMilliseconds(value) }))
    .filter(entry => entry.milliseconds != null)
    .sort((left, right) => left.milliseconds - right.milliseconds);
  return entries[0]?.value ?? null;
}

function copyKnownNumber(target, key, value, validator = finiteNonNegative) {
  const normalized = validator(value);
  if (normalized != null) target[key] = normalized;
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function rowIdentity(row) {
  const kind = positiveKind(row?.kind);
  const quality = nonNegativeInteger(row?.quality);
  return kind == null ? null : `${kind}:${quality == null ? '?' : quality}`;
}

function compareRows(left, right) {
  const leftKind = positiveKind(left?.kind) ?? Number.MAX_SAFE_INTEGER;
  const rightKind = positiveKind(right?.kind) ?? Number.MAX_SAFE_INTEGER;
  if (leftKind !== rightKind) return leftKind - rightKind;
  const leftQuality = nonNegativeInteger(left?.quality) ?? Number.MAX_SAFE_INTEGER;
  const rightQuality = nonNegativeInteger(right?.quality) ?? Number.MAX_SAFE_INTEGER;
  return leftQuality - rightQuality;
}

function evidenceItems(value) {
  return Array.isArray(value?.items) && value.items.length <= MAX_ROWS ? value.items : [];
}

function rowEvidenceFresh(row, parentGate, nowMs, maxAgeMs) {
  if (!plainObject(row) || (row.status != null && row.status !== 'ok')) return false;
  const rowObservedAt = evidenceTime(row);
  if (rowObservedAt == null) return parentGate.ok;
  return freshness(
    { status: 'ok', observedAt: rowObservedAt },
    nowMs,
    maxAgeMs,
  ).ok && parentGate.ok;
}

function validWarehouseMetadata(state) {
  return state?.warehouse?.complete === true
    && state?.warehouse?.allPositiveProductsIncluded === true;
}

function validStateStockRows(state) {
  if (!Array.isArray(state?.stock) || state.stock.length > MAX_ROWS) return [];
  return state.stock.filter(row => positiveKind(row?.kind) != null);
}

function stateStockByKind(state) {
  return new Map(validStateStockRows(state).map(row => [row.kind, row]));
}

function validPlan(state, nowMs, maxAgeMs) {
  const source = sourceFreshness(state, 'surplusPlan', nowMs, maxAgeMs);
  const plan = state?.surplusPlan;
  const stateMs = timestampMilliseconds(state?.t);
  const planMs = timestampMilliseconds(plan?.asOf);
  return {
    ok: source.ok && plainObject(plan) && plan.status === 'ok' && plan.complete === true
      && stateMs != null && planMs === stateMs && plainObject(plan.items),
    observedAt: earliestTimestamp([source.observedAt, plan?.asOf]),
    plan,
  };
}

function planItem(planEvidence, kind) {
  const item = planEvidence.ok ? planEvidence.plan.items?.[String(kind)] : null;
  if (!plainObject(item) || item.status !== 'ok' || positiveKind(item.kind) !== kind) return null;
  return item;
}

function exactStateStockRow(state, kind) {
  const rows = validStateStockRows(state).filter(row => row.kind === kind);
  if (rows.length !== 1 || rows[0].known !== true) return null;
  const row = rows[0];
  const amount = finiteNonNegative(row.amount);
  const availableAmount = finiteNonNegative(row.availableAmount);
  const blockedAmount = finiteNonNegative(row.blockedAmount);
  if (amount == null || availableAmount == null || blockedAmount == null
      || !nearlyEqual(amount, availableAmount + blockedAmount)) return null;
  return { row, amount, availableAmount, blockedAmount };
}

function trustedStaticFacts(facts, nowMs) {
  if (!plainObject(facts) || !plainObject(facts.mechanics) || !plainObject(facts.resources)
      || positiveInteger(facts.resourceCount) == null
      || facts.resourceCount < MIN_COMPLETE_TICKER_KINDS
      || Object.keys(facts.resources).length !== facts.resourceCount
      || !Array.isArray(facts.warnings) || facts.warnings.length !== 0) return null;
  const generatedMs = timestampMilliseconds(facts.generated);
  if (generatedMs == null || generatedMs > nowMs + MAX_CLOCK_SKEW_MS) return null;
  const exchangeFeeRate = finiteNonNegative(facts.mechanics.exchange_fee);
  if (exchangeFeeRate == null || !nearlyEqual(exchangeFeeRate, 0.04)) return null;
  return { exchangeFeeRate, resources: facts.resources };
}

function priceRecordTimestampMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  // The current collector stores epoch seconds. Accept epoch milliseconds too, but reject values
  // whose unit cannot be distinguished safely.
  if (value >= 1_000_000_000 && value < 100_000_000_000) return value * 1000;
  if (value >= 1_000_000_000_000 && value < 100_000_000_000_000) return value;
  return null;
}

function trustedTickerEvidence(state, priceHistory, nowMs, maxAgeMs) {
  const source = sourceFreshness(state, 'ticker', nowMs, maxAgeMs);
  const sourceMs = timestampMilliseconds(source.observedAt);
  if (!source.ok || state?.sources?.ticker?.source !== PRICE_TRACKER_SOURCE
      || sourceMs == null || !Array.isArray(priceHistory)
      || priceHistory.length === 0 || priceHistory.length > MAX_PRICE_HISTORY_RECORDS) return null;
  const expectedKinds = validStateStockRows(state).map(row => row.kind);
  const candidates = [];
  for (const record of priceHistory) {
    const normalized = normalizePriceSnapshot(record, { expectedKinds });
    if (!normalized || normalized.catalogSize < MIN_COMPLETE_TICKER_KINDS) continue;
    if (priceRecordTimestampMs(normalized.t) === sourceMs) candidates.push(normalized);
  }
  if (candidates.length !== 1) return null;
  const snapshot = candidates[0];
  for (const stock of validStateStockRows(state)) {
    const statePrice = finiteNonNegative(stock.exchPrice);
    const capturedPrice = finiteNonNegative(snapshot.p[stock.kind]);
    if (statePrice == null || statePrice <= 0 || capturedPrice == null
        || !nearlyEqual(statePrice, capturedPrice)) return null;
  }
  return {
    observedAt: source.observedAt,
    prices: snapshot.p,
  };
}

function normalizeInspectionStoreEntries(store) {
  if (!plainObject(store) || Number(store.schemaVersion) !== 1
      || !plainObject(store.artifactsByKind)) return [];
  const entries = Object.entries(store.artifactsByKind);
  if (entries.length > MAX_ROWS) return [];
  const seen = new Set();
  const result = [];
  for (const [kindText, artifact] of entries) {
    const kind = positiveKind(Number(kindText));
    if (kind == null || String(kind) !== kindText || seen.has(kind)
        || !plainObject(artifact) || positiveKind(Number(artifact.kind)) !== kind) return [];
    seen.add(kind);
    result.push({ kind, artifact });
  }
  return result.sort((left, right) => left.kind - right.kind);
}

function normalizedQualityChoices(artifact) {
  if (!Array.isArray(artifact?.qualityChoices) || artifact.qualityChoices.length === 0
      || artifact.qualityChoices.length > MAX_ROWS) return null;
  const seenIndexes = new Set();
  const choices = [];
  for (const raw of artifact.qualityChoices) {
    if (!plainObject(raw)) return null;
    const index = nonNegativeInteger(raw.index);
    const available = finiteNonNegative(raw.available);
    const quality = raw.quality == null ? null : nonNegativeInteger(raw.quality);
    const unitCost = finiteNonNegative(raw.unitCost);
    if (index == null || available == null || available <= 0 || unitCost == null
        || (raw.quality != null && quality == null) || seenIndexes.has(index)) return null;
    seenIndexes.add(index);
    choices.push({ index, available, quality, unitCost });
  }
  return choices.sort((left, right) => left.index - right.index);
}

function validatedActiveInspection({ state, planEvidence, factsEvidence, kind, artifact, nowMs, maxAgeMs }) {
  if (!planEvidence.ok || !factsEvidence || positiveInteger(artifact?.effectiveQty) == null
      || !(finiteNonNegative(artifact?.bestAsk) > 0)) return null;
  let validation;
  try {
    validation = validateFreshSaleInspection(
      artifact,
      state,
      kind,
      artifact.effectiveQty,
      artifact.bestAsk,
      nowMs,
    );
  } catch {
    return null;
  }
  if (!validation.ok) return null;
  const inspected = freshness(
    { status: 'ok', observedAt: artifact.inspectedAt },
    nowMs,
    maxAgeMs,
  );
  const book = freshness(
    { status: 'ok', observedAt: artifact.bookAsOf },
    nowMs,
    maxAgeMs,
  );
  const inspectedMs = timestampMilliseconds(artifact.inspectedAt);
  const bookMs = timestampMilliseconds(artifact.bookAsOf);
  if (!inspected.ok || !book.ok || inspectedMs == null || bookMs == null
      || bookMs < inspectedMs - MAX_CLOCK_SKEW_MS
      || bookMs > inspectedMs + maxAgeMs) return null;
  const stock = exactStateStockRow(state, kind);
  const transportStock = exactStateStockRow(state, 13);
  const plan = planItem(planEvidence, kind);
  const factsTransport = finiteNonNegative(factsEvidence.resources?.[String(kind)]?.transportation);
  const planTransport = finiteNonNegative(plan?.transportPerUnit);
  if (!stock || !transportStock || !plan || factsTransport == null || planTransport == null
      || !nearlyEqual(factsTransport, planTransport)
      || !nearlyEqual(Number(artifact.feeRate), factsEvidence.exchangeFeeRate)
      || artifact.uiProduct?.exact !== true
      || artifact.uiProduct?.scopeConnected !== true
      || artifact.uiProduct?.boundToForm !== true
      || positiveInteger(artifact.uiInputs?.quantity) !== artifact.effectiveQty
      || !nearlyEqual(Number(artifact.uiInputs?.price), Number(artifact.bestAsk))
      || nonNegativeInteger(artifact.uiLot?.index) == null
      || finiteNonNegative(artifact.uiLot?.available) == null
      || !nearlyEqual(Number(artifact.uiLot?.inspectedAvailable), Number(artifact.uiLot?.available))
      || finiteNonNegative(artifact.uiLot?.unitCost) == null
      || artifact.uiLot?.stillSelected !== true || artifact.uiLot?.costBound !== true
      || !nearlyEqual(Number(artifact.transportPerUnit), planTransport)
      || !nearlyEqual(Number(artifact.transport?.transportPerUnit), planTransport)
      || !nearlyEqual(Number(artifact.transport?.available), transportStock.availableAmount)) return null;
  const choices = normalizedQualityChoices(artifact);
  if (!choices) return null;
  const selected = choices.find(choice => choice.index === validation.selectedLotIndex);
  if (!selected || !nearlyEqual(selected.available, validation.selectedLotAvailable)
      || !nearlyEqual(selected.unitCost, validation.selectedLotUnitCost)
      || selected.quality !== validation.selectedLotQuality) return null;
  return { artifact, book, choices, kind, plan, stock, validation };
}

function evidenceContainer(items, observedAtValues, extra = {}) {
  if (!items.length || items.length > MAX_ROWS) return null;
  const observedAt = earliestTimestamp(observedAtValues);
  if (!observedAt) return null;
  return { status: 'ok', observedAt, items, ...extra };
}

function inspectionBusinessEvidence(
  state,
  inspectionStore,
  facts,
  tickerEvidence,
  nowMs,
  maxAgeMs,
) {
  const planEvidence = validPlan(state, nowMs, maxAgeMs);
  const factsEvidence = trustedStaticFacts(facts, nowMs);
  const validated = normalizeInspectionStoreEntries(inspectionStore).flatMap(({ kind, artifact }) => {
    const value = validatedActiveInspection({
      state, planEvidence, factsEvidence, kind, artifact, nowMs, maxAgeMs,
    });
    return value ? [value] : [];
  });
  const warehouseItems = [];
  const warehouseTimes = [];
  const marketItems = [];
  const marketTimes = [];
  const economicsItems = [];
  const economicsTimes = [];
  for (const evidence of validated) {
    const { artifact, choices, kind, plan, stock, validation } = evidence;
    const exactQualityChoices = choices.every(choice => choice.quality != null);
    const choiceTotal = choices.reduce((sum, choice) => sum + choice.available, 0);
    if (exactQualityChoices && stock.blockedAmount === 0
        && nearlyEqual(choiceTotal, stock.availableAmount)) {
      for (const choice of choices) {
        const item = {
          status: 'ok',
          observedAt: artifact.inspectedAt,
          kind,
          quality: choice.quality,
          onHandAmount: choice.available,
          blockedAmount: 0,
          unitCost: choice.unitCost,
        };
        if (Number(plan.reserve) === 0) item.reserveAmount = 0;
        warehouseItems.push(item);
        warehouseTimes.push(artifact.inspectedAt);
      }
    }
    // The raw live order book is a Q0+ floor. It is exact for a selected Q0 lot only; treating it
    // as the competing price for Q1+ would reproduce the quality-pricing bug seen in the UI.
    if (validation.selectedLotQuality === 0) {
      const marketPrice = finiteNonNegative(tickerEvidence?.prices?.[kind]);
      // MP-relative chat offers resolve against the reconciled ticker MP, never the live best ask.
      // The exact Q0 UI lot is still required so an unqualified ticker row cannot invent quality.
      if (marketPrice != null && marketPrice > 0) {
        marketItems.push({
          status: 'ok',
          observedAt: tickerEvidence.observedAt,
          kind,
          quality: 0,
          marketPrice,
        });
        marketTimes.push(tickerEvidence.observedAt);
      }
      economicsItems.push({
        status: 'ok',
        observedAt: artifact.bookAsOf,
        kind,
        quality: 0,
        alternativeSellNetPerUnit: Number(artifact.bestAsk) * (1 - factsEvidence.exchangeFeeRate),
      });
      economicsTimes.push(artifact.bookAsOf);
    }
  }
  return {
    warehouse: evidenceContainer(warehouseItems, warehouseTimes, { complete: true }),
    market: evidenceContainer(marketItems, marketTimes),
    economics: evidenceContainer(economicsItems, economicsTimes),
  };
}

function transportBusinessEvidence(state, facts, priceHistory, nowMs, maxAgeMs) {
  const global = stateFreshness(state, nowMs, maxAgeMs);
  const stockSource = sourceFreshness(state, 'stock', nowMs, maxAgeMs);
  const planEvidence = validPlan(state, nowMs, maxAgeMs);
  const factsEvidence = trustedStaticFacts(facts, nowMs);
  const transportStock = exactStateStockRow(state, 13);
  if (!global.ok || !stockSource.ok || !planEvidence.ok || !factsEvidence || !transportStock) return null;
  const ticker = trustedTickerEvidence(state, priceHistory, nowMs, maxAgeMs);
  const transportOpportunityCost = finiteNonNegative(ticker?.prices?.[13]);
  const rawItems = Object.values(planEvidence.plan.items || {});
  if (rawItems.length === 0 || rawItems.length > MAX_ROWS) return null;
  const entries = [];
  const seen = new Set();
  const observedAtValues = [state.t, planEvidence.observedAt];
  for (const plan of rawItems) {
    const kind = positiveKind(plan?.kind);
    const unitsPerItem = finiteNonNegative(plan?.transportPerUnit);
    const factsUnits = kind == null
      ? null
      : finiteNonNegative(factsEvidence.resources?.[String(kind)]?.transportation);
    if (plan?.status !== 'ok' || kind == null || unitsPerItem == null || factsUnits == null
        || seen.has(kind) || !nearlyEqual(unitsPerItem, factsUnits)) continue;
    seen.add(kind);
    const entry = { status: 'ok', observedAt: state.t, kind, unitsPerItem };
    if (unitsPerItem > 0) {
      if (transportOpportunityCost == null || transportOpportunityCost <= 0) continue;
      entry.opportunityCostPerUnit = transportOpportunityCost;
      entry.observedAt = earliestTimestamp([state.t, ticker.observedAt]);
      observedAtValues.push(ticker.observedAt);
    }
    entries.push(entry);
  }
  return evidenceContainer(entries, observedAtValues, {
    availableAmount: transportStock.availableAmount,
  });
}

/**
 * Convert only reconciled local runtime artifacts into optional projector evidence. This function
 * is pure: it never opens Chrome, calls an API, reads a file, or assigns Q0 to an unlabeled lot.
 */
function buildProductionBusinessEvidence(input = {}, options = {}) {
  const nowMs = normalizeNow(options.now ?? Date.now());
  const maxAgeMs = Number(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError('maxAgeMs must be a positive integer');
  }
  if (!plainObject(input.state)) {
    return { warehouse: null, market: null, economics: null, transport: null };
  }
  const tickerEvidence = trustedTickerEvidence(
    input.state,
    input.priceHistory,
    nowMs,
    maxAgeMs,
  );
  const inspected = inspectionBusinessEvidence(
    input.state,
    input.inspectionStore,
    input.facts,
    tickerEvidence,
    nowMs,
    maxAgeMs,
  );
  return {
    ...inspected,
    transport: transportBusinessEvidence(
      input.state,
      input.facts,
      input.priceHistory,
      nowMs,
      maxAgeMs,
    ),
  };
}

function unknownAggregateInventory(state, stockSource, planEvidence) {
  if (!stockSource.ok || !validWarehouseMetadata(state)) return [];
  return validStateStockRows(state).map(stock => {
    const row = { status: 'unknown', kind: stock.kind };
    if (stockSource.observedAt) row.observedAt = stockSource.observedAt;
    copyKnownNumber(row, 'onHandAmount', stock.amount);
    copyKnownNumber(row, 'blockedAmount', stock.blockedAmount);
    const reserve = finiteNonNegative(planItem(planEvidence, stock.kind)?.reserve);
    if (reserve != null) row.reserveAmount = reserve;
    // Aggregated state intentionally has neither exact quality nor lot-level unit cost.  It must
    // never be silently interpreted as Q0 or a zero-cost lot.
    return row;
  }).sort(compareRows);
}

function warehouseKindReconciles(items, stock) {
  if (!stock || items.length === 0) return false;
  const onHand = items.reduce((sum, row) => {
    const value = finiteNonNegative(row?.onHandAmount);
    return value == null ? NaN : sum + value;
  }, 0);
  const blocked = items.reduce((sum, row) => {
    const value = finiteNonNegative(row?.blockedAmount);
    return value == null ? NaN : sum + value;
  }, 0);
  const stateOnHand = finiteNonNegative(stock.amount);
  const stateBlocked = finiteNonNegative(stock.blockedAmount);
  return Number.isFinite(onHand) && Number.isFinite(blocked)
    && stateOnHand != null && stateBlocked != null
    && Math.abs(onHand - stateOnHand) < 1e-9
    && Math.abs(blocked - stateBlocked) < 1e-9;
}

function reserveAllocations(items, reserve) {
  if (reserve == null || items.length === 0) return null;
  if (items.length === 1) return [reserve];
  const explicit = items.map(row => finiteNonNegative(row?.reserveAmount));
  if (explicit.some(value => value == null)) return null;
  const total = explicit.reduce((sum, value) => sum + value, 0);
  return Math.abs(total - reserve) < 1e-9 ? explicit : null;
}

function projectInventory(state, warehouse, gates) {
  const { global, stockSource, planEvidence, nowMs, maxAgeMs } = gates;
  if (!global.ok || !stockSource.ok || !validWarehouseMetadata(state)) return [];
  if (!plainObject(warehouse)) return unknownAggregateInventory(state, stockSource, planEvidence);

  const warehouseSource = freshness(warehouse, nowMs, maxAgeMs);
  if (!warehouseSource.ok || warehouse.complete !== true) {
    return unknownAggregateInventory(state, stockSource, planEvidence);
  }
  const items = evidenceItems(warehouse);
  if (items.length === 0) return unknownAggregateInventory(state, stockSource, planEvidence);
  const byKind = new Map();
  for (const item of items) {
    const kind = positiveKind(item?.kind);
    if (kind == null) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(item);
  }

  const stockMap = stateStockByKind(state);
  const aggregateMap = new Map(
    unknownAggregateInventory(state, stockSource, planEvidence).map(row => [row.kind, row]),
  );
  const result = [];
  for (const [kind, kindItems] of byKind) {
    if (!kindItems.every(item => rowEvidenceFresh(item, warehouseSource, nowMs, maxAgeMs))) {
      if (aggregateMap.has(kind)) result.push(aggregateMap.get(kind));
      continue;
    }
    const reconciled = warehouseKindReconciles(kindItems, stockMap.get(kind));
    const identityCounts = new Map();
    for (const item of kindItems) {
      const identity = rowIdentity(item);
      if (identity) identityCounts.set(identity, (identityCounts.get(identity) || 0) + 1);
    }
    const plan = planItem(planEvidence, kind);
    const reserve = finiteNonNegative(plan?.reserve);
    const allocations = reserveAllocations(kindItems, reserve);
    for (let index = 0; index < kindItems.length; index += 1) {
      const item = kindItems[index];
      const row = { status: 'unknown', kind };
      const observedAt = earliestTimestamp([
        evidenceTime(item),
        warehouseSource.observedAt,
        stockSource.observedAt,
        planEvidence.observedAt,
      ]);
      if (observedAt) row.observedAt = observedAt;
      const quality = copyKnownNumber(row, 'quality', item.quality, nonNegativeInteger);
      const onHandAmount = copyKnownNumber(row, 'onHandAmount', item.onHandAmount);
      const blockedAmount = copyKnownNumber(row, 'blockedAmount', item.blockedAmount);
      const unitCost = copyKnownNumber(row, 'unitCost', item.unitCost);
      if (allocations) row.reserveAmount = allocations[index];
      const itemGate = rowEvidenceFresh(item, warehouseSource, nowMs, maxAgeMs);
      if (itemGate && reconciled && plan && allocations
          && identityCounts.get(rowIdentity(item)) === 1
          && quality != null && onHandAmount != null && blockedAmount != null && unitCost != null) {
        row.status = 'ok';
      }
      result.push(row);
    }
  }

  // A complete external lot view must cover every kind in the complete state stock capture.
  // Missing kinds remain explicit aggregate UNKNOWN rows rather than disappearing.
  for (const aggregate of unknownAggregateInventory(state, stockSource, planEvidence)) {
    if (!byKind.has(aggregate.kind)) result.push(aggregate);
  }
  return result.length <= MAX_ROWS ? result.sort(compareRows) : [];
}

function collectIdentities(...collections) {
  const identities = new Map();
  for (const collection of collections) {
    for (const row of collection || []) {
      const identity = rowIdentity(row);
      if (identity && !identities.has(identity)) {
        const value = { kind: row.kind };
        if (nonNegativeInteger(row.quality) != null) value.quality = row.quality;
        identities.set(identity, value);
      }
    }
  }
  const result = [...identities.values()];
  return result.length <= MAX_ROWS ? result.sort(compareRows) : [];
}

function sourceRowsByIdentity(source) {
  const rows = new Map();
  const duplicates = new Set();
  for (const row of evidenceItems(source)) {
    const identity = rowIdentity(row);
    if (!identity) continue;
    if (rows.has(identity)) duplicates.add(identity);
    else rows.set(identity, row);
  }
  return { rows, duplicates };
}

function projectMarkets(market, inventory, gates) {
  const marketGate = freshness(market, gates.nowMs, gates.maxAgeMs);
  const sourceRows = sourceRowsByIdentity(market);
  const trustedSourceIdentities = evidenceItems(market).filter(
    row => rowEvidenceFresh(row, marketGate, gates.nowMs, gates.maxAgeMs),
  );
  const identities = collectIdentities(inventory, trustedSourceIdentities);
  return identities.map(identity => {
    const key = rowIdentity(identity);
    const source = sourceRows.rows.get(key);
    const row = { status: 'unknown', ...identity };
    const observedAt = earliestTimestamp([evidenceTime(source), marketGate.observedAt]);
    if (observedAt) row.observedAt = observedAt;
    const rowFresh = rowEvidenceFresh(source, marketGate, gates.nowMs, gates.maxAgeMs);
    const unique = !sourceRows.duplicates.has(key);
    const price = rowFresh && unique
      ? copyKnownNumber(row, 'marketPrice', source?.marketPrice)
      : null;
    if (gates.global.ok && rowFresh
        && unique && nonNegativeInteger(identity.quality) != null
        && price != null && price > 0) {
      row.status = 'ok';
    }
    return row;
  }).sort(compareRows);
}

const ECONOMIC_COMMON_FIELDS = Object.freeze([
  ['contractFeeRate', finiteNonNegative],
  ['fixedCost', finiteNonNegative],
]);
const ECONOMIC_SELL_FIELDS = Object.freeze([
  ['alternativeSellNetPerUnit', finiteNonNegative],
]);
const ECONOMIC_BUY_FIELDS = Object.freeze([
  ['buyUseValuePerUnit', finiteNonNegative],
  ['buyNeedAmount', nonNegativeInteger],
  ['warehouseFreeAmount', nonNegativeInteger],
]);
const ECONOMIC_FIELDS = Object.freeze([
  ...ECONOMIC_COMMON_FIELDS,
  ...ECONOMIC_SELL_FIELDS,
  ...ECONOMIC_BUY_FIELDS,
]);

function projectEconomics(economics, inventory, markets, gates) {
  const sourceGate = freshness(economics, gates.nowMs, gates.maxAgeMs);
  const sourceRows = sourceRowsByIdentity(economics);
  const trustedSourceIdentities = evidenceItems(economics).filter(
    row => rowEvidenceFresh(row, sourceGate, gates.nowMs, gates.maxAgeMs),
  );
  const identities = collectIdentities(inventory, markets, trustedSourceIdentities);
  return identities.map(identity => {
    const key = rowIdentity(identity);
    const source = sourceRows.rows.get(key);
    const row = { status: 'unknown', ...identity };
    const observedAt = earliestTimestamp([evidenceTime(source), sourceGate.observedAt]);
    if (observedAt) row.observedAt = observedAt;
    const rowFresh = rowEvidenceFresh(source, sourceGate, gates.nowMs, gates.maxAgeMs);
    const unique = !sourceRows.duplicates.has(key);
    const known = new Map();
    for (const [field, validator] of ECONOMIC_FIELDS) {
      known.set(field, rowFresh && unique
        ? copyKnownNumber(row, field, source?.[field], validator)
        : null);
    }
    const commonComplete = ECONOMIC_COMMON_FIELDS.every(([field]) => known.get(field) != null)
      && row.contractFeeRate <= 1;
    const sellComplete = ECONOMIC_SELL_FIELDS.every(([field]) => known.get(field) != null);
    const buyComplete = ECONOMIC_BUY_FIELDS.every(([field]) => known.get(field) != null);
    if (gates.global.ok && rowFresh
        && unique && nonNegativeInteger(identity.quality) != null
        && commonComplete && (sellComplete || buyComplete)) {
      row.status = 'ok';
    }
    return row;
  }).sort(compareRows);
}

function stateTransportAvailable(state, stockSource) {
  if (!stockSource.ok) return null;
  const rows = validStateStockRows(state).filter(row => row.kind === 13);
  if (rows.length !== 1) return null;
  return finiteNonNegative(rows[0].availableAmount);
}

function fallbackTransportEntries(planEvidence) {
  if (!planEvidence.ok) return [];
  return Object.values(planEvidence.plan.items || {}).flatMap(item => {
    const kind = positiveKind(item?.kind);
    const unitsPerItem = finiteNonNegative(item?.transportPerUnit);
    return item?.status === 'ok' && kind != null && unitsPerItem != null
      ? [{ kind, unitsPerItem }]
      : [];
  }).sort(compareRows);
}

function projectTransport(state, transport, gates) {
  const availableFromState = stateTransportAvailable(state, gates.stockSource);
  const sourceGate = freshness(transport, gates.nowMs, gates.maxAgeMs);
  const suppliedEntries = evidenceItems(transport);
  const externalEntries = sourceGate.ok ? suppliedEntries : [];
  const entries = externalEntries.length > 0 ? externalEntries : fallbackTransportEntries(gates.planEvidence);
  const resultEntries = [];
  const seen = new Set();
  let entriesComplete = externalEntries.length > 0;
  for (const source of entries) {
    const kind = positiveKind(source?.kind);
    if (kind == null || seen.has(kind)) {
      entriesComplete = false;
      continue;
    }
    seen.add(kind);
    const entry = { kind };
    const unitsPerItem = copyKnownNumber(entry, 'unitsPerItem', source.unitsPerItem);
    const opportunityCost = copyKnownNumber(
      entry,
      'opportunityCostPerUnit',
      source.opportunityCostPerUnit,
    );
    const rowFresh = rowEvidenceFresh(source, sourceGate, gates.nowMs, gates.maxAgeMs);
    // If this product consumes zero Transport, its total Transport opportunity cost is exactly
    // zero regardless of the currently unknown price of one Transport unit. Keep that unknown
    // field absent; the evaluator derives the effective zero without fabricating a unit price.
    if (unitsPerItem == null || (unitsPerItem > 0 && opportunityCost == null) || !rowFresh) {
      entriesComplete = false;
    }
    const plan = planItem(gates.planEvidence, kind);
    if (plan && unitsPerItem != null
        && Math.abs(unitsPerItem - Number(plan.transportPerUnit)) >= 1e-9) {
      entriesComplete = false;
    }
    resultEntries.push(entry);
  }

  const result = { status: 'unknown', entries: resultEntries.sort(compareRows) };
  const observedAt = earliestTimestamp([
    gates.stockSource.observedAt,
    sourceGate.observedAt,
    externalEntries.length > 0 ? gates.planEvidence.observedAt : null,
  ]);
  if (observedAt) result.observedAt = observedAt;
  if (availableFromState != null) result.availableAmount = availableFromState;
  const externalAvailable = sourceGate.ok ? finiteNonNegative(transport?.availableAmount) : null;
  const reconciled = externalAvailable != null && availableFromState != null
    && Math.abs(externalAvailable - availableFromState) < 1e-9;
  if (gates.global.ok && sourceGate.ok && transport?.status === 'ok'
      && reconciled && entriesComplete) {
    result.status = 'ok';
  }
  return result;
}

function projectFinance(state, finance, gates) {
  const authSource = sourceFreshness(state, 'auth', gates.nowMs, gates.maxAgeMs);
  const externalSupplied = plainObject(finance);
  const sourceGate = externalSupplied
    ? freshness(finance, gates.nowMs, gates.maxAgeMs)
    : authSource;
  const result = { status: 'unknown' };
  const observedAt = earliestTimestamp([authSource.observedAt, sourceGate.observedAt]);
  if (observedAt) result.observedAt = observedAt;
  const stateCash = finiteNonNegative(state?.money);
  const evidenceUsable = authSource.ok && sourceGate.ok;
  const cashAvailable = evidenceUsable
    ? (externalSupplied ? finiteNonNegative(finance.cashAvailable) : stateCash)
    : null;
  const cashReserve = evidenceUsable
    ? (externalSupplied
      ? finiteNonNegative(finance.cashReserve)
      : finiteNonNegative(state?.config?.minCash))
    : null;
  if (cashAvailable != null) result.cashAvailable = cashAvailable;
  if (cashReserve != null) result.cashReserve = cashReserve;
  const reconciled = !externalSupplied || (stateCash != null && cashAvailable === stateCash);
  if (gates.global.ok && authSource.ok && sourceGate.ok && reconciled
      && cashAvailable != null && cashReserve != null) {
    result.status = 'ok';
  }
  return result;
}

function unavailableSnapshot(nowMs) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    observedAt: new Date(nowMs).toISOString(),
    inventory: [],
    markets: [],
    economics: [],
    transport: { status: 'unknown', entries: [] },
    finance: { status: 'unknown' },
  };
}

/**
 * Project trusted business evidence into the minimal typed DTO consumed by the chat planner.
 *
 * Optional warehouse/market/economics/transport evidence uses the shape
 * `{ status, observedAt, items }`. Warehouse evidence must additionally set `complete:true`.
 * No chat message is accepted by this API; unknown input fields and descriptive strings are never
 * copied or included in the content fingerprint.
 */
function buildBusinessSnapshot(input = {}, options = {}) {
  const nowMs = normalizeNow(options.now ?? Date.now());
  const maxAgeMs = Number(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError('maxAgeMs must be a positive integer');
  }
  const state = input?.state;
  const global = stateFreshness(state, nowMs, maxAgeMs);
  let body = unavailableSnapshot(nowMs);
  if (global.ok) {
    const stockSource = sourceFreshness(state, 'stock', nowMs, maxAgeMs);
    const planEvidence = validPlan(state, nowMs, maxAgeMs);
    const gates = { global, stockSource, planEvidence, nowMs, maxAgeMs };
    const inventory = projectInventory(state, input.warehouse, gates);
    const markets = projectMarkets(input.market, inventory, gates);
    const economics = projectEconomics(input.economics, inventory, markets, gates);
    body = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      observedAt: new Date(nowMs).toISOString(),
      inventory,
      markets,
      economics,
      transport: projectTransport(state, input.transport, gates),
      finance: projectFinance(state, input.finance, gates),
    };
  }
  const fingerprint = crypto.createHash('sha256').update(stableJson(body)).digest('hex');
  return deepFreeze({
    schemaVersion: body.schemaVersion,
    snapshotId: `bs1:${fingerprint}`,
    observedAt: body.observedAt,
    inventory: body.inventory,
    markets: body.markets,
    economics: body.economics,
    transport: body.transport,
    finance: body.finance,
  });
}

function openRegularReadOnly(file) {
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile()) {
    fs.closeSync(descriptor);
    throw new Error('business evidence source must be a regular file');
  }
  return { descriptor, stat };
}

function defaultReadJson(file) {
  const { descriptor, stat } = openRegularReadOnly(file);
  try {
    if (stat.size <= 0 || stat.size > MAX_JSON_FILE_BYTES) {
      throw new Error('business evidence JSON exceeds its size boundary');
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

function defaultReadPriceHistory(file) {
  const { descriptor, stat } = openRegularReadOnly(file);
  try {
    if (stat.size <= 0) throw new Error('price history is empty');
    const bytes = Math.min(stat.size, MAX_PRICE_HISTORY_TAIL_BYTES);
    const start = stat.size - bytes;
    const buffer = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(descriptor, buffer, 0, bytes, start);
    if (read !== bytes) throw new Error('price history tail was not read completely');
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      if (newline < 0) throw new Error('price history row exceeds its size boundary');
      text = text.slice(newline + 1);
    }
    const lines = text.split(/\r?\n/u).filter(line => line.trim());
    if (lines.length === 0) throw new Error('price history has no complete rows');
    return lines.slice(-MAX_PRICE_HISTORY_RECORDS).map(line => JSON.parse(line));
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeLoad(loader) {
  try {
    return typeof loader === 'function' ? loader() : null;
  } catch {
    return null;
  }
}

/**
 * Create a lazy, synchronous loader. Constructing/importing it performs no I/O. On load, the
 * production defaults read only bounded regular local files: current state, active (never used)
 * exchange inspections, recent price history, and measured game facts. Every reader remains
 * injectable for tests and trusted host code.
 */
function createBusinessSnapshotLoader(options = {}) {
  const statePath = path.resolve(options.statePath || DEFAULT_STATE_PATH);
  const inspectionPath = path.resolve(options.inspectionPath || DEFAULT_INSPECTION_PATH);
  const priceHistoryPath = path.resolve(options.priceHistoryPath || DEFAULT_PRICE_HISTORY_PATH);
  const factsPath = path.resolve(options.factsPath || DEFAULT_FACTS_PATH);
  const readJson = options.readJson || defaultReadJson;
  if (typeof readJson !== 'function') throw new TypeError('readJson must be a function');
  const stateLoader = options.loadState || (() => readJson(statePath));
  const sourceLoaders = {
    warehouse: options.loadWarehouse || null,
    market: options.loadMarket || null,
    economics: options.loadEconomics || null,
    transport: options.loadTransport || null,
    finance: options.loadFinance || null,
  };
  const productionLoaders = {
    inspectionStore: options.loadInspectionStore || (() => readJson(inspectionPath)),
    priceHistory: options.loadPriceHistory || (() => defaultReadPriceHistory(priceHistoryPath)),
    facts: options.loadGameFacts || (() => readJson(factsPath)),
  };
  for (const [name, loader] of Object.entries({
    state: stateLoader,
    ...sourceLoaders,
    ...productionLoaders,
  })) {
    if (loader != null && typeof loader !== 'function') {
      throw new TypeError(`load${name[0].toUpperCase()}${name.slice(1)} must be a function`);
    }
  }
  const clock = options.clock || (() => new Date());
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const maxAgeMs = Number(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError('maxAgeMs must be a positive integer');
  }
  return Object.freeze({
    load(overrides = {}) {
      const has = key => Object.prototype.hasOwnProperty.call(overrides, key);
      const now = has('now') ? overrides.now : clock();
      const state = has('state') ? overrides.state : safeLoad(stateLoader);
      const productionKeys = ['warehouse', 'market', 'economics', 'transport'];
      const needsProduction = plainObject(state) && productionKeys.some(
        key => !has(key) && sourceLoaders[key] == null,
      );
      const production = needsProduction
        ? buildProductionBusinessEvidence({
          state,
          inspectionStore: safeLoad(productionLoaders.inspectionStore),
          priceHistory: safeLoad(productionLoaders.priceHistory),
          facts: safeLoad(productionLoaders.facts),
        }, { now, maxAgeMs })
        : {};
      const input = { state };
      for (const key of Object.keys(sourceLoaders)) {
        if (has(key)) input[key] = overrides[key];
        else if (sourceLoaders[key] != null) input[key] = safeLoad(sourceLoaders[key]);
        else input[key] = production[key] ?? null;
      }
      return buildBusinessSnapshot(input, {
        now,
        maxAgeMs,
      });
    },
  });
}

function loadBusinessSnapshot(options = {}) {
  return createBusinessSnapshotLoader(options).load();
}

module.exports = {
  DEFAULT_FACTS_PATH,
  DEFAULT_INSPECTION_PATH,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_PRICE_HISTORY_PATH,
  DEFAULT_STATE_PATH,
  MAX_CLOCK_SKEW_MS,
  SNAPSHOT_SCHEMA_VERSION,
  buildBusinessSnapshot,
  buildProductionBusinessEvidence,
  createBusinessSnapshotLoader,
  loadBusinessSnapshot,
};
