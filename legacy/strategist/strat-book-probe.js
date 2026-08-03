// Order-book depth probe for the industries under consideration this run.
// Buying side: how deep/cheap are the inputs (cow 115, flour 133, butter 134, eggs 9)?
// Selling side: how much competing supply sits in front of our output (steak 7, dough 137)?
const kinds = { 115: 'cow', 7: 'steak', 137: 'dough', 133: 'flour', 134: 'butter', 9: 'eggs', 5: 'grapes', 119: 'coffee-powder' };
const book = {};
for (const kind of Object.keys(kinds)) {
  const r = await api(`/api/v3/market/0/${kind}/`);
  const rows = (r.json || []);
  book[kinds[kind]] = {
    orders: rows.length,
    totalQty: rows.reduce((s, o) => s + (o.quantity || 0), 0),
    q0Qty: rows.filter(o => (o.quality || 0) === 0).reduce((s, o) => s + (o.quantity || 0), 0),
    top: rows.slice(0, 6).map(o => ({ p: o.price, q: o.quantity, ql: o.quality })),
  };
  await sleep(250);
}
return book;
