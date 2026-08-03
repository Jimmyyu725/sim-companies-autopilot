#!/usr/bin/env node
// realizable.js — realizable $/building-hour that never rewards unsellable output.
//
// Designed + adversarially verified by a 6-agent workflow (wf_f14ed4ab-464, 2026-07-24). It
// replaces the paper "$/h = margin × rate" that ranked flight computers ($3,849/bldg-hr) above
// everything real, when the realm consumes ~0.057 flight computers/hour. Paper $/h is a mirage;
// this haircuts the rate by demand you can ACTUALLY claim.
//
// Absorption A(k) = realized retail/restaurant leaf L(k) + recipe-graph DERIVED B2B demand.
// The derived term is the load-bearing insight: crude oil reads consumption=0/retail=0 in
// game-facts (same as dead aerospace parts), but the reverse recipe graph shows crude feeds
// refined fuels that feed ~everything (derived≈200), while aerospace electronics feed only
// flight computers/satellites that feed nothing sellable (derived≈0.05). That single number
// separates "deep B2B" from "dead lake". Leontief fixed point over the consumer graph.
//
// Verdicts: RETAIL-OK | B2B-DEEP | B2B-THIN | B2B-BLIND | OVERSUPPLIED | MIRAGE | MIRAGE(dead-lake) | SEASONAL
// READ-ONLY. Exports buildRealizable(); run directly for a ranked table + board/.realizable.json.
//
// Fixes applied over the raw spec (each verified against the known-truth cases):
//   D1  RETAIL rate was a 12% τ-band sliver — steak capped at 4.33/h vs measured ~26/h. Replaced
//       with rr=min(g, m(S)·A_ret), m(S)=clamp(1−S/2,0,1): steak→11.5/h→$335 ≈ measured $324.
//   R1  unitsSoldAnHour===1 is a game placeholder ("never trust bare 1"); treat as sentinel→0.
//   R3  guard board.market so a stale/missing board-data.json can't crash the caller.
//   C1  goods consumed by BUILD/RESEARCH mechanics (steel-beams, construction-units, research
//       inputs) have no recipe consumer → der=0 → falsely MIRAGE. Flag them B2B-BLIND (visible,
//       "verify build/research demand"), never hard-zeroed as dead.
const fs = require('fs'), path = require('path');
const DIR = '/srv/appdata/chrome-automation/sim';

const C = {                                   // tunable constants (see spec §12)
  L1: 0.8087, FEE: 0.04, TRANSPORT_KIND: 13,
  BETA: 1.0, ALPHA: 0.34,
  A_DEEP: 50, A_MIR: 1.0, EPS_G: 0.02,        // B2B tiers
  S_DEAD: 1.8, EPS_DRAIN: 0.002,              // retail level/trend
  DOS_DEAD: 30, P_BAND: 0.05,
};

// C1: kinds whose demand comes from game MECHANICS (building construction / research), which the
// recipe graph cannot see. Never classify these as dead MIRAGE — flag B2B-BLIND for manual check.
const BUILD_KINDS = new Set([43, 101, 102, 103, 107, 109, 110, 111, 112, 114]); // steel..robots (planks k108 has retail)
const RESEARCH_KINDS = new Set([29, 30, 31, 32, 33, 34, 35, 58, 59, 100, 113, 145]);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function load(factsPath, boardPath, defsPath) {
  const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const defs = defsPath && fs.existsSync(defsPath) ? JSON.parse(fs.readFileSync(defsPath, 'utf8')).resources : null;
  return { R: facts.resources, board, defs };
}

function buildRealizable({
  factsPath = DIR + '/game-facts.json',
  boardPath = DIR + '/board-data.json',
  defsPath = DIR + '/defs.json',
} = {}) {
  const { R, board, defs } = load(factsPath, boardPath, defsPath);
  const kinds = Object.keys(R);
  const nm = k => ((defs && defs[k] && defs[k].image) || 'k' + k).replace(/.*\//, '').replace('.png', '');

  // R1: unitsSoldAnHour===1 is a placeholder, not a measurement — treat as 0 (fall back to consumption).
  const usSan = k => { const u = R[k].unitsSoldAnHour || 0; return u === 1 ? 0 : u; };

  // R3: a stale/missing board-data.json must not crash the ranker that requires this module.
  const mk = board.market || {};
  const price = {}, isUp = {};
  for (const t of (mk.ticker || [])) { price[t.kind] = t.price; isUp[t.kind] = t.is_up; }

  const retailByDb = {};
  for (const e of (mk.retail || [])) {
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

  // ---- realized leaf: what actually sells to consumers/restaurants right now ----
  const L = {};
  for (const k of kinds) {
    const cons = R[k].consumption || 0, us = usSan(k), ri = RI(k);
    const retailTerm = ri.inFeed ? (ri.clears ? Math.max(us, cons) : cons) : cons;
    L[k] = retailTerm + (ri.restH || 0);
  }
  // ---- reverse recipe graph + Leontief fixed point → derived B2B demand ----
  const consumers = {};
  for (const y of kinds) for (const [x, m] of Object.entries(R[y].recipe || {}))
    (consumers[x] = consumers[x] || []).push({ y, mult: m });
  let A = Object.assign({}, L);
  for (let it = 0; it < 500; it++) {
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
      return { pk: clamp(1 - dos / C.DOS_DEAD, 0, 1), stale: false };
    }
    return { pk: isUp[k] ? 0.6 : 0.5, stale: true };   // no book captured → price-trend coin-flip
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
    const kn = +k;
    let rr = 0, verdict, channel, bookStale = false;

    if (r.retailSeason || r.productionSeason || r.accumulator) { verdict = 'SEASONAL'; channel = 'season'; }
    else if (ri.inFeed && !ri.clears && (ri.restH || 0) === 0) { verdict = 'MIRAGE(dead-lake)'; channel = 'retail'; }
    else if (ri.inFeed && (ri.clears || ri.restH > 0)) {                      // RETAIL branch
      channel = (ri.restH > 0 && !ri.clears) ? 'restaurant' : 'retail';
      const Aret = (ri.clears ? usSan(k) : 0) + (ri.restH || 0);
      const S = ri.sat;
      // D1: credit a clearing/draining lake m(S)·A_ret of throughput (was a 12% τ-band that
      // capped steak at 4.33/h; m(S)=clamp(1−S/2) gives steak 11.5/h ≈ measured 26/h × margin).
      const mS = clamp(1 - S / 2, 0, 1);
      rr = Math.min(g, mS * Aret / C.BETA);
      if (ri.restH > 0 && !ri.clears) verdict = 'B2B-DEEP';                   // restaurant-driven (samosa)
      else if (S >= C.S_DEAD) { verdict = 'MIRAGE(dead-lake)'; rr = 0; }
      else if (S > 1.0 && ri.dS >= -C.EPS_DRAIN) verdict = 'OVERSUPPLIED';    // flat/flooding (apples)
      else verdict = 'RETAIL-OK';                                            // healthy or draining (steak, construction)
    } else {                                                                  // B2B branch (no retail feed)
      channel = 'b2b';
      const Ad = der[k];
      if (Ad < Math.max(C.A_MIR, C.EPS_G * g)) {
        // C1: recipe graph shows no consumer — but build/research goods are consumed by MECHANICS
        // the graph can't see. Flag those B2B-BLIND (visible, verify manually) instead of dead.
        if (BUILD_KINDS.has(kn) || RESEARCH_KINDS.has(kn) || r.isResearch) { verdict = 'B2B-BLIND'; rr = 0; }
        else { verdict = 'MIRAGE'; rr = 0; }                                  // genuinely dead (aerospace parts)
      } else {
        const pke = priceKeepExch(k); bookStale = pke.stale;
        rr = Math.min(g, C.ALPHA * Ad) * pke.pk;
        verdict = Ad >= C.A_DEEP ? 'B2B-DEEP' : 'B2B-THIN';
      }
    }
    const realizable$h = pu == null ? null : pu * rr;   // caller subtracts wage (has the building table)
    byKind[k] = {
      kind: kn, name: nm(k), channel, verdict,
      g: +g.toFixed(3), absorption: +A[k].toFixed(3), derived: +der[k].toFixed(3),
      realizableRate: +rr.toFixed(4), realizableFraction: g > 0 ? +(rr / g).toFixed(4) : 0,
      perUnitProfit: pu == null ? null : +pu.toFixed(3),
      realizablePerHour_preWage: realizable$h == null ? null : +realizable$h.toFixed(1),
      bookStale,
    };
  }
  return { byKind, constants: C, generated: board.generated };
}

module.exports = { buildRealizable, CONSTANTS: C };

// ---- CLI: ranked table + artifact for the strategist/board ----
if (require.main === module) {
  const out = buildRealizable();
  const rows = Object.values(out.byKind)
    .filter(r => r.realizablePerHour_preWage != null && r.verdict !== 'SEASONAL')
    .sort((a, b) => b.realizablePerHour_preWage - a.realizablePerHour_preWage);
  const p = (s, n) => String(s).padEnd(n);
  console.log(p('resource', 20) + p('verdict', 20) + p('rr/h', 9) + p('frac', 7) + p('$/h(preWage)', 14) + 'A(total)');
  console.log('-'.repeat(84));
  for (const r of rows.slice(0, Number(process.env.TOP) || 40))
    console.log(p(r.name, 20) + p(r.verdict, 20) + p(r.realizableRate, 9) +
      p(r.realizableFraction, 7) + p('$' + r.realizablePerHour_preWage, 14) + r.absorption);
  fs.writeFileSync(DIR + '/board/.realizable.json', JSON.stringify(out, null, 1));
  console.error('\nwrote board/.realizable.json (' + rows.length + ' scored kinds)');
}
