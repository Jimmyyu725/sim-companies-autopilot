// Prune DEAD Bakery-only inputs/output from the price-alert watchlist (2026-07-24 18:20 CDT).
// eggs(9) "dough input 1x", butter(134) "dough input 0.5x", dough(137) "bakery output" — the
// Bakery was KILLED by Board #3 (unitsSoldAnHour 0 = 100% exchange dump). We neither buy nor
// sell any of them, so their price moves fire ONLY no-op alerts that WAKE a strategist
// (tick.js:449). Keep flour(133) = latent Mill product; power(1)/crude(10) = future oil rig.
const fs = require('fs');
fs.copyFileSync('config.json', 'config.json.bak-strat-1820');
const c = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const before = Object.keys(c.watchlist).join(',');
const DEAD = ['9', '134', '137'];
const removed = [];
for (const k of DEAD) { if (c.watchlist[k]) { removed.push(k + ':' + c.watchlist[k].name); delete c.watchlist[k]; } }
c._watchlist_pruned_2026_07_24_1820 =
  'Removed eggs(9)/butter(134)/dough(137) — all Bakery-recipe-only; Board #3 (2026-07-24 11:26) ' +
  'KILLED the Bakery, so their price moves only fired no-op alerts that WAKE a strategist for a ' +
  'line we do not run. Kept flour(133) (latent Mill product) + power(1)/crude(10) (future oil rig). ' +
  'If the Bakery is ever revived, re-add these three inputs.';
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
JSON.parse(fs.readFileSync('config.json', 'utf8')); // re-parse: throws on invalid JSON
console.log('before:', before);
console.log('removed:', removed.join(' '));
console.log('after :', Object.keys(c.watchlist).join(','), '| slotAlert.minCash=', c.slotAlert.minCash);
