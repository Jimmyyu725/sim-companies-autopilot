// One-shot: switch the recipes exchange page to the sell panel, fill 20 @ undercut,
// submit, and report the resulting book state. Run via:
//   flock .tick.lock sh -c 'node cdp.js goto .../market/resource/145/ && node cdp.js js sell-recipes-once.js'
// so navigation and this script share one lock hold (the 2-min tick steals the tab otherwise).
const buyBtn = all('button').find(b => norm(b.innerText) === 'BUY' && b.offsetParent !== null);
if (!buyBtn) return { ok: false, step: 'buy-panel', reason: 'BUY not found' };
const toggle = all('button', buyBtn.parentElement.parentElement).find(b => norm(b.innerText) !== 'BUY');
if (!toggle) return { ok: false, step: 'toggle', reason: 'toggle not found' };
toggle.click();
await sleep(2000);

const allBtn = all('button').find(b => norm(b.innerText) === 'ALL' && b.offsetParent !== null);
const underBtn = all('button').find(b => norm(b.innerText) === 'UNDERCUT' && b.offsetParent !== null);
if (!allBtn || !underBtn) return { ok: false, step: 'fill', reason: 'ALL/UNDERCUT missing' };
allBtn.click(); await sleep(600);
underBtn.click(); await sleep(600);
const vals = all('input').filter(i => i.offsetParent !== null && i.type === 'number').map(i => i.value);

const sellBtn = all('button').find(b => norm(b.innerText) === 'SELL ON THE EXCHANGE' && b.offsetParent !== null);
if (!sellBtn) return { ok: false, step: 'submit', reason: 'sell button missing', vals };
if (sellBtn.disabled) return { ok: false, step: 'submit', reason: 'sell button disabled', vals };
sellBtn.click();
await sleep(4000);

const t = norm(document.body.innerText);
const book = await api('/api/v3/market/0/145/');
const top = (book.json || []).slice(0, 3).map(o => ({ price: o.price, quantity: o.quantity }));
return { ok: true, vals, pageAfter: t.slice(0, 700), bookTop: top };
