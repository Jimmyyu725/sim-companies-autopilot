// Upgrade the currently open building one level.
// Params from window.__upgrade = { maxCost, minCashAfter, confirm }.
//
// The dialog is a two-step commit: BUY MISSING purchases whatever construction materials
// the warehouse lacks (this is the only cash actually spent — materials already in stock
// are credited as "sourcing cost"), which then enables UPGRADE NOW. Button lookups are
// scoped to the dialog: the building page has its own "UPGRADE" action button, and
// searching the whole document finds that one and merely reopens the dialog.
const { buildingId, maxCost, minCashAfter, confirm, cash: cashSnapshot,
  beforeBuildings } = window.__upgrade;
if (confirm === true && (!Array.isArray(beforeBuildings)
    || !beforeBuildings.some(building => Number(building.id) === Number(buildingId)))) {
  return { ok: false, reason: 'authoritative pre-upgrade target is unavailable', buildingId };
}

if (document.body.innerText.includes('currently busy')) {
  return { ok: false, reason: 'building busy — cannot upgrade' };
}

const opener = all('button').find(b => /^UPGRADE$/i.test(norm(b.innerText)));
if (!opener) return { ok: false, reason: 'UPGRADE button not found' };
opener.click();
await sleep(3000);

const findDialog = () => all('[role=dialog], [class*=odal]')
  .filter(m => /Upgrade building/i.test(m.innerText))
  .sort((a, b) => a.innerText.length - b.innerText.length)[0];

let dlg = findDialog();
if (!dlg) return { ok: false, reason: 'upgrade dialog did not open' };

const num = (re, src) => Number((src.match(re) || [])[1]?.replace(/,/g, ''));
const text = norm(dlg.innerText);
const effectMatch = text.match(/\b(Sales|Production)\s+increase\s+by\s+(\d+(?:\.\d+)?)%/i);
const cashCost = num(/Exchange purchase cost \$([\d,]+)/, text);   // the only cash outlay
const totalValue = num(/Cost inflation \(savings\) \$([\d,]+)/, text) ? null : null;
const money = cashSnapshot?.value == null ? NaN : Number(cashSnapshot.value);
const info = {
  cashCost, money: Number.isFinite(money) ? money : null,
  cashSource: cashSnapshot?.source || null,
  cashAsOf: cashSnapshot?.asOf || null,
  cashAfter: Number.isFinite(money) ? money - cashCost : null,
  effect: effectMatch?.[0] || null,
  effectType: effectMatch?.[1] || null,
  effectPct: effectMatch ? Number(effectMatch[2]) : null,
  downtime: (text.match(/downtime ([\d:]+h)/) || [])[1] || null,
};

const btn = (label) => all('button', findDialog() || dlg)
  .find(b => new RegExp('^' + label + '$', 'i').test(norm(b.innerText)));

const bail = (reason) => {
  const cancel = btn('I changed my mind');
  if (cancel) cancel.click();
  return { ok: false, reason, ...info };
};

if (!isFinite(cashCost)) return bail('could not read exchange purchase cost');
if (!isFinite(money)) return bail('could not verify company cash from auth API or fresh state');
if (confirm !== true) {
  const cancel = btn('I changed my mind');
  if (cancel) cancel.click();
  return {
    ok: true,
    dry: true,
    preview: true,
    note: 'dry run — not confirmed',
    ...info,
    affordability: {
      withinMaxCost: cashCost <= maxCost,
      reserveSatisfied: money - cashCost >= minCashAfter,
      maxCost,
      minCashAfter,
    },
  };
}
if (cashCost > maxCost) return bail(`cash cost $${cashCost} exceeds maxCost $${maxCost}`);
if (money - cashCost < minCashAfter) return bail(`would leave $${money - cashCost}, below minCashAfter $${minCashAfter}`);

const buy = btn('BUY MISSING');
if (buy && !buy.disabled) { buy.click(); await sleep(6000); }

const go = btn('UPGRADE NOW');
if (!go) return bail('UPGRADE NOW button vanished');
if (go.disabled) return bail('UPGRADE NOW still disabled after BUY MISSING');

go.click();
await sleep(2500);
return { ok: false, commitClicked: true, verificationPending: true,
  verified: false, mutationAttempted: true, doNotRetry: true, buildingId,
  reason: 'UPGRADE NOW was clicked; act.js must capture the authoritative buildings payload before reporting success',
  ...info, after: norm(document.body.innerText).slice(0, 260) };
