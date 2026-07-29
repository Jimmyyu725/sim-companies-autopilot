// One-off strategist probe 2026-07-22 19:07 CDT: warehouse stock snapshot.
// Run via: flock -w 300 .tick.lock node cdp.js js probe-inventory.js
const res = await api('/api/v3/resources/5714348/');
const inv = (res.json || []).map(r => ({
  kind: r.kind, amount: r.amount,
  unitCost: r.amount ? +(Object.values(r.cost || {}).reduce((a, b) => a + b, 0) / r.amount).toFixed(3) : 0,
})).filter(r => r.amount > 0);
return { resStatus: res.status, inv };
