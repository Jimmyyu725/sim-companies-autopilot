'use strict';

const MAX_PUBLIC_POST_CHARS = 60;
const MAX_PUBLIC_POST_LINES = 1;

const KNOWN_RESOURCE_NAMES = Object.freeze({
  1: Object.freeze({ canonical: 'Power', aliases: Object.freeze(['Power']) }),
  2: Object.freeze({ canonical: 'Water', aliases: Object.freeze(['Water']) }),
  118: Object.freeze({
    canonical: 'Coffee beans',
    aliases: Object.freeze(['Coffee beans', 'Coffee Beans']),
  }),
  119: Object.freeze({
    canonical: 'Coffee powder',
    aliases: Object.freeze(['Coffee powder', 'Coffee Powder', 'Coffee ground', 'Coffee Ground']),
  }),
});

const BUTTON_SEMANTICS = Object.freeze({
  copy: 'copy_company_name',
  envelope: 'open_private_conversation',
  reply: 'mention_reply',
  retract: 'retract_own_message',
  thumbtack: 'pin_message',
  trash: 'delete_message_moderator_only',
  'trash-alt': 'delete_message_moderator_only',
  language: 'translate_message',
  'paper-plane': 'send_message',
  'arrow-down': 'scroll_to_newest',
});

function normalizeInlineText(value) {
  return String(value ?? '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function strictPositiveInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function parseResourceToken(value) {
  const match = String(value ?? '').trim().match(/^:re-(\d+):$/);
  if (!match) return null;
  const kind = Number(match[1]);
  return strictPositiveInteger(kind);
}

function parseResourceAlt(alt) {
  return parseResourceToken(alt);
}

function resourceToken(kind) {
  const parsed = strictPositiveInteger(kind);
  if (parsed === null) throw new TypeError('resource kind must be a positive safe integer');
  return `:re-${parsed}:`;
}

function normalizeName(value) {
  return normalizeInlineText(value).toLocaleLowerCase('en-US');
}

function resourceSuggestionSpec(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    throw new TypeError('resource part must be an object');
  }
  const keys = Object.keys(part);
  if (keys.some(key => !['type', 'kind', 'name'].includes(key))) {
    throw new TypeError('resource part contains an unknown field');
  }
  const kind = strictPositiveInteger(part.kind);
  if (kind === null) throw new TypeError('resource kind must be a positive safe integer');

  const known = KNOWN_RESOURCE_NAMES[kind];
  const suppliedName = normalizeInlineText(part.name);
  if (known && suppliedName) {
    const aliases = known.aliases.map(normalizeName);
    if (!aliases.includes(normalizeName(suppliedName))) {
      throw new TypeError(`resource ${kind} name does not match ${known.canonical}`);
    }
  }
  if (!known && !suppliedName) {
    throw new TypeError('unknown resource kinds require the exact visible suggestion name');
  }

  return {
    kind,
    token: resourceToken(kind),
    suggestionName: known ? known.canonical : suppliedName,
    query: known ? known.canonical : suppliedName,
  };
}

function appendResourceToken(markup, token) {
  let next = markup;
  if (next && !/\s$/.test(next)) next += ' ';
  next += token;
  next += ' ';
  return next;
}

function appendTextValue(markup, value) {
  if (/\s$/.test(markup) && /^[ \t]/.test(value)) {
    return markup + value.replace(/^[ \t]+/, '');
  }
  return markup + value;
}

function buildPublicPostPlan(parts, options = {}) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 30) {
    throw new TypeError('parts must contain between 1 and 30 entries');
  }
  let markup = '';
  const resources = [];
  const steps = [];

  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new TypeError('every post part must be an object');
    }
    if (part.type === 'text') {
      const keys = Object.keys(part);
      if (keys.some(key => !['type', 'value'].includes(key))) {
        throw new TypeError('text part contains an unknown field');
      }
      if (typeof part.value !== 'string' || part.value.length === 0) {
        throw new TypeError('text part value must be a non-empty string');
      }
      if (/:re-\d+:/i.test(part.value)) {
        throw new TypeError('raw resource tokens are forbidden; use a resource part and the UI suggestion');
      }
      markup = appendTextValue(markup, part.value);
      steps.push({ type: 'text', value: part.value });
      continue;
    }
    if (part.type === 'resource') {
      const spec = resourceSuggestionSpec(part);
      markup = appendResourceToken(markup, spec.token);
      resources.push(spec.kind);
      steps.push({ type: 'resource', ...spec });
      continue;
    }
    throw new TypeError('post part type must be text or resource');
  }

  markup = markup.trim();
  const prefix = typeof options.replyPrefix === 'string' ? options.replyPrefix : '';
  const finalMarkup = `${prefix}${markup}`;
  const maxChars = options.maxChars === undefined
    ? MAX_PUBLIC_POST_CHARS
    : strictPositiveInteger(options.maxChars);
  if (maxChars === null || maxChars > MAX_PUBLIC_POST_CHARS) {
    throw new TypeError(`maxChars must be between 1 and ${MAX_PUBLIC_POST_CHARS}`);
  }
  if (!finalMarkup.trim()) throw new TypeError('post is empty');
  if (finalMarkup.length > maxChars) {
    throw new RangeError(`public post exceeds ${maxChars} characters`);
  }
  const lineCount = finalMarkup.split(/\r?\n/).length;
  if (lineCount > MAX_PUBLIC_POST_LINES) {
    throw new RangeError(`public post exceeds ${MAX_PUBLIC_POST_LINES} lines`);
  }

  return {
    finalMarkup,
    visibleText: normalizeInlineText(finalMarkup.replace(/:re-\d+:/g, ' ')),
    resourceKinds: resources,
    steps,
    charCount: finalMarkup.length,
    lineCount,
  };
}

function directRoomFromHref(href, base = 'https://www.simcompanies.com/') {
  let parsed;
  try {
    parsed = new URL(String(href), base);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^\/messages\/chatroom_([^/]+)\/?$/i);
  if (!match) return null;
  let room;
  try {
    room = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  room = normalizeInlineText(room);
  if (!room) return null;
  return {
    room,
    slug: `chatroom_${encodeURIComponent(room)}`,
    url: `${parsed.origin}/messages/chatroom_${encodeURIComponent(room)}/`,
  };
}

function unreadFromLabel(label) {
  const text = normalizeInlineText(label).replace(/\n/g, ' ');
  const match = text.match(/(?:^|\s)(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function discoverRoomLinks(links, base) {
  if (!Array.isArray(links)) throw new TypeError('links must be an array');
  const rooms = new Map();
  for (const link of links) {
    const parsed = directRoomFromHref(link?.href, base);
    if (!parsed) continue;
    const current = rooms.get(parsed.url);
    const candidate = {
      ...parsed,
      unread: unreadFromLabel(link?.text),
      active: link?.active === true,
    };
    if (!current || candidate.active || candidate.unread > current.unread) {
      rooms.set(parsed.url, candidate);
    }
  }
  return [...rooms.values()].sort((a, b) => a.room.localeCompare(b.room, 'en'));
}

function buttonSemantic(iconName) {
  const key = String(iconName ?? '').trim().toLowerCase();
  return BUTTON_SEMANTICS[key] ?? 'unknown';
}

function paneHasExactRoomEvidence(pane, room) {
  const wanted = normalizeInlineText(room).toLocaleLowerCase('en-US');
  if (!wanted || !pane || pane.visible !== true) return false;
  const headers = Array.isArray(pane.exactHeaders) ? pane.exactHeaders : [];
  const iconAlts = Array.isArray(pane.iconAlts) ? pane.iconAlts : [];
  const hrefs = Array.isArray(pane.conversationHrefs) ? pane.conversationHrefs : [];
  const exactHeader = headers.some(value => normalizeName(value) === wanted);
  const exactRoomIcon = iconAlts.some(value => normalizeName(value) === wanted);
  const roomHref = hrefs.some(href => {
    let decoded;
    try {
      decoded = decodeURIComponent(String(href));
    } catch {
      return false;
    }
    return decoded.toLocaleLowerCase('en-US').includes(`-chatroom_${wanted}`)
      || decoded.toLocaleLowerCase('en-US').includes(`/chatroom_${wanted}`);
  });
  return exactHeader && (exactRoomIcon || roomHref);
}

function choosePublicRoomPane(panes, room) {
  if (!Array.isArray(panes)) throw new TypeError('panes must be an array');
  const matches = panes.filter(pane => paneHasExactRoomEvidence(pane, room)
    && pane.textareaCount === 1
    && pane.sendButtonCount === 1);
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: 'exact public room pane count is not one',
      count: matches.length,
    };
  }
  return { ok: true, pane: matches[0] };
}

function exactRenderedSignature(candidate, expected) {
  if (!candidate || !expected) return false;
  const text = normalizeInlineText(candidate.visibleText);
  const kinds = Array.isArray(candidate.resourceKinds) ? candidate.resourceKinds : [];
  if (text !== normalizeInlineText(expected.visibleText)) return false;
  if (kinds.length !== expected.resourceKinds.length) return false;
  return kinds.every((kind, index) => kind === expected.resourceKinds[index]);
}

function verifySingleSendTransition({ beforeCount, afterCount, composerValue, sendClicked }) {
  if (sendClicked !== true) {
    return { ok: false, posted: false, doNotRetry: false, reason: 'send was not clicked' };
  }
  if (!Number.isSafeInteger(beforeCount) || beforeCount < 0
      || !Number.isSafeInteger(afterCount) || afterCount < 0) {
    return {
      ok: false,
      posted: null,
      doNotRetry: true,
      status: 'UNKNOWN_AFTER_SINGLE_CLICK',
      reason: 'message counts are invalid after the single send click',
    };
  }
  if (afterCount === beforeCount + 1 && String(composerValue ?? '') === '') {
    return { ok: true, posted: true, doNotRetry: false };
  }
  return {
    ok: false,
    posted: null,
    doNotRetry: true,
    status: 'UNKNOWN_AFTER_SINGLE_CLICK',
    reason: 'exact rendered message transition was not proven after the single send click',
  };
}

function replyPrefix(company) {
  const clean = normalizeInlineText(company);
  if (!clean || clean.length > 80 || /[@\r\n]/.test(clean)) {
    throw new TypeError('company name cannot form a safe mention');
  }
  return `@${clean.replace(/ /g, '-')} `;
}

module.exports = {
  BUTTON_SEMANTICS,
  KNOWN_RESOURCE_NAMES,
  MAX_PUBLIC_POST_CHARS,
  MAX_PUBLIC_POST_LINES,
  buildPublicPostPlan,
  buttonSemantic,
  choosePublicRoomPane,
  directRoomFromHref,
  discoverRoomLinks,
  exactRenderedSignature,
  normalizeInlineText,
  parseResourceAlt,
  parseResourceToken,
  paneHasExactRoomEvidence,
  replyPrefix,
  resourceSuggestionSpec,
  resourceToken,
  unreadFromLabel,
  verifySingleSendTransition,
};
