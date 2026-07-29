// Assess a failed private-send row without clicking it.
// Params: window.__chatPrivateRetry = {
//   targetCompany, text, originalAttemptId, originalOutcome: 'PRE_CLICK_FAILURE'
// }.
// The rendered UI exposes no stable server message ID. Therefore a prior click (including an
// ambiguous click) can never be retried automatically. Only a proven pre-click failure may be
// submitted later as a brand-new chat-private-send attemptId.
const privateRetry = window.__chatPrivateRetry || {};
const compact = value => String(value == null ? '' : value).normalize('NFKC')
  .replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const targetCompany = compact(privateRetry.targetCompany);
const text = compact(privateRetry.text);
const originalAttemptId = String(privateRetry.originalAttemptId || '').trim();
const originalOutcome = String(privateRetry.originalOutcome || '').trim();
const visible = element => !!element && element.offsetParent !== null;
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');

if (!targetCompany || !text || !/^[A-Za-z0-9._:-]{8,100}$/u.test(originalAttemptId)) {
  return { ok: false, doNotRetry: true, reason: 'targetCompany, text, and originalAttemptId are required' };
}
const headers = all('.well-header').filter(visible).filter(header => equalFold(header.textContent, targetCompany));
if (headers.length !== 1) return { ok: false, doNotRetry: true, reason: 'exact private pane header count != 1' };
let route;
try {
  const decoded = decodeURIComponent(location.pathname);
  const match = decoded.match(/(?:^|\/)messages(?:\/([^/]+))?\/?$/i);
  route = match ? match[1] || '' : '';
} catch (_) { route = ''; }
if (!(route === targetCompany || route.startsWith(`${targetCompany}-chatroom_`))) {
  return { ok: false, doNotRetry: true, reason: 'private URL is not bound to the exact target company' };
}
let pane = headers[0].parentElement;
while (pane && pane !== document.body) {
  const areas = Array.from(pane.querySelectorAll('textarea[placeholder^="Type here"]')).filter(visible);
  const planes = Array.from(pane.querySelectorAll('button')).filter(button =>
    visible(button) && button.querySelector('svg[data-icon="paper-plane"]'));
  if (areas.length === 1 && planes.length === 1) break;
  pane = pane.parentElement;
}
if (!pane || pane === document.body) return { ok: false, doNotRetry: true, reason: 'target pane was not isolated' };

const failedRows = Array.from(pane.querySelectorAll('div')).filter(element => {
  if (!visible(element)) return false;
  const body = compact(element.innerText);
  if (!body.includes(text) || !/Failed\s*-\s*Retry\?/iu.test(body)) return false;
  return !Array.from(element.children).some(child => {
    const childBody = compact(child.innerText);
    return childBody.includes(text) && /Failed\s*-\s*Retry\?/iu.test(childBody);
  });
});
const storageKey = `sim-chat-private-send:${originalAttemptId}`;
let attempt = null;
try { attempt = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}

if (attempt && attempt.clicked === true) {
  return {
    ok: false,
    doNotRetry: true,
    ambiguous: attempt.landed !== true,
    alreadyDelivered: attempt.landed === true,
    reason: attempt.landed === true
      ? 'the original attempt already proved delivery'
      : 'the original attempt clicked; without a stable message ID, retry could duplicate it',
    failedRowVisible: failedRows.length === 1,
    messageId: null,
    idStatus: 'UNKNOWN',
  };
}
if (originalOutcome !== 'PRE_CLICK_FAILURE') {
  return {
    ok: false,
    doNotRetry: true,
    ambiguous: true,
    reason: 'only an explicitly recorded pre-click failure may create another attempt',
    failedRowVisible: failedRows.length === 1,
    messageId: null,
    idStatus: 'UNKNOWN',
  };
}
if (failedRows.length !== 0) {
  return {
    ok: false,
    doNotRetry: true,
    ambiguous: true,
    reason: 'a failed-send row proves a UI send existed; without a stable message ID it cannot be retried safely',
    failedRowVisible: true,
    messageId: null,
    idStatus: 'UNKNOWN',
  };
}
return {
  ok: true,
  retryClicked: false,
  safeToCreateNewAttempt: true,
  originalClickProvenAbsent: true,
  failedRowVisible: failedRows.length === 1,
  targetCompany,
  text,
  note: 'use a new chat-private-send attemptId; the game Retry control was intentionally not clicked',
};
