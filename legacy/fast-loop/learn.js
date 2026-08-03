#!/usr/bin/env node
// Learning layer for the autopilot.
//
// Every hardcoded number in config.json is a snapshot of one evening's market. Left alone
// it rots: retail averages drift, sell rates change with store level and weather, and the
// x3 new-account acceleration expires outright. So the bot records what it actually did and
// what actually happened, and re-derives its own parameters from that.
//
//   observations.jsonl  append-only: one record per tick (state) and per action (decision)
//   knowledge.json      the derived parameters tick.js prefers over config defaults
//
// Usage: node learn.js            re-derive knowledge.json and print a summary
//        node learn.js --quiet    same, no output (called at the end of each tick)

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OBS = path.join(DIR, 'observations.jsonl');
const OUT = path.join(DIR, 'knowledge.json');
const QUIET = process.argv.includes('--quiet');

// How long a measurement stays trustworthy. Past this it is kept but demoted to
// "reference" — visible for context, never the basis of a decision.
const MAX_AGE_MIN = { retailAverage: 60, sellRate: 360, xp: 1440 };
const ageMin = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;
const stamp = (iso, kind) => {
  const age = Math.round(ageMin(iso));
  return { at: iso, ageMin: age, status: age <= MAX_AGE_MIN[kind] ? 'fresh' : 'reference' };
};

function readObs() {
  if (!fs.existsSync(OBS)) return [];
  return fs.readFileSync(OBS, 'utf8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Retail averages come straight from the game's own /resources-retail-info/ feed, which the
// store-page capture already returns. Preferring the newest observation keeps the price
// sweep centred on the live market instead of last night's numbers.
function learnRetailAverages(obs) {
  const out = {};
  for (const o of obs) {
    if (o.type !== 'state' || !o.retailAvg) continue;
    for (const [kind, avg] of Object.entries(o.retailAvg)) {
      out[kind] = { avgPrice: avg, ...stamp(o.t, 'retailAverage') };
    }
  }
  return out;
}

// A placed sales order tells us, for free, what the game thinks the sell rate is:
// quantity / projected hours. That number already includes store level, weather and any
// modifier we do not model, so it beats anything computed by hand.
function learnSellRates(obs) {
  const acc = {};
  for (const o of obs) {
    if (o.type !== 'sell' || !o.qty || !o.hours) continue;
    const rate = o.qty / o.hours;
    const netPerUnit = o.perHour != null ? o.perHour / rate + (o.unitCost || 0) : null;
    (acc[o.kind] = acc[o.kind] || []).push({ rate, netPerUnit, price: o.price, at: o.t });
  }
  const out = {};
  for (const [kind, rows] of Object.entries(acc)) {
    const recent = rows.slice(-8);
    const last = recent[recent.length - 1];
    out[kind] = {
      sellRate: +(recent.reduce((s, r) => s + r.rate, 0) / recent.length).toFixed(2),
      samples: rows.length,
      lastPrice: last.price,
      ...stamp(last.at, 'sellRate'),
    };
  }
  return out;
}

// Which drives XP — units shipped or revenue booked? Both fit the first data point we had,
// so score each against every interval and let the residuals decide. Until one clearly wins
// the answer stays "unknown" rather than a guess.
function learnXpModel(obs) {
  const states = obs.filter(o => o.type === 'state' && o.xp != null);
  const points = [];
  for (let i = 1; i < states.length; i++) {
    const a = states[i - 1], b = states[i];
    const dXP = b.xp - a.xp + (b.level > a.level ? a.xpNext * (b.level - a.level) : 0);
    const dCash = b.money - a.money;
    let units = 0;
    for (const [k, amt] of Object.entries(a.stock || {})) {
      const now = (b.stock || {})[k] ?? 0;
      if (now < amt) units += amt - now;
    }
    if (dXP > 0) points.push({ dXP, dCash, units });
  }
  if (points.length < 4) return { model: 'unknown', points: points.length };

  const fit = (xs, ys) => {
    const n = xs.length;
    const k = xs.reduce((s, x, i) => s + x * ys[i], 0) / xs.reduce((s, x) => s + x * x, 0);
    const ss = ys.reduce((s, y, i) => s + (y - k * xs[i]) ** 2, 0);
    const mean = ys.reduce((a, b) => a + b, 0) / n;
    const tot = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
    return { k, r2: tot ? 1 - ss / tot : 0 };
  };
  const ys = points.map(p => p.dXP);
  const byUnits = fit(points.map(p => p.units), ys);
  const byCash = fit(points.map(p => p.dCash), ys);
  const winner = byUnits.r2 >= byCash.r2 ? 'perUnit' : 'perRevenue';
  return {
    model: Math.max(byUnits.r2, byCash.r2) < 0.5 ? 'unclear' : winner,
    xpPerUnit: +byUnits.k.toFixed(4), unitsR2: +byUnits.r2.toFixed(3),
    xpPerDollar: +byCash.k.toFixed(6), cashR2: +byCash.r2.toFixed(3),
    points: points.length,
  };
}

const obs = readObs();
const knowledge = {
  updated: new Date().toISOString(),                    // machine field: ISO UTC
  updatedLocal: new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' }) + ' CDT',
  observations: obs.length,
  retailAverages: learnRetailAverages(obs),
  sellRates: learnSellRates(obs),
  xp: learnXpModel(obs),
  // Rates measured under the x3 new-account acceleration do not survive its expiry.
  // Record the regime each measurement was taken in so stale ones can be discarded
  // wholesale rather than silently trusted.
  accelRegime: (() => {
    const last = [...obs].reverse().find(o => o.type === 'state' && o.accel);
    return last ? { ...last.accel, at: last.t } : null;
  })(),
  freshnessPolicyMin: MAX_AGE_MIN,
};

// Anything measured under a different acceleration regime than the current one is not
// comparable — demote it explicitly rather than letting it look authoritative.
if (knowledge.accelRegime) {
  const now = knowledge.accelRegime.multiplier;
  for (const o of obs) {
    if (o.type !== 'state' || !o.accel) continue;
    if (o.accel.multiplier !== now) {
      knowledge.regimeChanged = true;
      break;
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify(knowledge, null, 2));

if (!QUIET) {
  console.log(`observations: ${obs.length}`);
  console.log('xp model:', JSON.stringify(knowledge.xp));
  const sr = Object.entries(knowledge.sellRates);
  console.log(`learned sell rates: ${sr.length ? sr.map(([k, v]) => `${k}=${v.sellRate}/h (n=${v.samples}, ${v.status})`).join(' ') : '(none yet)'}`);
  const ra = Object.values(knowledge.retailAverages);
  const fresh = ra.filter(v => v.status === 'fresh').length;
  console.log(`retail averages: ${ra.length} tracked, ${fresh} fresh, ${ra.length - fresh} reference-only`);
  console.log('acceleration regime:', JSON.stringify(knowledge.accelRegime));
  if (knowledge.regimeChanged) console.log('WARNING: observations span an acceleration change — older rates are not comparable');
}
