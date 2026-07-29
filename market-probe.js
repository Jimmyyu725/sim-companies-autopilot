// Snapshot the exchange: full ticker plus order-book depth for the kinds under
// consideration this run (grapes 5, power 1, coffee powder 119).
// Run via: node cdp.js js market-probe.js (inside the tick lock).
const ticker = await api('/api/v3/market-ticker/0/');
const book = {};
for (const kind of [5, 1, 119]) {
  const r = await api(`/api/v3/market/0/${kind}/`);
  // Each entry is a standing sell order: price ascending, quantity, quality.
  book[kind] = (r.json || []).slice(0, 8).map(o => ({
    price: o.price, quantity: o.quantity, quality: o.quality,
  }));
  await sleep(300);
}
return { tickerStatus: ticker.status, ticker: ticker.json, book };
