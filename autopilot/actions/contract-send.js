#!/usr/bin/env node
// Send a direct contract from the warehouse (flow mapped in board/.probe-contracts.md §C).
// STANDALONE one-session cdp driver (NOT an evaluated fragment): the resource tile and the
// quality-lot row need REAL-MOUSE clicks (React ignores synthetic clicks — sell-exchange-ui.js
// lesson), which only Input.dispatchMouseEvent can do. Whole navigate→act chain stays inside
// THIS one process (LESSONS B5).
//
// Usage: node autopilot/actions/contract-send.js '{"name":"water","company":"...","qty":100,"price":0.35,
//                                      "lot":0,"confirm":false}'
// Self-gating: without confirm:true it selects the lot, fills the form, dumps everything the
// game shows and closes via Cancel — the final SEND CONTRACT (btn-primary) is NEVER clicked.
// Ambiguity trap (probe §C): opener and final confirm share the label "SEND CONTRACT" — the
// opener is excluded BY IDENTITY (stashed on window between evaluations) and the final must be
// the single remaining btn-primary match, else refuse.
const path = require('path');
const cdp = require(path.join(__dirname, '..', '..', 'shared', 'cdp.js'));
const p = JSON.parse(process.argv[2] || '{}');
const die = (obj) => { console.log(JSON.stringify(obj)); try { cdp.close(); } catch (e) {} process.exit(0); };

(async () => {
  const name = String(p.name || '').trim().toLowerCase().replace(/ /g, '-');
  const qty = Number(p.qty), price = Number(p.price), lot = Number(p.lot || 0);
  if (!name || !p.company || !Number.isSafeInteger(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0)
    return die({ ok: false, reason: 'need {name(imgname), company, integer qty>0, price>0}', got: p });

  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');

  // 1. Real-mouse click the resource tile (img filenames are content-hashed: water.8df7bb28.png).
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const box = await cdp.evaluate(`
    const img = all('img').find(i => new RegExp(${JSON.stringify('/' + esc + '\\.[0-9a-f]*\\.?png')}).test(i.src || ''));
    if (!img) return null;
    let el = img;
    for (let k = 0; k < 5 && el.parentElement; k++) { if (el.getBoundingClientRect().width > 40) break; el = el.parentElement; }
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (!box) return die({ ok: false, reason: 'warehouse tile not found for ' + name });
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 2600));

  // 2. Click the SEND CONTRACT opener (panel switch — safe), stash its identity, list lots.
  const lots = await cdp.evaluate(`
    const opener = all('button').find(b => b.offsetParent !== null && /^SEND CONTRACT$/i.test(norm(b.innerText)));
    if (!opener) return { ok: false, reason: 'no SEND CONTRACT opener on the tile panel',
      btns: all('button').filter(b => b.offsetParent !== null).map(b => norm(b.innerText)).slice(0, 12) };
    window.__cs_opener = opener;   // identity survives to later evaluations (no navigation between)
    opener.click();
    await sleep(2000);
    const cands = all('div, tr, li').filter(e => {
      if (e.offsetParent === null) return false;
      const t = norm(e.innerText);
      return /^\\d[\\d,]*\\s+\\$[\\d.]+\\s*\\(\\d+\\.\\d+%\\)/.test(t) && t.length < 120;
    });
    const innermost = cands.filter(c => !cands.some(o => o !== c && c.contains(o)));
    if (!innermost.length) return { ok: false, reason: 'no quality-lot rows (SELECT QUALITY ABOVE step missing?)',
      panel: norm(document.body.innerText).slice(0, 400) };
    return { ok: true, rows: innermost.map(e => {
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      return { text: norm(e.innerText).slice(0, 90), x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }) };`);
  if (!lots.ok) return die({ ok: false, step: 'lots', ...lots });
  if (!(lot >= 0 && lot < lots.rows.length))
    return die({ ok: false, reason: 'lot index out of range', lot, lots: lots.rows.map(r => r.text) });

  // 3. Real-mouse click the chosen lot row (a selection, not a confirm — probe §C step 3).
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: lots.rows[lot].x, y: lots.rows[lot].y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 2600));

  // 4. Fill the inline form; dry-dump or (confirm) submit. Opener excluded by identity.
  const res = await cdp.evaluate(`
    const ARM = ${p.confirm === true};
    const company = ${JSON.stringify(String(p.company))};
    const vis = (sel) => all(sel).filter(e => e.offsetParent !== null);
    const rec = vis('input[name=recipientLookup]')[0];
    const amt = vis('input[name=amount]')[0];
    const pri = vis('input[name=price]')[0];
    if (!rec || !amt || !pri) return { ok: false, reason: 'contract form fields not found',
      fields: vis('input').map(i => ({ name: i.name, ph: i.placeholder })) };
    const panelHead = norm(document.body.innerText).slice(0, 300);

    setInput(rec, company);
    await sleep(2800);   // autocomplete GET /api/v2/companies/list/0/<q>/ fires while typing
    const sugg = vis('li, [role=option], .dropdown-item')
      .map(e => ({ el: e, t: norm(e.innerText) })).filter(s => s.t && s.t.length < 60);
    const exact = sugg.filter(s => s.t.toLowerCase() === company.toLowerCase());
    if (exact.length !== 1) return { ok: false,
      reason: 'recipient autocomplete did not produce one exact company match; raw typed recipients are never submitted',
      exactMatches: exact.length, suggestions: sugg.map(s => s.t).slice(0, 8) };
    const picked = exact[0];
    picked.el.click();
    await sleep(1200);

    setInput(amt, ${qty});
    await sleep(300);
    setInput(pri, ${price});
    await sleep(1200);

    const finals = all('button').filter(b => b.offsetParent !== null && b !== window.__cs_opener &&
      /^SEND CONTRACT$/i.test(norm(b.innerText)));
    const primaries = finals.filter(b => /btn-primary/.test(b.className || ''));
    const final = primaries.length === 1 ? primaries[0] : (finals.length === 1 ? finals[0] : null);
    const entered = {
      recipient: String(rec.value || '').trim(),
      amount: Number(String(amt.value || '').replace(/,/g, '')),
      price: Number(String(pri.value || '').replace(/,/g, '')),
    };
    const valuesExact = entered.recipient.toLowerCase() === company.toLowerCase()
      && Number.isSafeInteger(entered.amount) && entered.amount === ${qty}
      && Number.isFinite(entered.price) && Math.abs(entered.price - ${price}) < 0.005;
    const dump = { panelHead, picked: picked.t,
      values: { recipient: rec.value, amount: amt.value, price: pri.value },
      entered, valuesExact,
      finalFound: !!final, finalDisabled: final ? final.disabled : null,
      buttons: all('button').filter(b => b.offsetParent !== null)
        .map(b => ({ t: norm(b.innerText), dis: b.disabled })).slice(0, 12) };

    const cancel = all('button, a').find(e => e.offsetParent !== null &&
      /link-button/.test(e.className || '') && /^cancel$/i.test(norm(e.innerText)));
    if (!final) { if (cancel) cancel.click(); return { ok: false, reason: 'final SEND CONTRACT not uniquely identified — refusing', dump }; }
    if (!valuesExact) { if (cancel) cancel.click(); return { ok: false,
      reason: 'contract form values do not exactly match the requested recipient, integer quantity, and price', dump }; }
    if (!ARM) { if (cancel) cancel.click(); await sleep(800);
      return { ok: true, dry: true, dump, note: 'form filled + closed via Cancel; pass confirm:true to send' }; }
    const finalDisabled = final.disabled
      || String(final.getAttribute('aria-disabled')).toLowerCase() === 'true'
      || /(^|\\s)disabled(\\s|$)/i.test(String(final.className || ''))
      || getComputedStyle(final).pointerEvents === 'none';
    if (finalDisabled) { if (cancel) cancel.click();
      return { ok: false, reason: 'final SEND CONTRACT is DISABLED (form did not validate — wrong recipient? qty > lot?)', dump }; }
    const outgoingBefore = await api('/api/v3/contracts-outgoing/me/');
    const beforeRows = Array.isArray(outgoingBefore.json) ? outgoingBefore.json
      : (Array.isArray(outgoingBefore.json?.outgoingContracts) ? outgoingBefore.json.outgoingContracts : null);
    if (outgoingBefore.status !== 200 || !beforeRows) { if (cancel) cancel.click(); return { ok: false,
      reason: 'could not capture authoritative outgoing contracts before submit; refusing confirmation',
      outgoingStatus: outgoingBefore.status, dump }; }
    const beforeIds = new Set(beforeRows.map(row => String(row?.id)));
    final.click();
    let newRows = [];
    let outgoingStatus = null;
    for (let attempt = 0; attempt < 5 && !newRows.length; attempt++) {
      await sleep(2200);
      const out = await api('/api/v3/contracts-outgoing/me/');
      outgoingStatus = out.status;
      const afterRows = Array.isArray(out.json) ? out.json
        : (Array.isArray(out.json?.outgoingContracts) ? out.json.outgoingContracts : null);
      if (out.status === 200 && afterRows) {
        newRows = afterRows.filter(row => !beforeIds.has(String(row?.id)));
      }
    }
    const verified = outgoingStatus === 200 && newRows.length === 1;
    return { ok: verified, sent: verified, verified, mutationAttempted: true,
      doNotRetry: !verified, dump, outgoingStatus,
      newContract: verified ? newRows[0] : null,
      reason: verified ? undefined
        : 'SEND CONTRACT was clicked but exactly one new outgoing contract was not authoritatively verified; do not retry blindly',
      after: norm(document.body.innerText).slice(0, 250) };`);

  // Belt and braces: leave the warehouse panel so no armed form lingers on the shared tab.
  await cdp.goto('https://www.simcompanies.com/headquarters/');
  console.log(JSON.stringify(res));
  cdp.close();
  process.exit(0);
})().catch(e => { console.log(JSON.stringify({ ok: false,
  reason: String(e.message || e).slice(0, 300) })); try { cdp.close(); } catch (x) {} process.exit(0); });
