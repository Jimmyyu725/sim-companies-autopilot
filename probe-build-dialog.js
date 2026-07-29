// Read-only probe of the Mill build dialog: open the catalogue from /landscape/,
// click the Mill row, sample the button set every 500 ms to time when the priced
// "BUY MISSING $..." label renders, then back out. Clicks nothing that commits.
const slot = all('a, div').find(e => /construction slot/i.test(norm(e.innerText)) &&
                                     norm(e.innerText).length < 40 && e.offsetParent !== null);
if (!slot) return { ok: false, reason: 'no free construction slot on the map' };
slot.click();
await sleep(4000);

const rowFor = (name) => all('div, li, a').filter(e => {
  const t = norm(e.innerText);
  return t.toUpperCase().startsWith(name.toUpperCase()) && /approximately \$/.test(t);
}).sort((a, b) => a.innerText.length - b.innerText.length)[0];

const row = rowFor('Mill');
if (!row) return { ok: false, reason: 'Mill row not found',
                   sample: norm(document.body.innerText).slice(0, 300) };
const quoted = (norm(row.innerText).match(/approximately \$([\d,]+)/) || [])[1];
row.click();

const samples = [];
for (let i = 0; i <= 24; i++) {
  const btns = all('button').map(b => ({ t: norm(b.innerText), d: !!b.disabled }))
    .filter(b => b.t);
  samples.push({ ms: i * 500, buttons: btns });
  await sleep(500);
}
const firstPriced = samples.find(s => s.buttons.some(b => /^BUY MISSING \$/i.test(b.t)));
const back = all('button').find(b => /changed my mind|cancel|^back$/i.test(norm(b.innerText)));
if (back) back.click();
await sleep(1500);
return {
  ok: true, quoted,
  pricedFirstSeenMs: firstPriced ? firstPriced.ms : null,
  firstSample: samples[0].buttons,
  lastSample: samples[samples.length - 1].buttons,
  backedOut: !!back
};
