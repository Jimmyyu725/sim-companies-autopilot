// Read-only: open the Mill's UPGRADE dialog and read the L1->L2 exchange purchase cost,
// even while the building is busy (upgrade.js bails on "busy" before reading cost). Cancels
// without committing. Run on the Mill building page (/b/<millId>/).
const busy = document.body.innerText.includes('currently busy');
const opener = all('button').find(b => /^UPGRADE$/i.test(norm(b.innerText)));
if (!opener) return { ok: false, busy, reason: 'no UPGRADE button on page' };
opener.click();
await sleep(3500);
const dlg = all('[role=dialog], [class*=odal]')
  .filter(m => /Upgrade building/i.test(m.innerText))
  .sort((a, b) => a.innerText.length - b.innerText.length)[0];
if (!dlg) return { ok: false, busy, reason: 'upgrade dialog did not open (busy blocks it?)' };
const text = norm(dlg.innerText);
const num = (re) => Number((text.match(re) || [])[1]?.replace(/,/g, ''));
const out = {
  ok: true, busy,
  exchangeCost: num(/Exchange purchase cost \$([\d,]+)/),
  effect: (text.match(/(Sales|Production) increase by \d+%/) || [])[0] || null,
  downtime: (text.match(/downtime ([\d:]+ ?h?)/i) || [])[1] || null,
  snippet: text.slice(0, 320),
};
const cancel = all('button', dlg).find(b => /changed my mind|cancel|^back$/i.test(norm(b.innerText)));
if (cancel) cancel.click();
return out;
