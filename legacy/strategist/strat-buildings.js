// Compact building levels — to detect which building the "200 sausages -> +1 level" PA deal upgrades.
const r = await api('/api/v2/companies/me/buildings/');
const arr = r.json || [];
return {
  count: arr.length,
  buildings: arr.map(b => ({ id: b.id, kind: b.kind, name: b.name, level: b.level })),
  _firstRaw: arr[0] || null,
};
