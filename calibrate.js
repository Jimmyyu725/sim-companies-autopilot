#!/usr/bin/env node
// Derive the XP formula from observation instead of guessing it.
//
// Between two ledger snapshots we know how much XP was gained, how much cash came in,
// and how many units left the warehouse. Two hypotheses fit the first data point we
// had (5 chocolate -> +5 XP): "1 XP per unit sold" and "XP proportional to revenue".
// A single large, cheap-per-unit sale separates them cleanly.
//
// Usage: node calibrate.js [xp-ledger.jsonl]

const fs = require('fs');
const file = process.argv[2] || __dirname + '/xp-ledger.jsonl';
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);

if (rows.length < 2) {
  console.log('need at least 2 ledger rows; run tick.js a few times');
  process.exit(0);
}

console.log('from -> to'.padEnd(46) + 'dXP'.padEnd(7) + 'dCash'.padEnd(11) +
            'unitsOut'.padEnd(10) + 'XP/unit'.padEnd(10) + '$/XP');
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  // XP resets on level-up, so add back the level's requirement for each level gained.
  const dXP = b.xp - a.xp + (b.level > a.level ? a.xpNext * (b.level - a.level) : 0);
  const dCash = b.money - a.money;
  let unitsOut = 0;
  for (const [kind, amt] of Object.entries(a.stock || {})) {
    const now = b.stock?.[kind] ?? 0;
    if (now < amt) unitsOut += amt - now;
  }
  if (dXP === 0 && dCash === 0) continue;
  console.log(
    `${a.t.slice(11, 19)} -> ${b.t.slice(11, 19)}`.padEnd(46) +
    String(dXP).padEnd(7) +
    ('$' + dCash).padEnd(11) +
    String(unitsOut).padEnd(10) +
    (unitsOut ? (dXP / unitsOut).toFixed(3) : '-').padEnd(10) +
    (dXP ? (dCash / dXP).toFixed(1) : '-'));
}

console.log('\nIf XP/unit is ~1.0 across rows -> XP is per unit sold: maximise UNITS/hour (apples).');
console.log('If $/XP is roughly constant     -> XP tracks revenue:  maximise REVENUE/hour (coffee powder, chocolate).');
