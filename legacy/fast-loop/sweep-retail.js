// Sweep a set of prices for one resource card and record the UI's own
// "Profit per unit / Profit per hour / Finishes in" projection for each.
// Params from window.__sweep = { name, qty, prices: [] }.
const { name, qty, prices } = window.__sweep;

const cards = all('div').filter(d => {
  const t = norm(d.innerText).toUpperCase();
  return t.startsWith(name.toUpperCase()) && t.includes('QUANTITY') && t.includes('PRICE')
    && d.querySelectorAll('input').length >= 2;
});
const card = cards.sort((a, b) => a.innerText.length - b.innerText.length)[0];
if (!card) return { ok: false, reason: 'card not found for ' + name };

const inputs = all('input', card);
setInput(inputs[0], qty);
await sleep(300);

const out = [];
for (const p of prices) {
  setInput(inputs[1], p);
  await sleep(1300);
  const t = norm(card.innerText);
  out.push({
    price: p,
    perUnit: (t.match(/Profit per unit: \$?(-?[\d,.]+)/) || [])[1] || null,
    perHour: (t.match(/Profit per hour: \$?(-?[\d,.]+)/) || [])[1] || null,
    time: (t.match(/in ([\dhms, ]+?) Profit/) || [])[1] || null,
  });
}
return { ok: true, name, qty, out };
