// Compose and send one short public-room post through the rendered UI only.
// Resource icons are inserted through the game's ':' suggestion menu, never as raw tokens.
// The paper-plane is clicked at most once; an ambiguous outcome is terminal for this attempt.
const request = window.__chatRoomPost || {};
const room = String(request.room || '').trim();
const parts = request.parts;
const replyPrefix = typeof request.replyPrefix === 'string' ? request.replyPrefix : '';
const attemptId = String(request.attemptId || '').trim();
const confirm = request.confirm === true;
const maxChars = request.maxChars === undefined ? 60 : request.maxChars;
if (!room) return { ok: false, reason: 'room is required' };
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}
if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 60) {
  return { ok: false, reason: 'maxChars must be an integer between 1 and 60' };
}
if (!Array.isArray(parts) || parts.length < 1 || parts.length > 30) {
  return { ok: false, reason: 'parts must contain between 1 and 30 entries' };
}

const visible = element => !!element && element.offsetParent !== null;
const clean = value => String(value || '')
  .replace(/[\u00a0\u202f]/g, ' ')
  .replace(/[ \t\r\f\v]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .trim();
const nameKey = value => clean(value).toLocaleLowerCase('en-US');
const knownNames = {
  1: { canonical: 'Power', aliases: ['power'] },
  2: { canonical: 'Water', aliases: ['water'] },
  118: { canonical: 'Coffee beans', aliases: ['coffee beans'] },
  119: { canonical: 'Coffee powder', aliases: ['coffee powder', 'coffee ground'] },
};
const steps = [];
const expectedKinds = [];
let bodyMarkup = '';
for (const part of parts) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return { ok: false, reason: 'every post part must be an object' };
  }
  if (part.type === 'text') {
    if (Object.keys(part).some(key => !['type', 'value'].includes(key))) {
      return { ok: false, reason: 'text part contains an unknown field' };
    }
    if (typeof part.value !== 'string' || !part.value.length) {
      return { ok: false, reason: 'text part value must be a non-empty string' };
    }
    if (/:re-\d+:/i.test(part.value)) {
      return { ok: false, reason: 'raw resource tokens are forbidden; use a resource part' };
    }
    const value = /\s$/.test(bodyMarkup) && /^[ \t]/.test(part.value)
      ? part.value.replace(/^[ \t]+/, '')
      : part.value;
    bodyMarkup += value;
    steps.push({ type: 'text', value });
    continue;
  }
  if (part.type === 'resource') {
    if (Object.keys(part).some(key => !['type', 'kind', 'name'].includes(key))) {
      return { ok: false, reason: 'resource part contains an unknown field' };
    }
    const kind = part.kind;
    if (!Number.isSafeInteger(kind) || kind <= 0) {
      return { ok: false, reason: 'resource kind must be a positive safe integer' };
    }
    const known = knownNames[kind];
    const suppliedName = clean(part.name);
    if (known && suppliedName && !known.aliases.includes(nameKey(suppliedName))) {
      return { ok: false, reason: `resource ${kind} name does not match ${known.canonical}` };
    }
    if (!known && !suppliedName) {
      return { ok: false, reason: 'unknown resource kinds require the exact suggestion name' };
    }
    const suggestionName = known ? known.canonical : suppliedName;
    const token = `:re-${kind}:`;
    if (bodyMarkup && !/\s$/.test(bodyMarkup)) bodyMarkup += ' ';
    bodyMarkup += `${token} `;
    expectedKinds.push(kind);
    steps.push({ type: 'resource', kind, token, suggestionName, query: suggestionName });
    continue;
  }
  return { ok: false, reason: 'post part type must be text or resource' };
}
bodyMarkup = bodyMarkup.trim();
if (!bodyMarkup) return { ok: false, reason: 'post is empty' };
if (replyPrefix && (!/^@[^@\r\n]{1,80} $/u.test(replyPrefix) || replyPrefix.length > 82)) {
  return { ok: false, reason: 'replyPrefix must be the exact native @company prefix' };
}
const finalMarkup = `${replyPrefix}${bodyMarkup}`;
if (finalMarkup.length > maxChars) {
  return { ok: false, reason: `public post exceeds ${maxChars} characters`, charCount: finalMarkup.length };
}
if (finalMarkup.split(/\r?\n/).length > 1) {
  return { ok: false, reason: 'public post must be one line' };
}
const expectedVisible = clean(finalMarkup.replace(/:re-\d+:/g, ' '));

const normalizedHref = href => {
  try {
    return decodeURIComponent(new URL(String(href || ''), location.origin).pathname)
      .toLocaleLowerCase('en-US');
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
      && nameKey(image.alt) === nameKey(room));
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
  return {
    ok: false,
    reason: 'exact public-room pane count != 1',
    paneCount: paneMatches.length,
    globalVisibleComposerCount: all('textarea[placeholder^="Type here"]').filter(visible).length,
  };
}

const { pane, textarea, scroller } = paneMatches[0];
const sendButtons = all('button').filter(button => pane.contains(button)
  && visible(button)
  && !!button.querySelector('svg[data-icon="paper-plane"]'));
if (sendButtons.length !== 1) {
  return { ok: false, reason: 'paper-plane count in exact public-room pane != 1', count: sendButtons.length };
}
const sendButton = sendButtons[0];

if (!confirm) {
  return {
    ok: true,
    dry: true,
    paneScoped: true,
    room,
    wouldPost: finalMarkup,
    visibleText: expectedVisible,
    resourceKinds: expectedKinds,
    attemptId,
    charCount: finalMarkup.length,
    note: 'confirm:true composes each resource through the native suggestion UI before one send click',
  };
}
const startingValue = String(textarea.value || '');
if (startingValue !== replyPrefix) {
  return {
    ok: false,
    reason: replyPrefix
      ? 'composer does not contain the exact prefix inserted by the native reply button'
      : 'exact room composer is not empty; refusing to overwrite it',
    expectedStartingValue: replyPrefix,
    actualStartingValue: startingValue,
  };
}

let accumulated = replyPrefix;
for (const step of steps) {
  if (step.type === 'text') {
    accumulated += step.value;
    setInput(textarea, accumulated);
    await sleep(80);
    if (String(textarea.value || '') !== accumulated) {
      return { ok: false, reason: 'composer rejected an exact text step', sendClicked: false };
    }
    continue;
  }

  if (accumulated && !/\s$/.test(accumulated)) accumulated += ' ';
  const triggerValue = `${accumulated}:${step.query}`;
  setInput(textarea, triggerValue);
  await sleep(350);
  const suggestionImages = all('img[alt]').filter(image => pane.contains(image)
    && visible(image)
    && nameKey(image.alt) === nameKey(step.suggestionName)
    && !/^:re-\d+:$/.test(String(image.alt || '')));
  const options = [...new Set(suggestionImages.map(image =>
    image.closest('[role="option"], li') || image.parentElement?.parentElement || image)
    .filter(element => element && pane.contains(element) && visible(element)))];
  if (options.length !== 1) {
    setInput(textarea, '');
    return {
      ok: false,
      reason: 'exact resource suggestion count != 1',
      kind: step.kind,
      suggestionName: step.suggestionName,
      count: options.length,
      sendClicked: false,
    };
  }

  options[0].click();
  await sleep(180);
  accumulated += `${step.token} `;
  if (String(textarea.value || '') !== accumulated) {
    setInput(textarea, '');
    return {
      ok: false,
      reason: 'native resource suggestion did not insert the exact expected token',
      kind: step.kind,
      expected: accumulated,
      actual: String(textarea.value || ''),
      sendClicked: false,
    };
  }
}

const kindsUnder = element => [...element.querySelectorAll('img[alt^=":re-"]')]
  .map(image => {
    const match = String(image.alt || '').match(/^:re-(\d+):$/);
    return match ? Number(match[1]) : null;
  })
  .filter(kind => Number.isSafeInteger(kind) && kind > 0);
const sameKinds = kinds => kinds.length === expectedKinds.length
  && kinds.every((kind, index) => kind === expectedKinds[index]);
const approvedComposerMarkup = String(textarea.value || '');
// Message-history icons are not composer entities. Suggestion menus have closed by this point,
// leaving the native mention highlighter adjacent to the exact textarea.
let composerScope = textarea.parentElement;
while (composerScope?.parentElement && composerScope.parentElement !== pane
    && !composerScope.parentElement.contains(scroller)
    && composerScope.parentElement.querySelectorAll('textarea[placeholder^="Type here"]').length === 1) {
  composerScope = composerScope.parentElement;
}
const nativeComposerKinds = [...(composerScope || pane).querySelectorAll('img[alt^=":re-"]')]
  .filter(visible)
  .map(image => {
    const match = String(image.alt || '').match(/^:re-(\d+):$/);
    return match ? Number(match[1]) : null;
  })
  .filter(kind => Number.isSafeInteger(kind) && kind > 0);
if (clean(approvedComposerMarkup) !== clean(finalMarkup) || !sameKinds(nativeComposerKinds)) {
  setInput(textarea, '');
  return {
    ok: false,
    reason: 'native composer entities do not match the approved post; refusing to send raw tokens',
    expectedKinds,
    nativeComposerKinds,
    sendClicked: false,
  };
}
if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
  setInput(textarea, '');
  return { ok: false, reason: 'exact public-room paper-plane remains disabled after native composition' };
}
const signatureMatches = element => visible(element)
  && clean(element.innerText) === expectedVisible
  && sameKinds(kindsUnder(element));
const exactMessageCount = () => {
  const candidates = all('div, span, p').filter(element => scroller.contains(element)
    && signatureMatches(element));
  const minimal = candidates.filter(element => ![...element.querySelectorAll('div, span, p')]
    .some(descendant => descendant !== element && signatureMatches(descendant)));
  return minimal.length;
};

const beforeCount = exactMessageCount();
sendButton.click();
let afterCount = exactMessageCount();
for (let attempt = 0; attempt < 24; attempt += 1) {
  await sleep(250);
  afterCount = exactMessageCount();
  if (afterCount !== beforeCount && String(textarea.value || '') === '') break;
}
const landed = afterCount === beforeCount + 1 && String(textarea.value || '') === '';
return {
  ok: landed,
  posted: landed ? true : null,
  sendClicked: true,
  room,
  attemptId,
  beforeCount,
  afterCount,
  composerCleared: String(textarea.value || '') === '',
  resourceKinds: expectedKinds,
  status: landed ? 'VERIFIED' : 'UNKNOWN_AFTER_SINGLE_CLICK',
  doNotRetry: !landed,
  reason: landed
    ? undefined
    : 'single paper-plane click was not followed by exactly one matching rendered message',
};
