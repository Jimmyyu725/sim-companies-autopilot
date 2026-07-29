// Open one exact contact's settings modal through its rendered gear. This clicks at most once.
const request = window.__chatContactSettings || {};
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

const rows = Array.from(document.querySelectorAll(`#chat-contacts a.js-test-chat-contact-${targetCompanyId}`))
  .filter(visible)
  .filter(anchor => {
    const directDivs = Array.from(anchor.children).filter(child => child.tagName === 'DIV');
    return directDivs.length > 0 && equalFold(directDivs[0].textContent, targetCompany);
  });
if (rows.length !== 1) return { ok: false, reason: 'exact contact row count != 1', count: rows.length };
const gears = Array.from(rows[0].querySelectorAll('svg[data-icon="gear"]')).filter(visible);
if (gears.length !== 1) {
  return { ok: false, unsupported: true, reason: 'exact visible settings gear count != 1', count: gears.length };
}
const control = gears[0].closest('button, a, [role="button"]') || gears[0];
if (request.confirm !== true) {
  return { ok: true, dry: true, targetCompany, targetCompanyId, wouldOpen: 'contact-settings' };
}
const storageKey = `sim-chat-contact-settings:${attemptId}`;
let prior = null;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked' };
try {
  sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, targetCompany, targetCompanyId }));
} catch (_) {
  return { ok: false, reason: 'replay guard could not be persisted; settings was not clicked' };
}
control.click();
let modal = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await sleep(150);
  const headers = Array.from(document.querySelectorAll('#chat-portal *')).filter(visible)
    .filter(element => equalFold(element.textContent, `${targetCompany} Settings`));
  if (headers.length === 1) {
    let candidate = headers[0].parentElement;
    while (candidate && candidate.id !== 'chat-portal') {
      if (candidate.querySelector('svg[data-icon="pin"]')
          && candidate.querySelector('svg[data-icon="ban"]')
          && candidate.querySelector('svg[data-icon="flag"]')) {
        modal = candidate;
        break;
      }
      candidate = candidate.parentElement;
    }
  }
  if (modal) break;
}
return modal
  ? { ok: true, opened: true, targetCompany, targetCompanyId, clickedOnce: true }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'settings gear clicked once but exact target modal was not proven',
    };
