'use strict';

const INVENTORY_LIQUIDATION_FACTOR = 0.85;

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

function addLot(lots, issues, lot) {
  const kind = positiveInteger(lot.kind);
  const amount = nonNegativeNumber(lot.amount);
  if (kind == null || amount == null) {
    issues.push(`Ignored malformed ${lot.location || 'inventory'} lot.`);
    return;
  }
  if (amount <= 0) return;
  const qualityNumber = finiteNumber(lot.quality);
  lots.push({
    kind,
    quality: Number.isSafeInteger(qualityNumber) && qualityNumber >= 0 ? qualityNumber : 0,
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
  for (const resource of rowsFrom(warehouse, ['resources', 'data', 'results'])) {
    addLot(lots, issues, {
      kind: resource?.kind,
      quality: resource?.quality,
      amount: resource?.amount,
      location: resource?.blocked === true ? 'warehouse-reserved' : 'warehouse',
      sourcingUnitCost: resourceSourcingUnitCost(resource),
    });
  }

  for (const order of rowsFrom(marketOrders, ['orders', 'marketOrders', 'data', 'results'])) {
    if (isBuyOrder(order)) continue;
    addLot(lots, issues, {
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
    addLot(lots, issues, {
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
        addLot(lots, issues, {
          kind: production.kind,
          quality: production.quality,
          amount: available,
          location: 'production-ready',
        });
        const remainingOutput = Math.max(0, total - available);
        const recipe = resourceDefinitions?.[production.kind]?.producedFrom;
        const recipeRows = recipe && typeof recipe === 'object'
          ? Object.entries(recipe).filter(([, multiplier]) => finiteNumber(multiplier) > 0)
          : [];
        if (recipeRows.length) {
          for (const [inputKind, multiplier] of recipeRows) {
            addLot(lots, issues, {
              kind: inputKind,
              quality: production.quality,
              amount: remainingOutput * Number(multiplier),
              location: 'work-in-process',
            });
          }
        } else {
          addLot(lots, issues, {
            kind: production.kind,
            quality: production.quality,
            amount: remainingOutput,
            location: 'work-in-process',
          });
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
        addLot(lots, issues, {
          kind: sale.kind,
          quality: sale.quality,
          amount: remainingProfit / price,
          location: 'retail',
        });
      }
    }
  }
  return {
    lots,
    accountsReceivable: roundMoney(accountsReceivable),
    issues,
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

function valueInventoryLots(lots, {
  referencePrices = {},
  tickerPrices = {},
} = {}) {
  const byLocation = {};
  const byKind = {};
  const issues = [];
  let total = 0;
  let knownAmount = 0;
  let unknownAmount = 0;
  let qualityLots = 0;

  for (const lot of lots || []) {
    const reference = referencePrices?.[lot.kind]?.liquidationUnitValue;
    const ticker = positiveInteger(lot.kind) != null
      ? nonNegativeNumber(tickerPrices?.[lot.kind])
      : null;
    const sourceCost = nonNegativeNumber(lot.sourcingUnitCost);
    let unitValue = nonNegativeNumber(reference);
    let basis = 'previous-day-vwap-85pct';
    if (unitValue == null && ticker != null && ticker > 0) {
      unitValue = ticker * INVENTORY_LIQUIDATION_FACTOR;
      basis = 'current-ticker-85pct-fallback';
    }
    if (unitValue == null && sourceCost != null) {
      unitValue = sourceCost;
      basis = 'recorded-sourcing-cost-fallback';
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
    if (!byKind[lot.kind]) byKind[lot.kind] = { amount: 0, value: 0, bases: new Set() };
    byKind[lot.kind].amount += lot.amount;
    byKind[lot.kind].value += value;
    byKind[lot.kind].bases.add(basis);
  }

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
  referencePriceResult,
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
    referencePrices: referencePriceResult?.prices,
    tickerPrices,
  });
  const buildingAssets = calculateBuildingAssets(buildings);
  const limitations = [
    ...inventory.issues,
    ...inventoryValue.issues,
    ...buildingAssets.issues,
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

  if (official.status !== 'ok') {
    return {
      methodVersion: 1,
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
      methodVersion: 1,
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
      || inventoryValue.unknownAmount > 0) {
    const gaps = [...sourceGaps, ...limitations];
    if (inventoryValue.unknownAmount > 0) {
      gaps.push(`${inventoryValue.unknownAmount} inventory units lack valuation evidence.`);
    }
    return {
      methodVersion: 1,
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
    patents: official.components.patents,
  };
  if (carried.cashReservedForOrders > 0) {
    limitations.push('Cash reserved for buy orders is carried from the daily statement.');
  }
  if (carried.deposits > 0 || carried.investmentInBonds > 0) {
    limitations.push('Deposits or bond investments are carried from the daily statement.');
  }
  if (carried.patents > 0) {
    limitations.push('Patent value is carried from the daily statement; intraday patent changes are not priced.');
  }
  if (inventoryValue.qualityLots > 0) {
    limitations.push('Tracked VWAP blends qualities, so quality-specific inventory values are approximate.');
  }

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
    carried.patents,
  ]);
  const total = currentAssets + nonCurrentAssets - liabilities;
  const confidence = inventoryValue.coveragePct < 90 || buildingAssets.issues.length
    ? 'low'
    : 'medium';
  return {
    methodVersion: 1,
    capturedAt,
    official,
    realtimeEstimate: {
      status: 'estimated',
      asOf: capturedAt,
      total: roundMoney(total),
      deltaFromOfficial: roundMoney(total - official.total),
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
        patents: roundMoney(carried.patents),
        bondsPayable: roundMoney(liabilities),
      },
      inventory: {
        total: inventoryValue.total,
        byLocation: inventoryValue.byLocation,
        knownAmount: inventoryValue.knownAmount,
        unknownAmount: inventoryValue.unknownAmount,
        coveragePct: inventoryValue.coveragePct,
        qualityLots: inventoryValue.qualityLots,
      },
      limitations: [...new Set(limitations)],
      methodology: {
        equation: 'current assets + non-current assets - liabilities',
        inventory: 'Previous-day tracked VWAP × 85%, with current ticker and recorded cost fallbacks.',
        buildings: 'Base reference value × completed levels; one base level moves to construction in progress while building.',
        carriedDailyFields: Object.keys(carried),
        referencePriceWindow: referencePriceResult?.window || null,
      },
    },
  };
}

module.exports = {
  INVENTORY_LIQUIDATION_FACTOR,
  calculateBuildingAssets,
  calculateCompanyValue,
  collectInventoryLots,
  derivePreviousDayReferencePrices,
  previousUtcDayWindow,
  resourceSourcingUnitCost,
  summarizeOfficialBalanceSheet,
  valueInventoryLots,
};
