#!/usr/bin/env node
// PROBE v2 (dry-only, structurally cannot send): full SEND CONTRACT flow on the water tile.
// Discovered by probe v1: clicking SEND CONTRACT first asks to SELECT QUALITY ABOVE (a lot
// row), and only then shows the contract form. This probe: tile (real mouse) -> SEND CONTRACT
// -> click first quality lot row (selection, not a confirm) -> dump the form's fields and
// buttons -> type one char in the receiver field to catch the autocomplete endpoint ->
// Escape to close. It never clicks any button matching /send|confirm|create|submit|offer/i
// after the form is open — there is no send code path at all.
// Usage: timeout 240 flock -w 150 .tick.lock node probe-contract-send-dialog2.js
const cdp = require('./cdp.js');

async function mouseClick(box) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');

  // 1. Real-mouse click the water tile.
  const box = await cdp.evaluate(`
    const img = all('img').find(i => /\\/water\\.[0-9a-f]*\\.?png/.test(i.src || ''));
    if (!img) return null;
    let el = img;
    for (let k = 0; k < 5 && el.parentElement; k++) { if (el.getBoundingClientRect().width > 40) break; el = el.parentElement; }
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `);
  if (!box) { console.log(JSON.stringify({ ok: false, reason: 'water tile not found' })); cdp.close(); process.exit(1); }
  await mouseClick(box);
  await new Promise(r => setTimeout(r, 2600));

  // 2. Click SEND CONTRACT, then locate the quality lot rows.
  const lots = await cdp.evaluate(`
    const opener = all('button').find(b => b.offsetParent !== null && /send contract/i.test(norm(b.innerText)));
    if (!opener) return { ok: false, reason: 'no SEND CONTRACT button' };
    opener.click();
    await sleep(2000);
    // Quality lot rows: innermost visible elements showing "<qty> $<price>(..%)".
    const cands = all('div, tr, li').filter(e => {
      if (e.offsetParent === null) return false;
      const t = norm(e.innerText);
      return /^\\d[\\d,]*\\s+\\$[\\d.]+\\s*\\(\\d+\\.\\d+%\\)/.test(t) && t.length < 120;
    });
    const innermost = cands.filter(c => !cands.some(o => o !== c && c.contains(o)));
    if (!innermost.length) return { ok: false, reason: 'no quality lot rows found',
      panelText: norm(document.body.innerText).slice(0, 700) };
    return { ok: true, rows: innermost.map(e => {
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      return { text: norm(e.innerText).slice(0, 90), cls: (e.className || '').toString().slice(0, 80),
               x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }) };
  `);
  if (!lots.ok) { console.log(JSON.stringify({ ok: false, step: 'lots', lots })); cdp.close(); process.exit(1); }

  // 3. Real-mouse click the first quality lot (selecting which units to contract — not a confirm).
  const watchP = cdp.watch(null, 16);
  await new Promise(r => setTimeout(r, 500));
  await mouseClick(lots.rows[0]);
  await new Promise(r => setTimeout(r, 2600));

  // 4. Dump the contract form; poke the receiver field for the autocomplete endpoint; close.
  const form = await cdp.evaluate(`
    const vis = (sel) => all(sel).filter(e => e.offsetParent !== null);
    const fields = vis('input, textarea, select').map(i => ({
      tag: i.tagName, type: i.type || null, name: i.name || null,
      placeholder: i.placeholder || null, value: String(i.value).slice(0, 30),
      ariaLabel: i.getAttribute('aria-label'), max: i.max || null,
    }));
    const buttons = vis('button').map(b => ({
      text: norm(b.innerText).slice(0, 50), disabled: b.disabled,
      cls: (b.className || '').toString().slice(0, 80),
    }));
    const dlg = all('div[role=dialog], .modal, .ReactModal__Content').filter(d => d.offsetParent !== null)[0];
    const dlgText = dlg ? norm(dlg.innerText).slice(0, 1100) : norm(document.body.innerText).slice(0, 1100);

    const companyField = vis('input').find(i => /company|receiver|recipient|search|name/i
      .test((i.placeholder || '') + (i.name || '') + (i.getAttribute('aria-label') || '')));
    let autoNote = 'no company-ish field found';
    if (companyField) { setInput(companyField, 'wak'); await sleep(2800); autoNote = 'typed "wak" into ' + (companyField.placeholder || companyField.name || '?'); }
    const suggestions = all('li, [role=option], .dropdown-item').filter(e => e.offsetParent !== null)
      .map(e => norm(e.innerText).slice(0, 60)).filter(t => t).slice(0, 10);

    document.activeElement && document.activeElement.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(1200);
    return { fields, buttons, dlgText, autoNote, suggestions };
  `);

  const urls = await watchP;
  // Belt-and-braces: real Escape + navigate away so nothing armed is left on screen.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await new Promise(r => setTimeout(r, 800));
  await cdp.goto('https://www.simcompanies.com/headquarters/');

  console.log(JSON.stringify({
    lots: lots.rows.map(r => r.text),
    form,
    dialogApiUrls: urls.filter(u => /simcompanies\.com\/api\//.test(u)),
  }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
