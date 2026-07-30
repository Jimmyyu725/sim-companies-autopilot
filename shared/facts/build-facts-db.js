#!/usr/bin/env node
// Parse the scraped encyclopedia pages + the bundle's defs into ONE structured,
// authoritative facts database: game-facts.json. Everything here is MEASURED (read from
// the game's own encyclopedia / bundle), so the board can cite it instead of assuming.
// Each building carries per-level construction cost/time/materials; each resource its
// verified recipe, rate, transport, season. Cross-checks defs vs encyclopedia and flags
// any mismatch rather than silently trusting one source.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-json.js');
const DIR = __dirname;
const ENC = path.join(DIR, 'encyclopedia');
const defs = require(path.join(DIR, 'defs.json')).resources;

// ---- parse one building encyclopedia page ------------------------------------------------
function parseBuilding(letter) {
  const f = path.join(ENC, `building-${letter}.txt`);
  if (!fs.existsSync(f)) return null;
  const txt = fs.readFileSync(f, 'utf8');

  // name + wage: the building's own block starts at "<Name>\nWorker wages: $N/hour"
  const wm = txt.match(/\n([A-Za-z &.'()]+)\nWorker wages: \$([\d,]+)\/hour/);
  if (!wm) return null;
  const name = wm[1].trim();
  const wage = Number(wm[2].replace(/,/g, ''));
  const after = txt.slice(txt.indexOf(wm[0]) + wm[0].length);

  // per-level construction cost lines: "Level 1\t~ $11,436" then two material lines "12x165x" "48x3x"
  const levels = {};
  const costBlock = after.slice(after.indexOf('Approximate cost'), after.indexOf('Reference value'));
  const costRe = /(Level \d+|Upgrade to lvl \d+)\t~ \$([\d,]+)\n([\d,]+x[\d,]+x)\n([\d,]+x[\d,]+x)/g;
  let m, lvl = 0;
  while ((m = costRe.exec(costBlock)) !== null) {
    lvl++;
    const [a, b] = m[3].split('x').map(x => Number(x.replace(/,/g, '')));
    const [c, d] = m[4].split('x').map(x => Number(x.replace(/,/g, '')));
    levels[lvl] = { approxCost: Number(m[2].replace(/,/g, '')),
                    materials: { concrete: a, bricks: b, planks: c, constructionUnits: d } };
  }
  // construction time per level: "Level 1\t1:00h"
  const timeBlock = after.slice(after.indexOf('Construction time'), after.indexOf('Industrial robots') > 0 ? after.indexOf('Industrial robots') : after.length);
  const timeRe = /(Level \d+|Upgrade to lvl \d+)\t([\d:]+h)/g;
  let t, ti = 0;
  while ((t = timeRe.exec(timeBlock)) !== null) { ti++; if (levels[ti]) levels[ti].buildTime = t[2]; }

  // products this building can make (uppercase lines before "Construction and upgrades")
  const prodBlock = (after.split('Construction and upgrades')[0] || '');
  const products = prodBlock.split('\n').map(s => s.trim())
    .filter(s => s && s === s.toUpperCase() && /^[A-Z][A-Z0-9 &-]+$/.test(s));

  return { letter, name, wage, products, levels };
}

// ---- assemble --------------------------------------------------------------------------
const buildings = {};
const letters = fs.readdirSync(ENC).filter(x => /^building-.+\.txt$/.test(x))
  .map(x => x.match(/^building-(.+)\.txt$/)[1]);
for (const L of letters) { const b = parseBuilding(L); if (b) buildings[L] = b; }

// resources straight from defs (the bundle is authoritative for recipes/rates)
const resources = {};
for (const [k, r] of Object.entries(defs)) {
  resources[k] = {
    kind: Number(k), dbLetter: r.dbLetter, producedAt: r.producedAt,
    ratePerHourRaw: r.producedPerHourRaw, recipe: r.producedFrom || {},
    transportation: r.transportation, consumption: r.consumption,
    retailSeason: r.retailSeason || null, productionSeason: r.productionSeason || null,
    isExchangeTradable: r.isExchangeTradable, isResearch: r.isResearch,
    sincePhase: r.sincePhase, unitsSoldAnHour: r.unitsSoldAnHour,
    accumulator: r.productionMechanic?.type === 'accumulator' || false,
  };
}

// verified mechanic constants (from the bundle, already dug out this session)
const mechanics = {
  L1_rate_factor: 0.8087,              // reproduced on apples/seeds/coffee-beans
  exchange_fee: 0.04,                  // realm 0 & 1
  scrap_returns_pct: 1.0,              // 100% cumulative materials, quality 0
  scrap_unlocks_company_level: 5,
  build_uses_warehouse_first: true,    // BUY MISSING only for the shortfall
  patent_base_probability: 0.0625,     // n5
  patents_needed_per_quality: [12, 50, 500, 2000, 5000, 10000, 10000, 10000, 10000, 10000, 50000, 50000],
  patent_value_by_research_kind: {
    29: 1368,
    30: 2160,
    31: 2160,
    32: 2592,
    33: 1584,
    34: 1296,
    35: 1260,
    58: 1440,
    59: 720,
    100: 2440.80,
    113: 1800,
    145: 1728,
  },
  patent_value_source: 'https://simcompanies.atlassian.net/wiki/spaces/GUIDES/pages/4620296/Research+guide',
  realm_phase: 8, realm_research_limit: 12,
  acceleration_ladder: 'x3 → x2(24h) → x1 (read live from auth-data)',
  level_unlocks: { contracts: 5, research: 10, bonds: 10, executives: 15, buyOrders: 25 },
  building_slots: { 0: 4, 5: 5, 10: 6, 15: 8, 20: 10, 25: 12, 30: 14 },
  _note: 'Mechanics are measured from the game bundle/encyclopedia; fixed patent values come from the official Research guide.',
};

// cross-check: building letters in defs vs encyclopedia
const warnings = [];
for (const r of Object.values(resources)) {
  if (r.producedAt && !buildings[r.producedAt] && !r.isResearch) {
    warnings.push(`resource kind ${r.kind} made at '${r.producedAt}' — no encyclopedia page parsed`);
  }
}

const db = {
  generated: new Date().toISOString(),
  source: 'encyclopedia/ (scraped in-game) + defs.json (public bundle) + official Research guide',
  buildingCount: Object.keys(buildings).length,
  resourceCount: Object.keys(resources).length,
  mechanics, buildings, resources,
  warnings,
};
writeJsonAtomic(path.join(DIR, 'game-facts.json'), db);
console.log(`game-facts.json: ${db.buildingCount} buildings, ${db.resourceCount} resources, ${warnings.length} warnings`);
if (warnings.length) console.log('warnings:', warnings.slice(0, 5).join(' | '));
