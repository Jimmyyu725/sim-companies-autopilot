#!/usr/bin/env node
// Recipe-graph derived-demand (Leontief backward demand propagation).
// READ-ONLY: reads game-facts.json + defs.json (for names). Writes nothing except stdout.
//
// Model:
//   finalDemand(X)  = unitsSoldAnHour(X)                 // terminal retail absorption / hr
//   totalDemand(X)  = finalDemand(X) + derivedDemand(X)  // gross realm throughput / hr
//   derivedDemand(X)= sum over every product Y whose recipe consumes X of
//                        totalDemand(Y) * recipe(Y)[X]   // B2B pull, weighted recursively
//
// i.e. solve x = f + A^T x  where A[Y][X] = units of X per unit of Y (Leontief).
// Fixed-point iteration; recipes form a tech-tree DAG so it converges.

const fs = require('fs');
const DIR = '/srv/appdata/chrome-automation/sim';
const facts = JSON.parse(fs.readFileSync(DIR + '/game-facts.json', 'utf8'));
const names = JSON.parse(fs.readFileSync('/tmp/claude-1000/-srv-appdata/8090e3c3-c3a6-4f3e-a75d-e4d735429a85/scratchpad/names.json', 'utf8'));
const R = facts.resources;
const kinds = Object.keys(R);
const nm = k => (names[k] || 'k' + k) + ' (k' + k + ')';

// ---- final demand = retail units sold / hr ----
const finalDemand = {};
for (const k of kinds) finalDemand[k] = R[k].unitsSoldAnHour || 0;

// ---- reverse edges: for each input X, list [consumerY, qtyPerUnitY] ----
const consumers = {}; // X -> [{Y, mult}]
for (const y of kinds) {
  const rec = R[y].recipe || {};
  for (const x of Object.keys(rec)) {
    (consumers[x] = consumers[x] || []).push({ y, mult: rec[x] });
  }
}

// ---- cycle check (topo) ----
let cyc = false;
{
  const color = {}; // 0/undef=white,1=gray,2=black
  const stack = [];
  const dfs = (u) => {
    color[u] = 1; stack.push(u);
    for (const x of Object.keys(R[u].recipe || {})) {
      if (!R[x]) continue;
      if (color[x] === 1) { cyc = true; }
      else if (!color[x]) dfs(x);
    }
    color[u] = 2; stack.pop();
  };
  for (const k of kinds) if (!color[k]) dfs(k);
}

// ---- fixed-point iteration: x = f + A^T x ----
let x = Object.assign({}, finalDemand);
let iters = 0, maxDelta = Infinity;
for (iters = 0; iters < 1000 && maxDelta > 1e-9; iters++) {
  const nx = Object.assign({}, finalDemand);
  for (const xk of kinds) {
    let acc = 0;
    const cs = consumers[xk];
    if (cs) for (const { y, mult } of cs) acc += x[y] * mult;
    nx[xk] += acc;
  }
  maxDelta = 0;
  for (const k of kinds) maxDelta = Math.max(maxDelta, Math.abs(nx[k] - x[k]));
  x = nx;
}
const totalDemand = x;
const derivedDemand = {};
for (const k of kinds) derivedDemand[k] = totalDemand[k] - finalDemand[k];

// ---- also compute UNWEIGHTED structural fan-out for contrast ----
// naive = sum over consumers of ratePerHourRaw(Y) * mult  (no recursion, no realizability)
const naive = {};
for (const xk of kinds) {
  let acc = 0;
  const cs = consumers[xk];
  if (cs) for (const { y, mult } of cs) acc += (R[y].ratePerHourRaw || 0) * mult;
  naive[xk] = acc;
}

// ---- report helpers ----
const REPORT = [10, 137, 81, 82, 86, 89, 52, 7, 108, 3];
const fmt = n => (n >= 1000 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4));

console.log('# cycles in recipe graph:', cyc, ' iterations to converge:', iters, ' final maxDelta:', maxDelta.toExponential(2));
console.log('# resources:', kinds.length);
console.log('');
console.log('KIND'.padEnd(26), 'retail/f'.padStart(9), 'derivedDem'.padStart(12), 'totalDem'.padStart(12), 'naiveFanout'.padStart(12), 'consumption'.padStart(11), 'exTrade'.padStart(8));
for (const k of REPORT) {
  const ks = String(k);
  console.log(
    nm(ks).padEnd(26),
    fmt(finalDemand[ks]).padStart(9),
    fmt(derivedDemand[ks]).padStart(12),
    fmt(totalDemand[ks]).padStart(12),
    fmt(naive[ks]).padStart(12),
    fmt(R[ks].consumption || 0).padStart(11),
    String(R[ks].isExchangeTradable).padStart(8)
  );
}

console.log('\n=== ALL resources ranked by derivedDemand (top 30) ===');
const ranked = kinds.slice().sort((a, b) => derivedDemand[b] - derivedDemand[a]);
console.log('RANK KIND'.padEnd(30), 'derivedDem'.padStart(12), 'retail'.padStart(9), 'total'.padStart(12));
ranked.slice(0, 30).forEach((k, i) => {
  console.log(String(i + 1).padStart(3), nm(k).padEnd(26), fmt(derivedDemand[k]).padStart(12), fmt(finalDemand[k]).padStart(9), fmt(totalDemand[k]).padStart(12));
});

console.log('\n=== Where do the report targets rank (out of ' + kinds.length + ') by derivedDemand? ===');
for (const k of REPORT) {
  const ks = String(k);
  const rank = ranked.indexOf(ks) + 1;
  console.log(nm(ks).padEnd(26), 'rank', String(rank).padStart(3), '/', kinds.length, ' derived=', fmt(derivedDemand[ks]));
}

// ---- what consumes the aerospace parts, and do those terminals sell retail? ----
console.log('\n=== downstream trace for aerospace parts (why derived≈0) ===');
for (const k of [81, 82, 86, 89, 52]) {
  const ks = String(k);
  const cs = consumers[ks] || [];
  const parts = cs.map(({ y, mult }) => nm(y) + ' x' + mult + ' [retail=' + (finalDemand[y] || 0) + ', totalDem=' + fmt(totalDemand[y]) + ']');
  console.log(nm(ks) + ' consumed by: ' + (parts.length ? parts.join('; ') : '(NOTHING)'));
}

// ---- combined score sketch: realizable throughput needs BOTH retail and derived ----
console.log('\n=== combined realizable throughput (totalDemand = retail + derived) for report set ===');
for (const k of REPORT) {
  const ks = String(k);
  console.log(nm(ks).padEnd(26), 'total/hr=', fmt(totalDemand[ks]).padStart(12), ' (retail', fmt(finalDemand[ks]) + ' + derived', fmt(derivedDemand[ks]) + ')');
}

// dump json for the report
fs.writeFileSync('/tmp/claude-1000/-srv-appdata/8090e3c3-c3a6-4f3e-a75d-e4d735429a85/scratchpad/derived-out.json',
  JSON.stringify({ finalDemand, derivedDemand, totalDemand, naive, cyc, iters, ranked: ranked.slice(0, 40) }, null, 1));
