#!/usr/bin/env node
// READ-ONLY probe of the building-auction page and the warehouse "Put on display" flow.
// It never clicks a final confirm/submit button anywhere: the auction page is only READ
// (the danger button is never touched), and the display modal is opened, recorded, and
// dismissed via a cancel-looking button only (else we navigate away). Findings feed
// board/.probe-auction.md. One cdp session for the whole navigate+read sequence (LESSONS B5).
const cdp = require('./cdp.js');
const cfg = require('./config.json');

(async () => {
  await cdp.connect();
  const out = { api: {}, building: {}, auctionPage: {}, warehouse: {}, displayPage: {} };

  // --- 1. API reads (GETs only) ---
  out.api = await cdp.evaluate(`
    const r = {};
    r.companyAuctions = await api('/api/v2/companies/${cfg.companyId}/building-auctions/');
    await sleep(600);
    r.activeUnlocks = await api('/api/v2/building-auctions/active-unlocks/');
    await sleep(600);
    r.displayCase = await api('/api/v2/companies/me/display-case/');
    await sleep(600);
    const realm = await api('/api/v2/building-auctions/0/');
    r.realmAuctions = realm.json && realm.json.buildingAuctions
      ? { status: realm.status, count: realm.json.buildingAuctions.length,
          sample: realm.json.buildingAuctions[0] || null }
      : realm;
    return r;`);

  // --- 2. Building page: what is the SEND TO AUCTION control? ---
  await cdp.goto('https://www.simcompanies.com/b/' + cfg.farmId + '/');
  out.building = await cdp.evaluate(`
    const ctl = all('button, a').filter(e => /send to auction/i.test(norm(e.innerText)) && e.offsetParent !== null)
      .map(e => ({ tag: e.tagName, text: norm(e.innerText), href: e.getAttribute('href'), disabled: e.disabled === true }));
    return { url: location.href, sendToAuctionControls: ctl,
      topButtons: all('button, a').filter(e => e.offsetParent !== null)
        .map(e => norm(e.innerText)).filter(t => /^(RENAME|UPGRADE|DOWNGRADE|REPOSITION|SEND TO AUCTION|SCRAP|CANCEL)/i.test(t)).slice(0, 12) };`);

  // --- 3. Auction page for the farm: READ ONLY, no clicks at all ---
  await cdp.goto('https://www.simcompanies.com/landscape/buildings/' + cfg.farmId + '/auction');
  out.auctionPage = await cdp.evaluate(`
    const bullets = all('li').filter(e => e.offsetParent !== null).map(e => norm(e.innerText)).filter(t => t && t.length < 120);
    const btns = all('button').filter(b => b.offsetParent !== null)
      .map(b => ({ text: norm(b.innerText), disabled: b.disabled === true })).filter(b => b.text);
    const h1 = all('h1').map(e => norm(e.innerText)).filter(Boolean);
    return { url: location.href, h1, bullets: bullets.slice(0, 15), buttons: btns.slice(0, 15),
      text: norm(document.body.innerText).slice(0, 1800) };`);

  // --- 4. Warehouse: real-mouse click the apples tile, list action buttons ---
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');
  const box = await cdp.evaluate(`
    const img = all('img').find(i => /apples/i.test(i.src || ''));
    if (!img) return null;
    let el = img; for (let k = 0; k < 5 && el.parentElement; k++) { if (el.getBoundingClientRect().width > 40) break; el = el.parentElement; }
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (box) {
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 2600));
  }
  out.warehouse = await cdp.evaluate(`
    const btns = all('button, a').filter(b => b.offsetParent !== null)
      .map(b => ({ tag: b.tagName, text: norm(b.innerText), href: b.getAttribute && b.getAttribute('href'), disabled: b.disabled === true }))
      .filter(b => /display|exchange|contract/i.test(b.text));
    return { url: location.href, tileClicked: ${JSON.stringify(!!box)}, actionButtons: btns.slice(0, 10) };`);

  // --- 5. Open PUT ON DISPLAY (a route navigation per the bundle), record the modal,
  //        dismiss ONLY via a cancel-looking button; otherwise navigate away. ---
  const open = await cdp.evaluate(`
    const b = all('button, a').find(e => /put on display/i.test(norm(e.innerText)) && e.offsetParent !== null);
    if (!b) return { ok: false, reason: 'no PUT ON DISPLAY control visible' };
    b.click();
    await sleep(3000);
    return { ok: true };`);
  out.displayPage.open = open;
  if (open.ok) {
    out.displayPage.dump = await cdp.evaluate(`
      const inputs = all('input').filter(i => i.offsetParent !== null)
        .map(i => ({ type: i.type, name: i.name, checked: i.checked, value: String(i.value).slice(0, 20) }));
      const btns = all('button').filter(b => b.offsetParent !== null)
        .map(b => ({ text: norm(b.innerText), disabled: b.disabled === true })).filter(b => b.text);
      const h4 = all('h1,h2,h3,h4').map(e => norm(e.innerText)).filter(Boolean).slice(0, 6);
      return { url: location.href, headings: h4, inputs, buttons: btns.slice(0, 12),
        text: norm(document.body.innerText).slice(0, 1500) };`);
    // Dismiss without confirming: only a clearly-cancel button, else navigate away.
    out.displayPage.dismiss = await cdp.evaluate(`
      const cancel = all('button').find(b => b.offsetParent !== null && /^(cancel|no|close|changed my mind)/i.test(norm(b.innerText)));
      if (cancel) { cancel.click(); await sleep(1200); return { via: 'cancel-button', label: norm(cancel.innerText) }; }
      return { via: 'none-found' };`);
    if (out.displayPage.dismiss.via === 'none-found') {
      await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');
      out.displayPage.dismiss = { via: 'navigated-away' };
    }
  }

  console.log(JSON.stringify(out, null, 2));
  cdp.close(); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
