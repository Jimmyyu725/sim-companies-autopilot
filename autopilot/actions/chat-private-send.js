// Send one short private message through the target pane's visible composer.
// Params: window.__chatPrivateSend = { targetCompany, targetCompanyId, text, attemptId, confirm }.
// One attemptId may click at most once. An uncertain click is never retried automatically.
// The postcondition is UI-only: a unique added own-message node, a cleared composer, and the
// unchanged exact destination. The current UI exposes no stable server message ID, so none is made up.
const privateSend = window.__chatPrivateSend || {};
const targetCompany = String(privateSend.targetCompany || '').normalize('NFKC').trim();
const targetCompanyId = Number(privateSend.targetCompanyId);
const idRequested = Number.isSafeInteger(targetCompanyId) && targetCompanyId > 0;
const attemptId = String(privateSend.attemptId || '').trim();
const compact = value => String(value == null ? '' : value).normalize('NFKC')
  .replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const text = compact(privateSend.text);
const visible = element => !!element && element.offsetParent !== null;
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
const forbidden = [
  /\b(?:a\.?i\.?|artificial intelligence|large language model|language model|llm|gpt(?:-?\d+(?:\.\d+)*)?|chatgpt|openai)\b/iu,
  /\b(?:(?:this )?account is automated|bot|chatbot|assistant|virtual assistant|virtual agent|automation|automated agent|automated account)\b/iu,
  /\b(?:(?:i am|i'm|this is|this account is|speaking as|as)\s+(?:an?\s+)?(?:robot|scripted)|(?:robot|scripted)\s+(?:account|team|operator))\b/iu,
  /\b(?:person in charge|pass (?:it|this) on|forward (?:it|this)|ask (?:the )?(?:owner|boss|manager))\b/iu,
  /\b(?:my name is|my name's|i am called|i'm called)\b/iu,
  /\b(?:Jimmy(?: Yu)?|Jay)\s+(?:here|speaking)\b|于京田(?:在此|发言)/iu,
  /^(?:I am|I'm|This is)\s+(?!(?:Able|Available|Building|Buying|Checking|Closed|Confirming|Interested|Looking|Offering|Open|Producing|Ready|Seeking|Selling|Upgrading|Waiting)\b)[A-Z][\p{L}'-]{1,39}(?:\s+[A-Z][\p{L}'-]{1,39}){0,2}(?=\s*(?:[,;:—.!?]|$))/u,
  /人工智能|聊天机器人|语言模型|大模型|智能助手|虚拟助手|助手|自动化账号|自动回复|负责人|转达|转交|请示老板|老板不在/u,
  /(?:我是|本账号是|作为)(?:一个)?(?:机器人|自动化|脚本)/u,
  /我叫|我的名字(?:是|叫)/u,
  /^我是\s*(?!(?:需要|购买|出售|买|卖|供应|生产|寻找|准备|可以|负责|经营|老板|买家|卖家|供应商|采购方|出售方))[\p{Script=Han}]{2,4}[。.!！?]?$/u,
];

if (!targetCompany || !text || !attemptId) {
  return { ok: false, reason: 'targetCompany, text, and attemptId are required' };
}
if (privateSend.confirm === true && !idRequested) {
  return { ok: false, reason: 'confirmed private send requires a stable targetCompanyId' };
}
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}
if (text.length > 180 || text.split('\n').length > 3) {
  return { ok: false, reason: 'private messages must be short (<=180 characters and <=3 lines)' };
}
if (forbidden.some(pattern => pattern.test(text))) {
  return { ok: false, reason: 'message violates the no-identity/no-delegation policy' };
}

let observedDestinationRoute = null;
const exactDestination = () => {
  let pathname;
  try { pathname = decodeURIComponent(location.pathname); } catch (_) { return false; }
  const match = pathname.match(/(?:^|\/)messages(?:\/([^/]+))?\/?$/i);
  const route = match ? match[1] || '' : '';
  const exactHeaders = all('.well-header').filter(visible).filter(header => equalFold(header.textContent, targetCompany));
  const verified = (route === targetCompany || route.startsWith(`${targetCompany}-chatroom_`))
    && exactHeaders.length === 1;
  if (verified) observedDestinationRoute = route;
  return verified;
};
if (!exactDestination()) return { ok: false, reason: 'URL and exact target private header are not both verified' };

const exactContactRecords = all('#chat-contacts a[class*="js-test-chat-contact-"]').filter(anchor => {
  if (!visible(anchor)) return false;
  const classMatch = Array.from(anchor.classList)
    .map(className => className.match(/^js-test-chat-contact-(\d+)$/))
    .find(Boolean);
  if (!classMatch || Number(classMatch[1]) !== targetCompanyId) return false;
  const directDivs = Array.from(anchor.children).filter(child => child.tagName === 'DIV');
  return directDivs.length > 0 && equalFold(directDivs[0].textContent, targetCompany);
});
if (idRequested && exactContactRecords.length !== 1) {
  return {
    ok: false,
    reason: 'target company name and ID are not bound to one unique contact record',
    count: exactContactRecords.length,
  };
}

const headers = all('.well-header').filter(visible).filter(header => equalFold(header.textContent, targetCompany));
let pane = headers[0].parentElement;
while (pane && pane !== document.body) {
  const paneAreas = Array.from(pane.querySelectorAll('textarea[placeholder^="Type here"]')).filter(visible);
  const paneSenders = Array.from(pane.querySelectorAll('button')).filter(button =>
    visible(button) && button.querySelector('svg[data-icon="paper-plane"]'));
  if (paneAreas.length === 1 && paneSenders.length === 1) break;
  pane = pane.parentElement;
}
if (!pane || pane === document.body) {
  return { ok: false, reason: 'could not isolate one target pane composer and paper-plane button' };
}
const areas = Array.from(pane.querySelectorAll('textarea[placeholder^="Type here"]')).filter(visible);
const senders = Array.from(pane.querySelectorAll('button')).filter(button =>
  visible(button) && button.querySelector('svg[data-icon="paper-plane"]'));
if (areas.length !== 1 || senders.length !== 1) {
  return { ok: false, reason: 'target pane composer/send button count changed before send' };
}
const composer = areas[0];
const initialComposerValue = String(composer.value || '');
if (initialComposerValue !== '') {
  return { ok: false, reason: 'target private composer is not empty; refusing to overwrite its draft' };
}

const hasRightAlignedAncestor = node => {
  let current = node;
  for (let depth = 0; current && current !== pane && depth < 8; depth += 1, current = current.parentElement) {
    if (getComputedStyle(current).textAlign === 'right') return true;
  }
  return false;
};
const exactOwnMessageNodes = root => Array.from(root.querySelectorAll('div,span,p')).filter(element => {
  if (!visible(element) || compact(element.innerText) !== text) return false;
  if (element.closest('textarea') || /Failed\s*-\s*Retry\?/iu.test(compact(element.parentElement && element.parentElement.innerText))) return false;
  if (element.querySelector('svg[data-icon="spinner"]') || element.closest('[aria-busy="true"]')) return false;
  if (Array.from(element.children).some(child => compact(child.innerText) === text)) return false;
  return hasRightAlignedAncestor(element);
});
const beforeNodes = exactOwnMessageNodes(pane);
if (beforeNodes.length > 0) {
  return { ok: false, doNotRetry: true, reason: 'the exact own message already exists in this thread' };
}

const storageKey = `sim-chat-private-send:${attemptId}`;
let priorAttempt = null;
try { priorAttempt = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (priorAttempt && priorAttempt.clicked === true) {
  return { ok: false, doNotRetry: true, reason: 'this attemptId already clicked send', priorAttempt };
}
if (privateSend.confirm !== true) {
  return {
    ok: true,
    dry: true,
    targetCompany,
    targetCompanyId: idRequested ? targetCompanyId : null,
    attemptId,
    wouldSend: text,
    destinationRoute: observedDestinationRoute,
    destinationVerified: true,
    targetIdVerified: idRequested && exactContactRecords.length === 1,
    composerEmpty: true,
    exactOwnMessageAbsent: true,
    messageId: null,
    idStatus: 'UNKNOWN',
  };
}

const addedRoots = [];
const observer = new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) if (node && node.nodeType === Node.ELEMENT_NODE) addedRoots.push(node);
  }
});
observer.observe(pane, { childList: true, subtree: true });
const clearOnlyThisDraft = () => {
  if (initialComposerValue === '' && compact(composer.value) === text) setInput(composer, '');
};
setInput(composer, text);
await sleep(250);
if (compact(composer.value) !== text || senders[0].disabled) {
  observer.disconnect();
  clearOnlyThisDraft();
  return { ok: false, reason: 'composer did not retain the exact text or send is disabled' };
}
try {
  sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, at: new Date().toISOString() }));
} catch (_) {
  observer.disconnect();
  clearOnlyThisDraft();
  return { ok: false, reason: 'attempt replay guard could not be persisted; send was not clicked' };
}

senders[0].click();
let proven = false;
let observedCount = 0;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await sleep(200);
  const current = exactOwnMessageNodes(pane);
  const addedMatches = addedRoots.flatMap(root => {
    const elements = [root, ...Array.from(root.querySelectorAll ? root.querySelectorAll('div,span,p') : [])];
    return elements.filter(element => element.isConnected && compact(element.innerText) === text && hasRightAlignedAncestor(element));
  }).filter((element, index, elements) => elements.indexOf(element) === index);
  observedCount = current.length;
  const composerCleared = compact(composer.value) === '';
  const noFailure = !/Failed\s*-\s*Retry\?/iu.test(compact(pane.innerText));
  const noPendingExact = !Array.from(pane.querySelectorAll('[aria-busy="true"],svg[data-icon="spinner"]'))
    .some(spinner => compact(spinner.parentElement && spinner.parentElement.innerText).includes(text));
  if (current.length === 1 && addedMatches.length >= 1 && composerCleared && noFailure && noPendingExact && exactDestination()) {
    proven = true;
    break;
  }
}
observer.disconnect();
if (!proven) {
  return {
    ok: false,
    mutationAttempted: true,
    doNotRetry: true,
    ambiguous: true,
    reason: 'send clicked once but the unique UI postcondition was not proven',
    targetCompany,
    targetCompanyId,
    attemptId,
    observedExactOwnNodes: observedCount,
    messageId: null,
    idStatus: 'UNKNOWN',
  };
}
try {
  sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, landed: true, at: new Date().toISOString() }));
} catch (_) {}
return {
  ok: true,
  posted: true,
  mutationAttempted: true,
  targetCompany,
  targetCompanyId,
  attemptId,
  messageId: null,
  idStatus: 'UNKNOWN',
  postcondition: 'unique-added-own-node+cleared-composer+exact-destination',
};
