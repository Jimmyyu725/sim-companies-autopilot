'use strict';

const INVENTORY_LIQUIDATION_FACTOR = 0.85;
const MATERIAL_LOW_CONFIDENCE_INVENTORY_PCT = 1;

function finiteNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = finiteNumber(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function summarizeOfficialBalanceSheet(balanceSheet) {
  const fields = [
    'cash',
    'cashReservedForOrders',
    'accountsReceivable',
    'materials',
    'research',
    'workInProcess',
    'finishedGoods',
    'valuationAllowance',
    'deposits',
    'investmentInBonds',
    'buildings',
    'constructionInProgress',
    'patents',
    'bondsPayable',
  ];
  if (!balanceSheet || typeof balanceSheet !== 'object' || Array.isArray(balanceSheet)) {
    return { status: 'unavailable', asOf: null, total: null, missingFields: fields };
  }
  const values = {};
  const missingFields = [];
  for (const field of fields) {
    const value = nonNegativeNumber(balanceSheet[field]);
    if (value == null) missingFields.push(field);
    else values[field] = value;
  }
  if (missingFields.length) {
    return {
      status: 'unavailable',
      asOf: balanceSheet.date || null,
      total: null,
      missingFields,
    };
  }
  const inventory = sum([
    values.materials,
    values.research,
    values.workInProcess,
    values.finishedGoods,
    values.valuationAllowance,
  ]);
  const currentAssets = sum([
    values.cash,
    values.cashReservedForOrders,
    values.accountsReceivable,
    inventory,
  ]);
  const nonCurrentAssets = sum([
    values.deposits,
    values.investmentInBonds,
    values.buildings,
    values.constructionInProgress,
    values.patents,
  ]);
  return {
    status: 'ok',
    asOf: balanceSheet.date || null,
    total: roundMoney(currentAssets + nonCurrentAssets - values.bondsPayable),
    currentAssets: roundMoney(currentAssets),
    nonCurrentAssets: roundMoney(nonCurrentAssets),
    liabilities: roundMoney(values.bondsPayable),
    components: {
      ...values,
      inventory: roundMoney(inventory),
    },
  };
}

function previousUtcDayWindow(statementDate) {
  const statementMs = Date.parse(statementDate);
  if (!Number.isFinite(statementMs)) return null;
  const statement = new Date(statementMs);
  const currentDayStart = Date.UTC(
    statement.getUTCFullYear(),
    statement.getUTCMonth(),
    statement.getUTCDate(),
  );
  const startMs = currentDayStart - 24 * 60 * 60 * 1000;
  return {
    start: startMs / 1000,
    end: currentDayStart / 1000,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(currentDayStart).toISOString(),
  };
}

function derivePreviousDayReferencePrices(volumeText, statementDate, aggregateVolumeRecords) {
  const window = previousUtcDayWindow(statementDate);
  if (!window || typeof aggregateVolumeRecords !== 'function') {
    return { status: 'unavailable', window, prices: {}, reason: 'reference window or volume parser is unavailable' };
  }
  let aggregate;
  try {
    aggregate = aggregateVolumeRecords(String(volumeText || ''), {
      cutoff: window.start,
      now: window.end,
    });
  } catch (error) {
    return {
      status: 'unavailable',
      window,
      prices: {},
      reason: String(error.message || error).slice(0, 180),
    };
  }
  const prices = {};
  for (const [kindText, unitsRaw] of Object.entries(aggregate.u || {})) {
    const kind = positiveInteger(kindText);
    const units = nonNegativeNumber(unitsRaw);
    const value = nonNegativeNumber(aggregate.v?.[kindText]);
    if (kind == null || units == null || units <= 0 || value == null) continue;
    const vwap = value / units;
    if (!Number.isFinite(vwap) || vwap <= 0) continue;
    prices[kind] = {
      vwap,
      liquidationUnitValue: vwap * INVENTORY_LIQUIDATION_FACTOR,
      units,
      tradedValue: value,
      ambiguousUnits: nonNegativeNumber(aggregate.amb?.[kindText]) || 0,
      qualityScope: 'all qualities blended',
    };
  }
  return {
    status: Object.keys(prices).length ? 'estimated' : 'unavailable',
    window,
    prices,
    intervals: aggregate.intervals || 0,
    invalidLines: aggregate.invalidLines || 0,
    duplicateIntervals: aggregate.duplicateIntervals || 0,
    methodology: 'Previous UTC day tracked VWAP multiplied by 85%; tracker rows blend qualities.',
  };
}

function qualityPriceKey(kind, quality) {
  const normalizedKind = positiveInteger(kind);
  const normalizedQuality = nonNegativeInteger(quality);
  return normalizedKind == null || normalizedQuality == null
    ? null
    : `${normalizedKind}:${normalizedQuality}`;
}

function inventoryAmountsByQuality(lots) {
  const amounts = {};
  for (const lot of lots || []) {
    if (lot?.location === 'work-in-process') continue;
    const key = qualityPriceKey(lot?.kind, lot?.quality);
    const amount = nonNegativeNumber(lot?.amount);
    if (key == null || amount == null || amount <= 0) continue;
    amounts[key] = (amounts[key] || 0) + amount;
  }
  return Object.fromEntries(
    Object.entries(amounts).map(([key, amount]) => [key, roundMoney(amount)]),
  );
}

function deriveQualityMarketPrices(marketSummaries, requiredAmounts = {}, {
  capturedAt = null,
  minimumOrderCount = 3,
} = {}) {
  const summariesByKind = {};
  for (const summary of marketSummaries || []) {
    const kind = positiveInteger(summary?.kind);
    if (kind == null || Number(summary?.status) !== 200 || !Array.isArray(summary?.qualities)) continue;
    const qualities = {};
    for (const row of summary.qualities) {
      const quality = nonNegativeInteger(row?.quality);
      const bestAsk = nonNegativeNumber(row?.bestAsk);
      const listedUnits = nonNegativeNumber(row?.listedUnits);
      const orderCount = nonNegativeInteger(row?.orderCount);
      if (quality == null || bestAsk == null || bestAsk <= 0
          || listedUnits == null || orderCount == null || orderCount <= 0) continue;
      qualities[quality] = { quality, bestAsk, listedUnits, orderCount };
    }
    if (Object.keys(qualities).length) summariesByKind[kind] = qualities;
  }

  const prices = {};
  const issues = [];
  const requiredKeys = Object.keys(requiredAmounts || {});
  for (const key of requiredKeys) {
    const match = key.match(/^([1-9]\d*):(\d+)$/);
    const requiredAmount = nonNegativeNumber(requiredAmounts[key]);
    if (!match || requiredAmount == null || requiredAmount <= 0) continue;
    const kind = Number(match[1]);
    const quality = Number(match[2]);
    const qualities = summariesByKind[kind] || {};
    const exact = qualities[quality] || null;
    const liquid = row => row && row.orderCount >= minimumOrderCount && row.listedUnits > 0;
    let marketUnitValue = null;
    let basis = null;
    let evidence = null;

    if (liquid(exact) && exact.listedUnits >= requiredAmount) {
      marketUnitValue = exact.bestAsk;
      basis = 'current-quality-best-ask';
      evidence = { ...exact };
    } else {
      const lower = Object.values(qualities)
        .filter(row => row.quality < quality && liquid(row))
        .sort((a, b) => b.quality - a.quality)[0] || null;
      const upper = Object.values(qualities)
        .filter(row => row.quality > quality && liquid(row))
        .sort((a, b) => a.quality - b.quality)[0] || null;
      if (lower && upper) {
        const weight = (quality - lower.quality) / (upper.quality - lower.quality);
        marketUnitValue = lower.bestAsk + (upper.bestAsk - lower.bestAsk) * weight;
        basis = 'current-quality-interpolated-best-ask';
        evidence = {
          requiredQuality: quality,
          lowerQuality: lower.quality,
          lowerBestAsk: lower.bestAsk,
          upperQuality: upper.quality,
          upperBestAsk: upper.bestAsk,
          exactQualityListedUnits: exact?.listedUnits || 0,
          exactQualityOrderCount: exact?.orderCount || 0,
        };
      } else if (exact && exact.listedUnits >= requiredAmount) {
        marketUnitValue = exact.bestAsk;
        basis = 'current-quality-thin-best-ask';
        evidence = { ...exact };
      }
    }

    if (marketUnitValue == null) {
      issues.push(`No liquid quality-specific market proxy for resource ${key}.`);
      continue;
    }
    if (!prices[kind]) prices[kind] = {};
    prices[kind][quality] = {
      marketUnitValue,
      liquidationUnitValue: marketUnitValue * INVENTORY_LIQUIDATION_FACTOR,
      basis,
      evidence,
    };
  }

  return {
    status: Object.keys(prices).length ? 'estimated' : 'unavailable',
    asOf: capturedAt,
    prices,
    requiredPairs: requiredKeys.length,
    pricedPairs: sum(Object.values(prices).map(qualities => Object.keys(qualities).length)),
    issues,
    methodology: 'Live quality-specific best asks multiplied by 85%; illiquid qualities are interpolated between liquid adjacent qualities.',
  };
}

function resourceSourcingUnitCost(resource) {
  const amount = nonNegativeNumber(resource?.amount);
  if (amount == null || amount <= 0 || !resource?.cost || typeof resource.cost !== 'object') return null;
  const total = Object.values(resource.cost)
    .map(nonNegativeNumber)
    .filter(value => value != null)
    .reduce((value, part) => value + part, 0);
  return total > 0 ? total / amount : null;
}

function rowsFrom(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function hasRowsShape(payload, keys = []) {
  return Array.isArray(payload)
    || keys.some(key => Array.isArray(payload?.[key]));
}

function isBuyOrder(row) {
  const side = String(row?.side ?? row?.type ?? row?.direction ?? '').trim().toLowerCase();
  return row?.buy === true
    || row?.isBuy === true
    || (row?.buyer != null && row?.seller == null)
    || ['buy', 'bid', 'purchase'].includes(side);
}

function addLot(lots, issues, limitations, lot) {
  const kind = positiveInteger(lot.kind);
  const amount = nonNegativeNumber(lot.amount);
  if (kind == null || amount == null) {
    issues.push(`Ignored malformed ${lot.location || 'inventory'} lot.`);
    return;
  }
  if (amount <= 0) return;
  const qualityNumber = finiteNumber(lot.quality);
  let quality = Number.isSafeInteger(qualityNumber) && qualityNumber >= 0
    ? qualityNumber
    : null;
  if (quality == null && lot.assumeQualityZero === true) {
    quality = 0;
    limitations.push(
      `${lot.location || 'inventory'} does not expose quality; Q0 was used conservatively.`,
    );
  }
  if (quality == null) {
    issues.push(`Ignored ${lot.location || 'inventory'} lot with unknown quality.`);
    return;
  }
  lots.push({
    kind,
    quality,
    amount,
    location: lot.location || 'unknown',
    sourcingUnitCost: nonNegativeNumber(lot.sourcingUnitCost),
  });
}

function collectInventoryLots({
  warehouse,
  marketOrders,
  outgoingContracts,
  buildings,
  resourceDefinitions,
}) {
  const lots = [];
  const issues = [];
  const limitations = [];
  for (const resource of rowsFrom(warehouse, ['resources', 'data', 'results'])) {
    addLot(lots, issues, limitations, {
      kind: resource?.kind,
      quality: resource?.quality,
      amount: resource?.amount,
      location: resource?.blocked === true ? 'warehouse-reserved' : 'warehouse',
      sourcingUnitCost: resourceSourcingUnitCost(resource),
    });
  }

  for (const order of rowsFrom(marketOrders, ['orders', 'marketOrders', 'data', 'results'])) {
    if (isBuyOrder(order)) continue;
    addLot(lots, issues, limitations, {
      kind: order?.kind ?? order?.resource?.kind,
      quality: order?.quality ?? order?.resource?.quality,
      amount: order?.amount ?? order?.quantity ?? order?.resource?.amount,
      location: 'exchange-order',
    });
  }

  for (const contract of rowsFrom(
    outgoingContracts,
    ['outgoingContracts', 'contracts', 'data', 'results'],
  )) {
    addLot(lots, issues, limitations, {
      kind: contract?.kind ?? contract?.resource?.kind,
      quality: contract?.quality ?? contract?.resource?.quality,
      amount: contract?.amount ?? contract?.quantity ?? contract?.resource?.amount,
      location: 'outgoing-contract',
    });
  }

  let accountsReceivable = 0;
  for (const building of rowsFrom(buildings, ['buildings', 'data', 'results'])) {
    const busy = building?.busy;
    const production = busy?.resource;
    if (production) {
      const total = nonNegativeNumber(production.amount);
      const availableRaw = nonNegativeNumber(production.amountAvailableNow);
      if (total == null) {
        issues.push(`Building ${building?.id ?? 'unknown'} has malformed production amount.`);
      } else {
        const available = Math.min(total, availableRaw || 0);
        addLot(lots, issues, limitations, {
          kind: production.kind,
          quality: production.quality,
          amount: available,
          location: 'production-ready',
        });
        const remainingOutput = Math.max(0, total - available);
        if (remainingOutput > 0) {
          const unitCost = nonNegativeNumber(production.unitCost);
          if (unitCost == null) {
            issues.push(`Building ${building?.id ?? 'unknown'} lacks live WIP unit cost.`);
          } else {
            addLot(lots, issues, limitations, {
              kind: production.kind,
              quality: production.quality,
              amount: remainingOutput,
              location: 'work-in-process',
              sourcingUnitCost: unitCost,
            });
          }
        }
      }
    }

    const sale = busy?.sales_order;
    if (sale) {
      const availableCash = nonNegativeNumber(sale.profitAvailableNow);
      if (availableCash == null) issues.push(`Building ${building?.id ?? 'unknown'} has malformed retail receivable.`);
      else accountsReceivable += availableCash;
      const remainingProfit = nonNegativeNumber(sale.remainingProfit);
      const price = nonNegativeNumber(sale.price);
      if (remainingProfit == null || price == null || price <= 0) {
        issues.push(`Building ${building?.id ?? 'unknown'} has malformed remaining retail inventory.`);
      } else {
        addLot(lots, issues, limitations, {
          kind: sale.kind,
          quality: sale.quality,
          amount: remainingProfit / price,
          location: 'retail',
          assumeQualityZero: true,
        });
      }
    }
  }
  return {
    lots,
    accountsReceivable: roundMoney(accountsReceivable),
    issues,
    limitations: [...new Set(limitations)],
  };
}

function calculateBuildingAssets(buildings) {
  let buildingsValue = 0;
  let constructionInProgress = 0;
  const issues = [];
  const rows = rowsFrom(buildings, ['buildings', 'data', 'results']);
  for (const building of rows) {
    if (String(building?.category || '').trim().toLowerCase() === 'seasonal'
        || building?.freeAndLocked === true) continue;
    const cost = nonNegativeNumber(building?.cost);
    const size = positiveInteger(building?.size);
    if (cost == null || size == null) {
      issues.push(`Building ${building?.id ?? 'unknown'} lacks a valid base cost or level.`);
      continue;
    }
    const underConstruction = building?.busy?.category === 'b' || building?.busy?.expanding === true;
    buildingsValue += cost * (underConstruction ? Math.max(0, size - 1) : size);
    if (underConstruction) constructionInProgress += cost;
    if (building?.robotsSpecialization != null) {
      issues.push(`Building ${building?.id ?? 'unknown'} has robots; robot asset value is not separately evidenced.`);
    }
  }
  return {
    buildings: roundMoney(buildingsValue),
    constructionInProgress: roundMoney(constructionInProgress),
    issues,
  };
}

function calculatePatentAssets(researchProgress, {
  resourceDefinitions,
  patentRequirements,
  patentValuesByResearchKind,
} = {}) {
  const issues = [];
  if (!hasRowsShape(researchProgress, ['research', 'data', 'results'])) {
    return {
      status: 'unavailable',
      total: null,
      patentCount: null,
      byProduct: {},
      byResearchKind: {},
      issues: ['The live research-progress source is unavailable.'],
    };
  }

  const requirements = Array.isArray(patentRequirements)
    ? patentRequirements.map(positiveInteger)
    : [];
  if (!requirements.length || requirements.some(value => value == null)) {
    issues.push('Patent requirements are unavailable or malformed.');
  }

  const values = {};
  if (patentValuesByResearchKind && typeof patentValuesByResearchKind === 'object'
      && !Array.isArray(patentValuesByResearchKind)) {
    for (const [kindText, valueRaw] of Object.entries(patentValuesByResearchKind)) {
      const kind = positiveInteger(kindText);
      const value = nonNegativeNumber(valueRaw);
      if (kind != null && value != null && value > 0) values[kind] = value;
    }
  }
  if (!Object.keys(values).length) {
    issues.push('Fixed patent values are unavailable or malformed.');
  }

  const researchKindByProduct = {};
  if (resourceDefinitions && typeof resourceDefinitions === 'object'
      && !Array.isArray(resourceDefinitions)) {
    for (const [researchKindText, definition] of Object.entries(resourceDefinitions)) {
      const researchKind = positiveInteger(researchKindText);
      if (researchKind == null || definition?.isResearch !== true
          || !Array.isArray(definition?.improvesQualityOf)) continue;
      for (const productKindRaw of definition.improvesQualityOf) {
        const productKind = positiveInteger(productKindRaw);
        if (productKind == null) continue;
        if (researchKindByProduct[productKind] != null
            && researchKindByProduct[productKind] !== researchKind) {
          issues.push(`Product kind ${productKind} maps to multiple research kinds.`);
          continue;
        }
        researchKindByProduct[productKind] = researchKind;
      }
    }
  }

  const byProduct = {};
  const byResearchKind = {};
  let total = 0;
  let patentCount = 0;
  const seenProducts = new Set();
  for (const row of rowsFrom(researchProgress, ['research', 'data', 'results'])) {
    const productKind = positiveInteger(row?.kind);
    const quality = nonNegativeInteger(row?.quality);
    const currentPatents = nonNegativeInteger(row?.patents);
    if (productKind == null || quality == null || currentPatents == null) {
      issues.push('Ignored malformed live research row.');
      continue;
    }
    if (seenProducts.has(productKind)) {
      issues.push(`Duplicate live research row for product kind ${productKind}.`);
      continue;
    }
    seenProducts.add(productKind);
    if (quality > requirements.length) {
      issues.push(`Product kind ${productKind} has unsupported quality ${quality}.`);
      continue;
    }

    const nextRequirement = quality < requirements.length ? requirements[quality] : null;
    const reportedRequirement = row?.patentsNeeded == null
      ? null
      : nonNegativeInteger(row.patentsNeeded);
    if (nextRequirement != null
        && (reportedRequirement !== nextRequirement || currentPatents >= nextRequirement)) {
      issues.push(`Product kind ${productKind} has inconsistent patent progress.`);
      continue;
    }
    if (nextRequirement == null && (currentPatents !== 0
        || (reportedRequirement != null && reportedRequirement !== 0))) {
      issues.push(`Max-quality product kind ${productKind} has unexpected patent progress.`);
      continue;
    }

    const researchKind = researchKindByProduct[productKind];
    const unitValue = researchKind != null ? values[researchKind] : null;
    if (researchKind == null || unitValue == null) {
      issues.push(`No fixed patent value mapping exists for product kind ${productKind}.`);
      continue;
    }

    const completedPatents = sum(requirements.slice(0, quality));
    const productPatentCount = completedPatents + currentPatents;
    const productValue = productPatentCount * unitValue;
    patentCount += productPatentCount;
    total += productValue;
    byProduct[productKind] = {
      researchKind,
      quality,
      currentPatents,
      nextRequirement,
      cumulativePatentCount: productPatentCount,
      unitValue: roundMoney(unitValue),
      value: roundMoney(productValue),
    };
    if (!byResearchKind[researchKind]) {
      byResearchKind[researchKind] = {
        patentCount: 0,
        unitValue: roundMoney(unitValue),
        value: 0,
      };
    }
    byResearchKind[researchKind].patentCount += productPatentCount;
    byResearchKind[researchKind].value += productValue;
  }

  for (const entry of Object.values(byResearchKind)) {
    entry.value = roundMoney(entry.value);
  }
  return {
    status: issues.length ? 'unavailable' : 'ok',
    total: issues.length ? null : roundMoney(total),
    patentCount: issues.length ? null : patentCount,
    byProduct,
    byResearchKind,
    issues,
  };
}

function valueInventoryLots(lots, {
  qualityMarketPrices = {},
  referencePrices = {},
  tickerPrices = {},
} = {}) {
  const byLocation = {};
  const byKind = {};
  const byKindQuality = {};
  const valueByBasis = {};
  const issues = [];
  let total = 0;
  let knownAmount = 0;
  let unknownAmount = 0;
  let qualityLots = 0;

  for (const lot of lots || []) {
    const qualityMarket = qualityMarketPrices?.[lot.kind]?.[lot.quality];
    const reference = referencePrices?.[lot.kind]?.liquidationUnitValue;
    const ticker = positiveInteger(lot.kind) != null
      ? nonNegativeNumber(tickerPrices?.[lot.kind])
      : null;
    const sourceCost = nonNegativeNumber(lot.sourcingUnitCost);
    let unitValue = null;
    let basis = null;
    if (lot.location === 'work-in-process' && sourceCost != null) {
      unitValue = sourceCost;
      basis = 'live-production-unit-cost';
    }
    if (unitValue == null) {
      unitValue = nonNegativeNumber(qualityMarket?.liquidationUnitValue);
      basis = unitValue == null ? null : String(qualityMarket?.basis || 'current-quality-market-85pct');
    }
    if (unitValue == null && Number(lot.quality) === 0 && ticker != null && ticker > 0) {
      unitValue = ticker * INVENTORY_LIQUIDATION_FACTOR;
      basis = 'current-ticker-85pct-fallback';
    }
    if (unitValue == null && sourceCost != null) {
      unitValue = sourceCost;
      basis = 'recorded-sourcing-cost-fallback';
    }
    if (unitValue == null) {
      unitValue = nonNegativeNumber(reference);
      basis = unitValue == null ? null : 'previous-day-local-blended-vwap-85pct-fallback';
    }
    if (lot.quality > 0) qualityLots++;
    if (unitValue == null) {
      unknownAmount += lot.amount;
      issues.push(`No valuation evidence for resource kind ${lot.kind} at ${lot.location}.`);
      continue;
    }
    const value = lot.amount * unitValue;
    total += value;
    knownAmount += lot.amount;
    byLocation[lot.location] = (byLocation[lot.location] || 0) + value;
    valueByBasis[basis] = (valueByBasis[basis] || 0) + value;
    if (!byKind[lot.kind]) byKind[lot.kind] = { amount: 0, value: 0, bases: new Set() };
    byKind[lot.kind].amount += lot.amount;
    byKind[lot.kind].value += value;
    byKind[lot.kind].bases.add(basis);
    const kindQualityKey = qualityPriceKey(lot.kind, lot.quality);
    if (!byKindQuality[kindQualityKey]) {
      byKindQuality[kindQualityKey] = {
        kind: lot.kind,
        quality: lot.quality,
        amount: 0,
        value: 0,
        bases: new Set(),
      };
    }
    byKindQuality[kindQualityKey].amount += lot.amount;
    byKindQuality[kindQualityKey].value += value;
    byKindQuality[kindQualityKey].bases.add(basis);
  }

  const lowConfidenceValue = sum(
    Object.entries(valueByBasis)
      .filter(([basis]) => basis.includes('fallback') || basis.includes('thin'))
      .map(([, value]) => value),
  );
  return {
    total: roundMoney(total),
    byLocation: Object.fromEntries(
      Object.entries(byLocation).map(([key, value]) => [key, roundMoney(value)]),
    ),
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, entry]) => [kind, {
      amount: roundMoney(entry.amount),
      value: roundMoney(entry.value),
      valuationBases: [...entry.bases],
    }])),
    byKindQuality: Object.fromEntries(
      Object.entries(byKindQuality).map(([key, entry]) => [key, {
        kind: entry.kind,
        quality: entry.quality,
        amount: roundMoney(entry.amount),
        value: roundMoney(entry.value),
        valuationBases: [...entry.bases],
      }]),
    ),
    valueByBasis: Object.fromEntries(
      Object.entries(valueByBasis).map(([basis, value]) => [basis, roundMoney(value)]),
    ),
    lowConfidenceValue: roundMoney(lowConfidenceValue),
    lowConfidenceSharePct: total > 0
      ? Math.round(lowConfidenceValue / total * 10000) / 100
      : 0,
    knownAmount: roundMoney(knownAmount),
    unknownAmount: roundMoney(unknownAmount),
    coveragePct: knownAmount + unknownAmount > 0
      ? roundMoney(knownAmount / (knownAmount + unknownAmount) * 100)
      : 100,
    qualityLots,
    issues,
  };
}

function calculateCompanyValue({
  capturedAt,
  balanceSheet,
  liveCash,
  liveBondsPayable,
  buildings,
  warehouse,
  marketOrders,
  outgoingContracts,
  resourceDefinitions,
  researchProgress,
  patentRequirements,
  patentValuesByResearchKind,
  referencePriceResult,
  qualityMarketPriceResult,
  tickerPrices,
}) {
  const official = summarizeOfficialBalanceSheet(balanceSheet);
  const inventory = collectInventoryLots({
    warehouse,
    marketOrders,
    outgoingContracts,
    buildings,
    resourceDefinitions,
  });
  const inventoryValue = valueInventoryLots(inventory.lots, {
    qualityMarketPrices: qualityMarketPriceResult?.prices,
    referencePrices: referencePriceResult?.prices,
    tickerPrices,
  });
  const buildingAssets = calculateBuildingAssets(buildings);
  const patentAssets = calculatePatentAssets(researchProgress, {
    resourceDefinitions,
    patentRequirements,
    patentValuesByResearchKind,
  });
  const limitations = [
    ...inventory.issues,
    ...inventory.limitations,
    ...inventoryValue.issues,
    ...(qualityMarketPriceResult?.issues || []),
    ...buildingAssets.issues,
    ...patentAssets.issues,
  ];
  const sourceGaps = [];
  if (!hasRowsShape(warehouse, ['resources', 'data', 'results'])) {
    sourceGaps.push('The complete warehouse source is unavailable.');
  }
  if (!hasRowsShape(marketOrders, ['orders', 'marketOrders', 'data', 'results'])) {
    sourceGaps.push('The open market-order source is unavailable.');
  }
  if (!hasRowsShape(outgoingContracts, ['outgoingContracts', 'contracts', 'data', 'results'])) {
    sourceGaps.push('The outgoing-contract source is unavailable.');
  }
  if (!hasRowsShape(buildings, ['buildings', 'data', 'results'])) {
    sourceGaps.push('The building source is unavailable.');
  }
  if (!hasRowsShape(researchProgress, ['research', 'data', 'results'])) {
    sourceGaps.push('The live research-progress source is unavailable.');
  }

  if (official.status !== 'ok') {
    return {
      methodVersion: 3,
      capturedAt,
      official,
      realtimeEstimate: {
        status: 'unavailable',
        total: null,
        reason: 'A complete official balance-sheet baseline is required.',
        limitations,
      },
    };
  }

  const cash = nonNegativeNumber(liveCash);
  const liabilities = nonNegativeNumber(liveBondsPayable);
  if (cash == null || liabilities == null) {
    return {
      methodVersion: 3,
      capturedAt,
      official,
      realtimeEstimate: {
        status: 'unavailable',
        total: null,
        reason: 'Live cash or outstanding bond principal is unavailable.',
        limitations,
      },
    };
  }
  if (sourceGaps.length || inventory.issues.length || buildingAssets.issues.length
      || patentAssets.status !== 'ok' || inventoryValue.unknownAmount > 0) {
    const gaps = [...sourceGaps, ...limitations];
    if (inventoryValue.unknownAmount > 0) {
      gaps.push(`${inventoryValue.unknownAmount} inventory units lack valuation evidence.`);
    }
    return {
      methodVersion: 3,
      capturedAt,
      official,
      realtimeEstimate: {
        status: 'unavailable',
        total: null,
        reason: 'One or more live asset components are incomplete.',
        inventoryCoveragePct: inventoryValue.coveragePct,
        limitations: [...new Set(gaps)],
      },
    };
  }

  const carried = {
    cashReservedForOrders: official.components.cashReservedForOrders,
    deposits: official.components.deposits,
    investmentInBonds: official.components.investmentInBonds,
  };
  if (carried.cashReservedForOrders > 0) {
    limitations.push('Cash reserved for buy orders is carried from the daily statement.');
  }
  if (carried.deposits > 0 || carried.investmentInBonds > 0) {
    limitations.push('Deposits or bond investments are carried from the daily statement.');
  }
  const valuationBases = Object.keys(inventoryValue.valueByBasis);
  if (valuationBases.some(basis => basis.includes('interpolated'))) {
    limitations.push('Illiquid exact-quality order books were interpolated between adjacent liquid qualities.');
  }
  if (valuationBases.some(basis => basis.includes('thin'))) {
    limitations.push('Some exact-quality order books were thin relative to the inventory being valued.');
  }
  if (valuationBases.some(basis => basis.includes('local-blended'))) {
    limitations.push('Some inventory used the local all-quality VWAP fallback.');
  }
  limitations.push(
    'Official daily per-quality reference prices are not exposed by a reliable live feed; live quality-specific market proxies are used.',
  );

  const currentAssets = sum([
    cash,
    carried.cashReservedForOrders,
    inventory.accountsReceivable,
    inventoryValue.total,
  ]);
  const nonCurrentAssets = sum([
    carried.deposits,
    carried.investmentInBonds,
    buildingAssets.buildings,
    buildingAssets.constructionInProgress,
    patentAssets.total,
  ]);
  const total = currentAssets + nonCurrentAssets - liabilities;
  const confidence = inventoryValue.coveragePct < 90 || buildingAssets.issues.length
    || inventoryValue.lowConfidenceSharePct >= MATERIAL_LOW_CONFIDENCE_INVENTORY_PCT
    ? 'low'
    : 'medium';
  const officialSnapshotAgeSeconds = (() => {
    const capturedMs = Date.parse(capturedAt);
    const officialMs = Date.parse(official.asOf);
    return Number.isFinite(capturedMs) && Number.isFinite(officialMs)
      ? Math.max(0, Math.round((capturedMs - officialMs) / 1000))
      : null;
  })();
  const componentDifference = {
    cash: roundMoney(cash - official.components.cash),
    cashReservedForOrders: roundMoney(
      carried.cashReservedForOrders - official.components.cashReservedForOrders,
    ),
    accountsReceivable: roundMoney(
      inventory.accountsReceivable - official.components.accountsReceivable,
    ),
    inventory: roundMoney(inventoryValue.total - official.components.inventory),
    buildings: roundMoney(buildingAssets.buildings - official.components.buildings),
    constructionInProgress: roundMoney(
      buildingAssets.constructionInProgress - official.components.constructionInProgress,
    ),
    deposits: roundMoney(carried.deposits - official.components.deposits),
    investmentInBonds: roundMoney(
      carried.investmentInBonds - official.components.investmentInBonds,
    ),
    patents: roundMoney(patentAssets.total - official.components.patents),
    bondsPayable: roundMoney(liabilities - official.components.bondsPayable),
  };
  return {
    methodVersion: 3,
    capturedAt,
    official,
    realtimeEstimate: {
      status: 'estimated',
      asOf: capturedAt,
      total: roundMoney(total),
      deltaFromOfficial: roundMoney(total - official.total),
      comparisonToOfficialSnapshot: {
        officialAsOf: official.asOf,
        snapshotAgeSeconds: officialSnapshotAgeSeconds,
        totalDifference: roundMoney(total - official.total),
        includesPostSnapshotActivity: officialSnapshotAgeSeconds == null
          ? null
          : officialSnapshotAgeSeconds > 0,
        componentDifference,
      },
      currentAssets: roundMoney(currentAssets),
      nonCurrentAssets: roundMoney(nonCurrentAssets),
      liabilities: roundMoney(liabilities),
      confidence,
      components: {
        cash: roundMoney(cash),
        cashReservedForOrders: roundMoney(carried.cashReservedForOrders),
        accountsReceivable: roundMoney(inventory.accountsReceivable),
        inventory: inventoryValue.total,
        buildings: buildingAssets.buildings,
        constructionInProgress: buildingAssets.constructionInProgress,
        deposits: roundMoney(carried.deposits),
        investmentInBonds: roundMoney(carried.investmentInBonds),
        patents: patentAssets.total,
        bondsPayable: roundMoney(liabilities),
      },
      patents: {
        total: patentAssets.total,
        patentCount: patentAssets.patentCount,
        byProduct: patentAssets.byProduct,
        byResearchKind: patentAssets.byResearchKind,
      },
      inventory: {
        total: inventoryValue.total,
        byLocation: inventoryValue.byLocation,
        byKind: inventoryValue.byKind,
        byKindQuality: inventoryValue.byKindQuality,
        valueByBasis: inventoryValue.valueByBasis,
        lowConfidenceValue: inventoryValue.lowConfidenceValue,
        lowConfidenceSharePct: inventoryValue.lowConfidenceSharePct,
        knownAmount: inventoryValue.knownAmount,
        unknownAmount: inventoryValue.unknownAmount,
        coveragePct: inventoryValue.coveragePct,
        qualityLots: inventoryValue.qualityLots,
      },
      limitations: [...new Set(limitations)],
      methodology: {
        equation: 'current assets + non-current assets - liabilities',
        inventory: 'Live quality-specific market proxy × 85%; WIP uses the live production unit cost; local VWAP, ticker, and recorded cost are explicit fallbacks.',
        buildings: 'Base reference value × completed levels; one base level moves to construction in progress while building.',
        patents: 'Cumulative completed-quality requirements plus current live progress, multiplied by the official fixed value for each research category.',
        carriedDailyFields: Object.keys(carried),
        referencePriceWindow: referencePriceResult?.window || null,
        qualityMarketAsOf: qualityMarketPriceResult?.asOf || null,
        qualityMarketMethodology: qualityMarketPriceResult?.methodology || null,
      },
    },
  };
}

module.exports = {
  INVENTORY_LIQUIDATION_FACTOR,
  calculateBuildingAssets,
  calculateCompanyValue,
  calculatePatentAssets,
  collectInventoryLots,
  deriveQualityMarketPrices,
  derivePreviousDayReferencePrices,
  inventoryAmountsByQuality,
  previousUtcDayWindow,
  qualityPriceKey,
  resourceSourcingUnitCost,
  summarizeOfficialBalanceSheet,
  valueInventoryLots,
};
