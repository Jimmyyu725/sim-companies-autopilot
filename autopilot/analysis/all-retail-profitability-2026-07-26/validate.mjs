#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('/srv/appdata/caddy/site/drive/vendor/xlsx.full.min.js');
const DIR = path.dirname(new URL(import.meta.url).pathname);
const FILES = {
  workbook: path.join(DIR, 'SimCompanies-Retail-Profitability-2026-07-26.xlsx'),
  allCsv: path.join(DIR, 'SimCompanies-Retail-All-SKUs-2026-07-26.csv'),
  q0Csv: path.join(DIR, 'SimCompanies-Retail-Q0-Products-2026-07-26.csv'),
  raw: path.join(DIR, 'SimCompanies-Retail-Profitability-RAW-2026-07-26.json'),
  market: path.join(DIR, 'SimCompanies-Retail-Market-Snapshot-2026-07-26.json'),
  qa: path.join(DIR, 'SimCompanies-Retail-QA-2026-07-26.json'),
  report: path.join(DIR, 'SimCompanies-Retail-Validation-2026-07-26.json'),
};
const EPS = 1e-7;
const STORE_SALARY_MODIFIERS = {
  '2': 1.1, G: 0.4, A: 1, C: 0.5, H: 0.9, B: 1.7,
  d: 0.5, t: 0.6, z: 0.7, I: 0.7, u: 0.7,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function near(actual, expected, message, relativeTolerance = EPS) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  assert(Math.abs(actual - expected) <= relativeTolerance * scale, `${message}: ${actual} != ${expected}`);
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function csvRowCount(file) {
  const content = fs.readFileSync(file, 'utf8');
  assert(content.charCodeAt(0) === 0xFEFF, `${path.basename(file)} has no UTF-8 BOM`);
  let rows = 0;
  let quoted = false;
  for (let index = 1; index < content.length; index += 1) {
    if (content[index] === '"') {
      if (quoted && content[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && content[index] === '\n') rows += 1;
  }
  assert(!quoted, `${path.basename(file)} has an unterminated CSV quote`);
  return rows - 1;
}

function normalizedGridPrice(price) {
  if (price < 8) return Math.round(price * 100) / 100;
  if (price < 2001) return Math.round(price * 10) / 10;
  return Math.round(price);
}

function assertContiguousRanks(rows, field, filter) {
  const eligible = rows.filter(row => filter(row) && Number.isFinite(row[field]));
  const values = eligible.map(row => row[field]).sort((a, b) => a - b);
  assert(values.length > 0, `${field} has no eligible rows`);
  values.forEach((value, index) => assert(value === index + 1, `${field} is not contiguous at ${index + 1}: ${value}`));
}

function main() {
  for (const [name, file] of Object.entries(FILES)) {
    if (name === 'report') continue;
    assert(fs.existsSync(file), `Missing output: ${file}`);
    assert(fs.statSync(file).size > 0, `Empty output: ${file}`);
  }
  const raw = readJson(FILES.raw);
  const market = readJson(FILES.market);
  const qa = readJson(FILES.qa);
  const rows = raw.skuRows;
  assert(Array.isArray(rows) && rows.length === 69, `Expected 69 SKU rows, got ${rows?.length}`);
  assert(raw.q0Rows.length === 57, `Expected 57 Q0 rows, got ${raw.q0Rows.length}`);
  assert(raw.restaurantRows.length === 16, `Expected 16 Restaurant mappings, got ${raw.restaurantRows.length}`);
  assert(raw.anomalyRows.length === 11, `Expected 11 unmatched API rows, got ${raw.anomalyRows.length}`);
  assert(Array.isArray(raw.rankingRows) && raw.rankingRows.length > 0, 'Long-form ranking export is missing');
  assert(new Set(rows.map(row => row.sku)).size === rows.length, 'SKU keys are not unique');
  assert(rows.filter(row => row.kind === 150).length === 13, 'Tree does not contain Q0-Q12');
  assert(rows.filter(row => row.kind === 150).every(row => row.retailCurveQualityArgument === 0), 'Tree quality was applied twice to retail curve');
  assert(rows.filter(row => [91, 94, 95, 96, 97, 99].includes(row.kind)).every(row => !row.currentExecutable && row.executionStatus === 'MODEL_CEILING_NOT_DIRECTLY_EXECUTABLE'), 'Sales Office execution classification failed');

  for (const row of rows.filter(row => row.optimizerStatus === 'ok')) {
    near(normalizedGridPrice(row.optimalPrice), row.optimalPrice, `${row.sku} is off the official price grid`, 1e-12);
    if (row.averagePrice !== null) {
      assert(row.optimalPrice >= row.averagePrice * 0.2 - 1e-9, `${row.sku} is below the 0.2x UI floor`);
      assert(row.optimalPrice <= row.averagePrice * 5 + 1e-9, `${row.sku} is above the 5x UI ceiling`);
    }
    assert(row.optimizerNeighborOptimal === true, `${row.sku} failed adjacent-grid optimality`);
    near(row.revenuePerHour, row.optimalPrice * row.unitsPerHour, `${row.sku} revenue identity`);
    near(row.grossContributionPerUnit, row.optimalPrice - row.currentOwnCostPerUnit, `${row.sku} gross/unit identity`);
    near(row.grossContributionPerHour, row.grossContributionPerUnit * row.unitsPerHour, `${row.sku} gross/hour identity`);
    near(row.operatingCostPerUnit, row.currentOwnCostPerUnit + row.retailWagePerUnit, `${row.sku} operating cost/unit identity`);
    near(row.operatingNetPerUnit, row.optimalPrice - row.operatingCostPerUnit, `${row.sku} operating net/unit identity`);
    near(row.operatingNetPerHour, row.grossContributionPerHour - row.retailWagePerHour, `${row.sku} operating net/hour identity`);
    near(row.grossContributionMargin, row.grossContributionPerHour / row.revenuePerHour, `${row.sku} gross margin identity`);
    near(row.markupOnOwnCost, row.grossContributionPerUnit / row.currentOwnCostPerUnit, `${row.sku} markup identity`);
    near(row.operatingNetMargin, row.operatingNetPerHour / row.revenuePerHour, `${row.sku} operating net margin identity`);
    near(row.operatingReturnOnOperatingCost, row.operatingNetPerHour / (row.operatingCostPerUnit * row.unitsPerHour), `${row.sku} operating return identity`);
    near(row.totalOperatingLevels, 1 + row.requiredProductionLevels, `${row.sku} total levels identity`);
    near(row.operatingNetPerTotalLevel, row.operatingNetPerHour / row.totalOperatingLevels, `${row.sku} net/level identity`);
    near(row.retailWagePerHour,
      345 * STORE_SALARY_MODIFIERS[row.storeCode] * row.administrationOverhead,
      `${row.sku} live retail wage identity`, 1e-12);
  }

  const theoretical = row => row.optimizerStatus === 'ok';
  const executable = row => row.optimizerStatus === 'ok' && row.currentExecutable;
  const rankSuffixes = [
    'NetPerHour', 'OperatingNetMargin', 'GrossMargin', 'Markup', 'OperatingReturn',
    'NetPerUnit', 'GrossPerUnit', 'NetPerTotalLevel', 'RevenuePerHour', 'UnitsPerHour',
    'LowestCost', 'LowestLevels',
  ];
  for (const suffix of rankSuffixes) {
    assertContiguousRanks(rows, `rankTheoretical${suffix}`, theoretical);
    assertContiguousRanks(rows, `rankExecutable${suffix}`, executable);
  }
  for (const store of new Set(rows.map(row => row.storeCode))) {
    for (const suffix of rankSuffixes) {
      assertContiguousRanks(rows, `rankStore${suffix}`, row => theoretical(row) && row.storeCode === store);
    }
  }

  assert(qa.pass === true, 'Generator QA is not PASS');
  assert(qa.counts.directSkus === 69 && qa.counts.directProducts === 57, 'Generator count QA mismatch');
  assert(qa.formulaValidation.neutralMaxRelativeError < 1e-12, 'Neutral recursive production model validation is too imprecise');
  assert(qa.formulaValidation.optimizerNeighborFailures.length === 0, 'Generator reports price neighbor failures');
  assert(qa.formulaValidation.uiBoundaryFailures.length === 0, 'Generator reports UI price-bound failures');
  assert(market.comparisons.modelDiffCount === 0, 'Current official and local state1 models differ');
  assert(market.comparisons.salesMappingEqual === true, 'Current official and local SALES mappings differ');
  assert(market.payloads.retail.length === 80, 'Market snapshot does not contain all 80 retail rows');
  assert(market.sources.retail.status === 200 && market.sources.weather.status === 200
    && market.sources.modifiers.status === 200 && market.sources.company.status === 200
    && market.sources.officialBundle.status === 200, 'One or more source fetches were not HTTP 200');

  assert(csvRowCount(FILES.allCsv) === 69, 'All-SKU CSV row count is not 69');
  assert(csvRowCount(FILES.q0Csv) === 57, 'Q0 CSV row count is not 57');

  const workbook = XLSX.read(fs.readFileSync(FILES.workbook), { type: 'buffer' });
  const requiredSheets = ['README', '产品基准Q0', '全部零售SKU', '当前可执行', '模型上限', '全部排名', '餐厅组合', '接口异常', '商店冠军', '指标说明', '当前咖啡瓶颈', '数据源与QA'];
  for (const name of requiredSheets) assert(workbook.SheetNames.includes(name), `Workbook is missing sheet ${name}`);
  assert(workbook.SheetNames.length === requiredSheets.length, `Workbook has unexpected sheet count ${workbook.SheetNames.length}`);
  const expectedDataRows = {
    '产品基准Q0': 57,
    '全部零售SKU': 69,
    '当前可执行': raw.executableRows.length,
    '模型上限': raw.modelRows.length,
    '全部排名': raw.rankingRows.length,
    '餐厅组合': 16,
    '接口异常': 11,
    '商店冠军': raw.storeChampions.length,
  };
  for (const [name, expected] of Object.entries(expectedDataRows)) {
    const range = XLSX.utils.decode_range(workbook.Sheets[name]['!ref']);
    assert(range.e.r === expected, `${name} has ${range.e.r} data rows, expected ${expected}`);
  }

  const report = {
    ok: true,
    validatedAt: new Date().toISOString(),
    counts: qa.counts,
    checks: {
      metricIdentities: rows.filter(theoretical).length,
      rankFamilies: rankSuffixes.length,
      priceGridAndUiBounds: rows.filter(theoretical).length,
      workbookSheets: workbook.SheetNames,
      csvBomAndRows: true,
      officialModelDiffCount: market.comparisons.modelDiffCount,
      neutralMaxRelativeError: qa.formulaValidation.neutralMaxRelativeError,
    },
    files: Object.fromEntries(Object.entries(FILES).filter(([name]) => name !== 'report').map(([name, file]) => [name, {
      file, bytes: fs.statSync(file).size, sha256: hashFile(file),
    }])),
  };
  fs.writeFileSync(FILES.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
