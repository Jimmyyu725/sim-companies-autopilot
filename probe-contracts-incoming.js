#!/usr/bin/env node
// PROBE (strictly read-only): incoming contracts.
// (1) Reads /api/v3/contracts-incoming/0/me/ via in-page api() (GETs work; only mutations
//     need the X-Ts/X-Prot signing — see sell-exchange-ui.js header).
// (2) Opens https://www.simcompanies.com/headquarters/ and clicks ONLY the INCOMING *tab*
//     (a view switch, not a confirm), then dumps each contract row's DOM: buttons, their
//     labels/classes, svg icon hints. NEVER clicks accept/decline — there is no code path
//     here that clicks anything inside a row.
// Usage: timeout 150 flock -w 120 .tick.lock node probe-contracts-incoming.js
const cdp = require('./cdp.js');

(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/');

  const apiRead = await cdp.evaluate(`
    const r = await api('/api/v3/contracts-incoming/0/me/');
    return { status: r.status, body: r.json !== undefined ? r.json : (r.text || '').slice(0, 800) };
  `);

  const ui = await cdp.evaluate(`
    // Locate the INCOMING tab. It is a view switch (safe to click), never a per-row action.
    const cands = all('a, button, div, span, li')
      .filter(e => e.offsetParent !== null)
      .filter(e => { const t = norm(e.innerText); return /^INCOMING(\\s*\\(?\\d*\\)?)?$/i.test(t) && t.length <= 20; })
      .sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
    if (!cands.length) {
      return { ok: false, reason: 'no INCOMING tab found',
               tabsSeen: all('a, button').filter(e => e.offsetParent !== null)
                 .map(e => norm(e.innerText)).filter(t => t && t.length < 25).slice(0, 40) };
    }
    const tab = cands[0];
    tab.scrollIntoView({ block: 'center' });
    tab.click();
    await sleep(3500);

    // Dump the contract list DOM WITHOUT touching any row control.
    const bodyTxt = norm(document.body.innerText);
    // Find candidate row containers: elements that contain both a company-ish link and buttons.
    const rows = all('div, li, tr').filter(el => {
      if (el.offsetParent === null) return false;
      const btns = el.querySelectorAll('button');
      if (btns.length < 1 || btns.length > 6) return false;
      const t = norm(el.innerText);
      return t.length > 10 && t.length < 400 && el.querySelectorAll('a[href*="/company/"], a[href*="/b/"]').length >= 0;
    });
    // Keep only the innermost such containers that actually hold buttons.
    const innermost = rows.filter(r => !rows.some(o => o !== r && r.contains(o) && o.querySelectorAll('button').length > 0));
    const describe = (el) => ({
      tag: el.tagName, cls: (el.className || '').toString().slice(0, 120),
      text: norm(el.innerText).slice(0, 220),
      links: all('a', el).map(a => a.getAttribute('href')).filter(Boolean).slice(0, 4),
      buttons: all('button', el).map(b => ({
        text: norm(b.innerText).slice(0, 40),
        title: b.title || b.getAttribute('aria-label') || null,
        cls: (b.className || '').toString().slice(0, 100),
        disabled: b.disabled,
        svgPaths: all('svg', b).length,
        svgHint: (all('svg', b)[0] ? (all('svg', b)[0].getAttribute('data-icon') || all('svg', b)[0].getAttribute('class') || '').toString().slice(0, 60) : null),
      })),
    });
    return {
      ok: true, url: location.href,
      tabClicked: norm(tab.innerText),
      pageTextTail: bodyTxt.slice(0, 900),
      rowCount: innermost.length,
      rows: innermost.slice(0, 8).map(describe),
    };
  `);

  console.log(JSON.stringify({ apiRead, ui }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
