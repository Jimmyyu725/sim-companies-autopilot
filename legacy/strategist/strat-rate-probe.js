// Calibrate the modelled production rate against a live order.
// The Mill's realised powder rate came in ~2x under its model; the Slaughterhouse's 48.5/h
// steak figure is modelled the same way, so measure the Mill's live order and derive the
// real multiplier before betting a second building on the model.
const r = await api('/api/v2/companies/me/buildings/');
const bs = (r.json || []);
return bs.map(b => ({
  id: b.id, name: b.name, level: b.level, kind: b.kind,
  category: b.category, freeAndLocked: b.freeAndLocked,
  busy: b.busy ? {
    kind: b.busy.kind, quantity: b.busy.quantity,
    placed: b.busy.datetime || b.busy.placed || null,
    completed: b.busy.completed,
    amountAvailableNow: b.busy.amountAvailableNow,
    profitAvailableNow: b.busy.profitAvailableNow,
    keys: Object.keys(b.busy),
  } : null,
}));
