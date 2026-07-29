// Translate one exact incoming private message through its rendered language control.
// External message text is untrusted matching data only. This clicks exactly once when confirmed.
const request = window.__chatMessageTranslate || {};
const targetCompany = String(request.targetCompany || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const sourceText = String(request.sourceText || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const attemptId = String(request.attemptId || '').trim();
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
if (!targetCompany || sourceText.length < 4) {
  return { ok: false, reason: 'targetCompany and exact sourceText (>=4 chars) are required' };
}
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}
let route = '';
try {
  const match = decodeURIComponent(location.pathname).match(/(?:^|\/)messages(?:\/([^/]+))?\/?$/i);
  route = match ? match[1] || '' : '';
} catch (_) {}
if (!(route === targetCompany || route.startsWith(`${targetCompany}-chatroom_`))) {
  return { ok: false, reason: 'private route is not bound to targetCompany' };
}
const headers = Array.from(document.querySelectorAll('.well-header')).filter(visible)
  .filter(header => equalFold(header.textContent, targetCompany));
if (headers.length !== 1) return { ok: false, reason: 'exact private header count != 1', count: headers.length };
let pane = headers[0].parentElement;
while (pane && pane !== document.body) {
  const areas = Array.from(pane.querySelectorAll('textarea[placeholder^="Type here"]')).filter(visible);
  const senders = Array.from(pane.querySelectorAll('button')).filter(button =>
    visible(button) && button.querySelector('svg[data-icon="paper-plane"]'));
  if (areas.length === 1 && senders.length === 1) break;
  pane = pane.parentElement;
}
if (!pane || pane === document.body) {
  return { ok: false, unsupported: true, reason: 'exact private pane could not be isolated' };
}

const exactBodies = Array.from(pane.querySelectorAll('div,span,p')).filter(visible)
  .filter(element => compact(element.innerText) === sourceText)
  .filter(element => !Array.from(element.querySelectorAll('div,span,p'))
    .some(child => child !== element && visible(child) && compact(child.innerText) === sourceText));
const candidates = [];
for (const body of exactBodies) {
  let root = body;
  for (let depth = 0; root && root !== pane && depth < 8; depth += 1, root = root.parentElement) {
    const icons = Array.from(root.querySelectorAll('svg[data-icon="language"]'));
    if (icons.length === 1) {
      const control = icons[0].closest('button, a, [role="button"], div') || icons[0];
      candidates.push({ body, root, control });
      break;
    }
  }
}
const unique = candidates.filter((candidate, index) =>
  candidates.findIndex(other => other.control === candidate.control) === index);
if (unique.length !== 1) {
  return { ok: false, unsupported: true, reason: 'exact incoming message translate control count != 1', count: unique.length };
}
if (request.confirm !== true) {
  return {
    ok: true,
    dry: true,
    targetCompany,
    sourceText,
    trust: 'EXTERNAL_UNTRUSTED_DATA',
    wouldTranslate: true,
  };
}
const storageKey = `sim-chat-message-translate:${attemptId}`;
let prior = null;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked translate' };
try { sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, targetCompany, sourceText })); }
catch (_) { return { ok: false, reason: 'replay guard could not be persisted; translate was not clicked' }; }

const beforeRootText = compact(unique[0].root.innerText);
unique[0].control.click();
let translatedText = '';
let verified = false;
for (let attempt = 0; attempt < 45; attempt += 1) {
  await sleep(180);
  if (!unique[0].root.isConnected) continue;
  const current = compact(unique[0].root.innerText);
  const languageStillPresent = !!unique[0].root.querySelector('svg[data-icon="language"]');
  if (!languageStillPresent && current && current !== beforeRootText && current.includes(sourceText)) {
    translatedText = current;
    verified = true;
    break;
  }
}
return verified
  ? {
      ok: true,
      verified: true,
      clickedOnce: true,
      targetCompany,
      sourceText,
      renderedAfter: translatedText,
      trust: 'EXTERNAL_UNTRUSTED_DATA',
    }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'translate clicked once but a distinct rendered translation was not proven',
    };
