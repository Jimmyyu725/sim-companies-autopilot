#!/usr/bin/env node
// Vertical integration vs pure assembly, at MATURE STEADY STATE, for one final product.
// Question (owner, 2026-07-23): if the whole chain is already built and running, which is
// more profitable per unit of TIME and MONEY invested — self-producing every input, or
// buying inputs and only running the final assembly line? Ignore building purchase cost;
// count only ongoing wages (time) + input purchases (money) and the final sale (return).
//
// The two things that trade off:
//   ASSEMBLY (buy all inputs)     → high unit cost, but ONE building, so max output/building
//   VERTICAL (self-make inputs)   → low unit cost, but MANY buildings feeding one, throttled
//                                    by the slowest sub-line, so lower output per building
//
// Metric that captures both: profit per building-hour (the scarce resource is building
// SLOTS and the TIME they run), and profit margin. All at L1, x1 steady state.

const fs = require('fs');
const path = require('path');
const f = require('./game-facts.json');
const live = require('/tmp/claude-1000/-srv-appdata/8090e3c3-c3a6-4f3e-a75d-e4d735429a85/scratchpad/live2.json');
const R = f.resources;
const L1 = 0.8087, FEE = 0.04;

const P = {}, N = {};
for (const t of live.ticker) { P[t.kind] = t.price; N[t.kind] = t.image.replace(/.*\//, '').replace('.png', ''); }

// building letter -> wage (from facts db)
const WAGE = {};
for (const b of Object.values(f.buildings)) WAGE[b.letter] = b.wage;

const TARGET = Number(process.argv[2] || 80);   // flight computer default
const TRANSPORT = P[13] || 0.377;

// selfCost(k): unit cost if this node and everything under it is self-produced.
// Also returns buildingHoursPerUnit: fractional building-hours consumed across the whole
// subtree to make one unit (the "time" cost that limits output).
const memo = {};
function selfChain(k) {
  if (memo[k]) return memo[k];
  const r = R[k];
  if (!r || !r.ratePerHourRaw) return null;
  const rate = r.ratePerHourRaw * L1;
  const wage = WAGE[r.producedAt] || 0;
  let unitCost = wage / rate;                 // this step's wage per unit
  let bhPerUnit = 1 / rate;                    // this step's building-hours per unit
  let feasible = true;
  for (const [ik, mult] of Object.entries(r.recipe || {})) {
    const sub = selfChain(Number(ik));
    if (!sub) { feasible = false; continue; }
    unitCost += mult * sub.unitCost;
    bhPerUnit += mult * sub.bhPerUnit;
  }
  return (memo[k] = { unitCost, bhPerUnit, rate, wage, feasible, letter: r.producedAt });
}

// For a given "self-produce depth", inputs shallower than the cut are BOUGHT (market price),
// deeper are self-made. Model the two extremes + an HGEC-only middle (the earlier finding
// that only high-grade-e-components is worth self-making).
function scenario(label, selfMakeSet /* set of kinds to self-produce; others bought */) {
  const r = R[TARGET];
  const rate = r.ratePerHourRaw * L1;
  const finalWage = WAGE[r.producedAt] || 0;

  // unit input cost + building-hours, deciding buy-vs-make per input recursively
  function cost(k, topLevel) {
    const node = R[k];
    const make = topLevel || selfMakeSet.has(Number(k));
    if (!make) return { unit: P[k] ?? 0, bh: 0 };   // bought: pay market, zero building-hours
    const nr = node.ratePerHourRaw * L1;
    let unit = (WAGE[node.producedAt] || 0) / nr;
    let bh = 1 / nr;
    for (const [ik, mult] of Object.entries(node.recipe || {})) {
      const sub = cost(Number(ik), false);
      unit += mult * sub.unit; bh += mult * sub.bh;
    }
    return { unit, bh };
  }
  let inputUnit = 0, inputBh = 0;
  for (const [ik, mult] of Object.entries(r.recipe || {})) {
    const c = cost(Number(ik), false);
    inputUnit += mult * c.unit; inputBh += mult * c.bh;
  }
  const unitCost = inputUnit + finalWage / rate;
  const bhPerUnit = inputBh + 1 / rate;                    // total building-hours per unit
  const netSell = P[TARGET] * (1 - FEE) - (r.transportation || 0) * TRANSPORT;
  const profitPerUnit = netSell - unitCost;
  const marginPct = profitPerUnit / netSell * 100;

  // Output per building-hour: 1 building-hour of the WHOLE chain makes (1/bhPerUnit) units.
  // Profit per building-hour = profit/unit ÷ building-hours/unit.
  const profitPerBH = profitPerUnit / bhPerUnit;
  // Buildings needed to run the final line at full rate (chain balanced): bhPerUnit × rate.
  const buildings = bhPerUnit * rate;
  // Money tied up per hour of final output = input purchases per hour (the cash cost of speed)
  const cashInputsPerHour = inputUnit * rate;

  return { label, unitCost: +unitCost.toFixed(0), netSell: +netSell.toFixed(0),
           profitPerUnit: +profitPerUnit.toFixed(0), marginPct: +marginPct.toFixed(1),
           finalRatePerH: +rate.toFixed(1), buildings: +buildings.toFixed(1),
           profitPerBH: Math.round(profitPerBH), cashInputsPerHour: Math.round(cashInputsPerHour),
           chainProfitPerH: Math.round(profitPerUnit * rate) };
}

// enumerate all descendant kinds of the target
function descendants(k, set = new Set()) {
  for (const ik of Object.keys(R[k]?.recipe || {})) { set.add(Number(ik)); descendants(Number(ik), set); }
  return set;
}
const all = descendants(TARGET);
const hgec = new Set([79]);                      // only high-grade-e-components (+ its subtree)
const hgecFull = descendants(79); hgecFull.forEach(x => hgec.add(x)); hgec.add(79);

console.log(`═══ ${N[TARGET]} — vertical vs assembly (L1, x1 steady state) ═══`);
console.log(`market price $${P[TARGET]}, net after 4% fee+transport $${(P[TARGET] * 0.96).toFixed(0)}\n`);
const scenarios = [
  scenario('BUY ALL (pure assembly)', new Set()),
  scenario('SELF only HGEC (+subtree)', hgec),
  scenario('SELF ALL (full vertical)', all),
];
const p = (s, n) => String(s).padEnd(n);
console.log(p('scenario', 26) + p('unit$', 8) + p('net/u', 8) + p('margin%', 9) + p('final/h', 9) + p('#bldgs', 8) + p('$/bldg-hr', 11) + '$/h(chain)');
console.log('─'.repeat(96));
for (const s of scenarios) {
  console.log(p(s.label, 26) + p('$' + s.unitCost, 8) + p('$' + s.profitPerUnit, 8) + p(s.marginPct, 9) +
              p(s.finalRatePerH, 9) + p(s.buildings, 8) + p('$' + s.profitPerBH.toLocaleString(), 11) + '$' + s.chainProfitPerH.toLocaleString());
}
console.log('\nkey: $/bldg-hr = profit per building-hour (buildings are the scarce slot — THIS is the ranker).');
console.log('     #bldgs = fractional buildings to feed one final line at full rate.');
console.log('     $/h(chain) = total profit/hour of the whole chain running (one final building).');
