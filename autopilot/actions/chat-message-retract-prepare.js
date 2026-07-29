// Open the native retract confirmation for one exact own public-room message.
// This preparation clicks one retract control and never confirms the persistent change.
const request = window.__chatMessageRetractPrepare || {};
const room = String(request.room || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const sourceText = String(request.sourceText || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const attemptId = String(request.attemptId || '').trim();
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
if (!room || sourceText.length < 4) return { ok: false, reason: 'room and exact sourceText (>=4 chars) are required' };
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}
let path = '';
try { path = decodeURIComponent(location.pathname); } catch (_) {}
if (!path.includes(`chatroom_${room}`)) return { ok: false, reason: 'URL is not bound to the requested public room' };

const roomHrefMatches = href => {
  try {
    const decoded = decodeURIComponent(new URL(href, location.origin).pathname).toLocaleLowerCase('en-US');
    const wanted = room.toLocaleLowerCase('en-US');
    return decoded.includes(`-chatroom_${wanted}`) || decoded.includes(`/chatroom_${wanted}`);
  } catch (_) { return false; }
};
const paneCandidates = [];
for (const area of Array.from(document.querySelectorAll('textarea[placeholder^="Type here"]')).filter(visible)) {
  let ancestor = area.parentElement;
  while (ancestor && ancestor !== document.body) {
    const areas = Array.from(ancestor.querySelectorAll('textarea[placeholder^="Type here"]')).filter(visible);
    const senders = Array.from(ancestor.querySelectorAll('button')).filter(button =>
      visible(button) && button.querySelector('svg[data-icon="paper-plane"]'));
    const header = Array.from(ancestor.querySelectorAll('*')).some(element =>
      visible(element) && equalFold(element.textContent, room));
    const roomLink = Array.from(ancestor.querySelectorAll('a[href]')).some(anchor => roomHrefMatches(anchor.href));
    const roomIcon = Array.from(ancestor.querySelectorAll('img[alt]')).some(image =>
      visible(image) && equalFold(image.alt, room));
    if (areas.length === 1 && senders.length === 1 && header && (roomLink || roomIcon)) {
      paneCandidates.push(ancestor);
      break;
    }
    ancestor = ancestor.parentElement;
  }
}
const panes = paneCandidates.filter((pane, index) => paneCandidates.indexOf(pane) === index);
if (panes.length !== 1) return { ok: false, reason: 'exact public pane count != 1', count: panes.length };
const pane = panes[0];

const exactBodies = Array.from(pane.querySelectorAll('div,span,p')).filter(visible)
  .filter(element => compact(element.innerText) === sourceText)
  .filter(element => !Array.from(element.querySelectorAll('div,span,p'))
    .some(child => child !== element && visible(child) && compact(child.innerText) === sourceText));
const candidates = [];
for (const body of exactBodies) {
  let root = body;
  for (let depth = 0; root && root !== pane && depth < 8; depth += 1, root = root.parentElement) {
    const icons = Array.from(root.querySelectorAll('svg[data-icon="retract"]'));
    if (icons.length === 1) {
      const control = icons[0].closest('button, a, [role="button"]') || icons[0];
      candidates.push({ root, control });
      break;
    }
  }
}
const unique = candidates.filter((candidate, index) =>
  candidates.findIndex(other => other.control === candidate.control) === index);
if (unique.length !== 1) {
  return { ok: false, unsupported: true, reason: 'exact own-message retract control count != 1', count: unique.length };
}
if (request.confirm !== true) {
  return { ok: true, dry: true, room, sourceText, wouldOpen: 'retract-confirmation' };
}
const storageKey = `sim-chat-message-retract-prepare:${attemptId}`;
let prior = null;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked retract control' };
try { sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, room, sourceText })); }
catch (_) { return { ok: false, reason: 'replay guard could not be persisted; retract was not clicked' }; }
unique[0].control.click();

let verified = false;
for (let attempt = 0; attempt < 25; attempt += 1) {
  await sleep(150);
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible)
    .filter(button => compact(button.innerText) === 'Retract');
  verified = buttons.length === 1;
  if (verified) break;
}
if (verified) {
  try {
    sessionStorage.setItem(`sim-chat-message-retract-phase:${attemptId}`, JSON.stringify({ room, sourceText }));
  } catch (_) {
    return { ok: false, ambiguous: true, doNotRetry: true, reason: 'confirmation opened but phase binding failed' };
  }
}
return verified
  ? { ok: true, verified: true, opened: true, clickedOnce: true, room, sourceText }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'retract control clicked once but exact confirmation button was not proven',
    };
