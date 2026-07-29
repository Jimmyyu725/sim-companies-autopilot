#!/usr/bin/env node
// autopilot/api.js — generic READ of any game API path for the brain ("read every page/book").
// Fetch-only via the injected in-page api() helper. The caller must hold .tick.lock: another
// process navigating the shared CDP target can otherwise destroy this read's execution context.
// Usage: flock -w 90 .tick.lock node autopilot/api.js '/api/v2/companies/me/income-statement/'
const path = require('path');
const cdp = require(path.join(__dirname, '..', 'shared', 'cdp.js'));
const { formatApiResponse } = require('./api-result.js');
const {
  PROSPECTOR_OVERVIEW_PATH,
  recordOwnerProspectorOverview,
} = require('./owner-directive.js');
let options;
try {
  const raw = process.argv[2] || '';
  options = raw.startsWith('{') ? JSON.parse(raw) : { path: raw };
} catch (error) {
  options = { path: '', parseError: String(error.message || error) };
}
const p = options.path;
if (!p || !p.startsWith('/api/')) { console.log(JSON.stringify({ ok: false, path: String(p || ''), status: null, fetchedAt: new Date().toISOString(), error: 'path must start with /api/', truncated: false })); process.exit(0); }
(async () => {
  await cdp.connect();
  const r = await cdp.evaluate(`const r = await api(${JSON.stringify(p)}); return { status: r.status, json: r.json };`);
  const fetchedAt = new Date().toISOString();
  const result = formatApiResponse({
    ok: r.status >= 200 && r.status < 300,
    path: p,
    status: r.status,
    fetchedAt,
    data: r.json,
    error: r.status >= 200 && r.status < 300 ? null : `API returned HTTP ${r.status}`,
  }, options);
  if (p === PROSPECTOR_OVERVIEW_PATH) {
    const ownerDirectiveEvidence = recordOwnerProspectorOverview(
      path.join(__dirname, 'OWNER-DIRECTIVE.json'),
      { path: p, status: r.status, fetchedAt, data: r.json },
      Date.now(),
    );
    if (ownerDirectiveEvidence) result.ownerDirectiveEvidence = ownerDirectiveEvidence;
  }
  console.log(JSON.stringify(result));
  cdp.close(); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ ok: false, path: p, status: null, fetchedAt: new Date().toISOString(), error: e.message, truncated: false })); try { cdp.close(); } catch (x) {} process.exit(0); });
