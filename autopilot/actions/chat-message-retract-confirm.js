// Confirm one exact, phase-bound public-message retraction through the native modal.
// The exact Retract button is clicked once; ambiguity is terminal for this attempt.
const request = window.__chatMessageRetractConfirm || {};
const room = String(request.room || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const sourceText = String(request.sourceText || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const attemptId = String(request.attemptId || '').trim();
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
if (!room || sourceText.length < 4) return { ok: false, reason: 'room and exact sourceText (>=4 chars) are required' };
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}
let phase = null;
try { phase = JSON.parse(sessionStorage.getItem(`sim-chat-message-retract-phase:${attemptId}`) || 'null'); } catch (_) {}
if (!phase || phase.room !== room || phase.sourceText !== sourceText) {
  return { ok: false, unsupported: true, reason: 'exact retract phase binding is missing' };
}
let path = '';
try { path = decodeURIComponent(location.pathname); } catch (_) {}
if (!path.includes(`chatroom_${room}`)) return { ok: false, reason: 'URL is not bound to the requested public room' };

const buttons = Array.from(document.querySelectorAll('button')).filter(visible)
  .filter(button => compact(button.innerText) === 'Retract');
if (buttons.length !== 1) {
  return { ok: false, unsupported: true, reason: 'exact Retract confirmation button count != 1', count: buttons.length };
}
const exactBodies = () => Array.from(document.querySelectorAll('div,span,p')).filter(visible)
  .filter(element => compact(element.innerText) === sourceText)
  .filter(element => !Array.from(element.querySelectorAll('div,span,p'))
    .some(child => child !== element && visible(child) && compact(child.innerText) === sourceText));
const hasRetractControl = body => {
  let root = body;
  for (let depth = 0; root && root !== document.body && depth < 8; depth += 1, root = root.parentElement) {
    if (root.querySelector('svg[data-icon="retract"]')) return true;
  }
  return false;
};
const beforeBodies = exactBodies().filter(hasRetractControl);
if (beforeBodies.length !== 1) {
  return { ok: false, unsupported: true, reason: 'exact unretracted own message count != 1', count: beforeBodies.length };
}
if (request.confirm !== true) {
  return { ok: true, dry: true, room, sourceText, wouldRetract: true };
}
const storageKey = `sim-chat-message-retract-confirm:${attemptId}`;
let prior = null;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked Retract' };
try { sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, room, sourceText })); }
catch (_) { return { ok: false, reason: 'replay guard could not be persisted; Retract was not clicked' }; }
buttons[0].click();

let verified = false;
for (let attempt = 0; attempt < 35; attempt += 1) {
  await sleep(180);
  const matching = exactBodies();
  const remainingControls = matching.filter(hasRetractControl);
  const confirmStillVisible = Array.from(document.querySelectorAll('button')).filter(visible)
    .some(button => compact(button.innerText) === 'Retract');
  verified = matching.length >= 1 && remainingControls.length === 0 && !confirmStillVisible;
  if (verified) break;
}
return verified
  ? { ok: true, verified: true, retracted: true, clickedOnce: true, room, sourceText }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'Retract clicked once but control removal/modal-close postcondition was not proven',
    };
