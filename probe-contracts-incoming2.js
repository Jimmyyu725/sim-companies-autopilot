#!/usr/bin/env node
// PROBE 2 (strictly read-only): empty-state text of the INCOMING tab panel + read-only GET
// mapping of contract-related API endpoints (no mutations, no row clicks).
// Usage: timeout 150 flock -w 120 .tick.lock node probe-contracts-incoming2.js
const cdp = require('./cdp.js');

(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/');

  const res = await cdp.evaluate(`
    // Click the INCOMING tab (view switch only).
    const tab = all('a, button, div, span, li')
      .filter(e => e.offsetParent !== null && /^INCOMING$/i.test(norm(e.innerText)))
      .sort((a, b) => norm(a.innerText).length - norm(b.innerText).length)[0];
    if (tab) { tab.scrollIntoView({ block: 'center' }); tab.click(); await sleep(3000); }

    // Panel text: everything after the tab strip.
    const full = norm(document.body.innerText);
    const idx = full.indexOf('INCOMING OUTGOING');
    const panel = idx >= 0 ? full.slice(idx, idx + 700) : full.slice(-700);

    // Read-only endpoint mapping (GET only, 4 requests, non-market so not the B8 bucket).
    const probes = {};
    for (const p of ['/api/v3/contracts-outgoing/0/me/',
                     '/api/v3/contracts/0/me/',
                     '/api/v2/contracts/',
                     '/api/v3/contracts-incoming/0/me/']) {
      const r = await api(p);
      probes[p] = { status: r.status,
        sample: r.json !== undefined ? JSON.stringify(r.json).slice(0, 300) : (r.text || '').slice(0, 120) };
      await sleep(400);
    }
    return { panel, probes };
  `);

  console.log(JSON.stringify(res, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
