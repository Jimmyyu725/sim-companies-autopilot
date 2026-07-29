// Confirm one already-prepared, phase-bound report through the rendered warning UI.
// Reporting exposes a private conversation to moderators, so ambiguity always stops.
const request = window.__chatContactReport || {};
const targetCompany = String(request.targetCompany || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const targetCompanyId = Number(request.targetCompanyId);
const attemptId = String(request.attemptId || '').trim();
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
if (!targetCompany || !Number.isSafeInteger(targetCompanyId) || targetCompanyId <= 0) {
  return { ok: false, reason: 'targetCompany and targetCompanyId are required' };
}
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}
let phase = null;
try { phase = JSON.parse(sessionStorage.getItem(`sim-chat-contact-phase:${attemptId}`) || 'null'); } catch (_) {}
if (!phase || phase.kind !== 'report' || phase.targetCompanyId !== targetCompanyId || phase.targetCompany !== targetCompany) {
  return { ok: false, unsupported: true, reason: 'exact report phase binding is missing' };
}
const headers = Array.from(document.querySelectorAll('#chat-portal *')).filter(visible)
  .filter(element => equalFold(element.textContent, `${targetCompany} Settings`));
const reportButtons = Array.from(document.querySelectorAll('#chat-portal button')).filter(visible)
  .filter(button => compact(button.innerText) === 'Yes, report');
const warningVisible = compact(document.body.innerText).includes('You are about to report this conversation to moderators');
if (headers.length !== 1 || reportButtons.length !== 1 || !warningVisible) {
  return { ok: false, unsupported: true, reason: 'exact target report warning/button is not proven' };
}
if (request.confirm !== true) {
  return { ok: true, dry: true, targetCompany, targetCompanyId, wouldReport: true };
}
const storageKey = `sim-chat-contact-report-confirm:${attemptId}`;
let prior = null;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked report' };
try { sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, targetCompanyId })); }
catch (_) { return { ok: false, reason: 'replay guard could not be persisted; report was not clicked' }; }
reportButtons[0].click();

let verified = false;
for (let attempt = 0; attempt < 35; attempt += 1) {
  await sleep(180);
  verified = compact(document.body.innerText)
    .includes(`You have reported your conversation with ${targetCompany}.`);
  if (verified) break;
}
return verified
  ? { ok: true, verified: true, reported: true, clickedOnce: true, targetCompany, targetCompanyId }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'report clicked once but the exact success acknowledgement was not proven',
    };
