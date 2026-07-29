'use strict';

function canonicalResourceName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function explicitFiniteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseExplicitCurrency(value) {
  if (value == null || typeof value === 'boolean') return null;
  const normalized = String(value).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function capturedCashSnapshot(state, nowMs = Date.now(), maxAgeSeconds = 300, maxFutureSeconds = 30) {
  const rawValue = state?.money;
  const value = rawValue == null || rawValue === '' ? null : Number(rawValue);
  const asOfMs = Date.parse(state?.t);
  const now = Number(nowMs);
  const ageSeconds = Number.isFinite(asOfMs) && Number.isFinite(now)
    ? Math.round((now - asOfMs) / 1000)
    : null;
  const fresh = Number.isFinite(value) && ageSeconds != null
    && ageSeconds >= -Math.abs(Number(maxFutureSeconds))
    && ageSeconds <= Math.abs(Number(maxAgeSeconds));
  return {
    value: fresh ? value : null,
    source: '.state.json',
    asOf: state?.t || null,
    ageSeconds,
  };
}

/**
 * Build a budget-safe market order from an authoritative market-book response.
 *
 * `maxUnitPrice` is a hard ceiling, not a sizing hint. When it is absent, the
 * order is limited to the current best-ask level so a thin first lot cannot
 * silently walk the book at worse prices.
 */
function planMarketPurchase(rows, maxSpend, maxUnitPrice = null) {
  const budget = Number(maxSpend);
  if (!Number.isFinite(budget) || budget <= 0) {
    return { ok: false, reason: 'maxSpend must be a positive finite number' };
  }

  const book = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      price: Number(row?.price),
      quantity: Math.floor(Number(row?.quantity)),
    }))
    .filter((row) => Number.isFinite(row.price) && row.price > 0
      && Number.isSafeInteger(row.quantity) && row.quantity > 0)
    .sort((a, b) => a.price - b.price);
  if (!book.length) return { ok: false, reason: 'market book has no positive asks' };

  const topAsk = book[0].price;
  const suppliedCeiling = maxUnitPrice == null ? null : Number(maxUnitPrice);
  if (suppliedCeiling != null && (!Number.isFinite(suppliedCeiling) || suppliedCeiling <= 0)) {
    return { ok: false, reason: 'ask must be a positive finite price or null', topAsk };
  }
  const priceCeiling = suppliedCeiling == null ? topAsk : suppliedCeiling;
  if (topAsk > priceCeiling + 1e-9) {
    return {
      ok: false,
      reason: `best ask $${topAsk} exceeds the $${priceCeiling} ceiling`,
      topAsk,
      priceCeiling,
    };
  }

  let quantity = 0;
  let estimatedCost = 0;
  let highestFillPrice = null;
  for (const row of book) {
    if (row.price > priceCeiling + 1e-9) break;
    const affordable = Math.floor((budget - estimatedCost + 1e-9) / row.price);
    if (affordable <= 0) break;
    const take = Math.min(row.quantity, affordable);
    quantity += take;
    estimatedCost += take * row.price;
    highestFillPrice = row.price;
    if (take < row.quantity) break;
  }
  estimatedCost = Math.round(estimatedCost * 1e6) / 1e6;
  if (quantity < 1) {
    return {
      ok: false,
      reason: `maxSpend $${budget} cannot buy one unit at the current ask`,
      topAsk,
      priceCeiling,
      estimatedCost: 0,
      quantity: 0,
    };
  }
  if (estimatedCost > budget + 1e-6) {
    return { ok: false, reason: 'calculated order exceeds maxSpend', topAsk, priceCeiling };
  }
  return {
    ok: true,
    quantity,
    estimatedCost,
    topAsk,
    priceCeiling,
    highestFillPrice,
  };
}

function quoteFixedMarketPurchase(rows, quantity, maxSpend, maxUnitPrice) {
  const wanted = Number(quantity);
  const budget = Number(maxSpend);
  const ceiling = Number(maxUnitPrice);
  if (!Number.isSafeInteger(wanted) || wanted <= 0
      || !Number.isFinite(budget) || budget <= 0
      || !Number.isFinite(ceiling) || ceiling <= 0) {
    return { ok: false, reason: 'fixed market quote inputs are invalid' };
  }
  const book = (Array.isArray(rows) ? rows : [])
    .map(row => ({ price: Number(row?.price), quantity: Math.floor(Number(row?.quantity)) }))
    .filter(row => Number.isFinite(row.price) && row.price > 0
      && Number.isSafeInteger(row.quantity) && row.quantity > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = wanted;
  let estimatedCost = 0;
  let highestFillPrice = null;
  for (const row of book) {
    if (row.price > ceiling + 1e-9) break;
    const take = Math.min(remaining, row.quantity);
    estimatedCost += take * row.price;
    remaining -= take;
    if (take > 0) highestFillPrice = row.price;
    if (remaining === 0) break;
  }
  estimatedCost = Math.round(estimatedCost * 1e6) / 1e6;
  if (remaining > 0) return { ok: false,
    reason: 'current book no longer has enough quantity within the authorized ask ceiling',
    quantity: wanted, unfilled: remaining, estimatedCost, priceCeiling: ceiling };
  if (estimatedCost > budget + 1e-6) return { ok: false,
    reason: `current fixed-quantity cost $${estimatedCost} exceeds maxSpend $${budget}`,
    quantity: wanted, estimatedCost, priceCeiling: ceiling, highestFillPrice };
  return { ok: true, quantity: wanted, estimatedCost,
    priceCeiling: ceiling, highestFillPrice };
}

function buildingHasBusyResource(buildings, buildingId, resourceName, resourceKind = null) {
  if (!Array.isArray(buildings) || !Number.isFinite(Number(buildingId))) return false;
  // Keep the normalizer local so this function remains self-contained when act.js serializes it
  // into the page context with Function#toString.
  const canon = (value) => {
    const normalized = String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();
    return normalized === 'COFFEE GROUND' ? 'COFFEE POWDER' : normalized;
  };
  const expectedName = canon(resourceName);
  const expectedKind = resourceKind == null ? null : Number(resourceKind);
  return buildings.some((building) => {
    if (Number(building?.id) !== Number(buildingId) || !building?.busy) return false;
    const resource = building.busy.resource || {};
    const actualKindRaw = resource.kind ?? building.busy.makingKind;
    const actualKind = actualKindRaw == null ? null : Number(actualKindRaw);
    if (expectedKind != null && Number.isFinite(expectedKind)
        && actualKind != null && Number.isFinite(actualKind)) {
      return actualKind === expectedKind;
    }
    const actualName = resource.name
      || resource.image
      || building.busy.makingName
      || building.busy.resourceName;
    return expectedName && canon(actualName) === expectedName;
  });
}

function bondOfferMatches(current, expectedAmount, expectedInterest) {
  if (current?.unsoldOfferAmountDollars == null || current.unsoldOfferAmountDollars === ''
      || current?.offerInterestPctPerDay == null || current.offerInterestPctPerDay === ''
      || expectedAmount == null || expectedAmount === ''
      || expectedInterest == null || expectedInterest === '') return false;
  const amount = Number(current?.unsoldOfferAmountDollars);
  const interest = Number(current?.offerInterestPctPerDay);
  const wantedAmount = Number(expectedAmount);
  const wantedInterest = Number(expectedInterest);
  return Number.isFinite(amount)
    && Number.isFinite(interest)
    && Number.isFinite(wantedAmount)
    && Number.isFinite(wantedInterest)
    && Math.abs(amount - wantedAmount) < 0.005
    && Math.abs(interest - wantedInterest) < 0.000005;
}

function evaluateSpendGuard(cost, maxCost, cash, minCashAfter) {
  if (cost == null || cost === '' || maxCost == null || maxCost === ''
      || cash == null || cash === '' || minCashAfter == null || minCashAfter === '') {
    return { ok: false, reason: 'live spend, cap, cash, and reserve must all be explicitly known' };
  }
  const spend = Number(cost);
  const cap = Number(maxCost);
  const available = Number(cash);
  const reserve = Number(minCashAfter);
  if (!Number.isFinite(spend) || spend < 0) {
    return { ok: false, reason: 'live spend is not a non-negative finite number' };
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    return { ok: false, reason: 'maxCost is not a positive finite number' };
  }
  if (!Number.isFinite(available) || !Number.isFinite(reserve) || reserve < 0) {
    return { ok: false, reason: 'cash or minCashAfter is not verifiable' };
  }
  if (spend > cap + 1e-9) {
    return { ok: false, reason: `live spend $${spend} exceeds maxCost $${cap}` };
  }
  if (available - spend < reserve - 1e-9) {
    return {
      ok: false,
      reason: `live spend would leave $${available - spend}, below reserve $${reserve}`,
    };
  }
  return { ok: true, cashAfter: available - spend };
}

function verifyBuildingRemoved(beforeRows, afterRows, buildingId) {
  if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
    return { ok: false, reason: 'authoritative buildings payload is unavailable' };
  }
  const id = Number(buildingId);
  if (!Number.isFinite(id)) return { ok: false, reason: 'buildingId is invalid' };
  const existedBefore = beforeRows.some((building) => Number(building?.id) === id);
  const existsAfter = afterRows.some((building) => Number(building?.id) === id);
  if (!existedBefore) {
    return { ok: false, reason: 'target building was not present before the scrap click' };
  }
  if (existsAfter) return { ok: false, reason: 'target building is still present after the scrap click' };
  return { ok: true };
}

function validateRebuildIdleEvidence(beforeBuilding, idleEvidence, nowMs = Date.now()) {
  const canon = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const allowed = new Set(['QUARRY', 'MINE', 'OIL RIG']);
  const buildingId = Number(beforeBuilding?.id);
  const level = Number(beforeBuilding?.size);
  const name = canon(beforeBuilding?.name);
  if (!Number.isSafeInteger(buildingId) || buildingId <= 0 || !allowed.has(name) || level !== 1) {
    return { ok: false, reason: 'rebuild idle evidence is not bound to an exact level-1 abundance building' };
  }
  if (!idleEvidence || Number(idleEvidence.buildingId) !== buildingId ||
      canon(idleEvidence.buildingName) !== name || Number(idleEvidence.level) !== level) {
    return { ok: false, reason: 'rebuild idle evidence is missing or bound to another building' };
  }
  const observedAtMs = Date.parse(idleEvidence.observedAt);
  const currentMs = Number(nowMs);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(currentMs) ||
      observedAtMs > currentMs + 10e3 || currentMs - observedAtMs > 60e3) {
    return { ok: false, reason: 'rebuild idle evidence is stale or has an invalid timestamp' };
  }
  if (idleEvidence.source === 'authoritative-api') {
    if (!Object.prototype.hasOwnProperty.call(beforeBuilding, 'busy') || beforeBuilding.busy !== null) {
      return { ok: false, reason: 'authoritative rebuild idle evidence disagrees with the API row' };
    }
  } else if (idleEvidence.source === 'page-derived') {
    if (Object.prototype.hasOwnProperty.call(beforeBuilding, 'busy') && beforeBuilding.busy !== undefined) {
      return { ok: false, reason: 'page-derived idle cannot override an authoritative busy value' };
    }
    if (idleEvidence.path !== `/b/${buildingId}/` || idleEvidence.construction !== false ||
        idleEvidence.orderBusy !== false || idleEvidence.collectible !== false ||
        idleEvidence.orderAvailable !== true || idleEvidence.rebuildOpenerCount !== 1 ||
        idleEvidence.rebuildOpenerEnabled !== true) {
      return { ok: false, reason: 'page-derived rebuild idle evidence is incomplete or contradictory' };
    }
  } else {
    return { ok: false, reason: 'rebuild idle evidence source is not trusted' };
  }
  return {
    ok: true,
    evidence: { ...idleEvidence, status: 'validated' },
  };
}

function verifyBuildingRebuildStarted(beforeRows, afterRows, buildingId, idleEvidence = null) {
  if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
    return { ok: false, reason: 'authoritative buildings payload is unavailable' };
  }
  const id = Number(buildingId);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: 'buildingId is invalid' };
  const before = beforeRows.find(building => Number(building?.id) === id);
  if (!before) return { ok: false, reason: 'rebuild target was not present before the click' };
  const idle = validateRebuildIdleEvidence(before, idleEvidence);
  if (!idle.ok) return { ok: false, reason: idle.reason };
  const canon = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const expectedName = canon(before.name);
  const beforeIds = new Set(beforeRows.map(building => String(building?.id)));
  const sameId = afterRows.filter(building => Number(building?.id) === id);
  const replacements = afterRows.filter(building => !beforeIds.has(String(building?.id)) &&
    canon(building?.name) === expectedName);
  const candidates = sameId.length === 1 ? sameId : replacements;
  if (sameId.length > 1 || (sameId.length === 0 && replacements.length !== 1)) {
    return { ok: false, reason: `expected one rebuilt ${before.name}, found ${candidates.length}` };
  }
  const rebuilt = candidates[0];
  if (canon(rebuilt?.name) !== expectedName) {
    return { ok: false, reason: 'rebuilt building type does not match the target' };
  }
  if (Number(rebuilt?.size) !== 1) {
    return { ok: false, reason: 'rebuilt abundance building is not level 1' };
  }
  if (!rebuilt?.busy) {
    return { ok: false, reason: 'rebuilt building is not authoritatively under construction' };
  }
  const busyCategory = String(rebuilt.busy.category || rebuilt.busy.type || '').trim().toLowerCase();
  if (rebuilt.busy.expanding !== true && !['b', 'construction'].includes(busyCategory)) {
    return { ok: false, reason: 'rebuilt building busy state is not authoritative construction' };
  }
  const rebuiltId = Number(rebuilt.id);
  if (!Number.isSafeInteger(rebuiltId) || rebuiltId <= 0) {
    return { ok: false, reason: 'rebuilt building has no valid authoritative building ID' };
  }
  const completesAtMs = Date.parse(rebuilt.busy.endsAt);
  return {
    ok: true,
    buildingId: rebuiltId,
    replacedBuildingId: id,
    ...(Number.isFinite(completesAtMs) ? {
      completesAt: new Date(completesAtMs).toISOString(),
    } : {}),
  };
}

function buildingHasRobotSpecialization(buildings, buildingId, specialization, resourceKind = null) {
  if (!Array.isArray(buildings)) return false;
  const building = buildings.find((row) => Number(row?.id) === Number(buildingId));
  if (!building || building.robotsSpecialization == null) return false;
  const expectedKind = resourceKind == null ? null : Number(resourceKind);
  const actualKind = Number(building.robotsSpecialization);
  if (expectedKind != null && Number.isFinite(expectedKind) && Number.isFinite(actualKind)) {
    return expectedKind === actualKind;
  }
  const canon = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  return canon(building.robotsSpecialization) === canon(specialization);
}

function verifyNewBuildingStarted(beforeRows, afterRows, buildingName) {
  if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
    return { ok: false, reason: 'authoritative buildings payload is unavailable' };
  }
  const beforeIds = new Set(beforeRows.map((building) => String(building?.id)));
  const canon = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const wanted = canon(buildingName);
  const created = afterRows.filter((building) => !beforeIds.has(String(building?.id))
    && canon(building?.name) === wanted);
  if (created.length !== 1) {
    return { ok: false, reason: `expected one new ${buildingName} building, found ${created.length}` };
  }
  if (!created[0].busy) {
    return { ok: false, reason: `new ${buildingName} exists but construction is not reported busy` };
  }
  const buildingId = Number(created[0].id);
  if (!Number.isSafeInteger(buildingId) || buildingId <= 0) {
    return { ok: false, reason: `new ${buildingName} has no valid authoritative building ID` };
  }
  return { ok: true, buildingId };
}

function verifyBuildingUpgradeStarted(beforeRows, afterRows, buildingId) {
  if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
    return { ok: false, reason: 'authoritative buildings payload is unavailable' };
  }
  const id = Number(buildingId);
  const before = beforeRows.find((building) => Number(building?.id) === id);
  const after = afterRows.find((building) => Number(building?.id) === id);
  if (!before || !after) return { ok: false, reason: 'exact upgrade target is missing from a buildings payload' };
  const beforeSize = Number(before.size);
  const afterSize = Number(after.size);
  if (!Number.isSafeInteger(beforeSize) || beforeSize < 1
      || !Number.isSafeInteger(afterSize) || afterSize < 1) {
    return { ok: false, reason: 'target level evidence is invalid' };
  }
  if (!(afterSize > beforeSize)) {
    return { ok: false, reason: `target level did not increase (${beforeSize} -> ${afterSize})` };
  }
  if (!after.busy) return { ok: false, reason: 'target level increased but construction is not reported busy' };
  return { ok: true, fromLevel: beforeSize, toLevel: afterSize };
}

function verifyCollectionResult(before, after, clickedBuildingIds) {
  const ids = Array.isArray(clickedBuildingIds)
    ? clickedBuildingIds.map(Number)
    : [];
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
      || new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'clicked building IDs must be unique positive safe integers' };
  }
  if (!Array.isArray(before?.buildings) || !Array.isArray(after?.buildings)
      || !Array.isArray(before?.resources) || !Array.isArray(after?.resources)) {
    return { ok: false, reason: 'authoritative before/after buildings and resources are required' };
  }

  const stockTotals = (rows) => {
    const totals = new Map();
    for (const row of rows) {
      const kind = explicitFiniteNumber(row?.kind);
      const amount = explicitFiniteNumber(row?.amount);
      if (!Number.isSafeInteger(kind) || kind <= 0 || amount == null || amount < 0) return null;
      totals.set(kind, (totals.get(kind) || 0) + amount);
    }
    return totals;
  };
  const beforeStock = stockTotals(before.resources);
  const afterStock = stockTotals(after.resources);
  if (!beforeStock || !afterStock) {
    return { ok: false, reason: 'authoritative resource snapshots contain an invalid row' };
  }
  const requiredKinds = new Set();
  let requiresCashIncrease = false;
  const transitions = [];

  for (const id of ids) {
    const beforeMatches = before.buildings.filter(row => Number(row?.id) === id);
    const afterMatches = after.buildings.filter(row => Number(row?.id) === id);
    if (beforeMatches.length !== 1 || afterMatches.length !== 1) {
      return { ok: false, reason: `exact building ${id} is missing or duplicated in a snapshot` };
    }
    const beforeBuilding = beforeMatches[0];
    const afterBuilding = afterMatches[0];
    if (!beforeBuilding || !afterBuilding || !beforeBuilding.busy) {
      return { ok: false, reason: `exact building ${id} is missing required before/after busy evidence` };
    }
    const beforeBusy = beforeBuilding.busy;
    const afterBusy = afterBuilding.busy || null;
    const beforeJobId = explicitFiniteNumber(beforeBusy.id);
    const afterJobId = explicitFiniteNumber(afterBusy?.id);
    const jobChanged = afterBusy == null
      || (beforeJobId != null && afterJobId != null && beforeJobId !== afterJobId);

    const resourceKind = explicitFiniteNumber(beforeBusy.resource?.kind);
    const beforeAmount = explicitFiniteNumber(beforeBusy.resource?.amountAvailableNow);
    const afterAmount = explicitFiniteNumber(afterBusy?.resource?.amountAvailableNow);
    const saleKind = explicitFiniteNumber(beforeBusy.sales_order?.kind);
    const beforeProfit = explicitFiniteNumber(beforeBusy.sales_order?.profitAvailableNow);
    const afterProfit = explicitFiniteNumber(afterBusy?.sales_order?.profitAvailableNow);
    const fetchCleared = beforeBusy.canFetch === true && afterBusy?.canFetch === false;
    const wasCollectible = beforeBusy.canFetch === true
      || (beforeAmount != null && beforeAmount > 0)
      || (beforeProfit != null && beforeProfit > 0);
    if (!wasCollectible) {
      return { ok: false, reason: `building ${id} was not authoritatively collectible before click` };
    }

    let transition = jobChanged || fetchCleared;
    let type = 'completion';
    if (Number.isSafeInteger(resourceKind) && resourceKind > 0) {
      requiredKinds.add(resourceKind);
      type = 'resource';
      transition = transition || (beforeAmount != null && beforeAmount > 0
        && afterAmount != null && afterAmount < beforeAmount - 1e-9);
    } else if (Number.isSafeInteger(saleKind) && saleKind > 0) {
      requiresCashIncrease = true;
      type = 'cash';
      transition = transition || (beforeProfit != null && beforeProfit > 0
        && afterProfit != null && afterProfit < beforeProfit - 1e-9);
    }
    if (!transition) {
      return { ok: false,
        reason: `building ${id} did not show an exact collectible-value or job transition` };
    }
    transitions.push({ buildingId: id, type, jobChanged, fetchCleared });
  }

  for (const kind of requiredKinds) {
    const prior = beforeStock.get(kind) || 0;
    const current = afterStock.get(kind) || 0;
    if (!(current > prior + 1e-9)) {
      return { ok: false, reason: `resource ${kind} stock did not increase after collection` };
    }
  }
  if (requiresCashIncrease) {
    const beforeMoney = explicitFiniteNumber(before.money);
    const afterMoney = explicitFiniteNumber(after.money);
    if (beforeMoney == null || afterMoney == null || !(afterMoney > beforeMoney + 1e-9)) {
      return { ok: false, reason: 'company cash did not increase after retail collection' };
    }
  }
  return { ok: true, transitions, resourceKinds: [...requiredKinds], cashIncreased: requiresCashIncrease };
}

module.exports = {
  bondOfferMatches,
  buildingHasRobotSpecialization,
  buildingHasBusyResource,
  capturedCashSnapshot,
  canonicalResourceName,
  explicitFiniteNumber,
  parseExplicitCurrency,
  evaluateSpendGuard,
  planMarketPurchase,
  quoteFixedMarketPurchase,
  verifyBuildingRemoved,
  validateRebuildIdleEvidence,
  verifyBuildingRebuildStarted,
  verifyBuildingUpgradeStarted,
  verifyCollectionResult,
  verifyNewBuildingStarted,
};
