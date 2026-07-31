'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateVolumeRecords } = require('../../shared/price-tracker/data-quality.js');
const {
  calculateBuildingAssets,
  calculateCompanyValue,
  calculatePatentAssets,
  collectInventoryLots,
  deriveQualityMarketPrices,
  derivePreviousDayReferencePrices,
  inventoryAmountsByQuality,
  summarizeOfficialBalanceSheet,
  valueInventoryLots,
} = require('../company-value.js');

const PATENT_REQUIREMENTS = [12, 50, 500, 2000, 5000, 10000, 10000, 10000, 10000, 10000, 50000, 50000];
const PATENT_VALUES = {
  29: 1368,
  145: 1728,
};
const RESEARCH_DEFINITIONS = {
  29: { isResearch: true, improvesQualityOf: [118] },
  145: { isResearch: true, improvesQualityOf: [119] },
};

function latestBalance() {
  return {
    date: '2026-07-30T01:08:16.893127+00:00',
    cash: 175693,
    cashReservedForOrders: 0,
    accountsReceivable: 11633,
    materials: 19458,
    research: 0,
    workInProcess: 11569,
    finishedGoods: 58289,
    valuationAllowance: 28021,
    deposits: 0,
    investmentInBonds: 0,
    buildings: 376050,
    constructionInProgress: 24150,
    patents: 25920,
    bondsPayable: 345000,
  };
}

test('reproduces the complete official company-value equation', () => {
  const result = summarizeOfficialBalanceSheet(latestBalance());
  assert.equal(result.status, 'ok');
  assert.equal(result.components.inventory, 117337);
  assert.equal(result.currentAssets, 304663);
  assert.equal(result.nonCurrentAssets, 426120);
  assert.equal(result.liabilities, 345000);
  assert.equal(result.total, 385783);
  assert.equal(summarizeOfficialBalanceSheet({ cash: 1 }).status, 'unavailable');
});

test('moves one base building level into construction in progress', () => {
  const assets = calculateBuildingAssets([
    { id: 1, category: 'production', cost: 27600, size: 3, busy: null },
    { id: 2, category: 'sales', cost: 10350, size: 2, busy: null },
    { id: 3, category: 'production', cost: 24150, size: 1,
      busy: { category: 'b', expanding: true } },
    { id: 4, category: 'seasonal', cost: 99999, size: 1 },
  ]);
  assert.equal(assets.buildings, 103500);
  assert.equal(assets.constructionInProgress, 24150);
  assert.deepEqual(assets.issues, []);
});

test('derives the prior UTC day tracked VWAP and 85% liquidation value', () => {
  const start = Date.parse('2026-07-29T00:00:00.000Z') / 1000;
  const end = Date.parse('2026-07-30T00:00:00.000Z') / 1000;
  const line = JSON.stringify({
    t0: start,
    t1: end,
    t0ByKind: { 119: start },
    u: { 119: 100 },
    v: { 119: 5000 },
    amb: {},
    kinds: 1,
    fail: [],
  });
  const result = derivePreviousDayReferencePrices(
    line,
    '2026-07-30T01:08:16.893127+00:00',
    aggregateVolumeRecords,
  );
  assert.equal(result.status, 'estimated');
  assert.equal(result.prices[119].vwap, 50);
  assert.equal(result.prices[119].liquidationUnitValue, 42.5);
  assert.equal(result.window.startIso, '2026-07-29T00:00:00.000Z');
  assert.equal(result.window.endIso, '2026-07-30T00:00:00.000Z');
});

test('collects every inventory location and values production WIP at live unit cost', () => {
  const result = collectInventoryLots({
    warehouse: [{ kind: 1, quality: 0, amount: 100, cost: { market: 28 } }],
    marketOrders: [{ kind: 2, quality: 0, quantity: 10, seller: { id: 1 } },
      { kind: 13, quantity: 99, buyer: { id: 1 } }],
    outgoingContracts: [{ kind: 66, quality: 0, amount: 5 }],
    buildings: [{
      id: 1,
      busy: {
        resource: {
          kind: 119,
          quality: 0,
          amount: 100,
          amountAvailableNow: 20,
          unitCost: 2.5,
        },
      },
    }, {
      id: 2,
      busy: {
        sales_order: {
          kind: 119,
          price: 38.8,
          remainingProfit: 3880,
          profitAvailableNow: 200,
        },
      },
    }],
    resourceDefinitions: {
      119: { producedFrom: { 118: 10 } },
    },
  });
  assert.equal(result.accountsReceivable, 200);
  assert.equal(result.lots.find(lot => lot.location === 'warehouse').sourcingUnitCost, 0.28);
  assert.equal(result.lots.find(lot => lot.location === 'exchange-order').amount, 10);
  assert.equal(result.lots.find(lot => lot.location === 'outgoing-contract').amount, 5);
  assert.equal(result.lots.find(lot => lot.location === 'production-ready').amount, 20);
  assert.equal(result.lots.find(lot => lot.location === 'work-in-process').kind, 119);
  assert.equal(result.lots.find(lot => lot.location === 'work-in-process').amount, 80);
  assert.equal(result.lots.find(lot => lot.location === 'work-in-process').sourcingUnitCost, 2.5);
  assert.ok(Math.abs(result.lots.find(lot => lot.location === 'retail').amount - 100) < 1e-9);
  assert.match(result.limitations.join(' '), /Q0 was used conservatively/);

  const valuation = valueInventoryLots(result.lots, {
    referencePrices: {
      1: { liquidationUnitValue: 0.2 },
      2: { liquidationUnitValue: 0.4 },
      66: { liquidationUnitValue: 0.3 },
      118: { liquidationUnitValue: 0.8 },
      119: { liquidationUnitValue: 42.5 },
    },
  });
  assert.equal(valuation.coveragePct, 100);
  assert.equal(valuation.byLocation['work-in-process'], 200);
  assert.equal(valuation.byLocation.retail, 4250);
  assert.equal(valuation.valueByBasis['live-production-unit-cost'], 200);
});

test('uses exact-quality live asks and interpolates an illiquid held quality', () => {
  const prices = deriveQualityMarketPrices([{
    kind: 119,
    status: 200,
    qualities: [
      { quality: 0, bestAsk: 38, listedUnits: 10000, orderCount: 10 },
      { quality: 1, bestAsk: 40, listedUnits: 10000, orderCount: 8 },
      { quality: 2, bestAsk: 46.5, listedUnits: 500, orderCount: 1 },
      { quality: 3, bestAsk: 44, listedUnits: 10000, orderCount: 6 },
    ],
  }], {
    '119:0': 100,
    '119:2': 2664,
  }, {
    capturedAt: '2026-07-31T03:00:00Z',
  });

  assert.equal(prices.status, 'estimated');
  assert.equal(prices.prices[119][0].marketUnitValue, 38);
  assert.equal(prices.prices[119][0].basis, 'current-quality-best-ask');
  assert.equal(prices.prices[119][2].marketUnitValue, 42);
  assert.equal(
    prices.prices[119][2].basis,
    'current-quality-interpolated-best-ask',
  );
  assert.ok(Math.abs(prices.prices[119][2].liquidationUnitValue - 35.7) < 1e-9);
});

test('requests quality prices only for inventory that is not WIP', () => {
  assert.deepEqual(inventoryAmountsByQuality([
    { kind: 119, quality: 2, amount: 100, location: 'warehouse' },
    { kind: 119, quality: 2, amount: 20, location: 'retail' },
    { kind: 119, quality: 2, amount: 50, location: 'work-in-process' },
    { kind: 2, quality: 0, amount: 10, location: 'warehouse' },
  ]), {
    '119:2': 120,
    '2:0': 10,
  });
});

test('quantifies immaterial inventory fallback exposure', () => {
  const valuation = valueInventoryLots([
    { kind: 119, quality: 2, amount: 1000, location: 'warehouse' },
    {
      kind: 2,
      quality: 0,
      amount: 1,
      location: 'warehouse',
      sourcingUnitCost: 1,
    },
  ], {
    qualityMarketPrices: {
      119: {
        2: {
          liquidationUnitValue: 40,
          basis: 'current-quality-best-ask',
        },
      },
    },
  });

  assert.equal(valuation.total, 40001);
  assert.equal(valuation.lowConfidenceValue, 1);
  assert.equal(valuation.lowConfidenceSharePct, 0);
});

test('keeps confidence medium when fallback inventory value is immaterial', () => {
  const result = calculateCompanyValue({
    capturedAt: '2026-07-31T04:00:00Z',
    balanceSheet: {
      date: '2026-07-31T01:00:00Z',
      cash: 1000,
      cashReservedForOrders: 0,
      accountsReceivable: 0,
      materials: 0,
      research: 0,
      workInProcess: 0,
      finishedGoods: 0,
      valuationAllowance: 0,
      deposits: 0,
      investmentInBonds: 0,
      buildings: 0,
      constructionInProgress: 0,
      patents: 0,
      bondsPayable: 0,
    },
    liveCash: 1000,
    liveBondsPayable: 0,
    buildings: [],
    warehouse: [
      { kind: 119, quality: 2, amount: 1000 },
      { kind: 2, quality: 0, amount: 1, cost: { market: 1 } },
    ],
    marketOrders: [],
    outgoingContracts: [],
    resourceDefinitions: {
      29: { isResearch: true, improvesQualityOf: [119] },
    },
    researchProgress: [],
    patentRequirements: [12],
    patentValuesByResearchKind: { 29: 100 },
    referencePriceResult: { prices: {}, window: null },
    qualityMarketPriceResult: {
      prices: {
        119: {
          2: {
            liquidationUnitValue: 40,
            basis: 'current-quality-best-ask',
          },
        },
      },
      issues: [],
    },
    tickerPrices: {},
  });

  assert.equal(result.realtimeEstimate.status, 'estimated');
  assert.equal(result.realtimeEstimate.confidence, 'medium');
  assert.equal(result.realtimeEstimate.inventory.lowConfidenceValue, 1);
  assert.equal(result.realtimeEstimate.inventory.lowConfidenceSharePct, 0);
});

test('reconstructs live patent value from cumulative quality thresholds and current progress', () => {
  const result = calculatePatentAssets([
    { quality: 2, kind: 119, patents: 1, patentsNeeded: 500 },
    { quality: 2, kind: 118, patents: 18, patentsNeeded: 500 },
  ], {
    resourceDefinitions: RESEARCH_DEFINITIONS,
    patentRequirements: PATENT_REQUIREMENTS,
    patentValuesByResearchKind: PATENT_VALUES,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.patentCount, 143);
  assert.equal(result.byProduct[119].cumulativePatentCount, 63);
  assert.equal(result.byProduct[119].value, 108864);
  assert.equal(result.byProduct[118].cumulativePatentCount, 80);
  assert.equal(result.byProduct[118].value, 109440);
  assert.equal(result.total, 218304);
});

test('calculates a live estimate using current patents instead of the daily patent field', () => {
  const balance = {
    date: '2026-07-30T01:00:00Z',
    cash: 100,
    cashReservedForOrders: 0,
    accountsReceivable: 0,
    materials: 10,
    research: 0,
    workInProcess: 0,
    finishedGoods: 0,
    valuationAllowance: 0,
    deposits: 0,
    investmentInBonds: 0,
    buildings: 50,
    constructionInProgress: 0,
    patents: 10,
    bondsPayable: 20,
  };
  const result = calculateCompanyValue({
    capturedAt: '2026-07-30T04:00:00Z',
    balanceSheet: balance,
    liveCash: 200,
    liveBondsPayable: 30,
    buildings: [{
      id: 1,
      category: 'sales',
      cost: 50,
      size: 1,
      busy: {
        sales_order: {
          kind: 1,
          quality: 0,
          price: 1,
          remainingProfit: 0,
          profitAvailableNow: 20,
        },
      },
    }],
    warehouse: [{ kind: 1, quality: 0, amount: 100 }],
    marketOrders: [],
    outgoingContracts: [],
    resourceDefinitions: {
      29: { isResearch: true, improvesQualityOf: [1] },
    },
    researchProgress: [{ quality: 0, kind: 1, patents: 2, patentsNeeded: 12 }],
    patentRequirements: [12, 50],
    patentValuesByResearchKind: { 29: 100 },
    referencePriceResult: {
      prices: { 1: { liquidationUnitValue: 0.1 } },
      window: { startIso: '2026-07-29T00:00:00Z', endIso: '2026-07-30T00:00:00Z' },
    },
    tickerPrices: {},
  });
  assert.equal(result.official.total, 150);
  assert.equal(result.methodVersion, 3);
  assert.equal(result.realtimeEstimate.total, 450);
  assert.equal(result.realtimeEstimate.deltaFromOfficial, 300);
  assert.equal(result.realtimeEstimate.components.inventory, 10);
  assert.equal(result.realtimeEstimate.confidence, 'low');
  assert.equal(result.realtimeEstimate.components.accountsReceivable, 20);
  assert.equal(result.realtimeEstimate.components.patents, 200);
  assert.equal(result.realtimeEstimate.patents.patentCount, 2);
  assert.equal(result.realtimeEstimate.comparisonToOfficialSnapshot.snapshotAgeSeconds, 10800);
  assert.equal(
    result.realtimeEstimate.comparisonToOfficialSnapshot.componentDifference.patents,
    190,
  );
  assert.ok(!result.realtimeEstimate.methodology.carriedDailyFields.includes('patents'));
});

test('refuses a total when a live asset source or inventory price is missing', () => {
  const completeInputs = {
    capturedAt: '2026-07-30T04:00:00Z',
    balanceSheet: latestBalance(),
    liveCash: 200000,
    liveBondsPayable: 345000,
    buildings: [],
    warehouse: [],
    marketOrders: [],
    outgoingContracts: [],
    resourceDefinitions: RESEARCH_DEFINITIONS,
    researchProgress: [],
    patentRequirements: PATENT_REQUIREMENTS,
    patentValuesByResearchKind: PATENT_VALUES,
    referencePriceResult: { prices: {}, window: null },
    tickerPrices: {},
  };
  const missingOrders = calculateCompanyValue({ ...completeInputs, marketOrders: null });
  assert.equal(missingOrders.realtimeEstimate.status, 'unavailable');
  assert.equal(missingOrders.realtimeEstimate.total, null);
  assert.match(missingOrders.realtimeEstimate.limitations.join(' '), /market-order source/);

  const missingResearch = calculateCompanyValue({ ...completeInputs, researchProgress: null });
  assert.equal(missingResearch.realtimeEstimate.status, 'unavailable');
  assert.equal(missingResearch.realtimeEstimate.total, null);
  assert.match(missingResearch.realtimeEstimate.limitations.join(' '), /research-progress source/);

  const missingPrice = calculateCompanyValue({
    ...completeInputs,
    warehouse: [{ kind: 150, quality: 0, amount: 10 }],
  });
  assert.equal(missingPrice.realtimeEstimate.status, 'unavailable');
  assert.equal(missingPrice.realtimeEstimate.inventoryCoveragePct, 0);
});
