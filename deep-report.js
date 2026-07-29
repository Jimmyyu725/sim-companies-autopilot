#!/usr/bin/env node
// The definitive industry survey. Every resource, every route, every friction cost.
//
// Data inputs (all verified this session):
//   defs.json            151 resource definitions from the public bundle
//   live.json            live exchange ticker (142 prices) + retail info (80 products)
//   encyclopedia/        54 building pages scraped in-game (wages, L1 costs)
//   restaurant-cycle.json  per-12h-cycle menu consumption (Xor table)
//   store catalogue      bpr table from the bundle (which store retails what)
//   realm facts          exchangeFee 4%, transport kind 13, L1 factor 0.8087
//
// Model notes:
//  - L1 rate = producedPerHourRaw × 0.8087 (reproduced on apples/seeds/coffee beans),
//    × any active event modifier from /production-modifiers/.
//  - Exchange route: net = price×(1−fee) − transportation×P(transport) − inputs;
//    per-building profit = net × rate − wage. No extra building needed.
//  - Retail route: two-building chain (producer + store). Store velocity is
//    unitsSoldAnHour × 0.9 (validated on apples at average price; coffee showed ~0.53
//    from price elasticity, so 0.9 is the OPTIMISTIC bound and is flagged as such).
//    Chain profit = netRetail × thru − prodWage − storeWage × (thru/velocity),
//    reported PER BUILDING over (1 + thru/velocity) buildings.
//  - Restaurant items are surveyed separately: occupancy is unknowable in advance and
//    menu leftovers spoil, so no $/h claim is made for that route.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const S = '/tmp/claude-1000/-srv-appdata/8090e3c3-c3a6-4f3e-a75d-e4d735429a85/scratchpad';
const defs = require(path.join(DIR, 'defs.json')).resources;
const live = require(path.join(S, 'live.json'));
const cyc = require(path.join(S, 'restaurant-cycle.json'));

const FEE = 0.04, L1 = 0.8087, VELOCITY_FACTOR = 0.9;
const TRANSPORT = 13;

const STORE_CATALOG = {
  '2': [53, 54, 55, 56, 57], 'G': [3, 4, 5, 7, 8, 9, 119, 123, 124, 125, 126, 122, 127, 140, 152],
  'A': [11, 12], 'C': [24, 25, 26, 27, 28, 98], 'H': [60, 61, 62, 63, 64, 65, 70, 71],
  'B': [91, 94, 95, 96, 97, 99], 'd': [102, 103, 108, 109, 110],
  'r': [117, 121, 134, 122, 119, 123, 129, 130, 131, 142, 143, 132, 124, 125, 126, 149],
};
// production modifiers active now (from /api/v2/production-modifiers/0/)
const EVENT_MOD = { 118: 21, 9: 23, 142: -28 };

const price = {}, name = {};
for (const t of live.ticker) { price[t.kind] = t.price; name[t.kind] = t.image.replace(/.*\//, '').replace('.png', ''); }
const retail = {};
for (const r of live.retailInfo) retail[r.dbLetter] = { avg: r.averagePrice, sat: r.saturation, demand: r.retailData.at(-1)?.demand, soldRestaurant: r.retailData.at(-1)?.amountSoldRestaurant };

// buildings from encyclopedia
const B = {};
for (const f of fs.readdirSync(path.join(DIR, 'encyclopedia')).filter(x => x.startsWith('building-'))) {
  const txt = fs.readFileSync(path.join(DIR, 'encyclopedia', f), 'utf8');
  const letter = f.match(/building-(.+)\.txt/)[1];
  const m = txt.match(/\n([A-Za-z &.']+)\nWorker wages: \$([\d,]+)\/hour/);
  if (!m) continue;
  const after = txt.slice(txt.indexOf(m[0]) + m[0].length);
  B[letter] = {
    name: m[1].trim(), wage: Number(m[2].replace(/,/g, '')),
    cost: Number((after.match(/Level 1\t~ \$([\d,]+)/) || [])[1]?.replace(/,/g, '')),
  };
}
const storeOf = {};
for (const [st, kinds] of Object.entries(STORE_CATALOG)) for (const k of kinds) (storeOf[k] = storeOf[k] || []).push(st);

const rows = [], excluded = [];
for (const [kindStr, r] of Object.entries(defs)) {
  const kind = Number(kindStr);
  const nm = name[kind] || (r.image || '').replace(/.*\//, '').replace('.png', '');
  const b = B[r.producedAt];
  if (r.isResearch) { excluded.push([nm, 'research (no market product)']); continue; }
  if (!r.producedPerHourRaw) { excluded.push([nm, 'no production rate']); continue; }
  if (!b || !b.cost) { excluded.push([nm, 'building data missing (' + r.producedAt + ')']); continue; }
  if (r.retailSeason || r.productionSeason) { excluded.push([nm, 'seasonal: ' + (r.retailSeason || r.productionSeason)]); continue; }
  if (r.productionMechanic) { excluded.push([nm, 'accumulator mechanic']); continue; }

  let inputCost = 0, inputsKnown = true;
  const recipe = [];
  for (const [ik, mult] of Object.entries(r.producedFrom || {})) {
    if (price[ik] == null) { inputsKnown = false; break; }
    inputCost += price[ik] * mult;
    recipe.push(`${mult}×${name[ik]}`);
  }
  if (!inputsKnown) { excluded.push([nm, 'input not priced on exchange']); continue; }

  const mod = 1 + (EVENT_MOD[kind] || 0) / 100;
  const rate = r.producedPerHourRaw * L1 * mod;
  const freight = (r.transportation || 0) * (price[TRANSPORT] || 0);

  // Route 1: exchange
  let ex = null;
  if (r.isExchangeTradable && price[kind] != null) {
    const netUnit = price[kind] * (1 - FEE) - freight - inputCost;
    ex = { netUnit, perHour: netUnit * rate - b.wage, perBuilding: netUnit * rate - b.wage };
  }

  // Route 2: retail chain (producer + store share)
  let rt = null;
  const stores = (storeOf[kind] || []).filter(s => s !== 'r' && B[s]);
  if (stores.length && retail[kind]) {
    const st = stores[0];
    const velocity = (r.unitsSoldAnHour || 0) * VELOCITY_FACTOR;
    if (velocity > 0) {
      const thru = Math.min(rate, velocity);
      const netUnit = retail[kind].avg - freight - inputCost;
      const chainProfit = netUnit * thru - b.wage - B[st].wage * (thru / velocity);
      const buildings = 1 + thru / velocity;
      rt = { store: B[st].name, velocity, thru, netUnit,
             chainProfit, perBuilding: chainProfit / buildings,
             storeCost: B[st].cost, sat: retail[kind].sat, demand: retail[kind].demand };
    }
  }

  const best = Math.max(ex ? ex.perBuilding : -1e9, rt ? rt.perBuilding : -1e9);
  if (best <= 0) { excluded.push([nm, 'unprofitable at L1 (' + Math.round(best) + '/h)']); continue; }
  const route = (rt && (!ex || rt.perBuilding >= ex.perBuilding)) ? 'retail' : 'exchange';
  const chosen = route === 'retail' ? rt : ex;
  const capital = b.cost + (route === 'retail' ? rt.storeCost * (rt.thru / rt.velocity) : 0);

  rows.push({
    kind, name: nm, building: b.name, bWage: b.wage, bCost: b.cost, phase: r.sincePhase,
    rate: +rate.toFixed(1), mod: EVENT_MOD[kind] || 0,
    sell: price[kind], retailAvg: retail[kind]?.avg ? +retail[kind].avg.toFixed(2) : null,
    inputCost: +inputCost.toFixed(2), freight: +freight.toFixed(2),
    route, perBuilding: Math.round(chosen.perBuilding),
    margin: chosen.netUnit != null ? +(chosen.netUnit / (route === 'retail' ? retail[kind].avg : price[kind]) * 100).toFixed(1) : null,
    capital: Math.round(capital), payback: +(capital / chosen.perBuilding).toFixed(1),
    restaurantItem: (storeOf[kind] || []).includes('r'),
    soldRestaurant: retail[kind]?.soldRestaurant ?? null,
    consumptionValue: Math.round((r.consumption || 0) * (price[kind] || 0)),
    recipe: recipe.join(' + ') || '(raw)',
    detail: { ex: ex && Math.round(ex.perBuilding), rt: rt && Math.round(rt.perBuilding) },
  });
}

rows.sort((a, b) => b.perBuilding - a.perBuilding);
fs.writeFileSync(path.join(S, 'deep-rows.json'), JSON.stringify({ rows, excluded }, null, 1));

const p = (s, n) => String(s ?? '-').padEnd(n);
console.log(p('#', 3) + p('resource', 21) + p('building', 22) + p('route', 9) + p('rate/h', 8) +
            p('margin%', 8) + p('$/h/bld', 9) + p('capital', 10) + p('payback', 9) + p('rest?', 6) + 'recipe');
console.log('─'.repeat(140));
rows.slice(0, 25).forEach((r, i) => {
  console.log(p(i + 1, 3) + p(r.name, 21) + p(r.building, 22) + p(r.route, 9) + p(r.rate, 8) +
              p(r.margin, 8) + p('$' + r.perBuilding.toLocaleString(), 9) +
              p('$' + (r.capital / 1000).toFixed(0) + 'k', 10) + p(r.payback + 'h', 9) +
              p(r.restaurantItem ? 'YES' : '', 6) + r.recipe.slice(0, 42));
});
console.log(`\n${rows.length} profitable, ${excluded.length} excluded.`);
