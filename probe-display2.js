#!/usr/bin/env node
// READ-ONLY probe #2: warehouse "Put on display" flow. Lists tiles, real-mouse clicks one,
// records the action panel, follows PUT ON DISPLAY (a route nav per bundle-main.js), records
// the modal, dismisses via cancel only — never a confirm. One cdp session (LESSONS B5).
const cdp = require('./cdp.js');

(async () => {
  await cdp.connect();
  const out = {};
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');
  out.tiles = await cdp.evaluate(`
    const imgs = all('img').filter(i => i.offsetParent !== null).map(i => {
      const base = ((i.src || '').split('/').pop() || '').split('?')[0];
      return base;
    }).filter(b => b && !/logo|avatar|flag|sim-boost|display-case/i.test(b));
    return { url: location.href, count: imgs.length, names: [...new Set(imgs)].slice(0, 30) };`);

  const pick = (out.tiles.names || []).find(n => /apple|orange|grape|water|seed|power/i.test(n)) || (out.tiles.names || [])[0];
  out.picked = pick;
  if (!pick) { console.log(JSON.stringify(out)); cdp.close(); process.exit(0); }

  const box = await cdp.evaluate(`
    const img = all('img').find(i => (i.src || '').includes(${JSON.stringify(pick)}));
    if (!img) return null;
    let el = img; for (let k = 0; k < 5 && el.parentElement; k++) { if (el.getBoundingClientRect().width > 40) break; el = el.parentElement; }
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (box) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 2600));
  }
  out.panel = await cdp.evaluate(`
    const btns = all('button, a').filter(b => b.offsetParent !== null)
      .map(b => ({ tag: b.tagName, text: norm(b.innerText), href: b.getAttribute && b.getAttribute('href'), disabled: b.disabled === true }))
      .filter(b => b.text && /display|exchange|contract|sell/i.test(b.text));
    return { url: location.href, clicked: ${JSON.stringify(!!box)}, buttons: btns.slice(0, 12) };`);

  const open = await cdp.evaluate(`
    const b = all('button, a').find(e => /put on display/i.test(norm(e.innerText)) && e.offsetParent !== null);
    if (!b) return { ok: false, reason: 'no PUT ON DISPLAY control', tag: null };
    const info = { tag: b.tagName, href: b.getAttribute && b.getAttribute('href'), disabled: b.disabled === true };
    b.click();
    await sleep(3000);
    return { ok: true, info };`);
  out.open = open;
  if (open.ok) {
    out.modal = await cdp.evaluate(`
      const inputs = all('input').filter(i => i.offsetParent !== null)
        .map(i => ({ type: i.type, name: i.name, checked: i.checked, value: String(i.value).slice(0, 20) }));
      const btns = all('button').filter(b => b.offsetParent !== null)
        .map(b => ({ text: norm(b.innerText), disabled: b.disabled === true })).filter(b => b.text);
      return { url: location.href, inputs, buttons: btns.slice(0, 12),
        headings: all('h1,h2,h3,h4').map(e => norm(e.innerText)).filter(Boolean).slice(0, 6),
        text: norm(document.body.innerText).slice(0, 1400) };`);
    out.dismiss = await cdp.evaluate(`
      const cancel = all('button').find(b => b.offsetParent !== null && /^(cancel|no$|close|changed my mind)/i.test(norm(b.innerText)));
      if (cancel) { cancel.click(); await sleep(1200); return { via: 'cancel-button', label: norm(cancel.innerText) }; }
      return { via: 'none-found' };`);
    if (out.dismiss.via === 'none-found') {
      await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');
      out.dismiss = { via: 'navigated-away' };
    }
  }
  console.log(JSON.stringify(out, null, 2));
  cdp.close(); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
