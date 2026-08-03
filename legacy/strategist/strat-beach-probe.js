// Page-context probe for the Beach market (free seasonal building, id in window.__beach.id).
// Sweeps a few prices on each retail card and reads back the game's OWN projection
// (Rule 1: the printed profit-per-hour beats my arithmetic). Reads only — never clicks SELL.
// Run: flock -w 300 .tick.lock node cdp.js goto https://www.simcompanies.com/b/<id>/
//      flock -w 300 .tick.lock node cdp.js js strat-beach-probe.js
const PRICES = [80, 90, 100, 111, 120];
const QTY = 100;

const out = { pageHead: norm(document.body.innerText).slice(0, 1200), cards: [] };

const cards = all('div').filter(d => {
  const t = norm(d.innerText).toUpperCase();
  return t.includes('QUANTITY') && t.includes('PRICE') && d.querySelectorAll('input').length >= 2;
});
// Smallest matching container per card = the card itself, not an ancestor wrapper.
const uniq = [];
for (const c of cards.sort((a, b) => a.innerText.length - b.innerText.length)) {
  if (!uniq.some(u => u.contains(c) || c.contains(u))) uniq.push(c);
}

for (const card of uniq) {
  const label = norm(card.innerText).slice(0, 60);
  const inputs = all('input', card);
  const samples = [];
  for (const p of PRICES) {
    setInput(inputs[0], QTY);
    await sleep(250);
    setInput(inputs[1], p);
    await sleep(1400);
    samples.push({ price: p, text: norm(card.innerText) });
  }
  out.cards.push({
    label,
    samples,
    buttons: all('button', card).map(b => ({ t: norm(b.innerText), disabled: b.disabled })),
  });
}
out.cardCount = uniq.length;
return out;
