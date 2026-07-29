// ⛔ BLOCKED / DO NOT USE — kept only as reference for the endpoint + payload + CSRF mechanism.
// Direct API POST is rejected with a 403 "Make sure your device has the correct system time set":
// the app signs mutating requests with bot-protection headers (X-Ts / X-Prot, computed by its own
// JS — see addBotProtection in bundle-main.js), which this cannot replicate. USE sell-exchange-ui.js
// (drives the warehouse UI, which the app signs itself — proven 2026-07-23, sold the gold watch).
//
// Post an exchange SELL order via the game's own market-order API — the exact call the UI makes:
//   POST /api/v2/market-order/  { resourceId, kind, quality, quantity, price }
// (payload shape read from bundle-main.js; the no-contractTo variant whose response carries
// `sellOrder`). Server-validated and CSRF-authed; a resting order is cancellable via
// DELETE /api/v2/market-order/{id}/. This automates a sanctioned action (DOCTRINE §2 explicitly
// permits "Sell surplus on the exchange") — it is NOT client-side tampering.
//
// Replaces the old sell-exchange.js, whose warehouse card-click never opened a dialog (the UI
// label differs from the image name, e.g. kind 70 shows as "gold watch", not "gold-watch").
// Params: window.__sellOrder = { resourceId, kind, quality, quantity, price }.
// Returns the created order (verify the id + that it is your company's) or the error body.
const o = window.__sellOrder;
if (!o || o.resourceId == null || o.kind == null || o.price == null || !o.quantity)
  return { ok: false, reason: 'missing __sellOrder fields', got: o };
// The CSRF cookie is HttpOnly (not JS-readable); the app fetches the token from /api/csrf/
// (body key `csrfToken`) and sends it as X-CSRFToken. Replicate that.
const cj = await api('/api/csrf/');
const csrf = cj.json && cj.json.csrfToken;
if (!csrf) return { ok: false, reason: 'could not obtain csrfToken', csrfStatus: cj.status };
const r = await fetch('/api/v2/market-order/', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf,
             'X-Requested-With': 'XMLHttpRequest' },
  body: JSON.stringify({ resourceId: o.resourceId, kind: o.kind, quality: o.quality,
                         quantity: o.quantity, price: o.price }),
});
const raw = await r.text();
let body; try { body = JSON.parse(raw); } catch (e) { body = raw.slice(0, 400); }
return { ok: r.status >= 200 && r.status < 300, status: r.status,
         result: (body && (body.sellOrder || body.contract)) || body, sent: o };
