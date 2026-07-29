// Click one exact public-message reply icon so the game inserts its native @company mention.
// This only edits the exact room composer; it never sends a message.
const request = window.__chatRoomReply || {};
const room = String(request.room || '').trim();
const company = String(request.company || '').replace(/\s+/g, ' ').trim();
const bodyContains = String(request.bodyContains || '').replace(/\s+/g, ' ').trim();
const conversationHref = request.conversationHref ? String(request.conversationHref) : null;
const requireExactBody = request.requireExactBody === true;
const sourceMessageId = request.sourceMessageId == null ? null : String(request.sourceMessageId);
const sourceCreatedAt = request.sourceCreatedAt == null ? null : String(request.sourceCreatedAt);
const sourceCompanyId = Number(request.sourceCompanyId);
const confirm = request.confirm === true;
if (!room || !company) return { ok: false, reason: 'room and company are required' };
if (company.length > 80 || /[@\r\n]/.test(company)) {
  return { ok: false, reason: 'company cannot form a safe native mention' };
}
if (!bodyContains && !conversationHref) {
  return { ok: false, reason: 'bodyContains or conversationHref is required to bind the target' };
}
if (requireExactBody && (!bodyContains || !/^[1-9]\d*$/u.test(sourceMessageId || '')
    || !Number.isFinite(Date.parse(sourceCreatedAt))
    || !Number.isSafeInteger(sourceCompanyId) || sourceCompanyId <= 0)) {
  return { ok: false, reason: 'exact reply requires body, source company, message ID, and exact time' };
}

const visible = element => !!element && element.offsetParent !== null;
const clean = value => String(value || '')
  .replace(/[\u00a0\u202f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const exactIso = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const bodyWithTokens = node => {
  const clone = node.cloneNode(true);
  for (const image of clone.querySelectorAll('img[alt^=":re-"]')) {
    const match = String(image.getAttribute('alt') || '').match(/^:re-(\d+):$/u);
    if (match) image.replaceWith(document.createTextNode(` :re-${match[1]}: `));
  }
  return clean(clone.textContent);
};
const componentSourceEvidence = ({ root, messageNode, visibleCompany, visibleExactTime }) => {
  // Read-only component evidence is used only to bind the target before one native UI click.
  // Event-handler props are never read or invoked. Any ambiguity rejects the reply.
  const internalKeys = Object.getOwnPropertyNames(root).filter(key =>
    key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$'));
  if (internalKeys.length !== 1) return null;
  let fiber = root[internalKeys[0]];
  let props = null;
  const seen = new Set();
  for (let depth = 0; fiber && depth < 20 && !seen.has(fiber); depth += 1) {
    seen.add(fiber);
    const candidate = fiber.memoizedProps;
    if (candidate && typeof candidate === 'object'
        && Object.prototype.hasOwnProperty.call(candidate, 'messageGroupId')
        && Object.prototype.hasOwnProperty.call(candidate, 'sender')
        && Object.prototype.hasOwnProperty.call(candidate, 'body')
        && Object.prototype.hasOwnProperty.call(candidate, 'fromMe')) {
      props = candidate;
      break;
    }
    fiber = fiber.return;
  }
  if (!props || props.fromMe !== false || !Array.isArray(props.body) || props.body.length !== 1) return null;
  const entry = props.body[0];
  const messageId = Number(entry?.id);
  const exactTime = exactIso(entry?.datetime);
  const messageGroupId = String(props.messageGroupId || '').trim();
  const senderId = Number(props.sender?.id);
  const senderCompany = clean(props.sender?.company);
  if (!Number.isSafeInteger(messageId) || messageId <= 0 || !exactTime
      || !Number.isSafeInteger(senderId) || senderId <= 0
      || !/^[A-Za-z0-9_-]{1,80}-\d+$/u.test(messageGroupId)
      || !messageGroupId.endsWith(`-${messageId}`)
      || !senderCompany || senderCompany.toLocaleLowerCase('en-US')
        !== clean(visibleCompany).toLocaleLowerCase('en-US')) return null;
  const domTime = exactIso(visibleExactTime);
  if (!domTime || Math.abs(Date.parse(domTime) - Date.parse(exactTime)) > 1000) return null;
  return { messageId: String(messageId), exactTime, senderId, body: bodyWithTokens(messageNode) };
};
const normalizedHref = href => {
  try {
    const url = new URL(String(href || ''), location.origin);
    return decodeURIComponent(url.pathname).replace(/\/$/, '').toLocaleLowerCase('en-US');
  } catch {
    return null;
  }
};
const roomHrefMatches = href => {
  const path = normalizedHref(href);
  const wanted = room.toLocaleLowerCase('en-US');
  return !!path && (path.includes(`-chatroom_${wanted}`) || path.includes(`/chatroom_${wanted}`));
};
const scrollersIn = root => all('div').filter(element => {
  if (!root.contains(element) || !visible(element)) return false;
  const style = getComputedStyle(element);
  return style.flexDirection === 'column-reverse'
    && ['auto', 'scroll'].includes(style.overflowY);
});
const hasExactHeader = root => all('*').some(element => root.contains(element)
  && visible(element)
  && !element.querySelector('textarea')
  && clean(element.innerText).toLocaleLowerCase('en-US') === room.toLocaleLowerCase('en-US'));

const paneMatches = [];
for (const textarea of all('textarea[placeholder^="Type here"]')) {
  if (!visible(textarea)) continue;
  let ancestor = textarea.parentElement;
  while (ancestor && ancestor !== document.body) {
    const localAreas = all('textarea[placeholder^="Type here"]')
      .filter(element => visible(element) && ancestor.contains(element));
    const roomIcon = all('img[alt]').some(image => ancestor.contains(image)
      && visible(image)
      && clean(image.alt).toLocaleLowerCase('en-US') === room.toLocaleLowerCase('en-US'));
    const roomConversation = all('a[href]').some(anchor => ancestor.contains(anchor)
      && visible(anchor)
      && roomHrefMatches(anchor.getAttribute('href')));
    const scrollers = scrollersIn(ancestor);
    if (localAreas.length === 1 && hasExactHeader(ancestor)
        && (roomIcon || roomConversation) && scrollers.length === 1) {
      paneMatches.push({ pane: ancestor, textarea, scroller: scrollers[0] });
      break;
    }
    ancestor = ancestor.parentElement;
  }
}
if (paneMatches.length !== 1) {
  return { ok: false, reason: 'exact public-room pane count != 1', paneCount: paneMatches.length };
}

const { pane, textarea, scroller } = paneMatches[0];
const requestedHref = conversationHref ? normalizedHref(conversationHref) : null;
const candidates = [];
for (const replyIcon of all('svg[data-icon="reply"]')) {
  if (!pane.contains(replyIcon) || !visible(replyIcon)) continue;
  const headerRegion = replyIcon.closest('div.invisible-possible');
  const root = headerRegion?.parentElement;
  if (!headerRegion || !root || !scroller.contains(root)) continue;
  const regions = [...root.children].filter(element =>
    element.matches?.('div.invisible-possible') && visible(element));
  const bodyRegion = regions.find(region => region !== headerRegion
    && [...region.children].some(child => child.tagName === 'DIV' && visible(child)));
  if (!bodyRegion) continue;
  const envelopeLink = headerRegion.querySelector('a[href] svg[data-icon="envelope"]')?.closest('a[href]');
  if (!envelopeLink || !roomHrefMatches(envelopeLink.getAttribute('href'))) continue;
  const headerTexts = [...headerRegion.children]
    .filter(visible)
    .map(element => clean(element.innerText))
    .filter(Boolean);
  const renderedCompany = headerTexts.find(text => !/(?:ago|yesterday|just now)$/i.test(text));
  if (clean(renderedCompany).toLocaleLowerCase('en-US') !== company.toLocaleLowerCase('en-US')) continue;
  if (requestedHref && normalizedHref(envelopeLink.getAttribute('href')) !== requestedHref) continue;
  let messageNodes = [...bodyRegion.children].filter(visible);
  if (!messageNodes.length && clean(bodyRegion.innerText)) messageNodes = [bodyRegion];
  const matchingBodies = messageNodes.filter(messageNode => {
    const renderedBody = bodyWithTokens(messageNode);
    return !bodyContains || (requireExactBody
      ? renderedBody.toLocaleLowerCase('en-US') === bodyContains.toLocaleLowerCase('en-US')
      : renderedBody.toLocaleLowerCase('en-US').includes(bodyContains.toLocaleLowerCase('en-US')));
  });
  if (matchingBodies.length !== 1) continue;
  let sourceEvidence = null;
  if (requireExactBody) {
    if (messageNodes.length !== 1) continue;
    const exactTimeNode = headerRegion.querySelector('time[datetime], [data-datetime]');
    const visibleExactTime = exactTimeNode?.getAttribute('datetime')
      || exactTimeNode?.getAttribute('data-datetime') || null;
    sourceEvidence = componentSourceEvidence({
      root,
      messageNode: matchingBodies[0],
      visibleCompany: renderedCompany,
      visibleExactTime,
    });
    if (!sourceEvidence || sourceEvidence.senderId !== sourceCompanyId
        || sourceEvidence.messageId !== sourceMessageId
        || sourceEvidence.body.toLocaleLowerCase('en-US') !== bodyContains.toLocaleLowerCase('en-US')
        || (sourceCreatedAt && sourceEvidence.exactTime !== exactIso(sourceCreatedAt))) continue;
  }
  candidates.push({ replyIcon, root, href: envelopeLink.href, sourceEvidence });
}
if (candidates.length !== 1) {
  return {
    ok: false,
    reason: 'exact reply target count != 1',
    targetCount: candidates.length,
    room,
    company,
  };
}

const replyButton = candidates[0].replyIcon.closest('button, a, [role="button"]')
  || candidates[0].replyIcon;
const expectedPrefix = `@${company.replace(/ /g, '-')} `;
if (!confirm) {
  return {
    ok: true,
    dry: true,
    room,
    company,
    conversationHref: candidates[0].href,
    sourceMessageIdVerified: requireExactBody ? sourceMessageId : null,
    sourceCompanyIdVerified: requireExactBody ? candidates[0].sourceEvidence?.senderId || null : null,
    sourceCreatedAtVerified: requireExactBody ? candidates[0].sourceEvidence?.exactTime || null : null,
    wouldInsert: expectedPrefix,
  };
}
if (String(textarea.value || '') !== '') {
  return { ok: false, reason: 'exact room composer is not empty; refusing to overwrite it' };
}

replyButton.click();
await sleep(500);
const actual = String(textarea.value || '');
const verified = actual === expectedPrefix;
if (!verified && actual !== '') setInput(textarea, '');
return {
  ok: verified,
  inserted: verified,
  room,
  company,
  sourceMessageIdVerified: verified && requireExactBody ? sourceMessageId : null,
  sourceCompanyIdVerified: verified && requireExactBody
    ? candidates[0].sourceEvidence?.senderId || null : null,
  sourceCreatedAtVerified: verified && requireExactBody
    ? candidates[0].sourceEvidence?.exactTime || null : null,
  expectedPrefix,
  actual,
  cleanupApplied: !verified && actual !== '',
  doNotRetry: !verified,
  reason: verified ? undefined : 'native reply click did not produce the exact expected mention',
};
