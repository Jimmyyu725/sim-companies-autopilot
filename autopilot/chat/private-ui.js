'use strict';

const { inspectOutgoingText } = require('./policy.js');

const MAX_PRIVATE_MESSAGE_LENGTH = 180;
const MAX_PRIVATE_MESSAGE_LINES = 3;

const FORBIDDEN_IDENTITY_PATTERNS = [
  { label: 'AI identity', re: /(?:^|[^a-z0-9])(?:ai|artificial intelligence|language model)(?:$|[^a-z0-9])/iu },
  { label: 'automation identity', re: /(?:^|[^a-z0-9])(?:(?:this )?account is automated|bot|robot|chatbot|automated assistant)(?:$|[^a-z0-9])/iu },
  { label: 'assistant identity', re: /(?:^|[^a-z0-9])(?:assistant|virtual assistant)(?:$|[^a-z0-9])/iu },
  { label: 'delegation language', re: /\b(?:person in charge|pass (?:it|this) on|forward (?:it|this)|ask (?:the )?(?:owner|boss|manager))\b/iu },
  { label: 'self-name disclosure', re: /\b(?:my name is|my name's|i am called|i'm called)\b/iu },
  { label: 'Chinese AI identity', re: /人工智能|机器人|聊天机器人|语言模型|大模型|智能助手|虚拟助手|助手/u },
  { label: 'Chinese delegation language', re: /负责人|转达|转交|请示老板|询问老板|老板不在/u },
  { label: 'Chinese self-name disclosure', re: /我叫|我的名字(?:是|叫)/u },
];

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function normalizeCompanyName(value) {
  return normalizeText(value).replace(/\s+/g, ' ');
}

function companyRouteToken(company) {
  return normalizeCompanyName(company).replace(/ /g, '-');
}

function parseMessagesRoute(href) {
  try {
    const url = new URL(String(href), 'https://www.simcompanies.com');
    const decoded = decodeURIComponent(url.pathname);
    const match = decoded.match(/(?:^|\/)messages(?:\/([^/]+))?\/?$/iu);
    if (!match) return null;
    return {
      href: url.href,
      pathname: decoded,
      route: match[1] || '',
    };
  } catch (_) {
    return null;
  }
}

function publicEnvelopeRoute(company, room) {
  const name = normalizeCompanyName(company);
  const roomName = normalizeText(room);
  if (!name || !roomName) return null;
  return `${name}-chatroom_${roomName}`;
}

function validatePublicEnvelope({ href, company, room }) {
  const parsed = parseMessagesRoute(href);
  const expectedRoute = publicEnvelopeRoute(company, room);
  if (!parsed || !expectedRoute) {
    return { ok: false, reason: 'invalid envelope route evidence' };
  }
  if (parsed.route !== expectedRoute) {
    return {
      ok: false,
      reason: 'envelope route does not bind the exact company and source room',
      expectedRoute,
      observedRoute: parsed.route,
    };
  }
  return { ok: true, expectedRoute, pathname: parsed.pathname };
}

function routeContainsExactCompany(route, company) {
  const normalizedRoute = normalizeText(route);
  const exact = normalizeCompanyName(company);
  if (!normalizedRoute || !exact) return false;
  return normalizedRoute === exact || normalizedRoute.startsWith(`${exact}-chatroom_`);
}

function validatePrivateDestination({ href, header, company, companyId, contactCompanyIds = [] }) {
  const parsed = parseMessagesRoute(href);
  const expectedCompany = normalizeCompanyName(company);
  const observedHeader = normalizeCompanyName(header);
  if (!parsed || !routeContainsExactCompany(parsed.route, expectedCompany)) {
    return { ok: false, reason: 'private route is not bound to the expected company' };
  }
  if (!expectedCompany || observedHeader.toLocaleLowerCase('en-US') !== expectedCompany.toLocaleLowerCase('en-US')) {
    return { ok: false, reason: 'private pane header is not the expected company' };
  }
  const expectedId = Number(companyId);
  const ids = [...new Set((contactCompanyIds || []).map(Number).filter(Number.isSafeInteger))];
  const idRequested = Number.isSafeInteger(expectedId) && expectedId > 0;
  const idVerified = idRequested ? ids.includes(expectedId) : false;
  return {
    ok: true,
    company: expectedCompany,
    companyId: idRequested ? expectedId : null,
    idVerified,
    pathname: parsed.pathname,
  };
}

function explicitNonNegativeInteger(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeContactRecords(records) {
  if (!Array.isArray(records)) return { ok: false, reason: 'contacts must be an array' };
  const seen = new Set();
  const contacts = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, reason: 'contact record is malformed' };
    }
    const companyId = explicitNonNegativeInteger(record.companyId ?? record.id);
    const company = normalizeCompanyName(record.company ?? record.name);
    const unread = explicitNonNegativeInteger(record.unread);
    if (!companyId || !company || unread == null) {
      return { ok: false, reason: 'contact is missing companyId, company, or unread evidence' };
    }
    if (seen.has(companyId)) return { ok: false, reason: `duplicate contact companyId ${companyId}` };
    seen.add(companyId);
    contacts.push({
      companyId,
      company,
      unread,
      pinned: record.pinned === true,
      privateNote: typeof record.privateNote === 'string' ? normalizeText(record.privateNote) : null,
      realmId: explicitNonNegativeInteger(record.realmId ?? record.realm),
      route: typeof record.route === 'string' ? record.route : null,
    });
  }
  return { ok: true, contacts };
}

function normalizeSender(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const companyId = explicitNonNegativeInteger(raw.companyId ?? raw.id);
  const company = normalizeCompanyName(raw.company ?? raw.name);
  if (!companyId || !company) return null;
  return { companyId, company };
}

function normalizeThreadMessages(records, { ownCompanyId = null } = {}) {
  if (!Array.isArray(records)) return { ok: false, reason: 'messages must be an array' };
  const ownId = explicitNonNegativeInteger(ownCompanyId);
  const seen = new Set();
  const messages = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, reason: 'message record is malformed' };
    }
    const id = explicitNonNegativeInteger(record.id);
    const sender = normalizeSender(record.sender);
    const body = normalizeText(record.dec && record.dec.body != null ? record.dec.body : record.body);
    const datetime = typeof record.datetime === 'string' && Number.isFinite(Date.parse(record.datetime))
      ? new Date(record.datetime).toISOString()
      : null;
    if (!id || !sender || !body || !datetime) {
      return { ok: false, reason: 'message is missing id, sender, body, or datetime evidence' };
    }
    if (seen.has(id)) return { ok: false, reason: `duplicate message id ${id}` };
    seen.add(id);
    const fromMe = ownId != null ? sender.companyId === ownId : record.fromMe === true;
    messages.push({
      id,
      sender,
      body,
      datetime,
      fromMe,
      retracted: record.retracted === true,
      deleted: record.deleted === true,
      pinned: record.pinned === true,
      trust: fromMe ? 'LOCAL_COMPANY_MESSAGE' : 'EXTERNAL_UNTRUSTED_DATA',
      instructionAuthority: fromMe ? 'local-output' : 'none',
    });
  }
  messages.sort((a, b) => a.id - b.id);
  return { ok: true, messages };
}

function incrementalMessages(messages, afterId) {
  const cursor = explicitNonNegativeInteger(afterId);
  if (cursor == null) return { ok: false, reason: 'afterId must be a non-negative integer' };
  const normalized = normalizeThreadMessages(messages);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    afterId: cursor,
    messages: normalized.messages.filter(message => message.id > cursor),
  };
}

function parseResourceIconAlt(alt) {
  const match = normalizeText(alt).match(/^:re-(\d+):$/u);
  if (!match) return null;
  const kind = Number(match[1]);
  return Number.isSafeInteger(kind) && kind > 0 ? kind : null;
}

function observationFingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `ui-observation-fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

// Normalizes evidence already observed from individual rendered DOM groups. The ordinal is part of
// the fingerprint so two identical visible messages remain two observations. This fingerprint is
// deliberately not a server ID and is not safe as a durable pagination cursor.
function normalizeObservedMessageGroups(groups) {
  if (!Array.isArray(groups)) return { ok: false, reason: 'observed groups must be an array' };
  const messages = [];
  groups.forEach((group, groupOrdinal) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return;
    const authorCandidates = [...new Map((group.authorCandidates || [])
      .map(normalizeCompanyName)
      .filter(Boolean)
      .map(company => [company.toLocaleLowerCase('en-US'), company])).values()];
    const authorCompany = authorCandidates.length === 1 ? authorCandidates[0] : null;
    const direction = group.directionEvidence === true && ['INCOMING', 'OUTGOING'].includes(group.direction)
      ? group.direction
      : 'UNKNOWN';
    const groupTime = group.renderedTimeEvidence === true ? normalizeText(group.renderedTime) || null : null;
    const observedBodies = Array.isArray(group.messages) ? group.messages : [];
    observedBodies.forEach((message, messageOrdinal) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const visibleBody = normalizeText(message.visibleBody ?? message.body);
      const resourceKinds = [...new Set((message.resourceKinds || [])
        .map(Number)
        .filter(kind => Number.isSafeInteger(kind) && kind > 0))];
      if (!visibleBody && resourceKinds.length === 0) return;
      const renderedTime = message.renderedTimeEvidence === true
        ? normalizeText(message.renderedTime) || null
        : groupTime;
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
        serverMessageId: null,
        idStatus: 'UNKNOWN',
        observationFingerprint: observationFingerprint(JSON.stringify(evidence)),
        groupOrdinal,
        messageOrdinal,
        authorCompany,
        authorRole: direction === 'OUTGOING' ? 'SELF' : direction === 'INCOMING' ? 'COUNTERPART' : 'UNKNOWN',
        authorStatus: authorCompany ? 'VERIFIED_VISIBLE_GROUP_HEADER' : 'UNKNOWN',
        direction,
        directionStatus: direction === 'UNKNOWN' ? 'UNKNOWN' : 'VERIFIED_RENDERED_STYLE',
        visibleBody,
        resourceKinds,
        renderedTime,
        timeStatus: renderedTime ? 'VERIFIED_RENDERED' : 'UNKNOWN',
        trust: direction === 'OUTGOING' ? 'LOCAL_COMPANY_MESSAGE' : 'EXTERNAL_OR_UNATTRIBUTED_UNTRUSTED_DATA',
        instructionAuthority: direction === 'OUTGOING' ? 'local-output' : 'none',
      });
    });
  });
  return { ok: true, messages };
}

function validateOutgoingText(value) {
  const text = normalizeText(value);
  if (!text) return { ok: false, reason: 'message is empty' };
  if (text.length > MAX_PRIVATE_MESSAGE_LENGTH) {
    return { ok: false, reason: `message exceeds ${MAX_PRIVATE_MESSAGE_LENGTH} characters` };
  }
  if (text.split('\n').length > MAX_PRIVATE_MESSAGE_LINES) {
    return { ok: false, reason: `message exceeds ${MAX_PRIVATE_MESSAGE_LINES} lines` };
  }
  const policyInspection = inspectOutgoingText(text, { scope: 'private' });
  if (!policyInspection.ok) {
    return { ok: false, reason: 'message violates the identity/delegation policy' };
  }
  for (const pattern of FORBIDDEN_IDENTITY_PATTERNS) {
    if (pattern.re.test(text)) return { ok: false, reason: `forbidden ${pattern.label}` };
  }
  return { ok: true, text };
}

function isIdentityQuestion(value) {
  const text = normalizeText(value);
  return /\b(?:are you (?:an? )?(?:ai|bot|robot|assistant)|who are you|what(?:'s| is) your name|is this (?:the )?(?:owner|boss)|am i talking to)\b/iu.test(text)
    || /你是(?:人工智能|AI|机器人|助手)吗|你是谁|你叫什么|你的名字|是老板吗|本人吗/u.test(text);
}

function identitySafeReply(value) {
  if (!isIdentityQuestion(value)) return null;
  return 'I run this company. What do you need?';
}

function verifyUniqueSendPostcondition({ before, after, ownCompanyId, text, baselineMaxId = null }) {
  const expected = validateOutgoingText(text);
  if (!expected.ok) return expected;
  const beforeNormalized = normalizeThreadMessages(before, { ownCompanyId });
  const afterNormalized = normalizeThreadMessages(after, { ownCompanyId });
  if (!beforeNormalized.ok || !afterNormalized.ok) {
    return { ok: false, ambiguous: true, doNotRetry: true, reason: 'message identity evidence is malformed' };
  }
  const beforeIds = new Set(beforeNormalized.messages.map(message => message.id));
  const inferredBaseline = beforeNormalized.messages.reduce((max, message) => Math.max(max, message.id), 0);
  const requestedBaseline = explicitNonNegativeInteger(baselineMaxId);
  const baseline = requestedBaseline == null ? inferredBaseline : requestedBaseline;
  const candidates = afterNormalized.messages.filter(message =>
    message.fromMe
    && message.id > baseline
    && !beforeIds.has(message.id)
    && message.body === expected.text);
  if (candidates.length !== 1) {
    return {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: `expected exactly one new own message, observed ${candidates.length}`,
      candidateIds: candidates.map(message => message.id),
    };
  }
  return { ok: true, posted: true, messageId: candidates[0].id, body: candidates[0].body };
}

function assessFailedSendRetry({
  failureVisible,
  priorOutcome,
  originalClickProvenAbsent,
  pendingBodies = [],
  messages = [],
  ownCompanyId,
  text,
  baselineMaxId,
}) {
  const expected = validateOutgoingText(text);
  if (!expected.ok) return expected;
  if (originalClickProvenAbsent !== true || priorOutcome !== 'pre-click-failure') {
    return { ok: false, doNotRetry: true, reason: 'only a proven pre-click failure may create a new attempt' };
  }
  if (failureVisible === true) {
    return { ok: false, doNotRetry: true, reason: 'a failed-send row proves a UI send existed' };
  }
  if ((pendingBodies || []).map(normalizeText).includes(expected.text)) {
    return { ok: false, doNotRetry: true, reason: 'the same message is still pending' };
  }
  const normalized = normalizeThreadMessages(messages, { ownCompanyId });
  if (!normalized.ok) {
    return { ok: false, doNotRetry: true, reason: 'cannot prove the failed message was not delivered' };
  }
  const baseline = explicitNonNegativeInteger(baselineMaxId);
  if (baseline == null) {
    return { ok: false, doNotRetry: true, reason: 'retry requires the original baseline message id' };
  }
  const alreadyDelivered = normalized.messages.some(message =>
    message.fromMe && message.id > baseline && message.body === expected.text);
  if (alreadyDelivered) {
    return { ok: false, alreadyDelivered: true, doNotRetry: true, reason: 'the message already landed' };
  }
  return { ok: true, retryAllowed: true, text: expected.text, baselineMaxId: baseline };
}

module.exports = {
  FORBIDDEN_IDENTITY_PATTERNS,
  MAX_PRIVATE_MESSAGE_LENGTH,
  MAX_PRIVATE_MESSAGE_LINES,
  assessFailedSendRetry,
  companyRouteToken,
  explicitNonNegativeInteger,
  identitySafeReply,
  incrementalMessages,
  isIdentityQuestion,
  normalizeCompanyName,
  normalizeContactRecords,
  normalizeObservedMessageGroups,
  normalizeText,
  normalizeThreadMessages,
  parseMessagesRoute,
  parseResourceIconAlt,
  observationFingerprint,
  publicEnvelopeRoute,
  routeContainsExactCompany,
  validateOutgoingText,
  validatePrivateDestination,
  validatePublicEnvelope,
  verifyUniqueSendPostcondition,
};
