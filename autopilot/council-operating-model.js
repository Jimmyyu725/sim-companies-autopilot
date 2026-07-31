'use strict';

// Build a compact, deterministic Coffee operating model for Council. The model intentionally
// separates measured values from bounded projections. It never turns an absent value into zero.

const COFFEE_KINDS = Object.freeze({
  power: 1,
  water: 2,
  seeds: 66,
  beans: 118,
  powder: 119,
});

const PORTFOLIO_BUILDING_NAMES = new Set([
  'farm',
  'mill',
  'grocery store',
  'power plant',
  'water reservoir',
]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function round(value, digits = 4) {
  const number = finiteNumber(value);
  if (number == null) return null;
  const scale = 10 ** digits;
  return Math.round((number + Number.EPSILON) * scale) / scale;
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase();
}

function selectPortfolioBuildings(state, focusBuildingId = null, limit = 24) {
  const buildings = Array.isArray(state?.buildings) ? state.buildings : [];
  const selected = [];
  const seen = new Set();
  const add = building => {
    const id = Number(building?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || selected.length >= limit) return;
    seen.add(id);
    selected.push({
      buildingId: id,
      name: String(building?.name || 'UNKNOWN'),
      level: Number.isSafeInteger(Number(building?.size)) ? Number(building.size) : null,
      category: building?.category || null,
    });
  };

  if (focusBuildingId != null) {
    add(buildings.find(building => Number(building?.id) === Number(focusBuildingId)) || {
      id: focusBuildingId,
      name: 'UNKNOWN',
      size: null,
      category: null,
    });
  }
  for (const building of buildings) {
    if (building?.freeAndLocked === true) continue;
    if (PORTFOLIO_BUILDING_NAMES.has(normalizedName(building?.name))) add(building);
  }
  return selected;
}

function compactBuildingInspection(raw, stateBuilding = null) {
  const buildingId = Number(raw?.buildingId ?? stateBuilding?.id);
  const level = Number(raw?.level ?? stateBuilding?.size);
  const products = Array.isArray(raw?.products)
    ? raw.products
      .filter(product => Object.values(COFFEE_KINDS).includes(Number(product?.kind)))
      .map(product => ({
        kind: Number(product.kind),
        name: String(product.name || 'UNKNOWN').slice(0, 80),
        productionPerHour: positiveNumber(product.productionPerHour),
        modifier: product.modifier && typeof product.modifier === 'object'
          ? {
            status: product.modifier.status || 'unknown',
            direction: product.modifier.direction || null,
            percent: finiteNumber(product.modifier.percent),
            expiresAt: product.modifier.expiresAt || null,
          }
          : { status: 'unknown', direction: null, percent: null, expiresAt: null },
      }))
    : [];
  const currentJob = stateBuilding?.busy && typeof stateBuilding.busy === 'object'
    ? {
      type: stateBuilding.busy.type || null,
      makingKind: stateBuilding.busy.makingKind ?? null,
      amount: finiteNumber(stateBuilding.busy.amount),
      amountSemantics: stateBuilding.busy.amountSemantics || null,
      remainingProfit: finiteNumber(stateBuilding.busy.remainingProfit),
      price: finiteNumber(stateBuilding.busy.price),
      startedAt: stateBuilding.busy.startedAt || null,
      endsAt: stateBuilding.busy.endsAt || null,
    }
    : null;
  return {
    ok: raw?.ok === true && raw?.pageOk !== false,
    buildingId: Number.isSafeInteger(buildingId) && buildingId > 0 ? buildingId : null,
    name: String(stateBuilding?.name || raw?.building || 'UNKNOWN'),
    level: Number.isSafeInteger(level) && level > 0 ? level : null,
    category: stateBuilding?.category || null,
    source: raw?.source || null,
    inspectedAt: raw?.inspectedAt || null,
    wagesPerHour: finiteNumber(raw?.wagesPerHour),
    busy: raw?.busy === true ? true : (raw?.busy === false ? false : null),
    busyType: raw?.busyType || stateBuilding?.busy?.type || null,
    currentJob,
    products,
    error: raw?.ok === true ? null : String(raw?.error || raw?.reason || 'inspection failed').slice(0, 180),
  };
}

function retailEvidenceFromState(state, curve = null, nowMs = Date.parse(state?.t)) {
  const buildings = Array.isArray(state?.buildings) ? state.buildings : [];
  const store = buildings.find(building => normalizedName(building?.name) === 'grocery store');
  const busy = store?.busy && typeof store.busy === 'object' ? store.busy : null;
  const result = {
    status: 'UNKNOWN',
    observedAt: state?.t || null,
    buildingId: Number.isSafeInteger(Number(store?.id)) ? Number(store.id) : null,
    level: Number.isSafeInteger(Number(store?.size)) ? Number(store.size) : null,
    source: '/api/v2/companies/me/buildings/',
    activeOrder: null,
    curve: null,
  };

  if (busy?.type === 'sale' && Number(busy.makingKind) === COFFEE_KINDS.powder) {
    const remainingUnits = positiveNumber(busy.amount);
    const remainingProfit = finiteNumber(busy.remainingProfit);
    const endMs = Date.parse(busy.endsAt);
    const remainingHours = Number.isFinite(nowMs) && Number.isFinite(endMs) && endMs > nowMs
      ? (endMs - nowMs) / 3_600_000
      : null;
    const unitsPerHour = remainingUnits != null && remainingHours != null
      ? remainingUnits / remainingHours
      : null;
    const profitPerUnit = remainingUnits != null && remainingProfit != null
      ? remainingProfit / remainingUnits
      : null;
    const profitPerHour = remainingProfit != null && remainingHours != null
      ? remainingProfit / remainingHours
      : null;
    result.status = unitsPerHour != null && profitPerUnit != null
      ? 'ACTIVE_ORDER'
      : 'PARTIAL_ACTIVE_ORDER';
    result.activeOrder = {
      kind: COFFEE_KINDS.powder,
      price: finiteNumber(busy.price),
      remainingUnits,
      remainingProfit,
      remainingHours: round(remainingHours),
      unitsPerHour: round(unitsPerHour),
      profitPerUnit: round(profitPerUnit),
      profitPerHour: round(profitPerHour),
      endsAt: busy.endsAt || null,
      amountSemantics: busy.amountSemantics || 'sales-order-remaining',
    };
  } else if (curve?.status === 'LIVE_CURVE' && curve?.best) {
    const profitPerUnit = positiveNumber(curve.best.profitPerUnit);
    const profitPerHour = positiveNumber(curve.best.profitPerHour);
    const unitsPerHour = profitPerUnit != null && profitPerHour != null
      ? profitPerHour / profitPerUnit
      : null;
    result.status = 'LIVE_CURVE';
    result.source = curve.source || result.source;
    result.curve = {
      ...curve,
      best: { ...curve.best, unitsPerHour: round(unitsPerHour) },
    };
  } else if (busy) {
    result.status = 'STORE_BUSY_NON_COFFEE';
  } else if (store && store?.activity?.busy === false) {
    result.status = curve?.status || 'IDLE_CURVE_UNAVAILABLE';
  } else if (store && store.busy == null) {
    result.status = curve?.status || 'IDLE_CURVE_UNAVAILABLE';
  }
  return result;
}

function productRate(inspection, kind, normalizeModifier = false) {
  const product = (inspection?.products || []).find(row => Number(row?.kind) === Number(kind));
  const rate = positiveNumber(product?.productionPerHour);
  if (rate == null || !normalizeModifier) return rate;
  const modifier = product?.modifier;
  const percent = finiteNumber(modifier?.percent);
  if (modifier?.status !== 'active' || percent == null || percent <= -100) return rate;
  return rate / (1 + percent / 100);
}

function rateTotals(inspections, normalizeModifier = false) {
  const rows = Array.isArray(inspections) ? inspections.filter(row => row?.ok === true) : [];
  const byName = name => rows.filter(row => normalizedName(row?.name) === name);
  const farms = byName('farm');
  const mills = byName('mill');
  const water = byName('water reservoir');
  const power = byName('power plant');
  const sum = (items, kind) => items.reduce((total, row) => {
    const rate = productRate(row, kind, normalizeModifier);
    return rate == null ? total : total + rate;
  }, 0);
  return {
    farmLevels: farms.reduce((total, row) => total + (positiveNumber(row.level) || 0), 0),
    millLevels: mills.reduce((total, row) => total + (positiveNumber(row.level) || 0), 0),
    waterLevels: water.reduce((total, row) => total + (positiveNumber(row.level) || 0), 0),
    powerLevels: power.reduce((total, row) => total + (positiveNumber(row.level) || 0), 0),
    beansPerHour: sum(farms, COFFEE_KINDS.beans),
    seedsPerHour: sum(farms, COFFEE_KINDS.seeds),
    powderPerHour: sum(mills, COFFEE_KINDS.powder),
    waterPerHour: sum(water, COFFEE_KINDS.water),
    powerPerHour: sum(power, COFFEE_KINDS.power),
  };
}

function recipeAmount(facts, outputKind, inputKind) {
  return finiteNumber(facts?.resources?.[outputKind]?.recipe?.[inputKind]);
}

function harmonicCapacity(primaryCapacity, supportCapacity, supportPerPrimary) {
  const primary = positiveNumber(primaryCapacity);
  const support = positiveNumber(supportCapacity);
  const ratio = finiteNumber(supportPerPrimary);
  if (primary == null || ratio == null || ratio < 0) return null;
  if (ratio === 0) return primary;
  if (support == null) return null;
  return 1 / (1 / primary + ratio / support);
}

function stockAmount(state, kind) {
  const row = Array.isArray(state?.stock)
    ? state.stock.find(item => Number(item?.kind) === Number(kind))
    : null;
  return finiteNumber(row?.availableAmount ?? row?.amount);
}

function chainFromTotals(totals, facts, retailEvidence) {
  const beansPerPowder = recipeAmount(facts, COFFEE_KINDS.powder, COFFEE_KINDS.beans);
  const seedsPerBean = recipeAmount(facts, COFFEE_KINDS.beans, COFFEE_KINDS.seeds);
  const directWaterPerBean = recipeAmount(facts, COFFEE_KINDS.beans, COFFEE_KINDS.water);
  const waterPerSeed = recipeAmount(facts, COFFEE_KINDS.seeds, COFFEE_KINDS.water);
  const powerPerWater = recipeAmount(facts, COFFEE_KINDS.water, COFFEE_KINDS.power);
  const farmBalancedBeans = harmonicCapacity(
    totals.beansPerHour,
    totals.seedsPerHour,
    seedsPerBean,
  );
  const waterPerBean = directWaterPerBean != null && waterPerSeed != null && seedsPerBean != null
    ? directWaterPerBean + waterPerSeed * seedsPerBean
    : null;
  const waterBoundBeans = positiveNumber(totals.waterPerHour) != null && positiveNumber(waterPerBean) != null
    ? totals.waterPerHour / waterPerBean
    : null;
  const powerPerBean = waterPerBean != null && powerPerWater != null
    ? waterPerBean * powerPerWater
    : null;
  const powerBoundBeans = positiveNumber(totals.powerPerHour) != null && positiveNumber(powerPerBean) != null
    ? totals.powerPerHour / powerPerBean
    : null;
  const beanBounds = [farmBalancedBeans, waterBoundBeans, powerBoundBeans]
    .filter(value => positiveNumber(value) != null);
  const sustainableBeans = beanBounds.length ? Math.min(...beanBounds) : null;
  const beanSupportedPowder = sustainableBeans != null && positiveNumber(beansPerPowder) != null
    ? sustainableBeans / beansPerPowder
    : null;
  const powderBounds = [positiveNumber(totals.powderPerHour), positiveNumber(beanSupportedPowder)]
    .filter(value => value != null);
  const sustainablePowder = powderBounds.length === 2 ? Math.min(...powderBounds) : null;
  const retailPerHour = positiveNumber(retailEvidence?.activeOrder?.unitsPerHour)
    ?? positiveNumber(retailEvidence?.curve?.best?.unitsPerHour);
  const monetizedPowder = sustainablePowder != null && retailPerHour != null
    ? Math.min(sustainablePowder, retailPerHour)
    : null;
  const bottlenecks = [];
  if (sustainablePowder != null) {
    const epsilon = Math.max(0.01, sustainablePowder * 0.001);
    if (beanSupportedPowder != null && Math.abs(beanSupportedPowder - sustainablePowder) <= epsilon) {
      if (farmBalancedBeans != null && Math.abs(farmBalancedBeans - sustainableBeans) <= epsilon * (beansPerPowder || 1)) {
        bottlenecks.push('FARM_SEEDS_BEANS_BALANCE');
      }
      if (waterBoundBeans != null && Math.abs(waterBoundBeans - sustainableBeans) <= epsilon * (beansPerPowder || 1)) {
        bottlenecks.push('WATER');
      }
      if (powerBoundBeans != null && Math.abs(powerBoundBeans - sustainableBeans) <= epsilon * (beansPerPowder || 1)) {
        bottlenecks.push('POWER');
      }
    }
    if (positiveNumber(totals.powderPerHour) != null &&
        Math.abs(totals.powderPerHour - sustainablePowder) <= epsilon) bottlenecks.push('MILL');
    if (retailPerHour != null && monetizedPowder != null &&
        retailPerHour <= sustainablePowder + epsilon) bottlenecks.push('GROCERY_RETAIL');
  }
  return {
    farm: {
      levels: totals.farmLevels,
      allBeansPerHour: round(totals.beansPerHour),
      allSeedsPerHour: round(totals.seedsPerHour),
      balancedBeansPerHour: round(farmBalancedBeans),
    },
    mills: {
      levels: totals.millLevels,
      powderPerHour: round(totals.powderPerHour),
      beansRequiredPerHour: beansPerPowder != null
        ? round(totals.powderPerHour * beansPerPowder)
        : null,
    },
    utilities: {
      waterPerHour: round(totals.waterPerHour),
      powerPerHour: round(totals.powerPerHour),
      waterRequiredPerBean: round(waterPerBean),
      powerRequiredPerBean: round(powerPerBean),
      waterBoundBeansPerHour: round(waterBoundBeans),
      powerBoundBeansPerHour: round(powerBoundBeans),
    },
    retail: {
      powderUnitsPerHour: round(retailPerHour),
      profitPerUnit: round(retailEvidence?.activeOrder?.profitPerUnit
        ?? retailEvidence?.curve?.best?.profitPerUnit),
      profitPerHour: round(retailEvidence?.activeOrder?.profitPerHour
        ?? retailEvidence?.curve?.best?.profitPerHour),
      evidenceStatus: retailEvidence?.status || 'UNKNOWN',
    },
    sustainableBeansPerHour: round(sustainableBeans),
    sustainablePowderPerHour: round(sustainablePowder),
    monetizedPowderPerHour: round(monetizedPowder),
    bottlenecks,
    recipes: {
      beansPerPowder,
      seedsPerBean,
      directWaterPerBean,
      waterPerSeed,
      powerPerWater,
    },
  };
}

function currentAllocation(inspections, facts) {
  const farms = (inspections || []).filter(row => row?.ok === true && normalizedName(row?.name) === 'farm');
  let beansPerHour = 0;
  let seedsPerHour = 0;
  for (const farm of farms) {
    const makingKind = Number(farm?.currentJob?.makingKind);
    if (makingKind === COFFEE_KINDS.beans) beansPerHour += productRate(farm, COFFEE_KINDS.beans) || 0;
    if (makingKind === COFFEE_KINDS.seeds) seedsPerHour += productRate(farm, COFFEE_KINDS.seeds) || 0;
  }
  const seedsPerBean = recipeAmount(facts, COFFEE_KINDS.beans, COFFEE_KINDS.seeds);
  const seedSupportedBeans = positiveNumber(seedsPerHour) != null && positiveNumber(seedsPerBean) != null
    ? seedsPerHour / seedsPerBean
    : null;
  const steadyStateBeans = positiveNumber(beansPerHour) != null && seedSupportedBeans != null
    ? Math.min(beansPerHour, seedSupportedBeans)
    : null;
  return {
    beansPerHour: round(beansPerHour),
    seedsPerHour: round(seedsPerHour),
    seedSupportedBeansPerHour: round(seedSupportedBeans),
    steadyStateBeansPerHour: round(steadyStateBeans),
  };
}

function modifierExpiries(inspections) {
  const out = [];
  const seen = new Set();
  for (const inspection of inspections || []) {
    for (const product of inspection?.products || []) {
      if (product?.modifier?.status !== 'active' || !product.modifier.expiresAt) continue;
      const key = `${product.kind}:${product.modifier.percent}:${product.modifier.expiresAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: Number(product.kind),
        percent: finiteNumber(product.modifier.percent),
        expiresAt: product.modifier.expiresAt,
      });
    }
  }
  return out.sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
}

function buildCoffeeOperatingModel({ state, inspections, facts, retailCurve = null }) {
  const retailEvidence = retailEvidenceFromState(state, retailCurve);
  const measuredTotals = rateTotals(inspections, false);
  const normalizedTotals = rateTotals(inspections, true);
  const current = chainFromTotals(measuredTotals, facts, retailEvidence);
  const afterKnownProductionModifiers = chainFromTotals(normalizedTotals, facts, retailEvidence);
  const requiredKinds = Object.values(COFFEE_KINDS);
  const missingKinds = [];
  if (!(positiveNumber(measuredTotals.beansPerHour))) missingKinds.push(COFFEE_KINDS.beans);
  if (!(positiveNumber(measuredTotals.seedsPerHour))) missingKinds.push(COFFEE_KINDS.seeds);
  if (!(positiveNumber(measuredTotals.powderPerHour))) missingKinds.push(COFFEE_KINDS.powder);
  if (!(positiveNumber(measuredTotals.waterPerHour))) missingKinds.push(COFFEE_KINDS.water);
  if (!(positiveNumber(measuredTotals.powerPerHour))) missingKinds.push(COFFEE_KINDS.power);
  const expectedPortfolio = selectPortfolioBuildings(state)
    .filter(building => PORTFOLIO_BUILDING_NAMES.has(normalizedName(building.name)));
  const inspectedIds = new Set((inspections || [])
    .filter(inspection => inspection?.ok === true)
    .map(inspection => Number(inspection.buildingId)));
  const missingBuildingIds = expectedPortfolio
    .map(building => Number(building.buildingId))
    .filter(buildingId => !inspectedIds.has(buildingId));
  const stock = Object.fromEntries(requiredKinds.map(kind => [kind, stockAmount(state, kind)]));
  const status = missingKinds.length === 0 && missingBuildingIds.length === 0 &&
    current.sustainablePowderPerHour != null
    ? 'COMPLETE'
    : 'PARTIAL';
  return {
    status,
    asOf: state?.t || null,
    source: 'fresh owned-building pages + authoritative state + measured game recipes',
    missingRateKinds: missingKinds,
    expectedPortfolioBuildingIds: expectedPortfolio.map(building => Number(building.buildingId)),
    missingPortfolioBuildingIds: missingBuildingIds,
    current,
    currentFarmAllocation: currentAllocation(inspections, facts),
    afterKnownProductionModifiers,
    modifierExpiries: modifierExpiries(inspections),
    warehouseAvailable: stock,
    retailEvidence,
  };
}

function parseDurationHours(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)h$/i);
  if (!match) return null;
  if (match[1] != null) return Number(match[1]) + Number(match[2]) / 60;
  return Number(match[2]);
}

function candidateCost(candidate) {
  const preview = candidate?.preview || {};
  for (const value of [
    preview.cashCost,
    preview.cashNeeded,
    preview.liveMissing,
    preview.quoted,
    preview.exchangeCostNumber,
  ]) {
    const number = finiteNumber(value);
    if (number != null && number >= 0) return number;
  }
  return null;
}

function perLevelReference(inspections, name, kind) {
  const relevant = (inspections || []).filter(row => row?.ok === true &&
    normalizedName(row?.name) === normalizedName(name) && positiveNumber(row?.level) != null);
  let rate = 0;
  let levels = 0;
  for (const row of relevant) {
    const product = productRate(row, kind);
    if (product == null) continue;
    rate += product;
    levels += row.level;
  }
  return levels > 0 ? rate / levels : null;
}

function cloneTotals(totals) {
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, finiteNumber(value) ?? value]));
}

function applyLevelDelta(totals, buildingName, levelDelta, inspections) {
  const next = cloneTotals(totals);
  const name = normalizedName(buildingName);
  const add = (field, kind) => {
    const perLevel = perLevelReference(inspections, name, kind);
    if (perLevel == null) return false;
    next[field] = (finiteNumber(next[field]) || 0) + perLevel * levelDelta;
    return true;
  };
  let applied = false;
  if (name === 'farm') {
    applied = add('beansPerHour', COFFEE_KINDS.beans) || applied;
    applied = add('seedsPerHour', COFFEE_KINDS.seeds) || applied;
    next.farmLevels = (finiteNumber(next.farmLevels) || 0) + levelDelta;
  } else if (name === 'mill') {
    applied = add('powderPerHour', COFFEE_KINDS.powder) || applied;
    next.millLevels = (finiteNumber(next.millLevels) || 0) + levelDelta;
  } else if (name === 'water reservoir') {
    applied = add('waterPerHour', COFFEE_KINDS.water) || applied;
    next.waterLevels = (finiteNumber(next.waterLevels) || 0) + levelDelta;
  } else if (name === 'power plant') {
    applied = add('powerPerHour', COFFEE_KINDS.power) || applied;
    next.powerLevels = (finiteNumber(next.powerLevels) || 0) + levelDelta;
  }
  return { applied, totals: next };
}

function removeBuildingFromTotals(totals, inspection) {
  const next = cloneTotals(totals);
  const name = normalizedName(inspection?.name);
  const subtract = (field, kind) => {
    const rate = productRate(inspection, kind);
    if (rate == null) return false;
    next[field] = Math.max(0, (finiteNumber(next[field]) || 0) - rate);
    return true;
  };
  let applied = false;
  if (name === 'farm') {
    applied = subtract('beansPerHour', COFFEE_KINDS.beans) || applied;
    applied = subtract('seedsPerHour', COFFEE_KINDS.seeds) || applied;
    next.farmLevels = Math.max(0, (finiteNumber(next.farmLevels) || 0) - (finiteNumber(inspection.level) || 0));
  } else if (name === 'mill') {
    applied = subtract('powderPerHour', COFFEE_KINDS.powder) || applied;
    next.millLevels = Math.max(0, (finiteNumber(next.millLevels) || 0) - (finiteNumber(inspection.level) || 0));
  } else if (name === 'water reservoir') {
    applied = subtract('waterPerHour', COFFEE_KINDS.water) || applied;
    next.waterLevels = Math.max(0, (finiteNumber(next.waterLevels) || 0) - (finiteNumber(inspection.level) || 0));
  } else if (name === 'power plant') {
    applied = subtract('powerPerHour', COFFEE_KINDS.power) || applied;
    next.powerLevels = Math.max(0, (finiteNumber(next.powerLevels) || 0) - (finiteNumber(inspection.level) || 0));
  }
  return { applied, totals: next };
}

function buildingNameForCandidate(candidate, inspections) {
  if (candidate?.action === 'upgrade' || candidate?.action === 'robots') {
    const buildingId = Number(candidate?.terms?.buildingId ?? candidate?.buildingId);
    return inspections.find(row => Number(row?.buildingId) === buildingId)?.name || null;
  }
  if (candidate?.action === 'build') {
    return String(candidate?.terms?.building || candidate?.target || '').trim() || null;
  }
  return null;
}

function buildCandidateComparison({ candidates, state, inspections, facts, operatingModel }) {
  const normalizedCandidates = Array.isArray(candidates) ? candidates.slice(0, 5) : [];
  const baseTotals = rateTotals(inspections, false);
  const baseline = operatingModel?.current || chainFromTotals(
    baseTotals,
    facts,
    operatingModel?.retailEvidence || {},
  );
  const retail = operatingModel?.retailEvidence || {};
  const profitPerUnit = positiveNumber(
    retail?.activeOrder?.profitPerUnit ?? retail?.curve?.best?.profitPerUnit,
  );
  const baselineMonetized = positiveNumber(baseline?.monetizedPowderPerHour);
  const output = [];

  for (const candidate of normalizedCandidates) {
    const action = normalizedName(candidate?.action);
    const buildingName = buildingNameForCandidate(candidate, inspections);
    const levelDelta = action === 'upgrade' || action === 'build' ? 1 : 0;
    const projection = levelDelta > 0 && buildingName
      ? applyLevelDelta(baseTotals, buildingName, levelDelta, inspections)
      : { applied: false, totals: cloneTotals(baseTotals) };
    const projectedChain = action === 'hold'
      ? baseline
      : (projection.applied ? chainFromTotals(projection.totals, facts, retail) : null);
    const projectedMonetized = finiteNumber(projectedChain?.monetizedPowderPerHour);
    const incrementalPowderPerHour = baselineMonetized != null && projectedMonetized != null
      ? Math.max(0, projectedMonetized - baselineMonetized)
      : null;
    const incrementalProfitPerHour = incrementalPowderPerHour != null && profitPerUnit != null
      ? incrementalPowderPerHour * profitPerUnit
      : null;
    const cashCost = candidateCost(candidate);
    const downtimeHours = parseDurationHours(candidate?.preview?.downtime);
    let downtimeLostProfit = null;
    if (action === 'upgrade' && downtimeHours != null && profitPerUnit != null && buildingName) {
      const target = inspections.find(row => Number(row?.buildingId) ===
        Number(candidate?.terms?.buildingId ?? candidate?.buildingId));
      const withoutTarget = target ? removeBuildingFromTotals(baseTotals, target) : { applied: false };
      if (withoutTarget.applied) {
        const withoutChain = chainFromTotals(withoutTarget.totals, facts, retail);
        const withoutMonetized = positiveNumber(withoutChain?.monetizedPowderPerHour);
        if (baselineMonetized != null && withoutMonetized != null) {
          downtimeLostProfit = Math.max(0, baselineMonetized - withoutMonetized)
            * profitPerUnit * downtimeHours;
        }
      }
    }
    const investmentWithDowntime = cashCost != null
      ? cashCost + (downtimeLostProfit || 0)
      : null;
    const paybackHours = investmentWithDowntime != null && positiveNumber(incrementalProfitPerHour) != null
      ? investmentWithDowntime / incrementalProfitPerHour
      : null;
    const evidenceStatus = action === 'hold'
      ? 'MEASURED_BASELINE'
      : (projection.applied && cashCost != null && incrementalProfitPerHour != null
        ? 'MEASURED_WITH_LINEAR_LEVEL_PROJECTION'
        : 'PARTIAL');
    const slotDelta = action === 'build' ? 1 : 0;
    const freeSlotsBefore = finiteNumber(state?.freeSlots);
    const freeSlotsAfter = freeSlotsBefore != null ? freeSlotsBefore - slotDelta : null;
    output.push({
      optionId: candidate?.optionId || null,
      action,
      buildingName,
      buildingId: candidate?.terms?.buildingId ?? candidate?.buildingId ?? null,
      evidenceStatus,
      cashCost: round(cashCost, 2),
      cashAfter: round(candidate?.preview?.cashAfter, 2),
      downtimeHours: round(downtimeHours),
      slotDelta,
      freeSlotsBefore,
      freeSlotsAfter,
      slotFeasible: freeSlotsAfter == null ? null : freeSlotsAfter >= 0,
      baselineMonetizedPowderPerHour: round(baselineMonetized),
      projectedMonetizedPowderPerHour: round(projectedMonetized),
      incrementalRetailPowderPerHour: round(incrementalPowderPerHour),
      currentRetailProfitPerPowder: round(profitPerUnit),
      incrementalRetailContributionPerHour: round(incrementalProfitPerHour, 2),
      incrementalContributionPerAddedSlotHour: slotDelta > 0
        ? round(incrementalProfitPerHour, 2)
        : null,
      cashCostPerIncrementalPowderPerHour: cashCost != null && positiveNumber(incrementalPowderPerHour) != null
        ? round(cashCost / incrementalPowderPerHour, 2)
        : null,
      downtimeLostProfit: round(downtimeLostProfit, 2),
      paybackHours: round(paybackHours, 2),
      paybackStatus: paybackHours != null
        ? 'FINITE'
        : (incrementalProfitPerHour === 0 ? 'NO_INCREMENTAL_RETAIL_PROFIT' : 'UNKNOWN'),
      projectedBottlenecks: projectedChain?.bottlenecks || [],
    });
  }
  return output;
}

function buildCouncilDecisionModel({
  state,
  inspections,
  facts,
  retailCurve = null,
  candidates = [],
}) {
  const operatingModel = buildCoffeeOperatingModel({ state, inspections, facts, retailCurve });
  return {
    status: operatingModel.status,
    asOf: operatingModel.asOf,
    projectionMethod: {
      capacity: 'Per-level output is projected from fresh printed rates of owned buildings of the same type.',
      retail: 'Retail value uses the current active order or a fresh idle-store curve.',
      profit: 'Incremental retail contribution applies the current game-printed per-unit profit; future production cost, finance cost, and price can change.',
      unknown: 'A post-build administration-overhead change is not exposed by a verified source and remains UNKNOWN.',
    },
    coffeeChain: operatingModel,
    candidateComparison: buildCandidateComparison({
      candidates,
      state,
      inspections,
      facts,
      operatingModel,
    }),
  };
}

module.exports = {
  COFFEE_KINDS,
  PORTFOLIO_BUILDING_NAMES,
  applyLevelDelta,
  buildCandidateComparison,
  buildCoffeeOperatingModel,
  buildCouncilDecisionModel,
  chainFromTotals,
  compactBuildingInspection,
  parseDurationHours,
  perLevelReference,
  rateTotals,
  removeBuildingFromTotals,
  retailEvidenceFromState,
  selectPortfolioBuildings,
};
