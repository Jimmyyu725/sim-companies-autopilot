#!/usr/bin/env node
// verify-metric.js — adversarial re-implementation of the §9 realizable.js spec, READ-ONLY.
// Reproduces the exact algorithm from board/.metric-spec.md §9 against live data,
// then prints the known-truth cases + diagnostics for auditing.
const fs = require('fs');
const DIR = '/srv/appdata/chrome-automation/sim';

const C = {
  L1: 0.8087, FEE: 0.04, TRANSPORT_KIND: 13,
  TAU: 0.12, BETA: 1.0, KT: 5, ALPHA: 0.34,
  A_DEEP: 50, A_MIR: 1.0, EPS_G: 0.02,
  S_DEAD: 1.8, EPS_DRAIN: 0.002,
  DOS_DEAD: 30, P_BAND: 0.05,
};

const facts = JSON.parse(fs.readFileSync(DIR + '/game-facts.json', 'utf8'));
const board = JSON.parse(fs.readFileSync(DIR + '/board-data.json', 'utf8'));
let defs = null; try { defs = JSON.parse(fs.readFileSync(DIR + '/defs.json', 'utf8')).resources; } catch (e) {}
const R = facts.resources;
const kinds = Object.keys(R);
const nm = k => ((defs && defs[k] && defs[k].image) || 'k' + k).replace(/.*\//, '').replace('.png', '');

const price = {}, isUp = {};
for (const t of board.market.ticker) { price[t.kind] = t.price; isUp[t.kind] = t.is_up; }

const retailByDb = {};
for (const e of board.market.retail) {
  const p = retailByDb[e.dbLetter];
  if (!p || (e.saturation || 0) > (p.saturation || 0)) retailByDb[e.dbLetter] = e;
}
const RI = k => {
  const e = retailByDb[R[k].dbLetter];
  if (!e) return { inFeed: false };
  const rd = e.retailData || [], n = rd.length, j = Math.max(0, n - 7);
  const last = rd[n - 1] || {};
  const dS = n >= 2 ? (e.saturation - rd[j].saturation) / Math.max(1, n - 1 - j) : 0;
  return {
    inFeed: true, sat: e.saturation, avgPrice: e.averagePrice,
    clears: e.averagePrice != null && e.averagePrice > 0,
    restH: (last.amountSoldRestaurant || 0) / 24, dS,
  };
};

// ---- §3.1 realized leaf ----
const L = {};
for (const k of kinds) {
  const cons = R[k].consumption || 0, us = R[k].unitsSoldAnHour || 0, ri = RI(k);
  const retailTerm = ri.inFeed ? (ri.clears ? Math.max(us, cons) : cons) : cons;
  L[k] = retailTerm + (ri.restH || 0);
}
// ---- §3.2 reverse graph + Leontief fixed point ----
const consumers = {};
for (const y of kinds) for (const [x, m] of Object.entries(R[y].recipe || {}))
  (consumers[x] = consumers[x] || []).push({ y, mult: m });
let A = Object.assign({}, L);
let iters = 0;
for (let it = 0; it < 500; it++) {
  iters = it + 1;
  const nA = Object.assign({}, L); let md = 0;
  for (const x of kinds) { const cs = consumers[x]; let a = 0; if (cs) for (const { y, mult } of cs) a += A[y] * mult; nA[x] += a; }
  for (const k of kinds) md = Math.max(md, Math.abs(nA[k] - A[k]));
  A = nA; if (md < 1e-12) break;
}
const der = {}; for (const k of kinds) der[k] = A[k] - L[k];

const books = (board.coo && board.coo.orderBooks) || (board.cmo && board.cmo.orderBooks) || {};
const priceKeepExch = k => {
  const bk = books[k];
  if (bk && bk.length) {
    const best = Math.min(...bk.map(o => o.price));
    const depth = bk.filter(o => o.price <= best * (1 + C.P_BAND)).reduce((s, o) => s + o.quantity, 0);
    const dos = depth / Math.max(1e-9, der[k]) / 24;
    return { pk: Math.max(0, Math.min(1, 1 - dos / C.DOS_DEAD)), stale: false };
  }
  return { pk: isUp[k] ? 0.6 : 0.5, stale: true };
};

const perUnitProfit = k => {
  const sell = price[k]; if (sell == null) return null;
  let ic = 0; for (const [x, m] of Object.entries(R[k].recipe || {})) { if (price[x] == null) return null; ic += price[x] * m; }
  const freight = (R[k].transportation || 0) * (price[C.TRANSPORT_KIND] || 0);
  return sell * (1 - C.FEE) - freight - ic;
};

const byKind = {};
for (const k of kinds) {
  const r = R[k], ri = RI(k), g = (r.ratePerHourRaw || 0) * C.L1, pu = perUnitProfit(k);
  let rr = 0, verdict, channel, bookStale = false;

  if (r.retailSeason || r.productionSeason || r.accumulator) { verdict = 'SEASONAL'; channel = 'season'; }
  else if (ri.inFeed && !ri.clears && (ri.restH || 0) === 0) { verdict = 'MIRAGE(dead-lake)'; channel = 'retail'; }
  else if (ri.inFeed && (ri.clears || ri.restH > 0)) {
    channel = (ri.restH > 0 && !ri.clears) ? 'restaurant' : 'retail';
    const Aret = (ri.clears ? (r.unitsSoldAnHour || 0) : 0) + (ri.restH || 0);
    const head = Math.max(0, C.TAU * (2 - ri.sat) - C.KT * ri.dS) * Aret / C.BETA;
    rr = Math.min(g, head);
    const S = ri.sat;
    if (ri.restH > 0 && !ri.clears) verdict = 'B2B-DEEP';
    else if (S >= C.S_DEAD) verdict = 'MIRAGE(dead-lake)', rr = 0;
    else if (S > 1.0 && ri.dS >= -C.EPS_DRAIN) verdict = 'OVERSUPPLIED';
    else verdict = 'RETAIL-OK';
  } else {
    channel = 'b2b';
    const Ad = der[k];
    if (Ad < Math.max(C.A_MIR, C.EPS_G * g)) { verdict = 'MIRAGE'; rr = 0; }
    else {
      const pke = priceKeepExch(k); bookStale = pke.stale;
      rr = Math.min(g, C.ALPHA * Ad) * pke.pk;
      verdict = Ad >= C.A_DEEP ? 'B2B-DEEP' : 'B2B-THIN';
    }
  }
  const realizable$h = pu == null ? null : pu * rr - 0;
  byKind[k] = {
    kind: +k, name: nm(k), channel, verdict,
    g: +g.toFixed(3), absorption: +A[k].toFixed(3), derived: +der[k].toFixed(3),
    realizableRate: +rr.toFixed(4), realizableFraction: g > 0 ? +(rr / g).toFixed(4) : 0,
    perUnitProfit: pu == null ? null : +pu.toFixed(3),
    paperPerHour: pu == null ? null : +(pu * g).toFixed(1),
    realizablePerHour_preWage: realizable$h == null ? null : +realizable$h.toFixed(1),
    bookStale,
  };
}

console.log('iters to converge:', iters);
const showKinds = [143,137,10,52,75,108,7,3,80,81,82,86,89,95,99];
const p=(s,n)=>String(s).padEnd(n);
console.log(p('name',18)+p('k',5)+p('chan',11)+p('verdict',18)+p('g/h',9)+p('A',11)+p('der',11)+p('rr',9)+p('frac',8)+p('paper$/h',11)+'realiz$/h');
console.log('-'.repeat(130));
for(const kk of showKinds){const r=byKind[kk];if(!r){console.log(kk,'MISSING');continue;}
  console.log(p(r.name,18)+p(r.kind,5)+p(r.channel,11)+p(r.verdict,18)+p(r.g,9)+p(r.absorption,11)+p(r.derived,11)+p(r.realizableRate,9)+p(r.realizableFraction,8)+p('$'+r.paperPerHour,11)+'$'+r.realizablePerHour_preWage);
}

// consumer-tree diagnostics for disputed kinds
console.log('\n--- consumer trees (who buys these B2B goods) ---');
for(const kk of [52,10,137,75,86,89]){
  const cs=consumers[kk]||[];
  console.log('k'+kk,nm(kk),'A='+A[kk].toFixed(3),'der='+der[kk].toFixed(3),'-> consumed by:',
    cs.map(c=>nm(c.y)+'(k'+c.y+' x'+c.mult+', A='+A[c.y].toFixed(3)+')').join('; ')||'NOBODY');
}
