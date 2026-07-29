#!/usr/bin/env node
// Scout probe #2: is /api/v2/resources-transactions/0/<kind>/ GLOBAL or own-company?
// Kind 119 (coffee powder, we sold recently) and 102 (bricks, we bought recently) vs 1 (power,
// no recent own trades). Also try a limit param. In-page fetch only — no lock; ends with close().
const path = require('path');
const SIM = '/srv/appdata/chrome-automation/sim';
const cdp = require(path.join(SIM, 'cdp.js'));

(async () => {
  await cdp.connect();
  const result = await cdp.evaluate(`
    const out = {};
    for (const p of [
      '/api/v2/resources-transactions/0/119/',
      '/api/v2/resources-transactions/0/102/',
      '/api/v2/resources-transactions/0/1/?limit=50',
      '/api/v2/resources-transactions/0/1/?page=1',
    ]) {
      try {
        const r = await api(p);
        const rows = Array.isArray(r.json) ? r.json : null;
        out[p] = {
          status: r.status,
          n: rows ? rows.length : null,
          fields: rows && rows[0] ? Object.keys(rows[0]) : null,
          sample: rows ? rows.slice(0, 3) : (r.json !== undefined ? r.json : (r.text || '').slice(0, 150)),
        };
      } catch (e) { out[p] = { error: String(e).slice(0, 120) }; }
      await sleep(500);
    }
    return out;
  `);
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
