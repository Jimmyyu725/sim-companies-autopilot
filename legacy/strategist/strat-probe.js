// Strategist read-only probe — run via: flock -w 300 .tick.lock node cdp.js js strat-probe.js
// Gathers the live facts the strategist needs beyond `tick.js --dry`: open market orders
// (e.g. did a listed gift sale fill?) and exact inventory counts for the feedstock/output
// kinds. Building order state is NOT read here — /api/v2/companies/me/buildings/ returns empty
// via a bare api() call (it only populates when captured off a company page, the way
// tick.js's readState does), and `tick.js --dry` already prints every building's busy state
// authoritatively. Read-only: no mutations.
const companyId = 5714348;
const [auth, resources, orders] = await Promise.all([
  api("/api/v3/companies/auth-data/"),
  api("/api/v3/resources/" + companyId + "/"),
  api("/api/v2/market-order/"),
]);
// 2 water, 3/4/5 apples/oranges/grapes, 66 seeds, 98 quadcopter, 118 coffee beans,
// 119 coffee powder, 133 flour, 134 butter.
const want = [2, 3, 4, 5, 66, 98, 118, 119, 133, 134];
const stock = {};
for (const r of (resources.json || [])) if (want.includes(r.kind)) stock[r.kind] = r.amount;
const myOrders = (orders.json || []).map(o => ({
  kind: o.kind, quality: o.quality, amount: o.amount, price: o.price, kindName: o.kindName,
}));
const a = auth.json;
return {
  money: a.authCompany.money,
  level: a.levelInfo.level,
  xp: a.levelInfo.experience,
  xpNext: a.levelInfo.experienceToNextLevel,
  maxBuildings: a.levelInfo.maxBuildings,
  accel: a.levelInfo.acceleration,
  stock,
  openMarketOrders: myOrders,
};
