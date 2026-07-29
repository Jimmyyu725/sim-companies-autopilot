#!/usr/bin/env node
// Scout probe #3: does the ticker itself carry volume fields, and do any hour-data/graph
// endpoints exist? In-page fetch only — no lock; ends with close().
const path = require('path');
const SIM = '/srv/appdata/chrome-automation/sim';
const cdp = require(path.join(SIM, 'cdp.js'));

(async () => {
  await cdp.connect();
  const result = await cdp.evaluate(`
    const out = {};
    const t = await api('/api/v3/market-ticker/0/');
    out.tickerFields = Array.isArray(t.json) && t.json[0] ? Object.keys(t.json[0]) : t.status;
    out.tickerSample = Array.isArray(t.json) ? t.json.slice(0, 2) : null;
    for (const p of [
      '/api/v2/resources-hour-data/0/1/',
      '/api/v1/resources-hour-data/0/1/',
      '/api/v2/market-graph/0/1/',
      '/api/v3/market-graph/0/1/',
    ]) {
      try {
        const r = await api(p);
        out[p] = { status: r.status,
                   sample: r.json !== undefined
                     ? (Array.isArray(r.json) ? r.json.slice(0, 2) : r.json)
                     : (r.text || '').slice(0, 80) };
      } catch (e) { out[p] = { error: String(e).slice(0, 100) }; }
      await sleep(400);
    }
    return out;
  `);
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
