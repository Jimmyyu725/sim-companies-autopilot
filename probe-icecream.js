// One-off board probe 2026-07-22: identify ice cream kinds + exchange books.
const t = await api('/api/v3/market-ticker/0/');
const all = t.json || [];
const seasonal = all.filter(e => e.kind >= 140 && e.kind <= 155);
const books = {};
for (const e of seasonal) {
  const r = await api(`/api/v3/market/0/${e.kind}/`);
  books[e.kind] = { raw: JSON.stringify(r.json).slice(0, 500) };
  await sleep(300);
}
return { tickerCount: all.length, seasonal, books };
