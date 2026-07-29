// Probe the grocery-store retail UI: fill quantity + price for one resource card and
// read back whatever projection the page renders. Ground truth beats guessing at the
// selling-speed formula.
// Params come from window.__probe = { name, qty, price }.
const { name, qty, price } = window.__probe;

if (/currently busy/i.test(document.body.innerText)) {
  return { ok: false, reason: 'store still busy' };
}

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

const text = norm(card.innerText);
if (/Stock too low|BUY MISSING/i.test(text)) {
  return {
    ok: false,
    reason: 'retail quantity exceeds verified stock; no sale quote is actionable',
    text,
    entered: { qty: inputs[0].value, price: inputs[1].value },
  };
}

return {
  ok: true,
  text,
  entered: { qty: inputs[0].value, price: inputs[1].value },
  buttons: all('button', card).map(b => ({
    t: norm(b.innerText),
    disabled: b.disabled,
    ariaDisabled: String(b.getAttribute('aria-disabled')).toLowerCase() === 'true',
    classDisabled: /(^|\s)disabled(\s|$)/i.test(String(b.className || '')),
    pointerDisabled: getComputedStyle(b).pointerEvents === 'none',
  })),
};
