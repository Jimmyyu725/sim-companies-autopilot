#!/usr/bin/env node
// Post an exchange sell order for a warehouse item.
// Usage: node sell-exchange.js <ITEM NAME> <qty> <price>
// Flow: open /headquarters/warehouse/, real-mouse-click the item card (React ignores
// synthetic el.click() here), then fill the sell dialog and submit.
const cdp = require('./cdp.js');

const [name, qty, price] = process.argv.slice(2);
if (!name || !qty || !price) { console.error('usage: sell-exchange.js <name> <qty> <price>'); process.exit(2); }

(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');

  const box = await cdp.evaluate(`
    const card = all('div').filter(d =>
      norm(d.innerText).toUpperCase().startsWith(${JSON.stringify(name.toUpperCase())}) &&
      d.offsetParent !== null && norm(d.innerText).length < 60);
    card.sort((a,b) => a.innerText.length - b.innerText.length);
    if (!card.length) return null;
    const el = card[0];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `);
  if (!box) { console.log(JSON.stringify({ ok: false, reason: 'card not found' })); process.exit(1); }

  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent',
      { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await new Promise(r => setTimeout(r, 2500));

  const dialog = await cdp.evaluate(`
    const btns = all('button').filter(b => b.offsetParent !== null).map(b => norm(b.innerText)).filter(Boolean);
    const inputs = all('input').filter(i => i.offsetParent !== null)
      .map(i => ({ type: i.type, value: i.value, placeholder: i.placeholder }));
    const modal = all('div[class*=modal], div[role=dialog], div[class*=popup], div[class*=overlay]')
      .filter(d => d.offsetParent !== null).map(d => norm(d.innerText).slice(0, 400));
    return { btns, inputs, modal, text: norm(document.body.innerText).slice(0, 900) };
  `);
  console.log(JSON.stringify({ clickedAt: box, dialog }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
