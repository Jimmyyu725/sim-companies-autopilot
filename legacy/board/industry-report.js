#!/usr/bin/env node
// Which industry actually pays? Ranks every producible resource by the profit one
// level-1 building earns per hour, after its own wage bill, and by how long that takes
// to repay the construction cost.
//
// Data sources, all verified rather than assumed:
//   defs.json      — recipes + producedPerHourRaw, pulled from the public JS bundle
//   capture json   — live exchange prices (market-ticker)
//   encyclopedia/  — building wages and level-1 construction cost, scraped in-game
//
// Rates: the farm's card showed 202.19/h against a raw 250/h for apples, and the same
// 0.8087 ratio reproduced for seeds and coffee beans, so level 1 runs at 0.8087 x raw.
// The x3 "acceleration" on a new account multiplies actual output on top of that, but it
// expires, so the ranking here deliberately uses the un-accelerated steady state.

const fs = require('fs');
const path = require('path');

// path.resolve so plain relative names work ("defs.json" — bare names hit Node's
// package resolution and throw MODULE_NOT_FOUND, which broke the documented usage).
const [defsPath, capPath] = process.argv.slice(2);
const defs = require(path.resolve(defsPath)).resources;
const cap = require(path.resolve(capPath));
const ticker = cap['/api/v3/market-ticker/0/'];
const L1 = 0.8087;
// Goods sold on the exchange lose the 4% fee (`exchangeFee` in the bundle). Retail does not
// pay it, but retail is capped by unitsSoldAnHour, so most of this table is exchange output
// and omitting the fee inflates every ranking by ~4% of revenue.
const EXCHANGE_FEE = 0.04;
// Each unit also burns `transportation` units of the transport resource on the way to market
// — the game's own encyclopedia warns its figures omit both. Negligible on expensive goods
// (0.01% of a flight computer) but 15% of an apple, so it reshapes the cheap end of the table.
const TRANSPORT_KIND = 13;

const price = {}, name = {};
for (const t of ticker) {
  price[t.kind] = t.price;
  name[t.kind] = t.image.replace(/.*\//, '').replace('.png', '');
}

// building dbLetter -> { name, wage, cost } parsed from the scraped encyclopedia pages
const B = {};
const dir = path.join(__dirname, 'encyclopedia');
for (const f of fs.readdirSync(dir).filter(x => x.startsWith('building-'))) {
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  const letter = f.match(/building-(.+)\.txt/)[1];
  const m = txt.match(/\n([A-Za-z &.]+)\nWorker wages: \$([\d,]+)\/hour/);
  if (!m) continue;
  const after = txt.slice(txt.indexOf(m[0]) + m[0].length);
  const cost = Number((after.match(/Level 1\t~ \$([\d,]+)/) || [])[1]?.replace(/,/g, ''));
  B[letter] = { name: m[1].trim(), wage: Number(m[2].replace(/,/g, '')), cost };
}

// Realizable-demand overlay: replace the paper-$/h rate with what the market will actually take,
// so nothing is ranked on unsellable output again (the flight-computer mirage). Wrapped so a
// stale/missing board-data.json degrades to paper $/h instead of crashing this report.
let RZ = {};
try { RZ = require('./realizable').buildRealizable().byKind; }
catch (e) { console.error('[realizable overlay unavailable: ' + e.message + ' — falling back to paper $/h]'); }

const rows = [], skipped = [];
for (const [kindStr, r] of Object.entries(defs)) {
  const kind = Number(kindStr);
  const sell = price[kind];
  const b = B[r.producedAt];
  if (!sell || !b || !b.cost || !r.producedPerHourRaw) continue;

  // Exclusions, each one a trap that inflates a naive ranking:
  //  - seasonal goods quote an off-season scarcity price the market will not sustain,
  //    and low-level companies cannot even trade them out of season;
  //  - accumulator resources (trees) do not produce at producedPerHourRaw at all —
  //    output builds with time-in-production, so the flat-rate maths is meaningless.
  if (r.retailSeason || r.productionSeason) { skipped.push([name[kind], 'seasonal']); continue; }
  if (r.productionMechanic?.type === 'accumulator') {
    skipped.push([name[kind], 'accumulator mechanic']); continue;
  }

  let inputCost = 0, ok = true;
  for (const [k, mult] of Object.entries(r.producedFrom || {})) {
    if (price[k] == null) { ok = false; break; }
    inputCost += price[k] * mult;
  }
  if (!ok) continue;

  const rate = r.producedPerHourRaw * L1;
  const freight = (r.transportation || 0) * (price[TRANSPORT_KIND] || 0);
  const netSell = sell * (1 - EXCHANGE_FEE) - freight;
  const profitPerHour = (netSell - inputCost) * rate - b.wage;
  if (profitPerHour <= 0) continue;

  // Realizable overlay: haircut the paper rate to what the market will actually take, and drop
  // dead-demand goods (aerospace parts show huge paper $/h but the realm buys ~0). MIRAGE is
  // excluded; B2B-BLIND / OVERSUPPLIED stay visible with their flag so the board sees the trap.
  const rz = RZ[kind] || {};
  if ((rz.verdict || '').startsWith('MIRAGE')) { skipped.push([name[kind] || kind, rz.verdict]); continue; }
  const realizableRate = rz.realizableRate != null ? rz.realizableRate : rate;
  const realizablePerHour = (netSell - inputCost) * realizableRate - b.wage;

  rows.push({
    name: name[kind] || r.image.replace(/.*\//, '').replace('.png', ''),
    building: b.name,
    phase: r.sincePhase,
    rate: +rate.toFixed(1),
    sell,
    netSell: +netSell.toFixed(2),
    inputCost: +inputCost.toFixed(2),
    wage: b.wage,
    profitPerHour: Math.round(profitPerHour),
    realizablePerHour: Math.round(realizablePerHour),
    verdict: rz.verdict || 'PAPER?',
    realizableFraction: rz.realizableFraction != null ? rz.realizableFraction : 1,
    cost: b.cost,
    paybackH: Math.round(b.cost / Math.max(1, realizablePerHour)),
    retailPerHour: r.unitsSoldAnHour || 0,
  });
}

// Rank by REALIZABLE $/h (what the market takes), never paper $/h — that ranking is the whole
// point of the overlay. Paper stays as a reference column so the size of the haircut is visible.
const by = process.argv.includes('--by-payback') ? 'paybackH' : 'realizablePerHour';
rows.sort((a, b) => by === 'paybackH' ? a.paybackH - b.paybackH : b.realizablePerHour - a.realizablePerHour);

const p = (s, n) => String(s).padEnd(n);
console.log(p('resource', 20) + p('building', 20) + p('verdict', 18) +
            p('REAL$/h', 10) + p('frac', 7) + p('paper$/h', 10) + p('rate/h', 8) + p('bld cost', 11) + p('payback', 9) + 'retail/h');
console.log('-'.repeat(131));
for (const r of rows.slice(0, Number(process.env.TOP) || 30)) {
  console.log(p(r.name, 20) + p(r.building, 20) + p(r.verdict, 18) +
              p('$' + r.realizablePerHour.toLocaleString(), 10) + p(r.realizableFraction, 7) +
              p('$' + r.profitPerHour.toLocaleString(), 10) + p(r.rate, 8) +
              p('$' + r.cost.toLocaleString(), 11) + p(r.paybackH + 'h', 9) +
              (r.retailPerHour || '-'));
}
console.log(`\nexcluded ${skipped.length} resources: ` +
  skipped.slice(0, 12).map(([n, why]) => `${n} (${why})`).join(', ') + ' ...');
