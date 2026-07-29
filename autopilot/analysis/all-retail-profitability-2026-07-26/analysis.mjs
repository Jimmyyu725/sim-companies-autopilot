#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('/srv/appdata/caddy/site/drive/vendor/xlsx.full.min.js');

const ROOT = '/srv/appdata/chrome-automation/sim';
const OUT = path.dirname(new URL(import.meta.url).pathname);
const LOCAL_BUNDLE = path.join(ROOT, 'bundle-main.js');
const DEFS_FILE = path.join(ROOT, 'defs.json');
const STATE_FILE = path.join(ROOT, 'autopilot/.state.json');
const AUTH_EVIDENCE_FILE = path.join(ROOT, 'mkt70.json');
const ECONOMY_STATE = 1;
const COMPANY_ID = 5714348;
const REALM_ID = 0;
const AVERAGE_SALARY = 345;
const SALARY_MID = 700;
const RETAIL_VARIABLE_COST = 370;
const QUALITY_WEIGHT = 0.3;
const SEASON_THRESHOLD = 0.8;
const EPS = 1e-10;

const URLS = {
  retail: `https://www.simcompanies.com/api/v4/${REALM_ID}/resources-retail-info/`,
  weather: `https://www.simcompanies.com/api/v2/weather/${REALM_ID}/`,
  modifiers: `https://www.simcompanies.com/api/v2/production-modifiers/${REALM_ID}/`,
  company: `https://www.simcompanies.com/api/v3/companies/${COMPANY_ID}/`,
  home: 'https://www.simcompanies.com/',
};

const STORE_NAMES = {
  '2': ['Car Dealership', '汽车经销店'],
  G: ['Grocery Store', '杂货店'],
  A: ['Gas Station', '加油站'],
  C: ['Electronics Store', '电子产品店'],
  H: ['Fashion Store', '时装店'],
  B: ['Sales Office', '销售办公室'],
  d: ['Hardware Store', '五金店'],
  r: ['Restaurant', '餐厅'],
  t: ['Halloween Market', '万圣节市场'],
  z: ['Beach Market', '海滩市场'],
  I: ['Easter Market', '复活节市场'],
  u: ['Christmas Market', '圣诞市场'],
};

const PRODUCT_NAMES = {
  3: ['Apples', '苹果'], 4: ['Oranges', '橙子'], 5: ['Grapes', '葡萄'],
  7: ['Steak', '牛排'], 8: ['Sausages', '香肠'], 9: ['Eggs', '鸡蛋'],
  11: ['Petrol', '汽油'], 12: ['Diesel', '柴油'],
  24: ['Smartphones', '智能手机'], 25: ['Tablets', '平板电脑'], 26: ['Laptops', '笔记本电脑'],
  27: ['Monitors', '显示器'], 28: ['Televisions', '电视'],
  53: ['Economy E-car', '经济电动车'], 54: ['Luxury E-car', '豪华电动车'],
  55: ['Economy Car', '经济型汽车'], 56: ['Luxury Car', '豪华汽车'], 57: ['Truck', '卡车'],
  60: ['Underwear', '内衣'], 61: ['Gloves', '手套'], 62: ['Dress', '连衣裙'],
  63: ['Stiletto Heels', '高跟鞋'], 64: ['Handbags', '手提包'], 65: ['Sneakers', '运动鞋'],
  67: ['Xmas Crackers', '圣诞拉炮'], 70: ['Luxury Watch', '豪华手表'], 71: ['Necklace', '项链'],
  91: ['Suborbital Rocket', '亚轨道火箭'], 94: ['BFR', 'BFR 火箭'], 95: ['Jumbo Jet', '大型客机'],
  96: ['Private Jet', '私人飞机'], 97: ['Single-engine Plane', '单引擎飞机'], 98: ['Quadcopter', '四旋翼飞行器'],
  99: ['Satellite', '卫星'], 102: ['Bricks', '砖'], 103: ['Cement', '水泥'],
  108: ['Planks', '木板'], 109: ['Windows', '窗户'], 110: ['Tools', '工具'],
  117: ['Milk', '牛奶'], 119: ['Coffee Powder', '咖啡粉'], 121: ['Bread', '面包'],
  122: ['Cheese', '奶酪'], 123: ['Apple Pie', '苹果派'], 124: ['Orange Juice', '橙汁'],
  125: ['Apple Cider', '苹果酒'], 126: ['Ginger Beer', '姜汁啤酒'], 127: ['Frozen Pizza', '冷冻披萨'],
  129: ['Hamburger', '汉堡'], 130: ['Lasagna', '千层面'], 131: ['Meatballs', '肉丸'],
  132: ['Cocktails', '鸡尾酒'], 134: ['Butter', '黄油'], 140: ['Chocolate', '巧克力'],
  142: ['Salad', '沙拉'], 143: ['Samosas', '萨莫萨三角饺'], 144: ['Xmas Ornament', '圣诞装饰'],
  146: ['Pumpkin', '南瓜'], 147: ["Jack O'Lantern", '南瓜灯'], 148: ['Witch Costume', '女巫服'],
  149: ['Pumpkin Soup', '南瓜汤'], 150: ['Tree', '圣诞树'], 151: ['Easter Bunny', '复活节兔子'],
  152: ['Ramadan Sweets', '斋月甜点'], 153: ['Chocolate Ice Cream', '巧克力冰淇淋'],
  154: ['Apple Ice Cream', '苹果冰淇淋'], 155: ['Cream Egg', '奶油蛋'],
};

const RETAIL_SEASONS = {
  Ramadan: [['01/01', 0.03], ['02/05', 0.03], ['02/18', 0.9], ['03/19', 1], ['03/30', 0.03], ['12/31', 0.03]],
  Easter: [['01/01', 0.03], ['03/05', 0.03], ['03/20', 0.9], ['04/20', 1], ['04/30', 0.03], ['12/31', 0.03]],
  Summer: [['01/01', 0.03], ['07/05', 0.03], ['07/14', 1], ['08/20', 1], ['09/14', 0.03], ['12/31', 0.03]],
  Halloween: [['01/01', 0.03], ['10/01', 0.03], ['10/15', 1], ['11/03', 1], ['11/15', 0.03], ['12/31', 0.03]],
  Xmas: [['01/01', 0.3], ['01/10', 0.03], ['11/01', 0.03], ['11/25', 0.7], ['12/04', 1], ['12/24', 1], ['12/31', 0.3]],
};

const PRODUCTION_SEASONS = {
  AutumnHarvest: [
    ['01/01', 0.03, 0.05], ['08/01', 0.03, 0.05], ['09/03', 0.8, 1],
    ['10/01', 1, 1.5], ['11/01', 1, 1.5], ['11/14', 0.3, 0.5],
    ['11/20', 0.03, 0.05], ['12/31', 0.03, 0.05],
  ],
};

const SALES_OFFICE_KINDS = new Set([91, 94, 95, 96, 97, 99]);
const SEASONAL_STORES = new Set(['t', 'z', 'I', 'u']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractEconomyModel(bundle, state = ECONOMY_STATE) {
  const marker = `'),${state}:JSON.parse('`;
  const start = bundle.indexOf(marker);
  assert(start >= 0, `Economy-state ${state} marker was not found in bundle`);
  const payloadStart = start + marker.length;
  const end = bundle.indexOf("')", payloadStart);
  assert(end > payloadStart, `Economy-state ${state} JSON terminator was not found`);
  return JSON.parse(bundle.slice(payloadStart, end));
}

function extractSales(bundle) {
  const open = bundle.indexOf('{2:[53,54,55,56,57],G:[');
  assert(open >= 0, 'SALES mapping marker was not found in bundle');
  let depth = 0;
  let end = -1;
  for (let index = open; index < bundle.length; index += 1) {
    if (bundle[index] === '{') depth += 1;
    if (bundle[index] === '}') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  assert(end > open, 'SALES mapping terminator was not found');
  const literal = bundle.slice(open, end + 1);
  // The public bundle literal contains only property names, arrays, and numeric values.
  return Function(`"use strict"; return (${literal});`)();
}

function extractSalaryModifiers(bundle) {
  const out = {};
  for (const match of bundle.matchAll(/salaryModifier:([.\d]+)/g)) {
    const letterAt = bundle.lastIndexOf('dbLetter:"', match.index);
    if (letterAt < 0 || match.index - letterAt > 4000) continue;
    const valueStart = letterAt + 'dbLetter:"'.length;
    const valueEnd = bundle.indexOf('"', valueStart);
    out[bundle.slice(valueStart, valueEnd)] = Number(match[1]);
  }
  return out;
}

async function fetchTextWithMeta(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  const text = await response.text();
  assert(response.ok, `HTTP ${response.status} for ${url}`);
  return {
    url,
    status: response.status,
    fetchedAt: new Date().toISOString(),
    headers: {
      date: response.headers.get('date'),
      lastModified: response.headers.get('last-modified'),
      etag: response.headers.get('etag'),
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
    },
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    text,
  };
}

async function fetchJsonWithMeta(url) {
  const result = await fetchTextWithMeta(url);
  return { ...result, json: JSON.parse(result.text) };
}

function stripPayload(source) {
  const { text, json, ...meta } = source;
  return meta;
}

function currentRetailPoint(row) {
  const history = Array.isArray(row.retailData) ? row.retailData : [];
  if (!history.length) return {};
  return history.reduce((latest, point) => !latest || String(point.date) > String(latest.date) ? point : latest, null);
}

function slugName(resource) {
  const slug = path.basename(resource.image || '', path.extname(resource.image || ''));
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function productNames(kind, resource) {
  return PRODUCT_NAMES[kind] || [slugName(resource), slugName(resource)];
}

function monthDayPoint(date, mmdd) {
  const [month, day] = mmdd.split('/').map(Number);
  return Date.UTC(date.getUTCFullYear(), month - 1, day);
}

function bracket(points, date) {
  const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  let previous = points[0];
  let next = points.at(-1);
  for (const point of points) {
    const pointAt = monthDayPoint(date, point[0]);
    if (pointAt <= at) previous = point;
    if (pointAt > at) { next = point; break; }
  }
  return { previous, next, at };
}

function retailSeasonValue(season, date) {
  if (!season) return 1;
  const points = RETAIL_SEASONS[season];
  assert(points, `Unknown retail season: ${season}`);
  const { previous, next, at } = bracket(points, date);
  if (previous === next) return previous[1];
  const from = monthDayPoint(date, previous[0]);
  const to = monthDayPoint(date, next[0]);
  return previous[1] + (at - from) / (to - from) * (next[1] - previous[1]);
}

function productionSeasonValue(season, date) {
  if (!season) return 1;
  const points = PRODUCTION_SEASONS[season];
  assert(points, `Unknown production season: ${season}`);
  const { previous, next, at } = bracket(points, date);
  if (previous === next) return previous[1];
  const from = monthDayPoint(date, previous[0]);
  const to = monthDayPoint(date, next[0]);
  // This intentionally mirrors the client: interpolate previous.min to next.max.
  return previous[1] + (at - from) / (to - from) * (next[2] - previous[1]);
}

function priceStep(price) {
  if (price < 8 - EPS) return 0.01;
  if (price < 2001 - EPS) return 0.1;
  return 1;
}

function normalizePrice(price) {
  if (price < 8) return Math.round(price * 100) / 100;
  if (price < 2001) return Math.round(price * 10) / 10;
  return Math.round(price);
}

function previousGridPrice(price) {
  if (price > 2001 + EPS) return Math.round(price) - 1;
  if (Math.abs(price - 2001) <= EPS) return 2000.9;
  if (price > 8 + EPS) return Math.round(price * 10 - 1) / 10;
  if (Math.abs(price - 8) <= EPS) return 7.99;
  return Math.round(price * 100 - 1) / 100;
}

function nextGridPrice(price) {
  if (price >= 2001 - EPS) return Math.round(price) + 1;
  if (price >= 2000.9 - EPS) return 2001;
  if (price >= 8 - EPS) return Math.round(price * 10 + 1) / 10;
  if (price >= 7.99 - EPS) return 8;
  return Math.round(price * 100 + 1) / 100;
}

function gridCandidatesAround(price) {
  const candidates = new Set();
  for (const step of [0.01, 0.1, 1]) {
    for (let offset = -8; offset <= 8; offset += 1) candidates.add(normalizePrice(price + offset * step));
  }
  let normalized = normalizePrice(price);
  candidates.add(normalized);
  for (let i = 0; i < 8; i += 1) {
    normalized = previousGridPrice(normalized);
    candidates.add(normalized);
  }
  normalized = normalizePrice(price);
  for (let i = 0; i < 8; i += 1) {
    normalized = nextGridPrice(normalized);
    candidates.add(normalized);
  }
  return candidates;
}

function firstGridAtOrAbove(value) {
  const probes = [
    Math.ceil((value - EPS) * 100) / 100,
    Math.ceil((Math.max(value, 8) - EPS) * 10) / 10,
    Math.ceil(Math.max(value, 2001) - EPS),
  ].map(normalizePrice).filter(candidate => candidate + EPS >= value);
  return Math.min(...probes);
}

function lastGridAtOrBelow(value) {
  const probes = [
    Math.floor((Math.min(value, 7.99) + EPS) * 100) / 100,
    Math.floor((Math.min(value, 2000.9) + EPS) * 10) / 10,
    Math.floor(value + EPS),
  ].map(normalizePrice).filter(candidate => candidate <= value + EPS && candidate > 0);
  return Math.max(...probes);
}

function retailSeconds(store, model, quantity, salesModifier, price, quality, saturation, weatherMultiplier = 1) {
  const demand = Math.min(Math.max(2 - saturation, 0), 2);
  const priceDemandFactor = Math.max(0.9, demand / 2 + 0.5);
  const qualityFactor = quality / 12;
  const variableCost = RETAIL_VARIABLE_COST
    * (model.buildingLevelsNeededPerUnitPerHour * model.modeledUnitsSoldAnHour + 1)
    * (store === 'B' ? 2.28 : 1)
    * (demand / 2 * (1 + qualityFactor * QUALITY_WEIGHT));
  const modeledUnits = model.modeledUnitsSoldAnHour * priceDemandFactor;
  const storeWage = model.modeledStoreWages ?? 0;
  const modeledPrice = model.modeledProductionCostPerUnit + (variableCost + storeWage) / modeledUnits;
  const curvature = (storeWage + variableCost)
    / ((modeledPrice - model.modeledProductionCostPerUnit) ** 2);
  const salesCurve = variableCost - ((price - modeledPrice) ** 2) * curvature;
  const seconds = (quantity * ((price - model.modeledProductionCostPerUnit) * 3600) - storeWage)
    / (salesCurve + storeWage);
  if (!Number.isFinite(seconds) || seconds <= 0) return NaN;
  return seconds * (1 - salesModifier / 100) / weatherMultiplier;
}

function retailUnitsPerHour(store, model, salesModifier, price, quality, saturation, weatherMultiplier) {
  const seconds = retailSeconds(store, model, 100, salesModifier, price, quality, saturation, weatherMultiplier);
  return Number.isFinite(seconds) && seconds > 0 ? 100 * 3600 / seconds : NaN;
}

function retailCurveBounds(store, model, quality, saturation) {
  const demand = Math.min(Math.max(2 - saturation, 0), 2);
  if (demand <= 0) return null;
  const priceDemandFactor = Math.max(0.9, demand / 2 + 0.5);
  const variableCost = RETAIL_VARIABLE_COST
    * (model.buildingLevelsNeededPerUnitPerHour * model.modeledUnitsSoldAnHour + 1)
    * (store === 'B' ? 2.28 : 1)
    * (demand / 2 * (1 + quality / 12 * QUALITY_WEIGHT));
  const modeledPrice = model.modeledProductionCostPerUnit
    + (variableCost + (model.modeledStoreWages ?? 0)) / (model.modeledUnitsSoldAnHour * priceDemandFactor);
  return {
    lower: model.modeledProductionCostPerUnit,
    upper: 2 * modeledPrice - model.modeledProductionCostPerUnit,
    modeledPrice,
  };
}

function goldenMaximum(fn, lower, upper) {
  if (!(upper > lower)) return lower;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let left = lower;
  let right = upper;
  let x1 = right - ratio * (right - left);
  let x2 = left + ratio * (right - left);
  let y1 = fn(x1);
  let y2 = fn(x2);
  for (let i = 0; i < 120; i += 1) {
    if (y1 < y2) {
      left = x1; x1 = x2; y1 = y2;
      x2 = left + ratio * (right - left); y2 = fn(x2);
    } else {
      right = x2; x2 = x1; y2 = y1;
      x1 = right - ratio * (right - left); y1 = fn(x1);
    }
  }
  return y1 >= y2 ? x1 : x2;
}

function optimizePrice({ store, model, quality, saturation, averagePrice, ownCost, retailWage, salesModifier, weatherMultiplier }) {
  const curve = retailCurveBounds(store, model, quality, saturation);
  if (!curve) return { status: 'zero-demand', price: null };
  const uiLower = Number.isFinite(averagePrice) ? averagePrice * 0.2 : 0;
  const uiUpper = Number.isFinite(averagePrice) ? averagePrice * 5 : Infinity;
  const lower = Math.max(curve.lower + EPS, uiLower, 0.01);
  const upper = Math.min(curve.upper - EPS, uiUpper);
  if (!(upper >= lower)) return { status: 'no-valid-price', price: null, lower, upper };

  const score = price => {
    const units = retailUnitsPerHour(store, model, salesModifier, price, quality, saturation, weatherMultiplier);
    return Number.isFinite(units) ? (price - ownCost) * units - retailWage : -Infinity;
  };
  const candidates = new Set();
  const segments = [[lower, Math.min(upper, 7.99)], [Math.max(lower, 8), Math.min(upper, 2000.9)], [Math.max(lower, 2001), upper]];
  for (const [segmentLower, segmentUpper] of segments) {
    if (segmentUpper + EPS < segmentLower) continue;
    const first = firstGridAtOrAbove(segmentLower);
    const last = lastGridAtOrBelow(segmentUpper);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last + EPS < first) continue;
    candidates.add(first); candidates.add(last);
    const peak = goldenMaximum(score, segmentLower, segmentUpper);
    for (const candidate of gridCandidatesAround(peak)) candidates.add(candidate);
  }
  for (const boundary of [8, 2001, lower, upper, curve.modeledPrice]) {
    for (const candidate of gridCandidatesAround(boundary)) candidates.add(candidate);
  }
  const valid = [...candidates].filter(price => price >= lower - EPS && price <= upper + EPS && price > 0);
  assert(valid.length > 0, `No valid price-grid point in [${lower}, ${upper}]`);
  let best = null;
  for (const price of valid) {
    const value = score(price);
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.value + EPS || (Math.abs(value - best.value) <= EPS && price < best.price)) best = { price, value };
  }
  if (!best) return { status: 'no-finite-profit', price: null, lower, upper };
  const previous = previousGridPrice(best.price);
  const next = nextGridPrice(best.price);
  const previousValue = previous >= lower - EPS ? score(previous) : null;
  const nextValue = next <= upper + EPS ? score(next) : null;
  const sampleBest = { price: null, value: -Infinity };
  for (let i = 0; i <= 2048; i += 1) {
    const price = lower + (upper - lower) * i / 2048;
    const value = score(price);
    if (value > sampleBest.value) { sampleBest.price = price; sampleBest.value = value; }
  }
  return {
    status: 'ok',
    price: best.price,
    value: best.value,
    uiBoundApplied: Number.isFinite(averagePrice),
    lower,
    upper,
    curveLower: curve.lower,
    curveUpper: curve.upper,
    continuousSampleBest: sampleBest,
    previousPrice: previous >= lower - EPS ? previous : null,
    previousValue,
    nextPrice: next <= upper + EPS ? next : null,
    nextValue,
    neighborOptimal: (previousValue === null || best.value + 1e-7 >= previousValue)
      && (nextValue === null || best.value + 1e-7 >= nextValue),
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, rows, columns) {
  const lines = [columns.map(column => csvEscape(column)).join(',')];
  for (const row of rows) lines.push(columns.map(column => csvEscape(row[column])).join(','));
  fs.writeFileSync(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function rankRows(rows, field, output, direction = 'desc', filter = () => true) {
  const eligible = rows.filter(row => filter(row) && Number.isFinite(row[field]));
  eligible.sort((a, b) => {
    const delta = direction === 'desc' ? b[field] - a[field] : a[field] - b[field];
    return Math.abs(delta) > EPS ? delta : a.kind - b.kind || a.quality - b.quality;
  });
  eligible.forEach((row, index) => { row[output] = index + 1; });
}

function workbookSheet(rows, columns, widths = {}) {
  const aoa = [columns.map(column => column.label), ...rows.map(row => columns.map(column => row[column.key] ?? null))];
  const sheet = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: Math.max(rows.length, 1), c: columns.length - 1 }) };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  sheet['!cols'] = columns.map(column => ({ wch: widths[column.key] || column.width || Math.max(10, column.label.length + 2) }));
  for (let r = 1; r <= rows.length; r += 1) {
    columns.forEach((column, c) => {
      if (!column.format) return;
      const address = XLSX.utils.encode_cell({ r, c });
      if (sheet[address]) sheet[address].z = column.format;
    });
  }
  return sheet;
}

function simpleSheet(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 26 }, { wch: 105 }, { wch: 20 }, { wch: 20 }];
  return sheet;
}

function addSheet(workbook, name, sheet) {
  XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const generatedAt = new Date();
  const localBundle = fs.readFileSync(LOCAL_BUNDLE, 'utf8');
  const defsPayload = readJson(DEFS_FILE);
  const resources = defsPayload.resources;
  const localModel = extractEconomyModel(localBundle);
  const localSales = extractSales(localBundle);
  const salaryModifiers = extractSalaryModifiers(localBundle);

  const [retailSource, weatherSource, modifiersSource, companySource, homeSource] = await Promise.all([
    fetchJsonWithMeta(URLS.retail), fetchJsonWithMeta(URLS.weather), fetchJsonWithMeta(URLS.modifiers),
    fetchJsonWithMeta(URLS.company), fetchTextWithMeta(URLS.home),
  ]);
  const bundlePathMatch = homeSource.text.match(/<script[^>]+src="([^"]*\/static\/bundle\/assets\/index-[^"]+\.js)"/);
  assert(bundlePathMatch, 'Current official bundle URL was not found on the Sim Companies home page');
  const officialBundleUrl = new URL(bundlePathMatch[1], URLS.home).href;
  const officialBundleSource = await fetchTextWithMeta(officialBundleUrl);
  const officialModel = extractEconomyModel(officialBundleSource.text);
  const officialSales = extractSales(officialBundleSource.text);
  const modelDiffKeys = Object.keys({ ...localModel, ...officialModel }).filter(key => JSON.stringify(localModel[key]) !== JSON.stringify(officialModel[key]));
  const salesMappingEqual = JSON.stringify(localSales) === JSON.stringify(officialSales);
  assert(modelDiffKeys.length === 0, `Local and current official economy model differ for ${modelDiffKeys.length} resources`);
  assert(salesMappingEqual, 'Local and current official SALES mappings differ');

  const sales = officialSales;
  const directEntries = Object.entries(sales).filter(([store]) => store !== 'r');
  const restaurantKinds = sales.r.map(Number);
  const directKinds = directEntries.flatMap(([, kinds]) => kinds.map(Number));
  assert(directKinds.length === 57, `Expected 57 direct retail products, got ${directKinds.length}`);
  assert(Object.values(sales).flat().length === 73, 'Expected 73 official store-product mappings');
  assert(new Set(Object.values(sales).flat()).size === 67, 'Expected 67 unique official SALES resources');

  const retailRows = retailSource.json;
  assert(Array.isArray(retailRows) && retailRows.length === 80, `Expected 80 public retail rows, got ${retailRows.length}`);
  const weather = weatherSource.json;
  const company = companySource.json;
  const companyInfo = company.companyPublicInfo;
  const adminOverhead = company.infrastructure.administrationOverhead;
  const productionModifier = companyInfo.productionModifier;
  const salesModifier = companyInfo.salesModifier;
  assert(Number.isFinite(adminOverhead) && adminOverhead > 0, 'Invalid administration overhead');
  assert(Number.isFinite(productionModifier), 'Invalid permanent production modifier');
  assert(Number.isFinite(salesModifier), 'Invalid permanent sales modifier');

  const modifierList = modifiersSource.json.resourceProductionModifiers || [];
  const activeModifiers = modifierList.filter(modifier => generatedAt >= new Date(modifier.since) && generatedAt < new Date(modifier.until));
  const modifierByKind = new Map();
  for (const modifier of activeModifiers) {
    assert(!modifierByKind.has(Number(modifier.kind)), `Overlapping active production modifiers for kind ${modifier.kind}`);
    modifierByKind.set(Number(modifier.kind), modifier);
  }

  let authenticatedEconomyEvidence = null;
  if (fs.existsSync(AUTH_EVIDENCE_FILE)) {
    const evidence = readJson(AUTH_EVIDENCE_FILE);
    authenticatedEconomyEvidence = {
      file: AUTH_EVIDENCE_FILE,
      fileMtime: fs.statSync(AUTH_EVIDENCE_FILE).mtime.toISOString(),
      economyState: evidence?.['/api/v2/common-data/0/']?.temporals?.economyState
        ?? evidence?.['/api/v3/companies/auth-data/']?.temporals?.economyState
        ?? null,
    };
  }
  // State 1 is intentionally fixed because the public endpoints do not expose economyState.
  assert(ECONOMY_STATE === 1, 'This analysis is audited only for economyState 1');

  const productionMemo = new Map();
  function production(kind, neutral = false, stack = []) {
    kind = Number(kind);
    const memoKey = `${neutral ? 'neutral' : 'current'}:${kind}`;
    if (productionMemo.has(memoKey)) return productionMemo.get(memoKey);
    if (stack.includes(kind)) throw new Error(`Production recipe cycle: ${[...stack, kind].join(' -> ')}`);
    const resource = resources[kind];
    assert(resource, `Missing resource definition for kind ${kind}`);
    const salaryModifier = salaryModifiers[resource.producedAt];
    assert(Number.isFinite(salaryModifier), `Missing salary modifier for building ${resource.producedAt}, kind ${kind}`);
    const abundance = resource.producedAt === 'M' || resource.producedAt === 'Q' ? 0.93 : resource.producedAt === 'O' ? 0.95 : 1;
    const temporaryModifier = neutral ? 0 : (modifierByKind.get(kind)?.speedModifier ?? 0);
    const permanentModifier = neutral ? 0 : productionModifier;
    const rate = resource.producedPerHourRaw * Math.pow(AVERAGE_SALARY / SALARY_MID, salaryModifier)
      * abundance * (1 + temporaryModifier / 100) / (1 - permanentModifier / 100);
    assert(Number.isFinite(rate) && rate > 0, `Invalid production rate for kind ${kind}`);
    let cost = AVERAGE_SALARY * salaryModifier * (neutral ? 1 : adminOverhead) / rate;
    let levels = 1 / rate;
    const buildingLevelsByKind = { [resource.producedAt]: 1 / rate };
    for (const [inputKindText, quantity] of Object.entries(resource.producedFrom || {})) {
      const input = production(Number(inputKindText), neutral, [...stack, kind]);
      cost += Number(quantity) * input.cost;
      levels += Number(quantity) * input.levels;
      for (const [buildingKind, inputLevels] of Object.entries(input.buildingLevelsByKind)) {
        buildingLevelsByKind[buildingKind] = (buildingLevelsByKind[buildingKind] || 0) + Number(quantity) * inputLevels;
      }
    }
    const result = { kind, rate, cost, levels, buildingLevelsByKind, abundance, temporaryModifier, permanentModifier };
    productionMemo.set(memoKey, result);
    return result;
  }

  function treeProduction(quality, neutral = false) {
    const model = officialModel[150].quality[quality];
    const baselineWater = officialModel[2];
    const currentWater = production(2, neutral);
    const resource = resources[150];
    const temp = neutral ? 0 : (modifierByKind.get(150)?.speedModifier ?? 0);
    const permanent = neutral ? 0 : productionModifier;
    const speedInverse = (1 - permanent / 100) / (1 + temp / 100);
    const baselineInputCost = 12 * baselineWater.modeledProductionCostPerUnit;
    const baselineInputLevels = 12 * baselineWater.buildingLevelsNeededPerUnitPerHour;
    const directCost = (model.modeledProductionCostPerUnit - baselineInputCost) * (neutral ? 1 : adminOverhead) * speedInverse;
    const directLevels = (model.buildingLevelsNeededPerUnitPerHour - baselineInputLevels) * speedInverse;
    const buildingLevelsByKind = {};
    for (const [buildingKind, levels] of Object.entries(currentWater.buildingLevelsByKind)) buildingLevelsByKind[buildingKind] = 12 * levels;
    buildingLevelsByKind[resource.producedAt] = (buildingLevelsByKind[resource.producedAt] || 0) + directLevels;
    return {
      kind: 150,
      rate: 1 / directLevels,
      cost: directCost + 12 * currentWater.cost,
      levels: directLevels + 12 * currentWater.levels,
      buildingLevelsByKind,
      abundance: 1,
      temporaryModifier: temp,
      permanentModifier: permanent,
    };
  }

  const neutralValidation = [];
  for (const kind of directKinds.filter(kind => kind !== 150)) {
    const computed = production(kind, true);
    const modeled = officialModel[kind];
    const costRelativeError = Math.abs(computed.cost - modeled.modeledProductionCostPerUnit) / Math.max(Math.abs(modeled.modeledProductionCostPerUnit), 1);
    const levelsRelativeError = Math.abs(computed.levels - modeled.buildingLevelsNeededPerUnitPerHour) / Math.max(Math.abs(modeled.buildingLevelsNeededPerUnitPerHour), 1);
    neutralValidation.push({ kind, costRelativeError, levelsRelativeError });
  }
  const neutralMaxError = Math.max(...neutralValidation.flatMap(row => [row.costRelativeError, row.levelsRelativeError]));
  assert(neutralMaxError < 1e-12, `Neutral recursive model validation failed: ${neutralMaxError}`);

  function productionChainAvailable(kind, date, seen = new Set()) {
    kind = Number(kind);
    if (seen.has(kind)) throw new Error(`Season availability cycle at kind ${kind}`);
    const resource = resources[kind];
    assert(resource, `Missing resource ${kind} during season check`);
    if (resource.productionSeason && productionSeasonValue(resource.productionSeason, date) <= SEASON_THRESHOLD) return false;
    const nextSeen = new Set(seen); nextSeen.add(kind);
    return Object.keys(resource.producedFrom || {}).every(inputKind => productionChainAvailable(Number(inputKind), date, nextSeen));
  }

  const marketByKey = new Map(retailRows.map(row => [`${Number(row.dbLetter)}:${row.quality ?? 'null'}`, row]));
  const skuRows = [];
  for (const [store, kinds] of directEntries) {
    for (const kindValue of kinds) {
      const kind = Number(kindValue);
      const resource = resources[kind];
      assert(resource, `Missing direct retail resource ${kind}`);
      const qualities = kind === 150 ? Array.from({ length: 13 }, (_, quality) => quality) : [0];
      for (const quality of qualities) {
        const marketKey = `${kind}:${kind === 150 ? quality : 'null'}`;
        const market = marketByKey.get(marketKey);
        assert(market, `Missing market row ${marketKey}`);
        const latest = currentRetailPoint(market);
        const averagePrice = Number.isFinite(latest.averagePrice) ? latest.averagePrice : null;
        const model = kind === 150 ? officialModel[150].quality[quality] : officialModel[kind];
        assert(model, `Missing economy model for kind ${kind}, quality ${quality}`);
        const productionInfo = kind === 150 ? treeProduction(quality) : production(kind);
        const retailSeasonValueNow = retailSeasonValue(resource.retailSeason, generatedAt);
        const retailSeasonActive = !resource.retailSeason || retailSeasonValueNow > SEASON_THRESHOLD;
        const productionChainActive = productionChainAvailable(kind, generatedAt);
        const salesOffice = SALES_OFFICE_KINDS.has(kind);
        const currentExecutable = !salesOffice && retailSeasonActive && productionChainActive && averagePrice !== null;
        const weatherMultiplier = resource.retailSeason === 'Summer' ? weather.sellingSpeedMultiplier : 1;
        // modeledStoreWages is part of the neutral retail curve. The current
        // operating wage must instead use this store's base salary modifier
        // and the live company administration overhead.
        const storeSalaryModifier = salaryModifiers[store];
        assert(Number.isFinite(storeSalaryModifier), `Missing salary modifier for retail store ${store}`);
        const retailWage = AVERAGE_SALARY * storeSalaryModifier * adminOverhead;
        // Accumulator quality is already baked into vO(state, kind, quality).
        // The client therefore passes quality=0 into A9r for Tree instead of applying Q/12 twice.
        const retailQualityArgument = kind === 150 ? 0 : quality;
        const optimizer = optimizePrice({
          store, model, quality: retailQualityArgument, saturation: market.saturation, averagePrice,
          ownCost: productionInfo.cost, retailWage, salesModifier, weatherMultiplier,
        });
        const optimalPrice = optimizer.price;
        const unitsPerHour = optimalPrice === null ? null
          : retailUnitsPerHour(store, model, salesModifier, optimalPrice, retailQualityArgument, market.saturation, weatherMultiplier);
        const revenuePerHour = Number.isFinite(unitsPerHour) ? optimalPrice * unitsPerHour : null;
        const grossPerUnit = optimalPrice === null ? null : optimalPrice - productionInfo.cost;
        const grossPerHour = Number.isFinite(unitsPerHour) ? grossPerUnit * unitsPerHour : null;
        const retailWagePerUnit = Number.isFinite(unitsPerHour) && unitsPerHour > 0 ? retailWage / unitsPerHour : null;
        const operatingCostPerUnit = retailWagePerUnit === null ? null : productionInfo.cost + retailWagePerUnit;
        const operatingNetPerUnit = operatingCostPerUnit === null ? null : optimalPrice - operatingCostPerUnit;
        const operatingNetPerHour = Number.isFinite(grossPerHour) ? grossPerHour - retailWage : null;
        const productionLevelsNeeded = Number.isFinite(unitsPerHour) ? productionInfo.levels * unitsPerHour : null;
        const totalOperatingLevels = productionLevelsNeeded === null ? null : 1 + productionLevelsNeeded;
        const regularSlotEquivalent = productionLevelsNeeded === null ? null : productionLevelsNeeded + (SEASONAL_STORES.has(store) ? 0 : 1);
        const productBuildingLevels = Number.isFinite(unitsPerHour)
          ? Object.fromEntries(Object.entries(productionInfo.buildingLevelsByKind).map(([key, value]) => [key, value * unitsPerHour])) : {};
        const [nameEn, nameZh] = productNames(kind, resource);
        skuRows.push({
          sku: `${kind}-Q${quality}`,
          kind, quality, productEn: nameEn, productZh: nameZh,
          storeCode: store, storeEn: STORE_NAMES[store]?.[0] || store, storeZh: STORE_NAMES[store]?.[1] || store,
          currentExecutable,
          executionStatus: salesOffice ? 'MODEL_CEILING_NOT_DIRECTLY_EXECUTABLE'
            : !retailSeasonActive ? 'RETAIL_SEASON_INACTIVE'
              : !productionChainActive ? 'PRODUCTION_SEASON_INACTIVE'
                : averagePrice === null ? 'NO_CURRENT_AVERAGE_PRICE'
                  : optimizer.status !== 'ok' ? `UNRANKABLE_${optimizer.status.toUpperCase()}` : 'EXECUTABLE_NOW',
          retailSeason: resource.retailSeason,
          retailSeasonValue: retailSeasonValueNow,
          retailSeasonActive,
          productionSeason: resource.productionSeason,
          productionChainActive,
          marketDate: latest.date ?? null,
          saturation: market.saturation,
          demand: Number.isFinite(latest.demand) ? latest.demand : 2 - market.saturation,
          averagePrice,
          priceUiLower: averagePrice === null ? null : averagePrice * 0.2,
          priceUiUpper: averagePrice === null ? null : averagePrice * 5,
          optimalPrice,
          optimizerStatus: optimizer.status,
          optimizerLower: optimizer.lower ?? null,
          optimizerUpper: optimizer.upper ?? null,
          optimizerNeighborOptimal: optimizer.neighborOptimal ?? null,
          optimizerPreviousPrice: optimizer.previousPrice ?? null,
          optimizerPreviousNetPerHour: optimizer.previousValue ?? null,
          optimizerNextPrice: optimizer.nextPrice ?? null,
          optimizerNextNetPerHour: optimizer.nextValue ?? null,
          currentOwnCostPerUnit: productionInfo.cost,
          neutralModelCostPerUnit: model.modeledProductionCostPerUnit,
          retailWagePerHour: retailWage,
          retailWagePerUnit,
          operatingCostPerUnit,
          unitsPerHour,
          revenuePerHour,
          grossContributionPerUnit: grossPerUnit,
          grossContributionPerHour: grossPerHour,
          grossContributionMargin: revenuePerHour ? grossPerHour / revenuePerHour : null,
          markupOnOwnCost: productionInfo.cost ? grossPerUnit / productionInfo.cost : null,
          operatingNetPerUnit,
          operatingNetPerHour,
          operatingNetMargin: revenuePerHour ? operatingNetPerHour / revenuePerHour : null,
          operatingReturnOnOperatingCost: operatingCostPerUnit && unitsPerHour
            ? operatingNetPerHour / (operatingCostPerUnit * unitsPerHour) : null,
          currentProductionLevelsPerUnitPerHour: productionInfo.levels,
          requiredProductionLevels: productionLevelsNeeded,
          totalOperatingLevels,
          regularSlotEquivalent,
          minimumBuildingTypes: Object.keys(productionInfo.buildingLevelsByKind).length + (SEASONAL_STORES.has(store) ? 0 : 1),
          operatingNetPerTotalLevel: totalOperatingLevels ? operatingNetPerHour / totalOperatingLevels : null,
          productionBuildings: Object.entries(productBuildingLevels).map(([key, value]) => `${key}:${value}`).join('; '),
          temporaryProductionModifierPct: productionInfo.temporaryModifier,
          permanentProductionModifierPct: productionInfo.permanentModifier,
          permanentSalesModifierPct: salesModifier,
          weatherMultiplier,
          administrationOverhead: adminOverhead,
          sourceEconomyState: ECONOMY_STATE,
          retailCurveQualityArgument: retailQualityArgument,
        });
      }
    }
  }
  assert(skuRows.length === 69, `Expected 69 direct retail SKUs, got ${skuRows.length}`);

  const rankingMetrics = [
    ['operatingNetPerHour', 'rankTheoreticalNetPerHour', 'rankExecutableNetPerHour', 'rankStoreNetPerHour', 'desc'],
    ['operatingNetMargin', 'rankTheoreticalOperatingNetMargin', 'rankExecutableOperatingNetMargin', 'rankStoreOperatingNetMargin', 'desc'],
    ['grossContributionMargin', 'rankTheoreticalGrossMargin', 'rankExecutableGrossMargin', 'rankStoreGrossMargin', 'desc'],
    ['markupOnOwnCost', 'rankTheoreticalMarkup', 'rankExecutableMarkup', 'rankStoreMarkup', 'desc'],
    ['operatingReturnOnOperatingCost', 'rankTheoreticalOperatingReturn', 'rankExecutableOperatingReturn', 'rankStoreOperatingReturn', 'desc'],
    ['operatingNetPerUnit', 'rankTheoreticalNetPerUnit', 'rankExecutableNetPerUnit', 'rankStoreNetPerUnit', 'desc'],
    ['grossContributionPerUnit', 'rankTheoreticalGrossPerUnit', 'rankExecutableGrossPerUnit', 'rankStoreGrossPerUnit', 'desc'],
    ['operatingNetPerTotalLevel', 'rankTheoreticalNetPerTotalLevel', 'rankExecutableNetPerTotalLevel', 'rankStoreNetPerTotalLevel', 'desc'],
    ['revenuePerHour', 'rankTheoreticalRevenuePerHour', 'rankExecutableRevenuePerHour', 'rankStoreRevenuePerHour', 'desc'],
    ['unitsPerHour', 'rankTheoreticalUnitsPerHour', 'rankExecutableUnitsPerHour', 'rankStoreUnitsPerHour', 'desc'],
    ['currentOwnCostPerUnit', 'rankTheoreticalLowestCost', 'rankExecutableLowestCost', 'rankStoreLowestCost', 'asc'],
    ['totalOperatingLevels', 'rankTheoreticalLowestLevels', 'rankExecutableLowestLevels', 'rankStoreLowestLevels', 'asc'],
  ];
  const modelEligible = row => row.optimizerStatus === 'ok';
  const executableEligible = row => row.currentExecutable && row.optimizerStatus === 'ok';
  for (const [metric, theoreticalRank, executableRank, storeRank, direction] of rankingMetrics) {
    rankRows(skuRows, metric, theoreticalRank, direction, modelEligible);
    rankRows(skuRows, metric, executableRank, direction, executableEligible);
    for (const store of Object.keys(STORE_NAMES).filter(key => key !== 'r')) {
      rankRows(skuRows, metric, storeRank, direction, row => modelEligible(row) && row.storeCode === store);
    }
  }

  const q0Rows = skuRows.filter(row => row.quality === 0);
  assert(q0Rows.length === 57, `Expected 57 Q0 product rows, got ${q0Rows.length}`);
  const executableRows = skuRows.filter(executableEligible).sort((a, b) => a.rankExecutableNetPerHour - b.rankExecutableNetPerHour);
  const modelRows = skuRows.filter(modelEligible).sort((a, b) => a.rankTheoreticalNetPerHour - b.rankTheoreticalNetPerHour);

  const restaurantRows = restaurantKinds.map((kind, index) => {
    const resource = resources[kind];
    const [nameEn, nameZh] = productNames(kind, resource);
    const alsoDirect = directKinds.includes(kind);
    return {
      mappingIndex: index + 1, kind, productEn: nameEn, productZh: nameZh,
      restaurantStore: 'Restaurant', alsoDirectRetail: alsoDirect,
      directStore: alsoDirect ? directEntries.find(([, kinds]) => kinds.includes(kind))?.[0] : null,
      status: 'NOT_COMPARABLE_RESTAURANT_MECHANIC',
      reason: 'Restaurant uses meal/recipe/client mechanics; the one-resource continuous retail curve is not valid.',
    };
  });
  assert(restaurantRows.length === 16, `Expected 16 Restaurant mappings, got ${restaurantRows.length}`);

  const directMarketKeys = new Set(skuRows.map(row => `${row.kind}:${row.kind === 150 ? row.quality : 'null'}`));
  const anomalyRows = retailRows.filter(row => !directMarketKeys.has(`${Number(row.dbLetter)}:${row.quality ?? 'null'}`)).map(row => {
    const resource = resources[row.dbLetter];
    const [nameEn, nameZh] = productNames(Number(row.dbLetter), resource);
    const latest = currentRetailPoint(row);
    return {
      kind: Number(row.dbLetter), quality: row.quality, productEn: nameEn, productZh: nameZh,
      saturation: row.saturation, averagePrice: latest.averagePrice ?? null, marketDate: latest.date ?? null,
      restaurantMapped: restaurantKinds.includes(Number(row.dbLetter)),
      reason: restaurantKinds.includes(Number(row.dbLetter))
        ? 'Restaurant-only or duplicate Restaurant market row; excluded from direct-retail rankings.'
        : 'Public retail API row is not present in the official direct SALES mapping; excluded rather than guessed.',
    };
  });
  assert(anomalyRows.length === 11, `Expected 11 unmatched API rows, got ${anomalyRows.length}`);

  const storeChampions = [];
  for (const [store] of directEntries) {
    const rows = skuRows.filter(row => row.storeCode === store && modelEligible(row));
    for (const [scope, subset] of [
      ['THEORETICAL_MODEL', rows],
      ['EXECUTABLE_NOW', rows.filter(executableEligible)],
    ]) {
      if (!subset.length) continue;
      for (const [metric, , , , direction] of rankingMetrics) {
        const winner = [...subset].sort((a, b) => (direction === 'desc' ? b[metric] - a[metric] : a[metric] - b[metric]) || a.kind - b.kind || a.quality - b.quality)[0];
        storeChampions.push({ scope, storeCode: store, storeZh: winner.storeZh, metric, sku: winner.sku, productZh: winner.productZh, quality: winner.quality, value: winner[metric] });
      }
    }
  }

  const metricLabels = {
    operatingNetPerHour: '经营净利/L1·h',
    operatingNetMargin: '经营净利率',
    grossContributionMargin: '毛贡献率',
    markupOnOwnCost: '自产成本加成率',
    operatingReturnOnOperatingCost: '经营成本回报率',
    operatingNetPerUnit: '经营净利/单位',
    grossContributionPerUnit: '毛贡献/单位',
    operatingNetPerTotalLevel: '经营净利/总等级',
    revenuePerHour: '收入/L1·h',
    unitsPerHour: '销量/L1·h',
    currentOwnCostPerUnit: '当前自产成本/单位',
    totalOperatingLevels: '总经营等级',
  };
  const rankingRows = [];
  for (const row of skuRows) {
    for (const [metric, theoreticalRank, executableRank, storeRank, direction] of rankingMetrics) {
      const base = {
        metric,
        metricZh: metricLabels[metric] || metric,
        direction: direction === 'desc' ? '越高越好' : '越低越好',
        value: row[metric],
        sku: row.sku,
        kind: row.kind,
        quality: row.quality,
        productZh: row.productZh,
        productEn: row.productEn,
        storeZh: row.storeZh,
        executionStatus: row.executionStatus,
      };
      if (Number.isFinite(row[theoreticalRank])) rankingRows.push({ scope: '全部模型', rank: row[theoreticalRank], ...base });
      if (Number.isFinite(row[executableRank])) rankingRows.push({ scope: '当前可执行', rank: row[executableRank], ...base });
      if (Number.isFinite(row[storeRank])) rankingRows.push({ scope: '店内模型', rank: row[storeRank], ...base });
    }
  }
  rankingRows.sort((left, right) => left.scope.localeCompare(right.scope)
    || left.metric.localeCompare(right.metric) || left.rank - right.rank
    || left.kind - right.kind || left.quality - right.quality);

  const state = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : null;
  const powderPerLevel = production(119).rate;
  const beansPerLevel = production(118).rate;
  const seedsPerLevel = production(66).rate;
  const mills = state?.buildings?.filter(building => building.kindLetter === 'i') || [];
  const farm = state?.buildings?.find(building => building.kindLetter === 'P');
  const grocery = state?.buildings?.find(building => building.kindLetter === 'G');
  const immediateMillRate = mills.reduce((sum, mill) => sum + (mill.busy?.type === 'construction' ? 0 : mill.size * powderPerLevel), 0);
  const afterConstructionMillRate = mills.reduce((sum, mill) => sum + mill.size * powderPerLevel, 0);
  const futureThreeL3Rate = mills.length * 3 * powderPerLevel;
  const sale = grocery?.busy?.type === 'sale' && grocery.busy.makingKind === 119 ? grocery.busy : null;
  const groceryActiveCoffeeRate = sale ? sale.amount / ((new Date(sale.endsAt) - new Date(sale.startedAt)) / 3_600_000) : null;
  const verifiedCoffeeOrder = {
    stateTimestamp: '2026-07-27T01:12:43.976Z',
    amount: 80,
    price: 37.8,
    durationMs: 1_602_000,
  };
  const verifiedGroceryRate = verifiedCoffeeOrder.amount / (verifiedCoffeeOrder.durationMs / 3_600_000);
  const coffeeMarket = marketByKey.get('119:null');
  const coffeeRateAtVerifiedPrice = grocery && coffeeMarket
    ? grocery.size * retailUnitsPerHour('G', officialModel[119], salesModifier,
      verifiedCoffeeOrder.price, 0, coffeeMarket.saturation, 1)
    : null;
  const coffeeOptimalRow = skuRows.find(row => row.kind === 119 && row.quality === 0);
  const groceryOptimalCoffeeRate = grocery && coffeeOptimalRow
    ? grocery.size * coffeeOptimalRow.unitsPerHour
    : null;
  const farmExternalSeedsRate = farm ? farm.size * beansPerLevel / 10 : null;
  const farmSelfSeedsRate = farm ? farm.size / (10 / beansPerLevel + 10 / seedsPerLevel) : null;
  const waterBuilding = state?.buildings?.find(building => building.kindLetter === 'W');
  const powerBuilding = state?.buildings?.find(building => building.kindLetter === 'E');
  const currentWaterCapacity = (waterBuilding?.size ?? 1) * production(2).rate;
  const currentPowerCapacity = (powerBuilding?.size ?? 1) * production(1).rate;
  // Full chain recipe per Coffee Powder: 10 Beans, 10 Seeds, 6 Water and
  // 1.2 Power (the Power is consumed by producing that Water).
  const auditedWaterNeed = verifiedGroceryRate * 6;
  const auditedPowerNeed = verifiedGroceryRate * 1.2;
  const bottleneckRows = [
    ['State timestamp', state?.t ?? null, 'Read-only autopilot state evidence', STATE_FILE],
    ['Mills right now', immediateMillRate, 'All three Mills are in construction at the captured state, so instantaneous output is zero.', 'state.buildings'],
    ['Mills after current construction', afterConstructionMillRate, `Current sizes ${mills.map(mill => `L${mill.size}`).join(' + ')} × ${powderPerLevel} Powder/h per level`, 'live formula + state'],
    ['Mills after construction / verified Grocery rate', afterConstructionMillRate / verifiedGroceryRate, '>1 means the Mills can cover the verified L2 Grocery Coffee rate', 'derived'],
    ['Mills after construction, 24h integer orders', mills.reduce((sum, mill) => sum + Math.floor(mill.size * powderPerLevel * 24), 0), 'Sum floor(rate × 24h) for each Mill; L2=1,124 and L3=1,686 at this snapshot.', 'live formula + state'],
    ['Mills after all reach L3', futureThreeL3Rate, `${mills.length} Mills × L3 × ${powderPerLevel} Powder/h per level`, 'live formula + state'],
    ['Three L3 Mills, 24h integer orders', mills.length * Math.floor(3 * powderPerLevel * 24), 'Three independent L3 24h buttons; 1,686 each at this snapshot.', 'live formula + state'],
    ['Active Coffee sale rate in latest state', groceryActiveCoffeeRate, sale ? `${sale.amount} units @ $${sale.price}, ${new Date(sale.endsAt) - new Date(sale.startedAt)} ms` : 'Latest state is not actively selling Coffee Powder; null does not mean zero store capacity.', 'latest state.buildings'],
    ['Last verified Grocery L2 Coffee order rate', verifiedGroceryRate, `${verifiedCoffeeOrder.amount} units @ $${verifiedCoffeeOrder.price}, ${verifiedCoffeeOrder.durationMs} ms; state ${verifiedCoffeeOrder.stateTimestamp}`, 'read-only state evidence captured in this session'],
    ['Current live model rate at $37.80', coffeeRateAtVerifiedPrice, 'L2 Grocery, current saturation and current permanent Sales modifier', 'official retail model + live API'],
    ['Current profit-optimal Coffee rate', groceryOptimalCoffeeRate, coffeeOptimalRow ? `L2 at optimized price $${coffeeOptimalRow.optimalPrice}` : 'Coffee row unavailable', 'all-retail optimizer + live API'],
    ['Farm L3 with externally supplied Seeds', farmExternalSeedsRate, 'Coffee Beans output / 10 Beans per Coffee Powder', 'live formula + state'],
    ['Farm with external Seeds / verified Grocery rate', farmExternalSeedsRate / verifiedGroceryRate, 'Current L3 Farm coverage; <1 is a shortfall', 'derived'],
    ['Farm with external Seeds shortfall', verifiedGroceryRate - farmExternalSeedsRate, 'Powder/h missing versus last verified Grocery Coffee rate', 'derived'],
    ['Farm L3 self-supplying Seeds + Beans', farmSelfSeedsRate, 'Shared Farm time: 10 Beans + 10 Seeds per Coffee Powder', 'live formula + state'],
    ['Self-supplied Farm / verified Grocery rate', farmSelfSeedsRate / verifiedGroceryRate, 'Long-run coverage; <1 is a shortfall', 'derived'],
    ['Self-supplied Farm shortfall', verifiedGroceryRate - farmSelfSeedsRate, 'Powder/h missing versus last verified Grocery Coffee rate', 'derived'],
    ['Current Water capacity', currentWaterCapacity, `${waterBuilding ? `L${waterBuilding.size}` : 'assumed L1'} × current rate`, 'live formula + state'],
    ['Water needed at last verified Grocery rate', auditedWaterNeed, '6 Water per Coffee Powder', 'verified sale × exact recipe'],
    ['Water capacity / demand', auditedWaterNeed ? currentWaterCapacity / auditedWaterNeed : null, '>1 means sufficient', 'derived'],
    ['Current Power capacity', currentPowerCapacity, `${powerBuilding ? `L${powerBuilding.size}` : 'assumed L1'} × current rate`, 'live formula + state'],
    ['Power needed at last verified Grocery rate', auditedPowerNeed, '1.2 Power per Coffee Powder through Water production', 'verified sale × exact recipe'],
    ['Power capacity / demand', auditedPowerNeed ? currentPowerCapacity / auditedPowerNeed : null, '>1 means sufficient', 'derived'],
  ];

  const sourceSnapshot = {
    generatedAt: generatedAt.toISOString(),
    assumptions: {
      realmId: REALM_ID, companyId: COMPANY_ID, economyState: ECONOMY_STATE,
      economyStateCaveat: 'The current public APIs do not expose economyState. State 1 is supported by the latest local authenticated evidence and must be rechecked if the realm changes state.',
      averageSalary: AVERAGE_SALARY, salaryMid: SALARY_MID,
      extractionAbundance: { Mine: 0.93, Quarry: 0.93, 'Oil Rig': 0.95, other: 1 },
      priceGrid: '<$8: $0.01; $8<=p<$2001: $0.10; p>=$2001: $1',
      uiPriceBoundary: '[0.2 × latest averagePrice, 5 × latest averagePrice], inclusive after grid normalization',
      standardRetailQuantity: 100,
      retailLevel: 1,
      robotsInstalled: 0,
      excludedFromOperatingNet: ['capex', 'bond interest', 'construction/demolition downtime', 'transport', 'inventory/decay', 'integer-building constraints', 'robots', 'future administration-overhead changes'],
    },
    company: { companyInfo, administrationOverhead: adminOverhead, productionModifier, salesModifier },
    authenticatedEconomyEvidence,
    sources: {
      retail: stripPayload(retailSource), weather: stripPayload(weatherSource), modifiers: stripPayload(modifiersSource),
      company: stripPayload(companySource), home: stripPayload(homeSource), officialBundle: stripPayload(officialBundleSource),
      localBundle: { file: LOCAL_BUNDLE, sha256: sha256(localBundle), bytes: Buffer.byteLength(localBundle), fileMtime: fs.statSync(LOCAL_BUNDLE).mtime.toISOString() },
      resourceDefinitions: { file: DEFS_FILE, sha256: sha256(fs.readFileSync(DEFS_FILE)), fileMtime: fs.statSync(DEFS_FILE).mtime.toISOString() },
    },
    comparisons: { economyModelResourceCount: Object.keys(officialModel).length, modelDiffCount: modelDiffKeys.length, modelDiffKeys, salesMappingEqual },
    payloads: { retail: retailSource.json, weather: weatherSource.json, modifiers: modifiersSource.json, company: companySource.json },
  };

  const qa = {
    generatedAt: generatedAt.toISOString(),
    pass: true,
    counts: {
      officialSalesMappings: Object.values(sales).flat().length,
      officialUniqueSalesResources: new Set(Object.values(sales).flat()).size,
      directProducts: directKinds.length,
      directSkus: skuRows.length,
      q0Rows: q0Rows.length,
      restaurantMappings: restaurantRows.length,
      retailApiRows: retailRows.length,
      unmatchedApiRows: anomalyRows.length,
      executableNowRows: executableRows.length,
      modelRankableRows: modelRows.length,
      longFormRankingRows: rankingRows.length,
    },
    formulaValidation: {
      neutralRows: neutralValidation.length,
      neutralMaxRelativeError: neutralMaxError,
      optimizerRowsChecked: skuRows.filter(row => row.optimizerStatus === 'ok').length,
      optimizerNeighborFailures: skuRows.filter(row => row.optimizerStatus === 'ok' && !row.optimizerNeighborOptimal).map(row => row.sku),
      uiBoundaryFailures: skuRows.filter(row => row.optimizerStatus === 'ok' && row.averagePrice !== null
        && (row.optimalPrice < row.priceUiLower - EPS || row.optimalPrice > row.priceUiUpper + EPS)).map(row => row.sku),
    },
    bundleComparison: sourceSnapshot.comparisons,
    sourceStatuses: Object.fromEntries(Object.entries(sourceSnapshot.sources).filter(([, source]) => source.url).map(([name, source]) => [name, source.status])),
  };
  assert(qa.formulaValidation.optimizerNeighborFailures.length === 0, 'One or more optimized prices fail neighbor optimality');
  assert(qa.formulaValidation.uiBoundaryFailures.length === 0, 'One or more optimized prices violate UI boundaries');

  const rawOutput = {
    generatedAt: generatedAt.toISOString(),
    skuRows, q0Rows, executableRows, modelRows, restaurantRows, anomalyRows, storeChampions, rankingRows,
    bottleneck: { stateTimestamp: state?.t ?? null, rows: bottleneckRows },
  };

  const outputFiles = {
    workbook: path.join(OUT, 'SimCompanies-Retail-Profitability-2026-07-26.xlsx'),
    allCsv: path.join(OUT, 'SimCompanies-Retail-All-SKUs-2026-07-26.csv'),
    q0Csv: path.join(OUT, 'SimCompanies-Retail-Q0-Products-2026-07-26.csv'),
    raw: path.join(OUT, 'SimCompanies-Retail-Profitability-RAW-2026-07-26.json'),
    market: path.join(OUT, 'SimCompanies-Retail-Market-Snapshot-2026-07-26.json'),
    qa: path.join(OUT, 'SimCompanies-Retail-QA-2026-07-26.json'),
  };

  const csvColumns = Object.keys(skuRows[0]);
  writeCsv(outputFiles.allCsv, skuRows, csvColumns);
  writeCsv(outputFiles.q0Csv, q0Rows, csvColumns);
  fs.writeFileSync(outputFiles.raw, `${JSON.stringify(rawOutput, null, 2)}\n`);
  fs.writeFileSync(outputFiles.market, `${JSON.stringify(sourceSnapshot, null, 2)}\n`);
  fs.writeFileSync(outputFiles.qa, `${JSON.stringify(qa, null, 2)}\n`);

  const mainColumns = [
    ['rankExecutableNetPerHour', '当前净利/h排名', 13], ['rankTheoreticalNetPerHour', '模型净利/h排名', 13],
    ['rankStoreNetPerHour', '店内净利/h排名', 13], ['sku', 'SKU', 12], ['productZh', '产品', 18], ['productEn', 'Product', 22],
    ['kind', 'Kind', 8], ['quality', '品质', 7], ['storeZh', '零售店', 16], ['executionStatus', '执行状态', 33],
    ['marketDate', '市场日期', 12], ['saturation', '饱和度', 12, '0.000000'], ['averagePrice', '市场均价', 14, '$#,##0.000000'],
    ['priceUiLower', '可输入价下限', 14, '$#,##0.000000'], ['priceUiUpper', '可输入价上限', 14, '$#,##0.000000'],
    ['optimalPrice', '精算最优价', 14, '$#,##0.00'], ['unitsPerHour', '销量/L1·h', 14, '#,##0.000000'],
    ['revenuePerHour', '收入/L1·h', 14, '$#,##0.00'], ['currentOwnCostPerUnit', '当前自产成本/单位', 18, '$#,##0.000000'],
    ['retailWagePerHour', '零售工资/L1·h', 16, '$#,##0.000000'], ['retailWagePerUnit', '零售工资/单位', 16, '$#,##0.000000'],
    ['operatingCostPerUnit', '经营成本/单位', 16, '$#,##0.000000'], ['grossContributionPerUnit', '毛贡献/单位', 14, '$#,##0.000000'],
    ['grossContributionPerHour', '毛贡献/L1·h', 14, '$#,##0.00'], ['operatingNetPerUnit', '经营净利/单位', 16, '$#,##0.000000'],
    ['operatingNetPerHour', '经营净利/L1·h', 16, '$#,##0.00'], ['grossContributionMargin', '毛贡献率', 13, '0.0000%'],
    ['markupOnOwnCost', '自产成本加成率', 16, '0.0000%'], ['operatingNetMargin', '经营净利率', 14, '0.0000%'],
    ['operatingReturnOnOperatingCost', '经营成本回报率', 17, '0.0000%'], ['requiredProductionLevels', '所需生产等级', 15, '0.000000'],
    ['totalOperatingLevels', '总经营等级', 14, '0.000000'], ['operatingNetPerTotalLevel', '净利/总等级', 14, '$#,##0.00'],
    ['regularSlotEquivalent', '普通槽等价', 13, '0.000000'], ['minimumBuildingTypes', '最少建筑类型数', 15],
    ['productionBuildings', '生产建筑等级明细', 45], ['retailSeason', '零售季节', 12], ['retailSeasonValue', '季节值', 11, '0.000000'],
    ['weatherMultiplier', '天气倍率', 11, '0.000000'], ['temporaryProductionModifierPct', '临时生产加速%', 14, '0.00'],
    ['permanentProductionModifierPct', '永久生产加速%', 14, '0.00'], ['permanentSalesModifierPct', '永久销售加速%', 14, '0.00'],
    ['administrationOverhead', '管理费倍率', 13, '0.000000'],
    ['rankExecutableOperatingNetMargin', '当前净利率排名', 14], ['rankExecutableGrossMargin', '当前毛贡献率排名', 15],
    ['rankExecutableMarkup', '当前加成率排名', 14], ['rankExecutableOperatingReturn', '当前成本回报排名', 15],
    ['rankExecutableNetPerUnit', '当前净利/单位排名', 16], ['rankExecutableGrossPerUnit', '当前毛利/单位排名', 16],
    ['rankExecutableNetPerTotalLevel', '当前净利/等级排名', 16], ['rankExecutableRevenuePerHour', '当前收入/h排名', 14],
    ['rankExecutableUnitsPerHour', '当前销量/h排名', 14], ['rankExecutableLowestCost', '当前低成本排名', 14],
    ['rankExecutableLowestLevels', '当前低等级排名', 14],
  ].map(([key, label, width, format]) => ({ key, label, width, format }));

  const workbook = XLSX.utils.book_new();
  addSheet(workbook, 'README', simpleSheet([
    ['Sim Companies 全零售产品精算', '生成时间', generatedAt.toISOString()],
    ['结论口径', '所有 $/h 均为一个 L1 零售等级的标准化结果；品质作为独立 SKU。'],
    ['产品覆盖', `${directKinds.length} 个普通直接零售产品；Tree Q0–Q12 后共 ${skuRows.length} 个直接零售 SKU。`],
    ['餐厅', `${restaurantRows.length} 个官方餐厅组合单列；餐厅是菜谱/配餐机制，不能套普通零售曲线。`],
    ['Sales Office', '6 个航空航天产品仅列理论模型上限；真实销售要等待/寻找客户，不能当作立即可执行零售。'],
    ['当前可执行', `${executableRows.length} 个 SKU 同时满足季节、生产链、市场均价和直接零售条件。`],
    ['经营净利', '(售价－当前递归自产成本)×销量－当前零售工资。它不是会计净利润。'],
    ['排除项目', '资本开支、债息、建造/拆除停工、运输、库存/腐损、整数建筑限制、转型后的管理费变化。'],
    ['机器人', '统一按未安装机器人计算；机器人属于另一个资本配置情景，不混入本榜。'],
    ['矿藏丰度', 'Mine/Quarry 使用官方模型基准 93%，Oil Rig 使用 95%；未来真实矿点丰度未知时不能把该假设当现场保证。'],
    ['精确价格网格', '<$8 按 $0.01；$8≤p<$2,001 按 $0.10；p≥$2,001 按 $1。'],
    ['提交硬边界', '可执行普通零售价必须在当日市场均价的 0.2×–5×（含边界）内；脚本在该范围内逐网格邻点验优。'],
    ['天气', '只对 retailSeason=Summer 的 Beach Market 商品应用；其他产品不应用天气。'],
    ['economyState', '使用 state 1；公共 API 不提供此字段，依据最近认证本地证据，已明确保留时效风险。'],
    ['当前数据', `零售 ${retailSource.headers.lastModified || retailSource.fetchedAt}；公司/天气/修正现场抓取。`],
    ['官方模型核对', `当前官网 bundle 与本地 state1 模型逐项差异 ${modelDiffKeys.length}；SALES 映射相同=${salesMappingEqual}。`],
    ['使用建议', '先看“当前可执行”的经营净利/h，再看净利/总等级与四类利润率；不要把理论上限直接当转型决策。'],
  ]));
  addSheet(workbook, '产品基准Q0', workbookSheet(q0Rows, mainColumns));
  addSheet(workbook, '全部零售SKU', workbookSheet(skuRows, mainColumns));
  addSheet(workbook, '当前可执行', workbookSheet(executableRows, mainColumns));
  addSheet(workbook, '模型上限', workbookSheet(modelRows, mainColumns));
  addSheet(workbook, '全部排名', workbookSheet(rankingRows, [
    { key: 'scope', label: '排名范围', width: 14 }, { key: 'metricZh', label: '指标', width: 22 },
    { key: 'metric', label: 'Metric', width: 34 }, { key: 'direction', label: '方向', width: 11 },
    { key: 'rank', label: '排名', width: 9 }, { key: 'value', label: '原始精确值', width: 22, format: '#,##0.0000000000' },
    { key: 'sku', label: 'SKU', width: 12 }, { key: 'productZh', label: '产品', width: 19 },
    { key: 'productEn', label: 'Product', width: 24 }, { key: 'kind', label: 'Kind', width: 8 },
    { key: 'quality', label: '品质', width: 8 }, { key: 'storeZh', label: '零售店', width: 16 },
    { key: 'executionStatus', label: '执行状态', width: 34 },
  ]));
  addSheet(workbook, '餐厅组合', workbookSheet(restaurantRows, [
    { key: 'mappingIndex', label: '映射序号', width: 10 }, { key: 'kind', label: 'Kind', width: 8 },
    { key: 'productZh', label: '产品', width: 18 }, { key: 'productEn', label: 'Product', width: 24 },
    { key: 'alsoDirectRetail', label: '也有普通零售', width: 13 }, { key: 'directStore', label: '普通零售店代码', width: 15 },
    { key: 'status', label: '状态', width: 34 }, { key: 'reason', label: '原因', width: 80 },
  ]));
  addSheet(workbook, '接口异常', workbookSheet(anomalyRows, [
    { key: 'kind', label: 'Kind', width: 8 }, { key: 'quality', label: '品质', width: 8 },
    { key: 'productZh', label: '产品', width: 18 }, { key: 'productEn', label: 'Product', width: 24 },
    { key: 'saturation', label: '饱和度', width: 13, format: '0.000000' }, { key: 'averagePrice', label: '均价', width: 14, format: '$#,##0.000000' },
    { key: 'marketDate', label: '市场日期', width: 13 }, { key: 'restaurantMapped', label: '餐厅映射', width: 11 },
    { key: 'reason', label: '排除原因', width: 80 },
  ]));
  addSheet(workbook, '商店冠军', workbookSheet(storeChampions, [
    { key: 'scope', label: '范围', width: 20 }, { key: 'storeZh', label: '商店', width: 17 },
    { key: 'metric', label: '指标', width: 34 }, { key: 'sku', label: 'SKU', width: 12 },
    { key: 'productZh', label: '冠军产品', width: 20 }, { key: 'quality', label: '品质', width: 8 },
    { key: 'value', label: '原始值', width: 22, format: '#,##0.0000000000' },
  ]));
  addSheet(workbook, '指标说明', simpleSheet([
    ['指标', '精确定义'],
    ['毛贡献/单位', '最优零售价－当前递归自产成本。未扣零售工资。'],
    ['毛贡献率', '(最优零售价－当前递归自产成本)÷最优零售价。'],
    ['自产成本加成率', '(最优零售价－当前递归自产成本)÷当前递归自产成本。'],
    ['经营净利/小时', '(最优零售价－当前递归自产成本)×每 L1 销量/小时－每 L1 零售工资。'],
    ['经营净利率', '经营净利/小时÷收入/小时。'],
    ['经营成本回报率', '经营净利/小时÷(自产成本×销量/小时＋零售工资/小时)。'],
    ['净利/总等级', '经营净利/小时÷(1 个零售等级＋支撑该销量所需的递归生产等级)。'],
    ['理论排名', '所有可用普通零售模型 SKU；包括季节未开放商品和 Sales Office 模型上限。'],
    ['当前排名', '只含现在季节开放、生产链可用、有均价并能直接提交的普通零售 SKU。'],
    ['店内排名', '同一零售建筑中的理论模型顺位。'],
    ['排名规则', '1 为最好；数值相同时按 kind、quality 固定排序，因此是可复现顺位，不是并列名次。'],
    ['低成本/低等级排名', '方向与利润指标相反：数值越低，名次越靠前。'],
  ]));
  addSheet(workbook, '当前咖啡瓶颈', simpleSheet([['指标', '数值', '说明', '证据'], ...bottleneckRows]));
  addSheet(workbook, '数据源与QA', simpleSheet([
    ['QA', '值'],
    ['总体', qa.pass ? 'PASS' : 'FAIL'],
    ['官网 bundle URL', officialBundleUrl],
    ['官网 bundle SHA-256', officialBundleSource.sha256],
    ['本地 bundle SHA-256', sha256(localBundle)],
    ['state1 模型差异数', modelDiffKeys.length],
    ['SALES 映射一致', salesMappingEqual],
    ['中性递归模型最大相对误差', neutralMaxError],
    ['最优价邻点失败数', qa.formulaValidation.optimizerNeighborFailures.length],
    ['价格硬边界失败数', qa.formulaValidation.uiBoundaryFailures.length],
    ['官方组合/独特资源', `${qa.counts.officialSalesMappings} / ${qa.counts.officialUniqueSalesResources}`],
    ['直接产品/SKU', `${qa.counts.directProducts} / ${qa.counts.directSkus}`],
    ['API/异常行', `${qa.counts.retailApiRows} / ${qa.counts.unmatchedApiRows}`],
    ['零售 API SHA-256', retailSource.sha256],
    ['天气 API SHA-256', weatherSource.sha256],
    ['生产修正 API SHA-256', modifiersSource.sha256],
    ['公司 API SHA-256', companySource.sha256],
    ['完整原始证据', path.basename(outputFiles.market)],
    ['完整 QA', path.basename(outputFiles.qa)],
  ]));
  const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  fs.writeFileSync(outputFiles.workbook, workbookBuffer);

  const manifest = Object.fromEntries(Object.entries(outputFiles).map(([key, file]) => [key, {
    file, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)),
  }]));
  console.log(JSON.stringify({ ok: true, generatedAt: generatedAt.toISOString(), counts: qa.counts, manifest }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
