// Subscribe or unsubscribe one exact chatroom by clicking its rendered checkbox once.
// The postcondition requires the requested checkbox state and one new "Saved successfully" UI ack.
const request = window.__chatSubscriptionToggle || {};
const realmId = Number(request.realmId);
const dbLetter = String(request.dbLetter || '').normalize('NFKC').trim();
const roomName = String(request.name || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const subscribe = request.subscribe;
const attemptId = String(request.attemptId || '').trim();
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
let routeRealm = null;
try {
  const match = decodeURIComponent(location.pathname)
    .match(/^\/(?:[a-z]{2}\/)?account-settings\/chatrooms\/(\d+)\/?$/i);
  routeRealm = match ? Number(match[1]) : null;
} catch (_) {}
if (!Number.isSafeInteger(realmId) || realmId < 0 || routeRealm !== realmId) {
  return { ok: false, reason: 'exact chatroom-settings realm route is not verified' };
}
if (!dbLetter || !roomName || typeof subscribe !== 'boolean') {
  return { ok: false, reason: 'dbLetter, name, and boolean subscribe are required' };
}
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}

const matches = Array.from(document.querySelectorAll('input[type="checkbox"][name]'))
  .map(input => ({ input, label: input.closest('label') }))
  .filter(candidate => candidate.label && visible(candidate.label))
  .filter(candidate => candidate.input.name === dbLetter && equalFold(candidate.label.innerText, roomName));
if (matches.length !== 1) {
  return { ok: false, unsupported: true, reason: 'exact chatroom checkbox count != 1', count: matches.length };
}
const { input } = matches[0];
if (input.disabled) return { ok: false, unsupported: true, reason: 'chatroom checkbox is disabled' };
if (input.checked === subscribe) {
  return { ok: false, reason: subscribe ? 'already subscribed' : 'already unsubscribed' };
}
if (request.confirm !== true) {
  return { ok: true, dry: true, realmId, dbLetter, name: roomName, wouldSubscribe: subscribe };
}
const storageKey = `sim-chat-subscription-toggle:${attemptId}`;
let prior = null;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked' };
try { sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, realmId, dbLetter, subscribe })); }
catch (_) { return { ok: false, reason: 'replay guard could not be persisted; checkbox was not clicked' }; }

const successCount = () => Array.from(document.querySelectorAll('*')).filter(visible)
  .filter(element => compact(element.textContent) === 'Saved successfully')
  .filter(element => !Array.from(element.children).some(child => compact(child.textContent) === 'Saved successfully'))
  .length;
const beforeSuccess = successCount();
input.click();
let maximumSuccessDelta = 0;
let checkedStable = false;
for (let attempt = 0; attempt < 34; attempt += 1) {
  await sleep(180);
  maximumSuccessDelta = Math.max(maximumSuccessDelta, successCount() - beforeSuccess);
  checkedStable = input.isConnected && input.checked === subscribe;
  if (checkedStable && maximumSuccessDelta === 1) break;
}
const verified = checkedStable && maximumSuccessDelta === 1;
return verified
  ? { ok: true, verified: true, clickedOnce: true, realmId, dbLetter, subscribed: subscribe }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'checkbox clicked once but exact state plus one save acknowledgement were not proven',
      observedChecked: input.isConnected ? input.checked : null,
      successDelta: maximumSuccessDelta,
    };
