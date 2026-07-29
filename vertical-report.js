#!/usr/bin/env node
// Full vertical integration survey: what does every product cost if EVERY input in its
// recipe tree is produced in-house, all the way down to power and water?
//
//   selfCost(k)  = Σ mult_i × selfCost(input_i)  +  wage(building_k) / rateL1(k)
//   buildings(k) = fractional buildings needed across the whole chain to support ONE
//                  final building of k at full rate (each supplier sized to demand)
//   chain $/h per building = (netSell − selfCost) × rateL1 / totalBuildings
//
// netSell = exchange × (1−4%) − transportation. L1 rates (raw × 0.8087), steady state,
// no event modifiers (they rotate; durability is the point of integration).
//
// Exclusions per the owner: Catering (building m), aerospace (buildings 7/8/9/0 and the
// rocket/jet items from Propulsion), seasonal, accumulator, research.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const S = '/tmp/claude-1000/-srv-appdata/8090e3c3-c3a6-4f3e-a75d-e4d735429a85/scratchpad';
const defs = require(path.join(DIR, 'defs.json')).resources;
const live = require(path.join(S, 'live2.json'));

const L1 = 0.8087, FEE = 0.04;
const price = {}, name = {};
for (const t of live.ticker) { price[t.kind] = t.price; name[t.kind] = t.image.replace(/.*\//, '').replace('.png', ''); }

const B = {};
for (const f of fs.readdirSync(path.join(DIR, 'encyclopedia')).filter(x => x.startsWith('building-'))) {
  const txt = fs.readFileSync(path.join(DIR, 'encyclopedia', f), 'utf8');
  const letter = f.match(/building-(.+)\.txt/)[1];
  const m = txt.match(/\n([A-Za-z &.']+)\nWorker wages: \$([\d,]+)\/hour/);
  if (!m) continue;
  const after = txt.slice(txt.indexOf(m[0]) + m[0].length);
  B[letter] = { name: m[1].trim(), wage: Number(m[2].replace(/,/g, '')),
                cost: Number((after.match(/Level 1\t~ \$([\d,]+)/) || [])[1]?.replace(/,/g, '')) };
}

const EXCLUDE_BUILDINGS = new Set(['m', '7', '8', '9', '0']);
const EXCLUDE_KINDS = new Set([85, 86, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 111]);

// Memoised recursion. Cycle guard: none of the game's recipes are cyclic.
const memo = {};
function chain(k) {
  if (memo[k]) return memo[k];
  const r = defs[k];
  if (!r || !r.producedPerHourRaw) return null;
  const b = B[r.producedAt];
  if (!b) return null;
  const rate = r.producedPerHourRaw * L1;
  let cost = b.wage / rate;                    // own step: wages per unit
  let buildingsPerUnit = 1 / rate;             // own step: building-hours per unit
  let depth = 1, feasible = true, blockers = [];
  for (const [ik, mult] of Object.entries(r.producedFrom || {})) {
    const sub = chain(Number(ik));
    if (!sub) { feasible = false; blockers.push(name[ik] || ik); continue; }
    if (!sub.feasible) { feasible = false; blockers.push(...sub.blockers); }
    cost += mult * sub.cost;
    buildingsPerUnit += mult * sub.buildingsPerUnit;
    depth = Math.max(depth, sub.depth + 1);
  }
  return (memo[k] = { cost, buildingsPerUnit, depth, feasible, blockers, rate, building: b });
}

const rows = [];
for (const [kStr, r] of Object.entries(defs)) {
  const k = Number(kStr);
  if (r.isResearch || r.retailSeason || r.productionSeason || r.productionMechanic) continue;
  if (EXCLUDE_BUILDINGS.has(r.producedAt) || EXCLUDE_KINDS.has(k)) continue;
  if (!price[k]) continue;
  const c = chain(k);
  if (!c || !c.feasible) continue;
  const netSell = price[k] * (1 - FEE) - (r.transportation || 0) * (price[13] || 0.39);
  const profitUnit = netSell - c.cost;
  if (profitUnit <= 0) continue;
  const totalBuildings = c.rate * c.buildingsPerUnit;   // for one final building fully fed
  rows.push({
    kind: k, name: name[k], building: c.building.name,
    rate: +c.rate.toFixed(1), depth: c.depth,
    selfCost: +c.cost.toFixed(3), netSell: +netSell.toFixed(2),
    marginPct: +(profitUnit / netSell * 100).toFixed(1),
    chainPerHour: Math.round(profitUnit * c.rate),
    buildings: +totalBuildings.toFixed(2),
    perBuilding: Math.round(profitUnit * c.rate / totalBuildings),
  });
}

const by = process.argv.includes('--by-margin') ? 'marginPct' : 'perBuilding';
rows.sort((a, b) => b[by] - a[by]);
const p = (s, n) => String(s ?? '-').padEnd(n);
console.log(p('#', 3) + p('product', 22) + p('final building', 22) + p('depth', 6) + p('self$/u', 10) +
            p('net$/u', 9) + p('margin%', 9) + p('chain$/h', 10) + p('#blds', 7) + '$/h/bld');
console.log('─'.repeat(110));
rows.slice(0, 30).forEach((r, i) =>
  console.log(p(i + 1, 3) + p(r.name, 22) + p(r.building, 22) + p(r.depth, 6) + p(r.selfCost, 10) +
              p(r.netSell, 9) + p(r.marginPct, 9) + p('$' + r.chainPerHour.toLocaleString(), 10) +
              p(r.buildings, 7) + '$' + r.perBuilding.toLocaleString()));
console.log(`\n${rows.length} products viable at full integration (of ${Object.keys(defs).length}).`);
fs.writeFileSync(path.join(S, 'vertical-rows.json'), JSON.stringify(rows, null, 1));
