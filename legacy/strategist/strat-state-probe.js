// Strategist state probe: capture the store page (same path tick.js uses) and extract
// building levels + free slots, the live resource stock for the coffee/fruit lines, and the
// store/mill order state. Operating profit is a closed-period lagging metric, so powder flow
// must be read directly from stock + the store's sales_order.
const cdp = require('./cdp.js');
const CFG = require('./config.json');

(async () => {
  await cdp.connect();
  const cap = await cdp.capture('https://www.simcompanies.com/b/' + CFG.storeId + '/', 15);
  const buildings = cap['/api/v2/companies/me/buildings/'] || [];
  const resources = cap['/api/v3/resources/' + CFG.companyId + '/'] || [];
  const auth = cap['/api/v3/companies/auth-data/'] || {};

  const bsummary = buildings.map(b => ({
    id: b.id, name: b.name, kind: b.kind, level: b.level,
    busy: b.busy ? { kind: b.busy.kind, resource: (b.busy.resource && (b.busy.resource.name || b.busy.resource.kind)),
                     amountAvailableNow: b.busy.amountAvailableNow, timeLeft: b.busy.timeLeft,
                     sales_order: b.busy.sales_order ? {
                       kind: b.busy.sales_order.kind,
                       price: b.busy.sales_order.price,
                       profitAvailableNow: b.busy.sales_order.profitAvailableNow,
                       canFetch: b.busy.sales_order.canFetch,
                       amountInStock: b.busy.sales_order.amountInStock } : undefined } : null,
  }));

  const res = resources
    .map(r => ({ kind: r.kind, name: r.resource && (r.resource.name || r.resource.reference), amount: Math.round((r.amount||0)*100)/100, quality: r.quality }))
    .filter(r => r.amount > 0)
    .sort((a,b) => a.kind - b.kind);

  console.log(JSON.stringify({
    money: auth.authCompany && auth.authCompany.money,
    level: auth.authCompany && auth.authCompany.level,
    buildingCount: buildings.length,
    buildings: bsummary,
    stock: res,
  }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
