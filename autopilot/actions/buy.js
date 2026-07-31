// Buy a resource on the exchange, bounded by maxSpend. Must already be ON the resource's
// market page (/market/resource/<kind>/) — the caller navigates there first, because a
// navigate inside the same CDP eval races the page teardown.
// Params: window.__buy = { kind, quantity?, maxSpend, ask? }.
//
// The button starts as "BUY" and, after quantity entry, includes the live total and unit price.
// Bind it to the exact form containing the unique Quantity input. A plain .click() is sometimes
// swallowed on a freshly-rendered SPA page, so dispatch a real MouseEvent. Confirm the fill via
// the resources API, never by reading text.
const { kind, quantity: exactQuantity, maxSpend, ask: askHint, minCashAfter } = window.__buy;

const qtyInputs = all('input').filter(i => i.offsetParent !== null
  && /quantity/i.test(i.placeholder || ''));
if (qtyInputs.length !== 1) return { ok: false,
  reason: 'market Quantity input is not unique', count: qtyInputs.length, url: location.href };
const qtyInput = qtyInputs[0];

// Never infer an ask from arbitrary dollar strings in document.body. That previously picked an
// unrelated $0.28 value on the Coffee page, sized 3,571 units, and then hit a disabled BUY. Read
// the authoritative current book and keep a supplied `ask` as a hard unit-price ceiling.
const market = await api('/api/v3/market/0/' + kind + '/');
if (market.status !== 200 || !Array.isArray(market.json)) {
  return { ok: false, reason: 'could not read the authoritative current market book',
           marketStatus: market.status };
}
if (typeof window.__planMarketPurchase !== 'function'
    || typeof window.__planExactMarketPurchase !== 'function') {
  return { ok: false, guard: true, reason: 'budget-safe market planner is unavailable' };
}
const plan = exactQuantity == null
  ? window.__planMarketPurchase(market.json, maxSpend, askHint == null ? null : askHint)
  : window.__planExactMarketPurchase(
    market.json,
    exactQuantity,
    maxSpend,
    askHint == null ? null : askHint,
  );
if (!plan.ok) return { ok: false, guard: true, ...plan };

const qty = plan.quantity;
setInput(qtyInput, qty);
await sleep(1800);
const enteredQty = Number(String(qtyInput.value || '').replace(/,/g, ''));
if (!Number.isSafeInteger(enteredQty) || enteredQty !== qty) {
  return { ok: false, reason: 'market UI changed the planned quantity before submit',
           plannedQty: qty, enteredQty: qtyInput.value, plan };
}

const buyForm = qtyInput.closest('form');
if (!buyForm) return { ok: false, reason: 'market Quantity input has no containing form', qty, plan };
const buyButtons = all('button', buyForm).filter(b => b.offsetParent !== null
  && /^BUY(?:\s|$)/i.test(norm(b.innerText)));
if (buyButtons.length !== 1) return { ok: false, reason: 'visible BUY button is not unique',
  count: buyButtons.length, labels: buyButtons.map(button => norm(button.innerText).slice(0, 120)),
  qty, plan };
const btn = buyButtons[0];
const buttonDisabled = btn.disabled
  || String(btn.getAttribute('aria-disabled')).toLowerCase() === 'true'
  || /(^|\s)disabled(\s|$)/i.test(String(btn.className || ''))
  || getComputedStyle(btn).pointerEvents === 'none';
if (buttonDisabled) return { ok: false, reason: 'BUY button is disabled', qty, plan };

const before = await api('/api/v3/resources/' + (window.__companyId || '5714348') + '/');
const beforeAuth = await api('/api/v3/companies/auth-data/');
if (before.status !== 200 || !Array.isArray(before.json)) {
  return { ok: false, reason: 'could not verify inventory before BUY', stockStatus: before.status };
}
const totalKindStock = (rows) => {
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(x => Number(x.kind) === Number(kind));
  let total = 0;
  for (const row of matches) {
    if (row?.amount == null || row.amount === '') return null;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    total += amount;
  }
  return total;
};
const had = totalKindStock(before.json);
const cashBeforeRaw = beforeAuth.json?.money ?? beforeAuth.json?.authCompany?.money;
const cashBefore = cashBeforeRaw == null || cashBeforeRaw === '' ? null : Number(cashBeforeRaw);
if (beforeAuth.status !== 200 || !Number.isFinite(cashBefore)
    || !Number.isFinite(had)) {
  return { ok: false, reason: 'could not verify cash before BUY', cashStatus: beforeAuth.status };
}
// Re-read immediately before dispatch. The 1.8-second React input settle is long enough for the
// top lot to move; the original quote cannot authorize a fixed quantity against a changed book.
const submitMarket = await api('/api/v3/market/0/' + kind + '/');
if (submitMarket.status !== 200 || !Array.isArray(submitMarket.json)
    || typeof window.__quoteFixedMarketPurchase !== 'function') {
  return { ok: false, guard: true,
    reason: 'could not re-quote the fixed quantity immediately before BUY',
    marketStatus: submitMarket.status, plan };
}
const submitQuote = window.__quoteFixedMarketPurchase(
  submitMarket.json,
  qty,
  maxSpend,
  plan.priceCeiling,
);
if (!submitQuote.ok) return { ok: false, guard: true,
  reason: `pre-submit market re-quote refused: ${submitQuote.reason}`, plan, submitQuote };
if (cashBefore - submitQuote.estimatedCost < Number(minCashAfter) - 1e-6) {
  return { ok: false, guard: true,
    reason: 'budget-safe order estimate would breach minCashAfter',
    cashBefore, minCashAfter: Number(minCashAfter), plan, submitQuote };
}
const finalEnteredQty = Number(String(qtyInput.value || '').replace(/,/g, ''));
const finalButtonDisabled = btn.disabled
  || String(btn.getAttribute('aria-disabled')).toLowerCase() === 'true'
  || /(^|\s)disabled(\s|$)/i.test(String(btn.className || ''))
  || getComputedStyle(btn).pointerEvents === 'none';
if (finalEnteredQty !== qty || finalButtonDisabled) return { ok: false, guard: true,
  reason: 'market form changed during the final book re-quote; BUY was not dispatched',
  finalEnteredQty, finalButtonDisabled, plan, submitQuote };

btn.scrollIntoView({ block: 'center' });
btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
await sleep(4000);

const after = await api('/api/v3/resources/' + (window.__companyId || '5714348') + '/');
const afterAuth = await api('/api/v3/companies/auth-data/');
const now = totalKindStock(after.json);
const cashAfterRaw = afterAuth.json?.money ?? afterAuth.json?.authCompany?.money;
const cashAfter = cashAfterRaw == null || cashAfterRaw === '' ? null : Number(cashAfterRaw);
const bought = Number.isFinite(now) && Number.isFinite(had) ? now - had : null;
const actualSpend = Number.isFinite(cashAfter) ? cashBefore - cashAfter : null;
const inventoryVerified = after.status === 200 && Number.isFinite(now)
  && bought > 0 && bought <= qty;
// Cash can increase concurrently when an outstanding bond sells. A non-negative delta is useful
// evidence; a negative delta is UNKNOWN rather than a reason to retry an already verified stock
// increase. The authoritative pre-click book plan remains the hard authorization.
const spendVerified = afterAuth.status === 200 && Number.isFinite(actualSpend)
  ? (actualSpend >= -0.01 ? actualSpend <= Number(maxSpend) + 0.01 : null)
  : null;
const postBudgetViolation = spendVerified === false;
return {
  ok: inventoryVerified && !postBudgetViolation,
  mutationAttempted: true,
  kind,
  qty,
  bought,
  stockNow: now,
  cashBefore,
  cashAfter: Number.isFinite(cashAfter) ? cashAfter : null,
  actualSpend,
  spendVerified,
  plan,
  submitQuote,
  reason: inventoryVerified && !postBudgetViolation ? undefined
    : 'BUY was clicked but exact inventory and cash deltas did not verify within maxSpend; do not retry blindly',
};
