#!/usr/bin/env node
// Exchange price collector for the real-time tracker. Captures the FULL market ticker (~142
// products) and appends one compact time-series line. Run every minute via cron under
// `timeout 45 flock -w 30 .tick.lock` — LESSONS.md B2: timeout-bounded so a hung capture can NEVER
// hold the shared browser lock; if the lock is busy it simply skips this minute (a small data gap
// is fine). Direct fetch of the ticker 403s under Cloudflare, so we capture via CDP like board-data.js.
const fs = require('fs'), path = require('path');
const TRACKER = __dirname;
const SHARED = path.dirname(TRACKER);
const cdp = require(path.join(SHARED, 'cdp.js'));
const cfg = require(path.join(SHARED, 'config.json'));
const {
  appendJsonlBoundedAtomic,
  atomicWriteJson,
  normalizeNameMap,
  normalizePriceSnapshot,
  normalizeTickerRows,
} = require(path.join(TRACKER, 'data-quality.js'));
const DATA = path.join(TRACKER, 'data');
const FILE = path.join(DATA, 'prices.jsonl');
const NAMES = path.join(DATA, 'names.json');
const KEEP = 20000;   // ~14 days at 1/min; compacted so the file + per-request read stay bounded

(async () => {
  await cdp.connect();
  // Warm the page so the in-page fetch inherits the right origin + cookies — a COLD fetch of the
  // ticker 403s under Cloudflare (board-data.js uses the same grab()+api() pattern).
  await cdp.capture('https://www.simcompanies.com/b/' + cfg.storeId + '/', 10);
  const ticker = await cdp.evaluate(`
    const grab = async (p) => { for (let i=0;i<3;i++){ try { const r = await api(p); if (r.status===200) return r.json; } catch(e){} await sleep(1200); } return null; };
    return await grab('/api/v3/market-ticker/0/');
  `);
  let previousNames = {};
  try {
    const checked = normalizeNameMap(JSON.parse(fs.readFileSync(NAMES, 'utf8')));
    if (checked.ok) previousNames = checked.names;
  } catch (_) {}
  const checkedTicker = normalizeTickerRows(ticker, {
    expectedKinds: Object.keys(previousNames),
    minimumKinds: 100,
  });
  if (!checkedTicker.ok) {
    console.error(`invalid or partial ticker: ${checkedTicker.reason}`);
    process.exit(1);
  }
  fs.mkdirSync(DATA, { recursive: true });

  const t = Math.floor(Date.now() / 1000);
  const snapshot = {
    t,
    p: checkedTicker.prices,
    unpriced: checkedTicker.unpriced,
    catalogSize: checkedTicker.catalogSize,
  };
  // Both rewrites are rename-atomic for dashboard readers. Publish prices first: if the process
  // dies between the two files, old names still cover every previously known kind and the next
  // run repairs the harmless missing labels. The inverse order could temporarily invalidate all
  // old samples when a new catalog kind appears.
  appendJsonlBoundedAtomic(FILE, snapshot, {
    keep: KEEP,
    normalize: normalizePriceSnapshot,
    timestamp: row => row.t,
  });
  atomicWriteJson(NAMES, checkedTicker.names);

  console.log(`${new Date(t * 1000).toISOString()} captured ${checkedTicker.catalogSize} products` +
    (checkedTicker.unpriced.length ? ` (${checkedTicker.unpriced.length} sold out/unpriced)` : ''));
  cdp.close(); process.exit(0);   // LESSONS: open ws keeps node alive -> timeout kills us as a false failure
})().catch(e => { console.error('ERR', e.message); try { cdp.close(); } catch (x) {} process.exit(1); });
