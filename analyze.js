#!/usr/bin/env node
// Profitability model for Sim Companies.
//
// Inputs: the resource definition table pulled from the public JS bundle (defs.json)
// and a live market-ticker capture. For every resource it values the inputs at exchange
// price, charges building wages against the observed production rate, and reports the
// gross margin per production-hour — the number that decides what a building should make.
//
// Usage: node analyze.js <defs.json> <capture-with-market-ticker.json>

const [defsPath, capPath] = process.argv.slice(2);
const defs = require(defsPath).resources;
const cap = require(capPath);
const ticker = cap['/api/v3/market-ticker/0/'];

const price = {}, name = {};
for (const t of ticker) {
  price[t.kind] = t.price;
  name[t.kind] = t.image.replace(/.*\//, '').replace('.png', '');
}

// Building letter -> label and the hourly wage bill observed in-game at level 1.
const BUILDING = {
  E: 'Power plant', W: 'Water pump', P: 'Farm', M: 'Mine', Q: 'Quarry',
  I: 'Industrial', F: 'Factory', R: 'Refinery', A: 'Agricultural',
  L: 'Laboratory', S: 'Store', G: 'Grocery', T: 'Fashion', C: 'Construction',
};

const rows = [];
for (const [kindStr, r] of Object.entries(defs)) {
  const kind = Number(kindStr);
  if (!r.producedPerHourRaw || r.isResearch) continue;
  const sell = price[kind];
  if (!sell) continue;

  let inputCost = 0, missing = false, recipe = [];
  for (const [k, mult] of Object.entries(r.producedFrom || {})) {
    const p = price[k];
    if (p == null) { missing = true; continue; }
    inputCost += p * mult;
    recipe.push(`${mult}x ${name[k] || k}`);
  }
  if (missing) continue;

  const margin = sell - inputCost;               // per unit, before wages
  const perHour = margin * r.producedPerHourRaw; // gross margin per production-hour
  rows.push({
    kind,
    name: name[kind] || r.image.replace(/.*\//, '').replace('.png', ''),
    at: BUILDING[r.producedAt] || r.producedAt,
    rate: r.producedPerHourRaw,
    sell,
    inputCost: +inputCost.toFixed(3),
    margin: +margin.toFixed(3),
    marginPct: +(margin / sell * 100).toFixed(1),
    perHour: Math.round(perHour),
    recipe: recipe.join(' + ') || '(raw)',
  });
}

rows.sort((a, b) => b.perHour - a.perHour);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('resource', 24) + pad('building', 14) + pad('rate/h', 9) +
            pad('sell$', 10) + pad('input$', 10) + pad('margin%', 9) +
            pad('$/prod-hour', 13) + 'recipe');
console.log('-'.repeat(150));
for (const r of rows.slice(0, Number(process.env.TOP) || 45)) {
  console.log(pad(r.name, 24) + pad(r.at, 14) + pad(r.rate, 9) +
              pad(r.sell, 10) + pad(r.inputCost, 10) + pad(r.marginPct, 9) +
              pad(r.perHour.toLocaleString(), 13) + r.recipe);
}
