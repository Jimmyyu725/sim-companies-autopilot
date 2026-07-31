// Construct a new building on a free slot.
// Params from window.__build = { building, maxCost, minCashAfter, confirm }.
//
// Must be run from /landscape/. Clicking a free slot opens the catalogue; each entry quotes
// an approximate cost that moves with construction-material prices, so the quote is re-read
// and checked here rather than trusted from config. Like the upgrade dialog this commits in
// two steps — BUY MISSING sources the materials, then the build starts.
const { building, maxCost, minCashAfter, confirm, effectiveCost, cash: cashSnapshot,
  beforeBuildings } = window.__build;
if (confirm === true && !Array.isArray(beforeBuildings)) {
  return { ok: false, reason: 'authoritative pre-construction buildings are unavailable' };
}

const slot = all('a, div').find(e => /construction slot/i.test(norm(e.innerText)) &&
                                     norm(e.innerText).length < 40 && e.offsetParent !== null);
if (!slot) return { ok: false, reason: 'no free construction slot on the map' };
slot.click();
await sleep(4000);

const rowFor = (name) => all('div, li, a').filter(e => {
  const t = norm(e.innerText);
  return t.toUpperCase().startsWith(name.toUpperCase()) && /approximately \$/.test(t);
}).sort((a, b) => a.innerText.length - b.innerText.length)[0];

const row = rowFor(building);
if (!row) return { ok: false, reason: `"${building}" not in the catalogue`,
                   sample: norm(document.body.innerText).slice(0, 300) };

const quoted = Number((norm(row.innerText).match(/approximately \$([\d,]+)/) || [])[1]?.replace(/,/g, ''));
const money = cashSnapshot?.value == null ? NaN : Number(cashSnapshot.value);
const info = { building, quoted, money: Number.isFinite(money) ? money : null,
               cashSource: cashSnapshot?.source || null, cashAsOf: cashSnapshot?.asOf || null,
               cashAfter: Number.isFinite(money) ? money - quoted : null };

if (!isFinite(quoted)) return { ok: false, reason: 'could not read quoted cost', ...info };
if (!isFinite(money)) return { ok: false, reason: 'could not verify company cash from auth API or fresh state', ...info };
// The catalogue quote is the FULL material bill; BUY MISSING only charges for what the
// warehouse lacks. When the plan supplies effectiveCost (missing materials priced from the
// exchange), affordability is judged on that — otherwise fall back to the full quote.
const parsedEffectiveCost = effectiveCost == null || effectiveCost === ''
  ? null
  : Number(effectiveCost);
const cashNeeded = Number.isFinite(parsedEffectiveCost) && parsedEffectiveCost >= 0
  ? parsedEffectiveCost
  : quoted;
info.cashNeeded = cashNeeded;
if (confirm !== true) return {
  ok: true,
  dry: true,
  preview: true,
  note: 'dry run — not confirmed',
  ...info,
  affordability: {
    withinMaxCost: quoted <= maxCost,
    reserveSatisfied: money - cashNeeded >= minCashAfter,
    maxCost,
    minCashAfter,
  },
};
if (quoted > maxCost) return { ok: false, reason: `quote $${quoted} exceeds maxCost $${maxCost}`, ...info };
if (money - cashNeeded < minCashAfter) {
  return { ok: false, reason: `would leave $${money - cashNeeded}, below reserve $${minCashAfter}`, ...info };
}

row.click();
await sleep(3500);

const dialogs = all('[role=dialog], [class*=odal], [class*=verlay]').filter(d =>
  d.offsetParent !== null
  && norm(d.innerText).toUpperCase().includes(building.toUpperCase())
  && /BUY MISSING|BUILD|CONSTRUCT/i.test(norm(d.innerText)));
const innermostDialogs = dialogs.filter(d => !dialogs.some(other => other !== d && d.contains(other)));
if (innermostDialogs.length !== 1) return { ok: false,
  reason: 'construction dialog is not unique; refusing to select spend/commit buttons',
  dialogCount: innermostDialogs.length, ...info };
const dlg = innermostDialogs[0];

const dialogBtns = (label) => all('button', dlg)
  .filter(b => b.offsetParent !== null
    && new RegExp('^' + label + '$', 'i').test(norm(b.innerText)) && !b.disabled);

// The dialog is a two-step commit, mapped by the 18:43 log plus a read-only probe
// (2026-07-22 19:36): it opens with an UNPRICED "BUY MISSING" and a disabled build
// button, and the priced confirm ("BUY MISSING $23,450") only renders after the
// unpriced button is clicked — no cash moves on that reveal click (18:43 clicked it
// with $18.6k against a $23.5k bill and nothing was debited). So: click the unpriced
// reveal, poll for the priced confirm, gate the spend on its live figure, then commit.
const buyBtns = () => all('button', dlg).filter(b => b.offsetParent !== null
  && /^BUY MISSING/i.test(norm(b.innerText)));
const pricedBtns = () => buyBtns()
  .map(b => ({ b, cost: Number((norm(b.innerText).match(/\$([\d,]+)/) || [])[1]?.replace(/,/g, '')) }))
  .filter(x => isFinite(x.cost));
const bail = (reason) => {
  const cancel = all('button', dlg).find(b => /changed my mind|cancel|^back$/i.test(norm(b.innerText)));
  if (cancel) cancel.click();
  return { ok: false, reason, ...info,
           buttons: all('button', dlg).map(b => norm(b.innerText)).filter(Boolean).slice(0, 12) };
};
let priced = pricedBtns();
if (!priced.length) {
  const reveals = buyBtns().filter(b => !b.disabled && !/\$[\d,]+/.test(norm(b.innerText)));
  if (reveals.length > 1) return bail('unpriced BUY MISSING reveal is ambiguous');
  const reveal = reveals[0];
  if (reveal) {
    reveal.click();
    for (let i = 0; i < 6 && !priced.length; i++) { await sleep(2000); priced = pricedBtns(); }
  }
}
if (priced.length > 1) return bail('priced BUY MISSING confirmation is ambiguous');
if (priced.length) {
  info.liveMissing = priced[0].cost;
  if (typeof window.__evaluateSpendGuard !== 'function') {
    return bail('live spend guard is unavailable');
  }
  // The catalogue quote is only an estimate. The priced BUY MISSING button is the final cash
  // authorization and must satisfy BOTH limits again; the old path rechecked only the reserve,
  // so a price move above maxCost could still be committed.
  const liveSpend = window.__evaluateSpendGuard(
    priced[0].cost,
    maxCost,
    money,
    minCashAfter,
  );
  if (!liveSpend.ok) return bail(liveSpend.reason);
  if (priced[0].b.disabled) return bail('priced BUY MISSING button is disabled');
  priced[0].b.click();
  await sleep(7000);
}
// No BUY MISSING at all → materials already on hand. Priced confirm never appeared
// after the reveal → either the reveal click itself completed the purchase or nothing
// happened; both cases resolve at the build-button poll below (it only enables once
// materials are actually in the warehouse, and bailing there cancels cleanly).

// The confirm button is labelled with the building name ("BUILD MILL"), and the
// purchase can take a few seconds to enable it — poll rather than sample once.
let goCandidates = [];
for (let i = 0; i < 6 && goCandidates.length !== 1; i++) {
  goCandidates = [
    ...dialogBtns('BUILD ' + building.toUpperCase()),
    ...dialogBtns('BUILD'),
    ...dialogBtns('BUILD NOW'),
    ...dialogBtns('CONSTRUCT'),
  ];
  goCandidates = [...new Set(goCandidates)];
  if (goCandidates.length > 1) return bail('enabled build confirmation is ambiguous');
  if (!goCandidates.length) await sleep(2500);
}
const go = goCandidates[0] || null;
if (!go) {
  const cancel = all('button', dlg).find(b => /changed my mind|cancel/i.test(norm(b.innerText)));
  if (cancel) cancel.click();
  return { ok: false, reason: 'no enabled build button', ...info,
           buttons: all('button', dlg).map(b => norm(b.innerText)).filter(Boolean).slice(0, 12) };
}
go.click();
await sleep(2500);
return { ok: false, commitClicked: true, verificationPending: true, mutationAttempted: true,
  doNotRetry: true,
  reason: 'BUILD was clicked; act.js must capture the authoritative buildings payload before reporting success',
  ...info, after: norm(document.body.innerText).slice(0, 260) };
