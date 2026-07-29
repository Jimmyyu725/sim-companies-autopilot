// Read one public room from its exact rendered pane. This supports the game's dual-pane URL,
// where a public room and a private conversation each have their own composer.
// Pure DOM read: no click, navigation, API call, or read-receipt mutation is performed here.
const request = window.__chatRoomRead || {};
const room = String(request.room || '').trim();
if (!room) return { ok: false, reason: 'room is required' };

const visible = element => !!element && element.offsetParent !== null;
const clean = value => String(value || '')
  .replace(/[\u00a0\u202f]/g, ' ')
  .replace(/[ \t\r\f\v]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .trim();
const directText = element => clean([...element.childNodes]
  .filter(node => node.nodeType === Node.TEXT_NODE)
  .map(node => node.textContent)
  .join(' '));
const exactHeaderIn = root => all('*').filter(element =>
  root.contains(element)
  && visible(element)
  && !element.querySelector('textarea')
  && clean(element.innerText).toLocaleLowerCase('en-US') === room.toLocaleLowerCase('en-US'));
const roomHrefMatches = href => {
  let decoded;
  try {
    decoded = decodeURIComponent(new URL(String(href || ''), location.origin).pathname);
  } catch {
    return false;
  }
  const lower = decoded.toLocaleLowerCase('en-US');
  const wanted = room.toLocaleLowerCase('en-US');
  return lower.includes(`-chatroom_${wanted}`) || lower.includes(`/chatroom_${wanted}`);
};
const scrollContainersIn = root => all('div').filter(element => {
  if (!root.contains(element) || !visible(element)) return false;
  const style = getComputedStyle(element);
  return style.flexDirection === 'column-reverse'
    && ['auto', 'scroll'].includes(style.overflowY);
});

const paneCandidates = [];
for (const textarea of all('textarea[placeholder^="Type here"]')) {
  if (!visible(textarea)) continue;
  let ancestor = textarea.parentElement;
  while (ancestor && ancestor !== document.body) {
    const localAreas = all('textarea[placeholder^="Type here"]')
      .filter(element => visible(element) && ancestor.contains(element));
    if (localAreas.length === 1) {
      const headers = exactHeaderIn(ancestor);
      const roomIcon = all('img[alt]').some(image => ancestor.contains(image)
        && visible(image)
        && clean(image.alt).toLocaleLowerCase('en-US') === room.toLocaleLowerCase('en-US'));
      const roomConversation = all('a[href]').some(anchor => ancestor.contains(anchor)
        && visible(anchor)
        && roomHrefMatches(anchor.getAttribute('href')));
      const scrollers = scrollContainersIn(ancestor);
      if (headers.length > 0 && (roomIcon || roomConversation) && scrollers.length === 1) {
        paneCandidates.push({ pane: ancestor, textarea, scroller: scrollers[0] });
        break;
      }
    }
    ancestor = ancestor.parentElement;
  }
}

if (paneCandidates.length !== 1) {
  return {
    ok: false,
    reason: 'exact public-room pane count != 1',
    room,
    paneCount: paneCandidates.length,
    visibleComposerCount: all('textarea[placeholder^="Type here"]').filter(visible).length,
  };
}

const { pane, textarea, scroller } = paneCandidates[0];
const parseKind = image => {
  const match = String(image.getAttribute('alt') || '').match(/^:re-(\d+):$/);
  if (!match) return null;
  const kind = Number(match[1]);
  return Number.isSafeInteger(kind) && kind > 0 ? kind : null;
};
const iconSemantic = icon => ({
  copy: 'copy_company_name',
  envelope: 'open_private_conversation',
  reply: 'mention_reply',
  retract: 'retract_own_message',
  thumbtack: 'pin_message',
  trash: 'delete_message_moderator_only',
  'trash-alt': 'delete_message_moderator_only',
  language: 'translate_message',
}[icon] || 'unknown');
const explicitId = (root, names) => {
  for (const element of [root, ...all('*').filter(item => root.contains(item))]) {
    for (const name of names) {
      const raw = element.getAttribute?.(name);
      if (raw === null || raw === undefined || raw === '') continue;
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
};
const exactIso = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const componentMessageIdentity = ({ root, messageCount, company, fromMe, visibleExactTime }) => {
  // React does not expose these stable IDs as DOM attributes. Reading the rendered component's
  // memoized props is therefore a read-only identity fallback. It is never used to invoke event
  // handlers or mutate the page, and every field is cross-checked against visible DOM evidence.
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
  if (!props || typeof props.fromMe !== 'boolean' || props.fromMe !== fromMe) return null;
  const messageGroupId = String(props.messageGroupId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}-\d+$/u.test(messageGroupId)) return null;
  const senderId = Number(props.sender?.id);
  const senderCompany = clean(props.sender?.company);
  if (!Number.isSafeInteger(senderId) || senderId <= 0 || !senderCompany
      || senderCompany.length > 200) return null;
  if (fromMe) {
    const ownIds = Array.isArray(props.myCompanyIds) ? props.myCompanyIds.map(Number) : [];
    if (!ownIds.some(id => Number.isSafeInteger(id) && id === senderId)) return null;
  } else if (!company
      || senderCompany.toLocaleLowerCase('en-US') !== clean(company).toLocaleLowerCase('en-US')) {
    return null;
  }
  // The component body is index-bound to DOM nodes below. Until multi-entry body markup has an
  // exact, measured text/resource normalization, accept only one-message groups so an ID can never
  // drift onto a neighboring visible body.
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
const bodyWithTokens = node => {
  const clone = node.cloneNode(true);
  for (const image of clone.querySelectorAll('img[alt^=":re-"]')) {
    const match = String(image.getAttribute('alt') || '').match(/^:re-(\d+):$/);
    if (match) image.replaceWith(document.createTextNode(` :re-${match[1]}: `));
  }
  return clean(clone.textContent);
};

const incomingRoots = [];
for (const envelope of all('svg[data-icon="envelope"]')) {
  if (!pane.contains(envelope) || !visible(envelope)) continue;
  const link = envelope.closest('a[href]');
  if (!link || !roomHrefMatches(link.getAttribute('href'))) continue;
  const inner = envelope.closest('div.invisible-possible');
  const root = inner?.parentElement;
  if (root && scroller.contains(root) && !incomingRoots.includes(root)) incomingRoots.push(root);
}

// A live message group has three direct regions: logo, header and body. Header and body are
// separate `div.invisible-possible` siblings; treating the first one as the whole group drops every
// message because the first region contains only company/actions/time.
const groupRoots = [...new Set(all('div.invisible-possible')
  .filter(element => scroller.contains(element) && visible(element))
  .map(element => element.parentElement)
  .filter(root => root && root !== scroller && scroller.contains(root)))]
  .filter(root => {
    const regions = [...root.children].filter(child =>
      child.matches?.('div.invisible-possible') && visible(child));
    return regions.length >= 2 && regions.some(region =>
      [...region.children].some(child => child.tagName === 'DIV' && visible(child)));
  });

const groups = [];
for (let groupIndex = 0; groupIndex < groupRoots.length; groupIndex += 1) {
  const root = groupRoots[groupIndex];
  const regions = [...root.children].filter(element =>
    element.matches?.('div.invisible-possible') && visible(element));
  const headerRegion = regions.find(region =>
    region.querySelector('time, svg[data-icon="copy"], svg[data-icon="envelope"], svg[data-icon="reply"]')) || regions[0];
  const bodyRegion = regions.find(region => region !== headerRegion &&
    [...region.children].some(child => child.tagName === 'DIV' && visible(child)));
  if (!bodyRegion) continue;

  const conversationAnchor = [...headerRegion.querySelectorAll('a[href]')]
    .find(anchor => roomHrefMatches(anchor.getAttribute('href'))) || null;
  const conversationHref = conversationAnchor?.href || null;
  const headerParts = [...headerRegion.children]
    .filter(visible)
    .map(element => clean(element.innerText || directText(element)))
    .filter(Boolean);
  const company = headerParts.find(text => !/(?:ago|yesterday|just now)$/i.test(text)) || null;
  const timeLabel = headerParts.find(text => /(?:ago|yesterday|just now)$/i.test(text)) || null;
  const exactTimeNode = headerRegion.querySelector('time[datetime], [data-datetime]');
  const exactTime = exactTimeNode?.getAttribute('datetime')
    || exactTimeNode?.getAttribute('data-datetime')
    || null;
  const headerButtons = [...headerRegion.querySelectorAll('svg[data-icon]')]
    .map(icon => ({ icon: icon.dataset.icon, semantic: iconSemantic(icon.dataset.icon) }));

  let messageNodes = [...bodyRegion.children].filter(visible);
  if (!messageNodes.length && clean(bodyRegion.innerText)) messageNodes = [bodyRegion];
  const renderedFromMe = getComputedStyle(root).textAlign === 'right' || !conversationHref;
  const componentIdentity = componentMessageIdentity({
    root,
    messageCount: messageNodes.length,
    company,
    fromMe: renderedFromMe,
    visibleExactTime: exactTime,
  });
  const messages = messageNodes.map((messageNode, messageIndex) => {
    const resourceKinds = [...messageNode.querySelectorAll('img[alt^=":re-"]')]
      .map(parseKind)
      .filter(kind => kind !== null);
    const actions = [...messageNode.querySelectorAll('svg[data-icon]')]
      .map(icon => ({ icon: icon.dataset.icon, semantic: iconSemantic(icon.dataset.icon) }));
    return {
      messageId: componentIdentity?.body[messageIndex]?.messageId
        ?? explicitId(messageNode, ['data-message-id', 'data-chat-entry-id', 'data-entry-id']),
      idStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_ID'
        : explicitId(messageNode, ['data-message-id', 'data-chat-entry-id', 'data-entry-id'])
          ? 'EXPLICIT_DOM_ATTRIBUTE' : 'UNKNOWN',
      exactTime: componentIdentity?.body[messageIndex]?.exactTime || null,
      timeStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_DATETIME' : 'UNKNOWN',
      messageIndex,
      text: bodyWithTokens(messageNode),
      visibleText: clean(messageNode.innerText),
      resourceKinds,
      actions,
    };
  }).filter(message => message.text || message.resourceKinds.length);

  if (!messages.length) continue;
  groups.push({
    messageGroupId: componentIdentity?.messageGroupId
      ?? explicitId(root, ['data-message-group-id', 'data-group-id']),
    identityStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_ID'
      : 'DOM_ONLY_OR_UNKNOWN',
    authorStatus: componentIdentity
      ? renderedFromMe ? 'VERIFIED_RENDERED_COMPONENT_SELF_ID'
        : 'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER'
      : explicitId(root, ['data-company-id', 'data-sender-id'])
        ? 'EXPLICIT_DOM_ID_AND_VISIBLE_HEADER' : 'UNKNOWN',
    directionStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_AND_STYLE'
      : 'VERIFIED_RENDERED_STYLE',
    groupIndex,
    fromMe: renderedFromMe,
    company,
    companyId: componentIdentity?.senderId
      ?? explicitId(root, ['data-company-id', 'data-sender-id']),
    conversationHref,
    timeLabel,
    exactTime: componentIdentity?.body[0]?.exactTime || exactIso(exactTime),
    timeStatus: componentIdentity ? 'VERIFIED_RENDERED_COMPONENT_DATETIME'
      : exactIso(exactTime) ? 'EXPLICIT_DOM_DATETIME' : 'UNKNOWN',
    buttons: headerButtons,
    messages,
  });
}

const sendButtons = all('button').filter(button => pane.contains(button)
  && visible(button)
  && !!button.querySelector('svg[data-icon="paper-plane"]'));
const scrollTop = Number(scroller.scrollTop);
const scrollHeight = Number(scroller.scrollHeight);
const clientHeight = Number(scroller.clientHeight);
const atNewest = Number.isFinite(scrollTop) ? scrollTop >= -2 : null;
const atOldest = [scrollTop, scrollHeight, clientHeight].every(Number.isFinite)
  ? Math.abs(scrollTop) + clientHeight >= scrollHeight - 2
  : null;
const emptyDiagnostics = groups.length ? null : {
  scrollerTextLength: clean(scroller.innerText).length,
  scrollerTextExcerpt: clean(scroller.innerText).slice(-1200),
  invisiblePossibleCount: all('div.invisible-possible')
    .filter(element => scroller.contains(element) && visible(element)).length,
  candidates: all('div.invisible-possible')
    .filter(element => scroller.contains(element) && visible(element))
    .slice(-8)
    .map(element => ({
      parentTag: element.parentElement?.tagName || null,
      parentClass: String(element.parentElement?.className || '').slice(0, 240),
      parentTextAlign: element.parentElement ? getComputedStyle(element.parentElement).textAlign : null,
      directChildren: [...element.children].map(child => ({
        tag: child.tagName,
        className: String(child.className || '').slice(0, 160),
        text: clean(child.innerText).slice(0, 180),
      })).slice(0, 12),
      icons: [...element.querySelectorAll('svg[data-icon]')]
        .map(icon => icon.dataset.icon).filter(Boolean).slice(0, 12),
      links: [...element.querySelectorAll('a[href]')]
        .map(anchor => anchor.getAttribute('href')).filter(Boolean).slice(0, 8),
      ancestorChain: (() => {
        const chain = [];
        for (let node = element.parentElement, depth = 0;
          node && node !== scroller && depth < 5;
          node = node.parentElement, depth += 1) {
          chain.push({
            tag: node.tagName,
            className: String(node.className || '').slice(0, 180),
            textAlign: getComputedStyle(node).textAlign,
            directChildCount: node.children.length,
            text: clean(node.innerText).slice(0, 260),
          });
        }
        return chain;
      })(),
    })),
};

return {
  ok: sendButtons.length === 1,
  room,
  paneScoped: true,
  globalVisibleComposerCount: all('textarea[placeholder^="Type here"]').filter(visible).length,
  composer: {
    countInPane: 1,
    sendButtonCountInPane: sendButtons.length,
    valueLength: String(textarea.value || '').length,
  },
  pagination: {
    scrollTop,
    scrollHeight,
    clientHeight,
    atNewest,
    atOldest,
    truncatedOlder: atOldest === false,
  },
  groups,
  messageCount: groups.reduce((sum, group) => sum + group.messages.length, 0),
  emptyDiagnostics,
  coverage: incomingRoots.length
    ? 'all DOM-visible sibling groups in the exact room pane'
    : 'no incoming group anchor was available to establish the message-group container',
  reason: sendButtons.length === 1 ? undefined : 'paper-plane count in exact room pane != 1',
};
