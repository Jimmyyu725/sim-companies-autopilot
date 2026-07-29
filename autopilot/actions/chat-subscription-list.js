// Read every rendered chatroom subscription checkbox from the account-settings UI.
// This action is read-only and never clicks, navigates, or calls a chat endpoint.
const request = window.__chatSubscriptionList || {};
const realmId = Number(request.realmId);
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
let routeRealm = null;
try {
  const match = decodeURIComponent(location.pathname)
    .match(/^\/(?:[a-z]{2}\/)?account-settings\/chatrooms\/(\d+)\/?$/i);
  routeRealm = match ? Number(match[1]) : null;
} catch (_) {}
if (!Number.isSafeInteger(realmId) || realmId < 0 || routeRealm !== realmId) {
  return { ok: false, reason: 'exact chatroom-settings realm route is not verified', routeRealm, realmId };
}

const rooms = [];
const seen = new Set();
for (const input of Array.from(document.querySelectorAll('input[type="checkbox"][name]'))) {
  const label = input.closest('label');
  if (!label || !visible(label)) continue;
  const dbLetter = compact(input.name);
  const name = compact(label.innerText);
  if (!dbLetter || !name || seen.has(dbLetter)) {
    return { ok: false, reason: 'chatroom checkbox lacks a unique dbLetter/name binding' };
  }
  seen.add(dbLetter);
  rooms.push({
    dbLetter,
    name,
    subscribed: input.checked === true,
    disabled: input.disabled === true,
  });
}
return rooms.length > 0
  ? { ok: true, realmId, rooms, source: 'rendered-ui' }
  : { ok: false, unsupported: true, reason: 'no visible chatroom subscription checkboxes were found' };
