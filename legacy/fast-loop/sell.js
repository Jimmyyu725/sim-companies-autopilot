// Start a retail sales order in the grocery store.
// Params from window.__sell = { name, qty, price }.
const { name, qty, price } = window.__sell;

if (document.body.innerText.includes('currently busy')) {
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
const sellBtn = all('button', card).find(b => /^SELL$/i.test(norm(b.innerText)));
if (!sellBtn) {
  return { ok: false, reason: 'SELL button not present',
           buttons: all('button', card).map(b => norm(b.innerText)), before };
}
if (sellBtn.disabled) return { ok: false, reason: 'SELL disabled', before };

sellBtn.click();
await sleep(3000);
return { ok: true, before, after: norm(document.body.innerText).slice(0, 400) };
