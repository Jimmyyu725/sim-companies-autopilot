#!/usr/bin/env node
// PROBE (dry-only, self-gating with NO send path at all): open the SEND CONTRACT dialog
// from the warehouse water tile, record its fields/buttons, then CLOSE it without sending.
// There is deliberately no confirm parameter — this script structurally cannot send:
// it never clicks any button whose label matches /send|confirm|create|submit|offer/i once
// the dialog is open; it only clicks (a) the water tile, (b) the "SEND CONTRACT" opener,
// (c) a close/cancel control (or presses Escape).
// Also records API URLs the dialog itself fetches (autocomplete etc.) via a no-nav watch.
// Usage: timeout 200 flock -w 150 .tick.lock node probe-contract-send-dialog.js
const cdp = require('./cdp.js');

(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');

  // Real-mouse click the water tile (React ignores synthetic clicks on tiles — sell-exchange-ui.js).
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
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 2600));

  // Start a no-nav network watch, then open the dialog inside the window.
  const watchP = cdp.watch(null, 16);
  await new Promise(r => setTimeout(r, 500));

  const res = await cdp.evaluate(`
    // The tile detail panel should now show action buttons. Record them first.
    const panelButtons = all('button').filter(b => b.offsetParent !== null).map(b => norm(b.innerText));
    const opener = all('button').find(b => b.offsetParent !== null && /send contract/i.test(norm(b.innerText)));
    if (!opener) return { ok: false, step: 'open', reason: 'no SEND CONTRACT button on water tile panel', panelButtons };
    opener.click();
    await sleep(3000);

    const vis = (sel) => all(sel).filter(e => e.offsetParent !== null);
    const fields = vis('input, textarea, select').map(i => ({
      tag: i.tagName, type: i.type || null, name: i.name || null,
      placeholder: i.placeholder || null, value: String(i.value).slice(0, 30),
      ariaLabel: i.getAttribute('aria-label'),
    }));
    const buttons = vis('button').map(b => ({
      text: norm(b.innerText).slice(0, 50), disabled: b.disabled,
      cls: (b.className || '').toString().slice(0, 80),
    }));
    // Dialog container text (modal usually appended near body end).
    const dlg = all('div[role=dialog], .modal, .ReactModal__Content').filter(d => d.offsetParent !== null)[0];
    const dlgText = dlg ? norm(dlg.innerText).slice(0, 900) : norm(document.body.innerText).slice(-900);

    // Type into the company field (if present) to trigger the autocomplete endpoint —
    // typing a query is read-only.
    const companyField = vis('input').find(i => /company|receiver|to whom|recipient|search/i
      .test((i.placeholder || '') + (i.name || '') + (i.getAttribute('aria-label') || '')));
    let autoNote = 'no company-ish field found';
    if (companyField) { setInput(companyField, 'a'); await sleep(2500); autoNote = 'typed "a" into ' + (companyField.placeholder || companyField.name || '?'); }

    // CLOSE WITHOUT SENDING. Only ever click an explicit close/cancel; else Escape.
    const closer = vis('button').find(b => /^(cancel|close|×|x)$/i.test(norm(b.innerText)))
      || vis('button[aria-label*="lose"], button.close')[0];
    let closed;
    if (closer) { closer.click(); closed = 'clicked ' + (norm(closer.innerText) || closer.getAttribute('aria-label') || 'close'); }
    else {
      document.activeElement && document.activeElement.blur();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      closed = 'dispatched Escape';
    }
    await sleep(1500);
    const stillOpen = !!all('div[role=dialog], .modal, .ReactModal__Content').filter(d => d.offsetParent !== null)[0];
    return { ok: true, panelButtons, fields, buttons, dlgText, autoNote, closed, stillOpen };
  `);

  const urls = await watchP;
  // If the modal survived the in-page close, press a real Escape key via CDP.
  if (res && res.stillOpen) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 1200));
    res.escapeRetry = await cdp.evaluate(`
      return { stillOpen: !!all('div[role=dialog], .modal, .ReactModal__Content').filter(d => d.offsetParent !== null)[0] };
    `);
  }

  console.log(JSON.stringify({
    res,
    dialogApiUrls: urls.filter(u => /simcompanies\.com\/api\//.test(u)),
  }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
