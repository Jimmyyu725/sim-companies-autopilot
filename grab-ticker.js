// Page-context script — run via: flock -w 300 .tick.lock node cdp.js js grab-ticker.js > capture-<ts>.json
// (NOT `node grab-ticker.js` — `api` and top-level await only exist inside cdp's page wrapper.)
const t = await api("/api/v3/market-ticker/0/");
return { "/api/v3/market-ticker/0/": t.json };
