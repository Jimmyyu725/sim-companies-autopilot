// Start a retail sales order in the grocery store.
// Params from window.__sell = { name, qty, price }.
const { buildingId, kind, name, qty, price } = window.__sell;

if (/currently busy/i.test(document.body.innerText)) {
  return { ok: false, reason: 'store still busy' };
}

const cards = all('div').filter(d => {
  const t = norm(d.innerText).toUpperCase();
  return t.startsWith(name.toUpperCase()) && t.includes('QUANTITY') && t.includes('PRICE')
    && d.querySelectorAll('input').length >= 2;
});
const card = cards.sort((a, b) => a.innerText.length - b.innerText.length)[0];
if (!card) return { ok: false, reason: 'card not found for ' + name };

const inputs = all('input', card);
setInput(inputs[0], qty);
await sleep(400);
setInput(inputs[1], price);
await sleep(1500);

const before = norm(card.innerText);
if (/Stock too low|BUY MISSING/i.test(before)) {
  return { ok: false, reason: 'retail quantity exceeds verified stock; sale was not submitted',
           requestedQty: qty, before };
}
const enteredQty = Number(inputs[0].value);
const enteredPrice = Number(inputs[1].value);
if (!Number.isFinite(enteredQty) || Math.abs(enteredQty - Number(qty)) >= 1e-9) {
  return { ok: false, reason: 'quantity changed before submit',
           requestedQty: qty, enteredQty: inputs[0].value, before };
}
if (!Number.isFinite(enteredPrice) || Math.abs(enteredPrice - Number(price)) >= 0.005) {
  return { ok: false, reason: 'price changed before submit',
           requestedPrice: price, enteredPrice: inputs[1].value, before };
}
const sellBtn = all('button', card).find(b => /^SELL$/i.test(norm(b.innerText)));
if (!sellBtn) {
  return { ok: false, reason: 'SELL button not present',
           buttons: all('button', card).map(b => norm(b.innerText)), before };
}
const sellDisabled = sellBtn.disabled
  || String(sellBtn.getAttribute('aria-disabled')).toLowerCase() === 'true'
  || /(^|\s)disabled(\s|$)/i.test(String(sellBtn.className || ''))
  || getComputedStyle(sellBtn).pointerEvents === 'none';
if (sellDisabled) return { ok: false, reason: 'SELL disabled', before };

sellBtn.click();
let started = false;
for (let i = 0; i < 5 && !started; i++) {
  await sleep(2500);
  if (/store is selling|currently busy/i.test(norm(document.body.innerText))) {
    started = true;
    break;
  }
  const buildings = await api('/api/v2/companies/me/buildings/');
  if (buildings.status === 200 && Array.isArray(buildings.json)
      && typeof window.__buildingHasBusyResource === 'function') {
    started = window.__buildingHasBusyResource(buildings.json, buildingId, name, kind);
  }
}
return {
  ok: started,
  clicked: true,
  mutationAttempted: true,
  started,
  buildingId,
  entered: { qty: enteredQty, price: enteredPrice },
  before,
  after: norm(document.body.innerText).slice(0, 400),
  reason: started ? undefined
    : 'SELL was clicked but the exact store did not become busy; no sale was verified and the action must not be reported as successful',
};
