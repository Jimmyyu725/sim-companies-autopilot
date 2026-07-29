// Does the Grocery store run ONE sales order at a time, or one per level? The board has
// gated a $14k retail-capacity decision on this since 2026-07-22 and it was never measured.
// Read the store page: count sales-order slots (busy + empty) and the building level.
const b = await api('/api/v2/companies/me/buildings/');
const store = (b.json || []).find(x => x.kind === 'G') || null;
const t = norm(document.body.innerText);
return {
  url: location.href,
  storeApi: store ? { level: store.level, kind: store.kind,
                      busyKeys: store.busy ? Object.keys(store.busy) : null,
                      busyIsArray: Array.isArray(store.busy),
                      salesOrder: store.busy && store.busy.sales_order
                        ? { kind: store.busy.sales_order.kind, price: store.busy.sales_order.price,
                            amountInStock: store.busy.sales_order.amountInStock } : null } : null,
  allLevels: (b.json || []).map(x => ({ name: x.name, kind: x.kind, level: x.level })),
  pageTail: t.slice(-1200),
};
