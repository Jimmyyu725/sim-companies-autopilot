// Read rendered contacts and one private thread through the game UI.
// Params: window.__chatPrivateRead = {
//   targetCompany, targetCompanyId?, previousSnapshotFingerprint?, cursorTail?, loadFull?, maxScrolls?
// }.
// Stable IDs are accepted only from read-only rendered-component props cross-checked against the
// visible DOM. If that proof is absent or inconsistent, IDs remain null rather than being invented.
const privateRead = window.__chatPrivateRead || {};
const targetCompany = String(privateRead.targetCompany || '').normalize('NFKC').trim();
const targetCompanyId = Number(privateRead.targetCompanyId);
const idRequested = Number.isSafeInteger(targetCompanyId) && targetCompanyId > 0;
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC')
  .replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
const parseRoute = href => {
  try {
    const pathname = decodeURIComponent(new URL(href, location.origin).pathname);
    const match = pathname.match(/(?:^|\/)messages(?:\/([^/]+))?\/?$/i);
    return match ? { pathname, route: match[1] || '' } : null;
  } catch (_) { return null; }
};
const fingerprint = value => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `ui-fnv1a-${hash.toString(16).padStart(8, '0')}`;
};

if (!targetCompany) return { ok: false, reason: 'targetCompany is required' };
const headers = all('.well-header').filter(visible).filter(header => equalFold(header.textContent, targetCompany));
if (headers.length !== 1) return { ok: false, reason: 'exact private pane header count != 1', count: headers.length };
const route = parseRoute(location.href);
if (!route || !(route.route === targetCompany || route.route.startsWith(`${targetCompany}-chatroom_`))) {
  return { ok: false, reason: 'private URL does not contain the exact target company', href: location.href };
}

const sidebars = all('#chat-contacts').filter(visible);
if (sidebars.length !== 1) {
  return {
    ok: false,
    reason: 'visible private-contact sidebar count != 1',
    count: sidebars.length,
  };
}
const sidebar = sidebars[0];
const contacts = [];
const seenContactIds = new Set();
for (const anchor of Array.from(sidebar.querySelectorAll('a[class*="js-test-chat-contact-"]')).filter(visible)) {
  const classMatch = Array.from(anchor.classList)
    .map(className => className.match(/^js-test-chat-contact-(\d+)$/))
    .find(Boolean);
  if (!classMatch) continue;
  const companyId = Number(classMatch[1]);
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || seenContactIds.has(companyId)) {
    return { ok: false, reason: 'malformed or duplicate contact companyId evidence' };
  }
  seenContactIds.add(companyId);
  const directDivs = Array.from(anchor.children).filter(child => child.tagName === 'DIV');
  const company = compact(directDivs[0] && directDivs[0].textContent);
  const badge = anchor.querySelector('.badge-info');
  const unreadText = compact(badge && badge.textContent);
  const unread = badge ? (unreadText === '∞' ? 100 : Number(unreadText)) : 0;
  if (!company || !Number.isSafeInteger(unread) || unread < 0) {
    return { ok: false, reason: `contact ${companyId} lacks exact company or unread evidence` };
  }
  contacts.push({
    companyId,
    company,
    unread,
    pinned: !!anchor.querySelector('svg[data-icon="pin"]'),
    privateNote: directDivs.length > 1 ? compact(directDivs[1].textContent) || null : null,
    route: parseRoute(anchor.href),
  });
}
const exactContactRecords = idRequested
  ? contacts.filter(contact => contact.companyId === targetCompanyId && equalFold(contact.company, targetCompany))
  : [];
if (idRequested && exactContactRecords.length !== 1) {
  return {
    ok: false,
    reason: 'target company name and ID are not bound to one unique contact record',
    count: exactContactRecords.length,
  };
}
const idVerified = exactContactRecords.length === 1;

let pane = headers[0].parentElement;
while (pane && pane !== document.body) {
  const paneAreas = Array.from(pane.querySelectorAll('textarea[placeholder^="Type here"]')).filter(visible);
  const paneSenders = Array.from(pane.querySelectorAll('button')).filter(button =>
    visible(button) && button.querySelector('svg[data-icon="paper-plane"]'));
  if (paneAreas.length === 1 && paneSenders.length === 1) break;
  pane = pane.parentElement;
}
if (!pane || pane === document.body) return { ok: false, reason: 'target private pane was not isolated' };
const scrollableCandidates = Array.from(pane.querySelectorAll('div')).filter(element => {
  if (!visible(element)) return false;
  const style = getComputedStyle(element);
  return ['column', 'column-reverse'].includes(style.flexDirection)
    && /(auto|scroll)/u.test(style.overflowY || style.overflow);
});
const withMessageRegions = scrollableCandidates.filter(element =>
  Array.from(element.querySelectorAll('div.invisible-possible')).some(visible));
const reverseCandidates = scrollableCandidates.filter(element =>
  getComputedStyle(element).flexDirection === 'column-reverse');
const relevantCandidates = withMessageRegions.length
  ? withMessageRegions
  : reverseCandidates.length ? reverseCandidates : scrollableCandidates;
// Prefer the innermost relevant scroll container. A surrounding layout column can also report
// overflow:auto, but it is not the message history when it contains a more specific candidate.
const scrollers = relevantCandidates.filter(candidate =>
  !relevantCandidates.some(other => other !== candidate && candidate.contains(other)));
if (scrollers.length !== 1) {
  return {
    ok: false,
    reason: 'target private history scroll container count != 1',
    count: scrollers.length,
    diagnostics: {
      scrollableCount: scrollableCandidates.length,
      reverseCount: reverseCandidates.length,
      withMessageRegionsCount: withMessageRegions.length,
    },
  };
}
const scroller = scrollers[0];
const bodyWithResourceTokens = node => {
  const clone = node.cloneNode(true);
  for (const image of clone.querySelectorAll('img[alt^=":re-"]')) {
    const match = compact(image.getAttribute('alt')).match(/^:re-(\d+):$/u);
    if (match) image.replaceWith(document.createTextNode(` :re-${match[1]}: `));
  }
  return compact(clone.textContent);
};
const looksLikeRenderedTime = value => {
  const text = compact(value).toLocaleLowerCase('en-US');
  return /^(?:just now|yesterday|today)$/u.test(text)
    || /^(?:about\s+)?(?:an?|one|\d+)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago$/u.test(text)
    || /^\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?(?:\s+\d{1,2}:\d{2}(?:\s*[ap]m)?)?$/u.test(text);
};
const exactIso = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const componentMessageIdentity = ({
  root, messageCount, visibleCompany, direction, visibleExactTime,
}) => {
  // Read React's rendered props only as identity evidence. Never call component handlers or use
  // this path for a mutation. Every accepted ID is bound back to visible company, direction, time,
  // and rendered message-count evidence; ambiguity falls back to null IDs.
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
  const expectedFromMe = direction === 'OUTGOING';
  if (!props || !['INCOMING', 'OUTGOING'].includes(direction)
      || typeof props.fromMe !== 'boolean' || props.fromMe !== expectedFromMe) return null;
  const messageGroupId = String(props.messageGroupId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}-\d+$/u.test(messageGroupId)) return null;
  const senderId = Number(props.sender?.id);
  const senderCompany = compact(props.sender?.company);
  if (!Number.isSafeInteger(senderId) || senderId <= 0 || !senderCompany
      || senderCompany.length > 200) return null;
  if (expectedFromMe) {
    const ownIds = Array.isArray(props.myCompanyIds) ? props.myCompanyIds.map(Number) : [];
    if (!ownIds.some(id => Number.isSafeInteger(id) && id === senderId)
        || (idRequested && senderId === targetCompanyId)) return null;
  } else if (!visibleCompany || !equalFold(senderCompany, visibleCompany)
      || !equalFold(senderCompany, targetCompany)
      || (idRequested && senderId !== targetCompanyId)) return null;
  // Multi-message component bodies need a measured text/resource normalizer before index binding
  // can be trusted. A single body cannot be shifted onto a sibling, so only that case is accepted.
  if (!Array.isArray(props.body) || props.body.length !== 1 || messageCount !== 1) return null;
  const messageIds = new Set();
  const body = [];
  for (const entry of props.body) {
    const messageId = Number(entry?.id);
    const exactTime = exactIso(entry?.datetime);
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || messageIds.has(messageId)
        || !exactTime) return null;
    messageIds.add(messageId);
    body.push({ messageId, exactTime });
  }
  if (!messageGroupId.endsWith(`-${body[0].messageId}`)) return null;
  const visibleTime = exactIso(visibleExactTime);
  if (!visibleTime || !body.some(entry =>
    Math.abs(Date.parse(entry.exactTime) - Date.parse(visibleTime)) <= 1000)) return null;
  return { messageGroupId, senderId, senderCompany, body };
};
const observedMessages = () => {
  // Live message groups render header and body as separate `div.invisible-possible` siblings.
  // Build roots from those direct regions so nested content cannot be mistaken for another group.
  const roots = [...new Set(Array.from(scroller.querySelectorAll('div.invisible-possible'))
    .filter(visible)
    .map(region => region.parentElement)
    .filter(root => root && root !== scroller && scroller.contains(root)))]
    .filter(root => {
      const regions = Array.from(root.children).filter(child =>
        child.matches?.('div.invisible-possible') && visible(child));
      const style = getComputedStyle(root);
      return regions.length >= 2
        && ['left', 'right'].includes(style.textAlign)
        && regions.some(region =>
          Array.from(region.children).some(child => child.tagName === 'DIV' && visible(child)));
    });
  const messages = [];
  for (let groupOrdinal = 0; groupOrdinal < roots.length; groupOrdinal += 1) {
    const root = roots[groupOrdinal];
    const regions = Array.from(root.children).filter(child =>
      child.matches?.('div.invisible-possible') && visible(child));
    const headerRegion = regions.find(region =>
      region.querySelector('time, svg[data-icon="copy"], svg[data-icon="envelope"], svg[data-icon="reply"]'))
      || regions[0];
    const bodyRegion = regions.find(region => region !== headerRegion
      && Array.from(region.children).some(child => child.tagName === 'DIV' && visible(child)));
    if (!bodyRegion) continue;
    const rootText = compact(root.innerText);
    if (/Failed\s*-\s*Retry\?/iu.test(rootText)
        || root.querySelector('svg[data-icon="spinner"], [aria-busy="true"]')) continue;

    const textAlign = getComputedStyle(root).textAlign;
    const direction = textAlign === 'right' ? 'OUTGOING' : textAlign === 'left' ? 'INCOMING' : 'UNKNOWN';
    const headerTexts = Array.from(headerRegion.children)
      .filter(visible)
      .map(child => compact(child.innerText || child.textContent))
      .filter(Boolean);
    const exactAuthors = headerTexts.filter(value => equalFold(value, targetCompany));
    const authorCompany = exactAuthors.length === 1 ? targetCompany : null;
    const timeCandidates = headerTexts.filter(looksLikeRenderedTime);
    const renderedTime = timeCandidates.length === 1 ? timeCandidates[0] : null;
    const visibleCompanyCandidates = headerTexts.filter(value => !looksLikeRenderedTime(value));
    const visibleCompany = visibleCompanyCandidates.length === 1 ? visibleCompanyCandidates[0] : null;
    const exactTimeNode = headerRegion.querySelector('time[datetime], [data-datetime]');
    const visibleExactTime = exactTimeNode?.getAttribute('datetime')
      || exactTimeNode?.getAttribute('data-datetime') || null;
    let messageNodes = Array.from(bodyRegion.children).filter(visible);
    if (!messageNodes.length && compact(bodyRegion.innerText)) messageNodes = [bodyRegion];
    const componentIdentity = componentMessageIdentity({
      root,
      messageCount: messageNodes.length,
      visibleCompany,
      direction,
      visibleExactTime,
    });
    for (let messageOrdinal = 0; messageOrdinal < messageNodes.length; messageOrdinal += 1) {
      const messageNode = messageNodes[messageOrdinal];
      const resourceKinds = Array.from(messageNode.querySelectorAll('img[alt^=":re-"]'))
        .map(image => compact(image.getAttribute('alt')).match(/^:re-(\d+):$/u))
        .filter(Boolean)
        .map(match => Number(match[1]))
        .filter((kind, index, kinds) => Number.isSafeInteger(kind) && kind > 0 && kinds.indexOf(kind) === index);
      const visibleBody = bodyWithResourceTokens(messageNode);
      if (!visibleBody && resourceKinds.length === 0) continue;
      const evidence = {
        groupOrdinal,
        messageOrdinal,
        authorCompany,
        direction,
        visibleBody,
        resourceKinds,
        renderedTime,
      };
      messages.push({
        serverMessageId: componentIdentity?.body[messageOrdinal]?.messageId || null,
        idStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_ID' : 'UNKNOWN',
        observationFingerprint: fingerprint(JSON.stringify(evidence))
          .replace(/^ui-fnv1a-/u, 'ui-observation-fnv1a-'),
        groupOrdinal,
        messageOrdinal,
        authorCompany: componentIdentity?.senderCompany || authorCompany,
        authorCompanyId: componentIdentity?.senderId || null,
        authorRole: direction === 'OUTGOING' ? 'SELF' : direction === 'INCOMING' ? 'COUNTERPART' : 'UNKNOWN',
        authorStatus: componentIdentity
          ? direction === 'OUTGOING' ? 'VERIFIED_RENDERED_COMPONENT_SELF_ID'
            : 'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER'
          : authorCompany ? 'VERIFIED_VISIBLE_GROUP_HEADER' : 'UNKNOWN',
        direction,
        directionStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_AND_STYLE'
          : direction === 'UNKNOWN' ? 'UNKNOWN' : 'VERIFIED_RENDERED_STYLE',
        visibleBody,
        resourceKinds,
        renderedTime,
        exactCreatedAt: componentIdentity?.body[messageOrdinal]?.exactTime || null,
        timeStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_DATETIME'
          : renderedTime ? 'VERIFIED_RENDERED' : 'UNKNOWN',
        trust: direction === 'OUTGOING' ? 'LOCAL_COMPANY_MESSAGE' : 'EXTERNAL_OR_UNATTRIBUTED_UNTRUSTED_DATA',
        instructionAuthority: direction === 'OUTGOING' ? 'local-output' : 'none',
      });
    }
  }
  return messages;
};

const capture = () => {
  const renderedText = compact(scroller.innerText);
  const resourceKinds = Array.from(scroller.querySelectorAll('img[alt^=":re-"]'))
    .map(image => compact(image.getAttribute('alt')).match(/^:re-(\d+):$/))
    .filter(Boolean)
    .map(match => Number(match[1]))
    .filter((kind, index, kinds) => Number.isSafeInteger(kind) && kind > 0 && kinds.indexOf(kind) === index);
  const companyProfileRoutes = Array.from(scroller.querySelectorAll('a[href*="/company/"]'))
    .map(anchor => {
      try { return decodeURIComponent(new URL(anchor.href, location.origin).pathname); } catch (_) { return null; }
    })
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  const renderedLines = renderedText ? renderedText.split('\n').filter(Boolean) : [];
  const messages = observedMessages();
  const snapshotFingerprint = fingerprint(JSON.stringify({ renderedText, resourceKinds, companyProfileRoutes }));
  return {
    renderedText,
    renderedLines,
    resourceKinds,
    companyProfileRoutes,
    messages,
    snapshotFingerprint,
  };
};

let snapshot = capture();
// An empty first paint is not proof of an empty thread; it may still be loading. Completeness is
// earned only by repeated stable samples at the measured oldest scroll boundary.
let historyComplete = false;
let scrolls = 0;
if (privateRead.loadFull === true) {
  const maxScrolls = Math.min(30, Math.max(1, Number(privateRead.maxScrolls) || 20));
  let stable = 0;
  let priorFingerprint = snapshot.snapshotFingerprint;
  const atOldestBoundary = () => {
    const direction = getComputedStyle(scroller).flexDirection;
    const span = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const position = Number(scroller.scrollTop);
    if (!Number.isFinite(position)) return false;
    if (span <= 2) return Math.abs(position) <= 2;
    return direction === 'column-reverse'
      ? Math.abs(position + span) <= 2
      : position <= 2;
  };
  for (; scrolls < maxScrolls && stable < 2; scrolls += 1) {
    const direction = getComputedStyle(scroller).flexDirection;
    scroller.scrollTop = direction === 'column-reverse'
      ? -Math.max(scroller.scrollHeight, scroller.clientHeight)
      : 0;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(900);
    snapshot = capture();
    const loading = Array.from(scroller.querySelectorAll('svg[data-icon="spinner"],[aria-busy="true"]')).some(visible);
    if (snapshot.snapshotFingerprint === priorFingerprint && !loading && atOldestBoundary()) stable += 1;
    else stable = 0;
    priorFingerprint = snapshot.snapshotFingerprint;
  }
  historyComplete = stable >= 2 && atOldestBoundary();
}

const previousFingerprint = compact(privateRead.previousSnapshotFingerprint);
const changedSincePrevious = previousFingerprint ? previousFingerprint !== snapshot.snapshotFingerprint : null;
const cursorTail = compact(privateRead.cursorTail);
let incrementalText = null;
let incrementalStatus = cursorTail ? 'UNKNOWN' : 'NOT_REQUESTED';
if (cursorTail) {
  const first = snapshot.renderedText.indexOf(cursorTail);
  const last = snapshot.renderedText.lastIndexOf(cursorTail);
  if (first >= 0 && first === last) {
    incrementalText = compact(snapshot.renderedText.slice(first + cursorTail.length));
    incrementalStatus = 'UNIQUE_UI_TAIL_MATCH';
  } else if (first >= 0) incrementalStatus = 'AMBIGUOUS_DUPLICATE_TAIL';
  else incrementalStatus = 'CURSOR_NOT_RENDERED';
}

return {
  ok: true,
  targetCompany,
  targetCompanyId: idRequested ? targetCompanyId : null,
  idVerified,
  contacts,
  thread: {
    messageId: null,
    idStatus: 'UNKNOWN',
    renderedText: snapshot.renderedText,
    renderedLines: snapshot.renderedLines,
    resourceKinds: snapshot.resourceKinds,
    companyProfileRoutes: snapshot.companyProfileRoutes,
    messages: snapshot.messages,
    messageCount: snapshot.messages.length,
    messageGroupingStatus: snapshot.messages.length ? 'VERIFIED_RENDERED_DOM_GROUPS' : 'UNKNOWN_USE_RENDERED_SNAPSHOT',
    snapshotFingerprint: snapshot.snapshotFingerprint,
    changedSincePrevious,
    incrementalText,
    incrementalStatus,
    trust: 'MIXED_EXTERNAL_UNTRUSTED_DATA',
    instructionAuthority: 'none-for-external-content',
  },
  historyComplete,
  historyStatus: historyComplete ? 'STABLE_AT_OLDEST_UI_BOUNDARY' : 'PARTIAL_OR_UNKNOWN',
  scrolls,
};
