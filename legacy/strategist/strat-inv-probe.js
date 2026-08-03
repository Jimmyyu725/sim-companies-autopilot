// Strategist inventory probe: read warehouse stock, label the lines we care about, and
// flag beans against the 19,030 drain-confirmation threshold (JOURNAL watch #1, 2026-07-24).
const NAME = { 2:'water', 5:'grapes', 3:'apples', 4:'oranges', 7:'steak', 8:'sausages',
  66:'seeds', 115:'cow', 118:'coffee-beans', 119:'coffee-powder', 133:'flour', 139:'fodder' };
const res = await api('/api/v3/resources/5714348/');
const inv = (res.json || []).map(r => ({
  kind: r.kind, name: NAME[r.kind] || ('kind' + r.kind), amount: r.amount,
  unitCost: r.amount ? +(Object.values(r.cost || {}).reduce((a, b) => a + b, 0) / r.amount).toFixed(3) : 0,
})).filter(r => r.amount > 0).sort((a, b) => a.kind - b.kind);
const beans = inv.find(r => r.kind === 118);
return {
  resStatus: res.status,
  beans: beans ? beans.amount : 0,
  beanDrainOk: beans ? beans.amount < 19030 : null,   // true = draining as expected
  inv,
};
