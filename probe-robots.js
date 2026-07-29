#!/usr/bin/env node
// READ-ONLY probe of the INSTALL ROBOTS dialog on a production building page.
// Opens the dialog, reads cost / robots needed / quality / savings / specialization
// options, screenshots it, then closes WITHOUT confirming. It never clicks
// "BUY MISSING" (spends money) or the modal's install button (irreversible-ish:
// uninstall only refunds 50% of robots at Q0). Self-gating by construction:
// there is no arm flag at all — this script cannot commit anything.
//
// Usage: timeout 300 flock -w 240 /srv/appdata/chrome-automation/sim/.tick.lock \
//          node /srv/appdata/chrome-automation/sim/probe-robots.js [buildingId]
// Default buildingId: 55042846 (Mill). Farm fallback: 54959369.
const cdp = require('/srv/appdata/chrome-automation/sim/cdp.js');
const bid = process.argv[2] || '55042846';

(async () => {
  await cdp.connect();
  await cdp.goto(`https://www.simcompanies.com/b/${bid}/`);

  const res = await cdp.evaluate(`
    const out = { bid: ${JSON.stringify(bid)} };

    // 1) Read the building record via the game's own API (pure GET, no side effects).
    const b = await api('/api/v2/companies/me/buildings/${bid}/');
    if (b.json) {
      const keep = {};
      for (const k of Object.keys(b.json)) {
        if (/robot|size|kind|name|busy/i.test(k)) keep[k] = b.json[k];
      }
      out.buildingApi = keep;
    } else out.buildingApi = { status: b.status };

    // 2) Find the opener. It is a secondary button holding the robots icon + label.
    const opener = all('button').find(bt =>
      bt.offsetParent !== null &&
      /INSTALL ROBOTS/i.test(norm(bt.innerText)) &&
      !/UNINSTALL/i.test(norm(bt.innerText)));
    if (!opener) {
      return Object.assign(out, { ok: false, reason: 'no INSTALL ROBOTS button',
        buttons: all('button').map(x => norm(x.innerText)).filter(Boolean) });
    }
    out.openerHtml = opener.outerHTML.slice(0, 300);
    opener.click();          // state-only: sets robotsConfirmation, opens the modal
    await sleep(3500);

    // 3) Locate the dialog (header is "Install robots").
    const dlg = all('[role=dialog], [class*=odal], [class*=verlay]')
      .filter(m => /Install robots/i.test(m.innerText))
      .sort((a, c) => a.innerText.length - c.innerText.length)[0];
    if (!dlg) return Object.assign(out, { ok: false, reason: 'dialog did not open',
      body: norm(document.body.innerText).slice(0, 400) });

    const text = norm(dlg.innerText);
    out.dialogText = text.slice(0, 2500);
    out.buttons = all('button', dlg).map(x => ({
      t: norm(x.innerText), disabled: !!x.disabled,
      cls: (x.className || '').slice(0, 60) }));
    out.inputs = all('input, select', dlg).map(i => ({
      tag: i.tagName, type: i.type, name: i.name, value: i.value,
      checked: i.checked }));
    // Specialization choices render as clickable resource rows below "Select specialization".
    out.imgs = all('img', dlg).map(i => (i.src || '').split('/').pop()).slice(0, 40);
    out.parsed = {
      workforcePct: (text.match(/reduce workforce by (\\d+)%/i) || [])[1],
      wagesPct: (text.match(/Wages costs will be reduced by (\\d+)%/i) || [])[1],
      refundPct: (text.match(/giving you back (\\d+)% robots/i) || [])[1],
      downtime: (text.match(/downtime ([\\d:]+ ?h?)/i) || [])[1],
      finishes: (text.match(/finishes: ([^.]{4,40})/i) || [])[1],
      robotsLine: (text.match(/([\\d,]+ ?x ?Q\\d+[^.]{0,60})/i) || [])[1],
      dollars: (text.match(/\\$[\\d,.]+/g) || []).slice(0, 8),
    };

    // 4) Close WITHOUT confirming. Never touch BUY MISSING or the install button.
    const FORBIDDEN = /BUY MISSING|INSTALL ROBOTS/i;
    let closer = all('button', dlg).find(x => {
      const t = norm(x.innerText);
      return !FORBIDDEN.test(t) && /^(CANCEL|CLOSE|BACK|CHANGED MY MIND|I CHANGED MY MIND)/i.test(t);
    });
    if (!closer) {
      closer = all('button, [role=button], a', dlg).find(x =>
        /close/i.test(x.getAttribute && (x.getAttribute('aria-label') || '') + ' ' + (x.className || ''))
        && !FORBIDDEN.test(norm(x.innerText)));
    }
    if (closer) { out.closedVia = norm(closer.innerText) || closer.className.slice(0, 40); closer.click(); }
    else {
      out.closedVia = 'Escape';
      for (const type of ['keydown', 'keyup'])
        document.dispatchEvent(new KeyboardEvent(type,
          { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
    await sleep(2000);
    out.dialogGone = !all('[role=dialog], [class*=odal]')
      .some(m => m.offsetParent !== null && /Install robots/i.test(m.innerText));
    out.ok = true;
    return out;
  `);

  // Screenshot AFTER the eval so we record the end state; the dialog text is in res.
  try { await cdp.shot('/srv/appdata/chrome-automation/sim/shots/robots-probe.png'); } catch (e) {}

  // Belt and braces: if the dialog somehow survived, navigate away to drop the modal state.
  if (res && res.ok && res.dialogGone === false) {
    await cdp.goto('https://www.simcompanies.com/landscape/');
    res.forcedNavAway = true;
  }
  console.log(JSON.stringify(res, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); try { cdp.close(); } catch (_) {} process.exit(1); });
