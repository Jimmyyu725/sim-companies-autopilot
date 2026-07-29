#!/usr/bin/env node
// One-shot scout probe for the volume tracker design (see board/.vol-design.md).
// Pure in-page fetches via cdp.evaluate — does NOT navigate the shared tab, so no .tick.lock
// needed (LESSONS.md B2/B6 apply only to navigating reads). MUST end with cdp.close() +
// process.exit(0) or the open websocket keeps node alive and the caller sees a false timeout.
const path = require('path');
const SIM = '/srv/appdata/chrome-automation/sim';
const cdp = require(path.join(SIM, 'cdp.js'));

(async () => {
  await cdp.connect();

  // Body-style evaluate string: uses the injected api()/sleep() helpers, plain `return` at end.
  const result = await cdp.evaluate(`
    const out = { where: location.href, tx: {}, books: {} };
    // (a) transactions endpoint variants — global trade feed vs own-company vs 404?
    const txPaths = [
      '/api/v2/resources-transactions/',
      '/api/v2/resources-transactions/0/',
      '/api/v2/resources-transactions/1/',
      '/api/v2/resources-transactions/0/1/',
      '/api/v3/resources-transactions/',
      '/api/v3/resources-transactions/0/1/',
    ];
    for (const p of txPaths) {
      try {
        const r = await api(p);
        let sample = null, n = null;
        if (r.json !== undefined) {
          if (Array.isArray(r.json)) { n = r.json.length; sample = r.json.slice(0, 2); }
          else sample = r.json;
        } else sample = (r.text || '').slice(0, 200);
        out.tx[p] = { status: r.status, n, sample };
      } catch (e) { out.tx[p] = { error: String(e).slice(0, 120) }; }
      await sleep(400);
    }
    // (b) order-book field inspection for 3 kinds (power 1, bricks 102, grapes 5).
    for (const kind of [1, 102, 5]) {
      try {
        const r = await api('/api/v3/market/0/' + kind + '/');
        const rows = Array.isArray(r.json) ? r.json : [];
        out.books[kind] = {
          status: r.status,
          n: rows.length,
          fields: rows[0] ? Object.keys(rows[0]) : [],
          sample: rows.slice(0, 3),
        };
      } catch (e) { out.books[kind] = { error: String(e).slice(0, 120) }; }
      await sleep(400);
    }
    return out;
  `);

  console.log(JSON.stringify(result, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); cdp.close(); process.exit(1); });
