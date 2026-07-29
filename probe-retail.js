// Probe the grocery-store retail UI: fill quantity + price for one resource card and
// read back whatever projection the page renders. Ground truth beats guessing at the
// selling-speed formula.
// Params come from window.__probe = { name, qty, price }.
const { name, qty, price } = window.__probe;

const cards = all('div').filter(d => {
  const t = norm(d.innerText).toUpperCase();
  return t.startsWith(name.toUpperCase()) && t.includes('QUANTITY') && t.includes('PRICE')
    && d.querySelectorAll('input').length >= 2;
});
// Smallest matching container = the card itself, not an ancestor wrapper.
const card = cards.sort((a, b) => a.innerText.length - b.innerText.length)[0];
if (!card) return { ok: false, reason: 'card not found for ' + name };

const inputs = all('input', card);
setInput(inputs[0], qty);
await sleep(300);
setInput(inputs[1], price);
await sleep(1500);

return {
  ok: true,
  text: norm(card.innerText),
  buttons: all('button', card).map(b => ({ t: norm(b.innerText), disabled: b.disabled })),
};
