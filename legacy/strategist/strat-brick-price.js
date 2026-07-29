// Price the live brick (kind 102) sell-book: what would 2,000 bricks actually cost to buy?
const r = await api('/api/v3/market/0/102/');
const orders = (r.json || []);
const top = orders.slice(0, 6).map(o => ({ price: o.price, quantity: o.quantity, quality: o.quality }));
let need = 2000, cost = 0, filled = 0;
for (const o of orders) { if (need <= 0) break; const take = Math.min(need, o.quantity); cost += take * o.price; filled += take; need -= take; }
return { status: r.status, bestAsk: top[0] ? top[0].price : null, top,
  buy2000: { filled, cost: +cost.toFixed(2), avg: filled ? +(cost / filled).toFixed(3) : null, shortBy: need } };
