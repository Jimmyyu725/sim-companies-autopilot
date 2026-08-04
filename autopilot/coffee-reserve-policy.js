'use strict';

const POWDER_KIND = 119;
const TRANSPORT_KIND = 13;
const DEFAULT_MAX_RATE_AGE_SECONDS = 15 * 60;
const PRINTED_RATE_ROUNDING_UPPER_PER_HOUR = 0.005;
const REQUIRED_KINDS = Object.freeze([1, 2, 66, 118, 119]);

function finiteNonNegative(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function factsResources(facts) {
  return facts && typeof facts === 'object' && facts.resources && typeof facts.resources === 'object'
    ? facts.resources
    : null;
}

function deriveRecipe(resources) {
  if (!resources) return null;
  const powderBeans = finiteNonNegative(resources[119]?.recipe?.[118]);
  const beanWater = finiteNonNegative(resources[118]?.recipe?.[2]);
  const beanSeeds = finiteNonNegative(resources[118]?.recipe?.[66]);
  const seedWater = finiteNonNegative(resources[66]?.recipe?.[2]);
  const waterPower = finiteNonNegative(resources[2]?.recipe?.[1]);
  if ([powderBeans, beanWater, beanSeeds, seedWater, waterPower].some(value => value == null)) return null;

  const recipe = {
    119: 1,
    118: powderBeans,
    66: powderBeans * beanSeeds,
    2: powderBeans * beanWater + powderBeans * beanSeeds * seedWater,
  };
  recipe[1] = recipe[2] * waterPower;
  const expected = { 119: 1, 118: 10, 66: 10, 2: 6, 1: 1.2 };
  return Object.keys(expected).every(kind => Math.abs(recipe[kind] - expected[kind]) < 1e-9)
    ? recipe
    : null;
}

function inspectionRows(rateEvidence, inspectionCache) {
  const sources = [rateEvidence, inspectionCache];
  const rows = [];
  for (const source of sources) {
    if (Array.isArray(source)) rows.push(...source);
    else if (Array.isArray(source?.inspections)) rows.push(...source.inspections);
    else if (source && typeof source === 'object') {
      const values = Object.values(source.byBuilding || source.buildings || {});
      if (values.length) rows.push(...values);
    }
  }
  return rows;
}

function powderProduct(inspection) {
  const products = Array.isArray(inspection?.products) ? inspection.products : [];
  const productKinds = products
    .map(row => Number(row?.kind))
    .filter(kind => Number.isInteger(kind) && kind > 0);
  if (new Set(productKinds).size !== productKinds.length) return null;
  const powderProducts = products.filter(row => Number(row?.kind) === POWDER_KIND);
  if (powderProducts.length !== 1) return null;
  const product = powderProducts[0];
  const displayedRate = Number(product.productionPerHour);
  if (!Number.isFinite(displayedRate) || displayedRate <= 0) return null;
  // The game prints production rates to two decimal places. Use the upper edge of that rounded
  // interval so a displayed value that rounded down can never reduce the reserve.
  const rate = displayedRate + PRINTED_RATE_ROUNDING_UPPER_PER_HOUR;
  return { product, rate, displayedRate };
}

function normalizedStateModifier(row) {
  const realm = row?.realm == null ? 0 : Number(row.realm);
  const kind = Number(row?.kind);
  const pct = Number(row?.pct);
  const sinceMs = Date.parse(row?.since);
  const untilMs = Date.parse(row?.until);
  if (realm !== 0 || !Number.isInteger(kind) || kind <= 0 || !Number.isFinite(pct) || pct === 0 ||
      Math.abs(pct) >= 100 || !Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) {
    return null;
  }
  return { realm, kind, pct, sinceMs, untilMs };
}

function reconcilePowderModifier(state, productModifier, inspectedMs, nowMs, horizonHours) {
  const sourceAsOfMs = Date.parse(state?.sources?.modifiers?.asOf);
  const stateMs = Date.parse(state?.t);
  if (state?.sources?.modifiers?.status !== 'ok' || !Array.isArray(state?.modifiers) ||
      !Number.isFinite(sourceAsOfMs) || !Number.isFinite(stateMs) || Math.abs(sourceAsOfMs - stateMs) > 5000) {
    return { ok: false, reason: 'authoritative production-modifier source is missing, stale, or detached from state' };
  }
  const rows = state.modifiers.map(normalizedStateModifier);
  if (rows.some(row => row == null)) {
    return { ok: false, reason: 'authoritative production-modifier data contains an invalid row' };
  }
  const powderRows = rows.filter(row => row.kind === POWDER_KIND);
  const active = powderRows.filter(row => row.sinceMs <= inspectedMs && inspectedMs < row.untilMs);
  if (active.length > 1) {
    return { ok: false, reason: 'multiple Coffee Powder modifiers overlap at the inspection time' };
  }
  const futureBoundaryMs = nowMs + horizonHours * 60 * 60 * 1000;
  if (powderRows.some(row => row.sinceMs > inspectedMs && row.sinceMs <= futureBoundaryMs)) {
    return { ok: false, reason: 'Coffee Powder modifier starts after the printed-rate inspection; reinspect after it starts' };
  }

  const status = productModifier?.status;
  if (!active.length) {
    return status === 'none'
      ? { ok: true, modifier: { status: 'none' }, source: 'product card + modifier API' }
      : { ok: false, reason: 'product-card modifier conflicts with the modifier API at inspection time' };
  }
  const expected = active[0];
  const direction = expected.pct > 0 ? 'increased' : 'decreased';
  const expiresAtMs = Date.parse(productModifier?.expiresAt);
  if (status !== 'active' || productModifier.direction !== direction ||
      Math.abs(Number(productModifier.percent) - Math.abs(expected.pct)) > 1e-9 ||
      !Number.isFinite(expiresAtMs) || expiresAtMs <= inspectedMs ||
      Math.abs(expiresAtMs - expected.untilMs) > 60 * 1000) {
    return { ok: false, reason: 'product-card modifier does not match the authoritative modifier API' };
  }
  return {
    ok: true,
    source: 'product card + modifier API',
    modifier: {
      status: 'active',
      direction,
      percent: Math.abs(expected.pct),
      since: new Date(expected.sinceMs).toISOString(),
      expiresAt: new Date(expected.untilMs).toISOString(),
    },
  };
}

function projectedRateEvidence(rate, modifier, inspectedMs, nowMs, horizonHours) {
  if (!modifier || (modifier.status !== 'none' && modifier.status !== 'active')) return null;
  if (modifier.status === 'none') {
    return {
      inspectedPowderPerHour: rate,
      currentPowderPerHour: rate,
      baselinePowderPerHour: rate,
      projectedPowder: rate * horizonHours,
      modifier: { status: 'none' },
    };
  }
  const percent = Number(modifier.percent);
  const expiresAtMs = Date.parse(modifier.expiresAt);
  const direction = modifier.direction;
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100 ||
      !Number.isFinite(expiresAtMs) || expiresAtMs <= inspectedMs ||
      !['increased', 'decreased'].includes(direction)) return null;
  const factor = direction === 'decreased' ? 1 - percent / 100 : 1 + percent / 100;
  const baseline = rate / factor;
  const modifiedHours = Math.min(
    horizonHours,
    Math.max(0, (expiresAtMs - nowMs) / (60 * 60 * 1000)),
  );
  const baselineHours = horizonHours - modifiedHours;
  return {
    inspectedPowderPerHour: rate,
    currentPowderPerHour: modifiedHours > 0 ? rate : baseline,
    baselinePowderPerHour: baseline,
    projectedPowder: rate * modifiedHours + baseline * baselineHours,
    modifier: {
      status: 'active',
      direction,
      percent,
      expiresAt: new Date(expiresAtMs).toISOString(),
      modifiedHours,
      baselineHours,
    },
  };
}

function collectMillCapacity(state, rateEvidence, inspectionCache, nowMs, maxAgeSeconds, horizonHours) {
  const mills = (state?.buildings || []).filter(building =>
    String(building.name || '').toLowerCase() === 'mill' || building.kindLetter === 'i');
  const rawIds = mills.map(building => Number(building.id));
  const expectedIds = rawIds.filter(id => Number.isSafeInteger(id) && id > 0);
  const duplicateBuildingIds = expectedIds.filter((id, index) => expectedIds.indexOf(id) !== index)
    .filter((id, index, rows) => rows.indexOf(id) === index);
  const buildingIdentityValid = expectedIds.length === mills.length && duplicateBuildingIds.length === 0;
  const latest = new Map();
  for (const row of inspectionRows(rateEvidence, inspectionCache)) {
    const id = Number(row?.buildingId);
    const inspectedMs = Date.parse(row?.inspectedAt);
    const expectedSource = Number.isInteger(id) && id > 0 ? `/b/${id}/` : null;
    if (!Number.isInteger(id) || !expectedIds.includes(id) || row?.ok !== true ||
        row?.source !== expectedSource || !Number.isFinite(inspectedMs)) continue;
    const ageSeconds = (nowMs - inspectedMs) / 1000;
    const powder = powderProduct(row);
    const modifierEvidence = powder == null
      ? null
      : reconcilePowderModifier(state, powder.product?.modifier, inspectedMs, nowMs, horizonHours);
    const projection = powder == null || !modifierEvidence?.ok
      ? null
      : projectedRateEvidence(powder.rate, modifierEvidence.modifier, inspectedMs, nowMs, horizonHours);
    const building = mills.find(candidate => Number(candidate.id) === id);
    const levelMatches = Number.isInteger(Number(row.level))
      && Number(row.level) === Number(building?.size);
    if (ageSeconds < -30 || ageSeconds > maxAgeSeconds || powder == null || !projection || !levelMatches) continue;
    const previous = latest.get(id);
    if (!previous || inspectedMs > previous.inspectedMs) {
      latest.set(id, {
        buildingId: id,
        level: Number(row.level),
        powderPerHour: powder.rate,
        displayedPowderPerHour: powder.displayedRate,
        printedRateRoundingUpperPerHour: PRINTED_RATE_ROUNDING_UPPER_PER_HOUR,
        inspectedPowderPerHour: projection.inspectedPowderPerHour,
        currentPowderPerHour: projection.currentPowderPerHour,
        baselinePowderPerHour: projection.baselinePowderPerHour,
        projectedPowder: projection.projectedPowder,
        modifier: { ...projection.modifier, evidenceSource: modifierEvidence.source },
        inspectedAt: new Date(inspectedMs).toISOString(),
        ageSeconds: Math.round(ageSeconds),
        source: expectedSource,
        inspectedMs,
      });
    }
  }
  const missingBuildingIds = expectedIds.filter(id => !latest.has(id));
  const rates = expectedIds.filter(id => latest.has(id)).map(id => {
    const { inspectedMs, ...entry } = latest.get(id);
    return entry;
  });
  const currentPowderPerHour = missingBuildingIds.length === 0 && rates.length
    ? rates.reduce((sum, row) => sum + row.currentPowderPerHour, 0)
    : null;
  const projectedPowder = missingBuildingIds.length === 0 && rates.length
    ? rates.reduce((sum, row) => sum + row.projectedPowder, 0)
    : null;
  return {
    status: buildingIdentityValid && expectedIds.length > 0 && missingBuildingIds.length === 0 ? 'fresh' : 'unknown',
    currentPowderPerHour,
    projectedPowder,
    powderPerHour: projectedPowder == null ? null : projectedPowder / horizonHours,
    expectedBuildingIds: expectedIds,
    missingBuildingIds,
    buildingIdentityValid,
    invalidBuildingCount: mills.length - expectedIds.length,
    duplicateBuildingIds,
    rates,
  };
}

function stockByKind(state) {
  const stockAsOfMs = Date.parse(state?.sources?.stock?.asOf);
  const stateMs = Date.parse(state?.t);
  if (!Array.isArray(state?.stock) || state?.warehouse?.complete !== true ||
      state?.warehouse?.allPositiveProductsIncluded !== true || state?.sources?.stock?.status !== 'ok' ||
      !Number.isFinite(stockAsOfMs) || !Number.isFinite(stateMs) || Math.abs(stockAsOfMs - stateMs) > 5000) {
    return null;
  }
  const out = new Map();
  for (const row of state.stock) {
    const kind = Number(row?.kind);
    if (!Number.isInteger(kind) || kind <= 0 || out.has(kind) || row?.known !== true) return null;
    const blocked = row?.blockedAmount == null
      ? 0
      : finiteNonNegative(row.blockedAmount);
    if (blocked == null) return null;
    const amount = row?.availableAmount == null && blocked > 0
      ? null
      : finiteNonNegative(row?.availableAmount ?? row?.amount);
    const totalAmount = finiteNonNegative(row?.amount);
    if (amount == null || totalAmount == null || Math.abs(totalAmount - amount - blocked) > 1e-6) return null;
    const current = {
      kind,
      name: row.name || `kind ${kind}`,
      stock: 0,
      totalStock: 0,
      blockedStock: 0,
    };
    current.stock += amount;
    current.totalStock += totalAmount;
    current.blockedStock += blocked;
    out.set(kind, current);
  }
  for (const kind of REQUIRED_KINDS) {
    if (!out.has(kind)) out.set(kind, {
      kind, name: `kind ${kind}`, stock: 0, totalStock: 0, blockedStock: 0,
    });
  }
  return out;
}

function unknownItems(stock, reason) {
  const items = {};
  for (const row of stock?.values?.() || []) {
    items[row.kind] = {
      kind: row.kind,
      name: row.name,
      stock: Math.floor(row.stock),
      totalStock: Math.floor(row.totalStock ?? row.stock),
      blockedStock: Math.floor(row.blockedStock || 0),
      reserve: null,
      surplus: null,
      sellable: 0,
      transportPerUnit: null,
      maxByTransport: null,
      status: 'unknown',
      evidence: { reason },
    };
  }
  return items;
}

function calculateCoffeeReservePolicy({
  state,
  rateEvidence = null,
  inspectionCache = null,
  facts,
  horizonHours = 24,
  bufferPct = 0.10,
  nowMs = Date.now(),
  maxRateAgeSeconds = DEFAULT_MAX_RATE_AGE_SECONDS,
} = {}) {
  const horizon = Number(horizonHours);
  const buffer = Number(bufferPct);
  const now = Number(nowMs);
  const maxAge = Number(maxRateAgeSeconds);
  if (!Number.isFinite(horizon) || horizon <= 0) throw new Error('horizonHours must be positive');
  if (!Number.isFinite(buffer) || buffer < 0) throw new Error('bufferPct must be non-negative');
  if (!Number.isFinite(now)) throw new Error('nowMs must be finite');
  if (!Number.isFinite(maxAge) || maxAge <= 0) throw new Error('maxRateAgeSeconds must be positive');

  const asOf = state?.t || new Date(now).toISOString();
  const stock = stockByKind(state);
  const resources = factsResources(facts);
  const recipe = deriveRecipe(resources);
  const millCapacity = collectMillCapacity(
    state, rateEvidence, inspectionCache, now, maxAge, horizon);
  const base = { asOf, complete: false, status: 'unknown', horizonHours: horizon, bufferPct: buffer, millCapacity };

  // Printed building rates are the 1x figure. Measured 2026-08-03: a Farm page printed 889.63
  // Seeds/h while the encyclopedia printed 2,668.89/h "(3x)" — exactly three times. Reserving from
  // the printed rate during acceleration therefore under-reserves the whole chain by the
  // multiplier, and the surplus it frees is inventory the Mills are about to eat. Refuse to answer
  // rather than answer wrongly; the flag lets the journal gate tell this apart from a missing
  // inspection, which is retryable, and this is not.
  const acceleration = state?.levelingProgress?.acceleration;
  const accelerationUnmodelled = acceleration != null &&
    (acceleration.active === 'UNKNOWN' || (acceleration.active === true && Number(acceleration.multiplier) !== 1));

  // Checked before anything else. Whether a multiplier is running is a property of the whole
  // computation, not of the stock or recipe feeds, and the gate must see the flag even when those
  // are also missing — otherwise the wake gets a retryable-looking reason for a state no retry can
  // fix, which is the livelock shape.
  if (accelerationUnmodelled) {
    const reason = `a ${acceleration.multiplier ?? 'UNKNOWN'}x production multiplier is active until ${acceleration.until ?? 'UNKNOWN'}; printed rates are the 1x figure, so a reserve computed from them would be short by that factor`;
    return { ...base, accelerationUnmodelled: true, acceleration, items: unknownItems(stock, reason) };
  }

  let reason = null;
  if (!stock) reason = 'warehouse stock is incomplete or unknown';
  else if (!recipe) reason = 'Coffee recipe facts are missing or do not match the verified 10/10/6/1.2 chain';
  else if (millCapacity.status !== 'fresh') reason = 'fresh per-building Coffee Powder rates do not cover every current Mill';
  if (reason) return { ...base, items: unknownItems(stock, reason) };

  const transportAvailable = Math.floor(stock.get(TRANSPORT_KIND)?.stock || 0);
  const items = {};
  let complete = true;
  for (const row of stock.values()) {
    const kind = row.kind;
    const transport = finiteNonNegative(resources[kind]?.transportation);
    const supportedTransport = transport === 0 || transport === 0.1 || transport === 1;
    const reserve = kind === TRANSPORT_KIND
      ? Math.floor(row.stock)
      : Math.ceil((recipe[kind] || 0) * millCapacity.projectedPowder * (1 + buffer));
    const surplus = Math.max(0, Math.floor(row.stock - reserve));
    const maxByTransport = transport === 0 ? null
      : (supportedTransport ? Math.floor((transportAvailable + 1e-9) / transport) : null);
    const sellable = supportedTransport
      ? Math.floor(transport === 0 ? surplus : Math.min(surplus, maxByTransport))
      : 0;
    if (!supportedTransport) complete = false;
    items[kind] = {
      kind,
      name: row.name,
      stock: Math.floor(row.stock),
      totalStock: Math.floor(row.totalStock ?? row.stock),
      blockedStock: Math.floor(row.blockedStock || 0),
      reserve,
      surplus,
      sellable,
      transportPerUnit: supportedTransport ? transport : null,
      maxByTransport,
      status: supportedTransport ? 'ok' : 'unknown',
      evidence: {
        stockAsOf: state.t || null,
        powderPerHour: millCapacity.powderPerHour,
        currentPowderPerHour: millCapacity.currentPowderPerHour,
        projectedPowder: millCapacity.projectedPowder,
        unitsPerPowder: recipe[kind] || 0,
        horizonHours: horizon,
        bufferPct: buffer,
        transportAvailable,
        transportScope: 'Per-item maximum; sellable values are not an additive allocation.',
        activeOrders: 'Inputs for active production were already deducted by the game and are not subtracted again.',
        reason: kind === TRANSPORT_KIND ? 'Transport is held as shared exchange capacity.' : null,
      },
    };
  }

  return {
    ...base,
    complete,
    status: complete ? 'ok' : 'unknown',
    millCapacity,
    items,
  };
}

module.exports = {
  calculateCoffeeReservePolicy,
  deriveRecipe,
};
