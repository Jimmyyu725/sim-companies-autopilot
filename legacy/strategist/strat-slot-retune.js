// One-shot: retune config.slotAlert after the 2nd Mill BUILT (2026-07-24 18:07 CDT).
// Raises the wake gate 40000 -> 55000 and corrects the STALE Bakery/Slaughterhouse#2 notes
// (both dead per Board #3). Run under flock to serialize vs the fast loop's config writes.
const fs = require('fs');
fs.copyFileSync('config.json', 'config.json.bak-strat-1810');
const c = JSON.parse(fs.readFileSync('config.json', 'utf8'));
c.slotAlert = c.slotAlert || {};
c.slotAlert.minCash = 55000;
c.slotAlert._asOf = '2026-07-24T18:10:00-05:00';
c.slotAlert._reranked_2026_07_24_1810 =
  'SUPERSEDES every earlier note in this field — IGNORE the Bakery and Slaughterhouse #2 ' +
  'references above, both are DEAD (Bakery KILLED by Board #3 2026-07-24 11:26: unitsSoldAnHour 0 ' +
  '= 100% exchange dump; Slaughterhouse #2 REJECTED: steak realizable 11.5/h vs 26/h production = ' +
  'oversupplied). At 18:07 CDT the 2ND MILL BUILT for ~$30,739 — a ~$50.7k SimCity-Space-Race ' +
  'one-off game payout pushed cash $28.6k -> $79.3k mid-tick, crossing the $34,560 gate; buildPlan ' +
  'auto-disarmed (enabled=false, _done stamped). We now have 5 real buildings ' +
  '(Farm / 2x Mill / Slaughterhouse / Grocery) and 1 FREE SLOT; cash after the build ~$48.6k. ' +
  'The last slot has only two live candidates: (a) 2ND GROCERY STORE ~$11-14k, a TRIGGERED build ' +
  'the board gated on "post-2nd-Mill powder+meat SATURATE the single store lane (~>=90 u/h) and ' +
  'starve steak/sausages" — NOT yet measurable (2nd Mill built minutes ago, powder still accruing). ' +
  'PRELIMINARY supply check (a HYPOTHESIS to test, not a decision): powder 36/h (2 mills) + steak ' +
  '26/h = 62/h < the ~90/h bar, and a 2nd L1 store built only to catch squeezed-out GRAPES was ' +
  'already REJECTED (grapes ~$90/h < $143/h wages = negative), so the trigger likely does NOT fire ' +
  '— but MEASURE the realized store split before ruling it out. (b) OIL RIG — endorsed next big ' +
  'build, gated cash>=$81k + a live crude sell-book probe (Rule 4d pt4); unaffordable at $48.6k, ' +
  'HOLD. 3rd Mill = NO (36/h < 40.4/h realizable ceiling). Catering/Restaurant forbidden. ' +
  'GATE raised 40000 -> 55000: at $48.6k the old $40k gate woke a strategist every 90 min to chase ' +
  'the dead Bakery; $55k (~4-6h at the lumpy ~$1.2k/h accrual) lets the 2nd Mill release powder and ' +
  'the store cycle 2-3x post-Mill so the NEXT woken strategist can MEASURE the lane split and decide ' +
  '2nd-store-vs-accumulate-to-$81k-oil-rig. Backstop: steak surplusWatch (cap 250) independently ' +
  'flags genuine lane saturation (steak piling = store not clearing it). _asOf 2026-07-24 18:10 CDT.';
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
JSON.parse(fs.readFileSync('config.json', 'utf8')); // re-parse: throws if we wrote invalid JSON
console.log('OK: backed up config.json.bak-strat-1810, minCash=', c.slotAlert.minCash,
  '| slotAlert keys:', Object.keys(c.slotAlert).join(','));
