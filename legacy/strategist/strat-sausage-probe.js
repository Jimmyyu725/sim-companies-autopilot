// Reliable sausage (kind 8) exchange price + my stock, via API — the market page's body text
// includes the commodity sidebar (power/seeds/water ~$0.27), so a $-decimal scrape mis-sizes a buy.
const t = await api('/api/v3/market-ticker/0/');
const row = (t.json || []).find(x => x.kind === 8);
const res = await api('/api/v3/resources/5714348/');
const mine = (res.json || []).find(x => x.kind === 8) || { amount: 0 };
// Order-book asks (lowest first): what a BUY actually fills against. Try known market endpoints.
let ob = null;
for (const p of ['/api/v3/market/8/', '/api/v3/market/0/8/', '/api/v3/exchange/8/']) {
  try {
    const r = await api(p);
    if (r.status === 200 && r.json && (Array.isArray(r.json) ? r.json.length : Object.keys(r.json).length)) {
      ob = { path: p, sample: Array.isArray(r.json) ? r.json.slice(0, 5) : r.json };
      break;
    }
  } catch (e) { /* try next */ }
}
return { tickerKind8: row, myStock: mine.amount, orderBook: ob };
