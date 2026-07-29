#!/usr/bin/env node
// PROBE 3 (strictly read-only): record which API URLs the app itself fetches when the
// INCOMING and OUTGOING tabs are clicked (view switches only — no row/confirm clicks).
// One cdp session: start a no-nav network watch, click tabs during the window.
// Usage: timeout 180 flock -w 150 .tick.lock node probe-contracts-tabs-watch.js
const cdp = require('./cdp.js');

(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/');

  // Start a 14s network watch WITHOUT navigation, then click tabs inside that window.
  const watchP = cdp.watch(null, 14);
  await new Promise(r => setTimeout(r, 1000));
  const clicks = await cdp.evaluate(`
    const clickTab = async (label) => {
      const t = all('a, button, div, span, li')
        .filter(e => e.offsetParent !== null && norm(e.innerText).toUpperCase() === label)
        .sort((a, b) => norm(a.innerText).length - norm(b.innerText).length)[0];
      if (!t) return 'missing:' + label;
      t.scrollIntoView({ block: 'center' }); t.click();
      await sleep(4000);
      return 'clicked:' + label;
    };
    const r1 = await clickTab('OUTGOING');
    const outgoingPanel = norm(document.body.innerText).slice(0, 500);
    const r2 = await clickTab('INCOMING');
    return { r1, r2, outgoingPanel };
  `);
  const urls = await watchP;

  console.log(JSON.stringify({
    clicks,
    apiUrls: urls.filter(u => /simcompanies\.com\/api\//.test(u)),
  }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
