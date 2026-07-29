'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  atomicWriteJson,
  withFileLock,
} = require('./persistence.js');
const {
  contractTermsHash,
  evaluateContractGate,
  normalizeTerms,
} = require('./contract-gate.js');
const {
  DEFAULT_MAX_EVIDENCE_AGE_MS,
  evaluateBusinessIntentOpportunity,
  evaluateLeadOpportunity,
} = require('./lead-engine.js');
const {
  draftLeadResponse,
  draftPrivateAcceptance,
  draftPrivateQuote,
} = require('./negotiation.js');
const {
  buildPublicPostPlan,
  replyPrefix,
} = require('./public-ui.js');
const { hasEconomicCommunicationLanguage } = require('./policy.js');
const { verifyProactivePublicIntent } = require('./public-economic-intent.js');

const AUTHORIZATION_SCHEMA_VERSION = 1;
const STORE_SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 5000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const ALLOWED_INTENTS = new Set(['quote', 'supply-promise', 'agreement', 'public-offer']);
const ALLOWED_DELIVERIES = new Set(['public-post', 'public-reply', 'private-reply']);
const LIFECYCLE_STATUSES = new Set([
  'AUTHORIZED',
  'CONSUMED',
  'VERIFIED',
  'AMBIGUOUS',
  'FAILED_PRE_CLICK',
]);

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex');
}

function exactKeys(value, expected, field) {
  const actual = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${field} contains unexpected or missing fields`);
  }
}

function parseNow(value) {
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError('now must be a Date or millisecond timestamp');
  return parsed;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length > 64) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function boundedString(value, field, { min = 1, max = 500, trim = true } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length < min || normalized.length > max) {
    throw new RangeError(`${field} must contain ${min}..${max} characters`);
  }
  return normalized;
}

function attemptIdentifier(value, field = 'attemptId') {
  const normalized = boundedString(value, field, { min: 8, max: 100 });
  if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(normalized)) {
    throw new TypeError(`${field} must be an opaque 8-100 character identifier`);
  }
  return normalized;
}

function companyIdentifier(value, field) {
  const normalized = boundedString(String(value ?? ''), field, { max: 160 });
  if (['__proto__', 'prototype', 'constructor'].includes(normalized)) {
    throw new TypeError(`${field} is unsafe`);
  }
  return normalized;
}

function positiveCompanyNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${field} must be a positive company ID`);
  }
  return parsed;
}

function normalizeConversationHref(value, field, required) {
  if (value == null && !required) return null;
  const raw = boundedString(value, field, { max: 500 });
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new TypeError(`${field} must be an absolute URL`); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.simcompanies.com'
      || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError(`${field} must be an exact Sim Companies HTTPS conversation URL`);
  }
  return parsed.href;
}

function normalizeSource(input, { requireHref = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('source must be an object');
  }
  exactKeys(input, [
    'conversationHref',
    'createdAt',
    'conversationId',
    'conversationType',
    'counterpartyCompanyId',
    'counterpartyCompanyName',
    'messageId',
    'observedAt',
    'visibleText',
  ], 'source');
  if (!['room', 'private'].includes(input.conversationType)) {
    throw new TypeError('source.conversationType must be room or private');
  }
  return {
    conversationType: input.conversationType,
    conversationId: boundedString(input.conversationId, 'source.conversationId', { max: 160 }),
    messageId: boundedString(input.messageId, 'source.messageId', { max: 160 }),
    counterpartyCompanyId: companyIdentifier(
      input.counterpartyCompanyId,
      'source.counterpartyCompanyId',
    ),
    counterpartyCompanyName: boundedString(
      input.counterpartyCompanyName,
      'source.counterpartyCompanyName',
      { max: 160 },
    ),
    observedAt: timestamp(input.observedAt, 'source.observedAt'),
    createdAt: timestamp(input.createdAt, 'source.createdAt'),
    visibleText: boundedString(input.visibleText, 'source.visibleText', { min: 4, max: 500 }),
    conversationHref: normalizeConversationHref(
      input.conversationHref,
      'source.conversationHref',
      requireHref,
    ),
  };
}

function normalizeDestination(input, delivery, source) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('destination must be an object');
  }
  if (delivery.startsWith('public-')) {
    exactKeys(input, ['conversationId', 'conversationType', 'room'], 'destination');
    if (input.conversationType !== 'room') {
      throw new TypeError('public destination must have conversationType room');
    }
    const room = boundedString(input.room, 'destination.room', { max: 120 });
    const conversationId = boundedString(
      input.conversationId,
      'destination.conversationId',
      { max: 160 },
    );
    if (source.conversationType !== 'room' || source.conversationId !== conversationId
        || conversationId !== room) {
      throw new Error('public destination must exactly match the source room');
    }
    return { conversationType: 'room', conversationId, room };
  }
  exactKeys(input, [
    'conversationId',
    'conversationType',
    'targetCompany',
    'targetCompanyId',
  ], 'destination');
  if (input.conversationType !== 'private') {
    throw new TypeError('private destination must have conversationType private');
  }
  const conversationId = boundedString(
    input.conversationId,
    'destination.conversationId',
    { max: 160 },
  );
  const targetCompany = boundedString(
    input.targetCompany,
    'destination.targetCompany',
    { max: 160 },
  );
  const targetCompanyId = positiveCompanyNumber(
    input.targetCompanyId,
    'destination.targetCompanyId',
  );
  if (source.conversationType !== 'private' || source.conversationId !== conversationId
      || source.counterpartyCompanyName !== targetCompany
      || source.counterpartyCompanyId !== String(targetCompanyId)) {
    throw new Error('private destination must exactly match the source counterparty and conversation');
  }
  return {
    conversationType: 'private',
    conversationId,
    targetCompany,
    targetCompanyId,
  };
}

function rejectUnknownKeys(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${field} contains unknown fields: ${unknown.join(', ')}`);
}

function assertTypedBusinessSnapshot(snapshot) {
  exactKeys(snapshot, [
    'economics',
    'finance',
    'inventory',
    'markets',
    'observedAt',
    'schemaVersion',
    'snapshotId',
    'transport',
  ], 'businessSnapshot');
  if (!Array.isArray(snapshot.inventory) || !Array.isArray(snapshot.markets)
      || !Array.isArray(snapshot.economics)
      || snapshot.inventory.length > 500 || snapshot.markets.length > 500
      || snapshot.economics.length > 500) {
    throw new TypeError('businessSnapshot evidence arrays are invalid or unbounded');
  }
  snapshot.inventory.forEach((entry, index) => rejectUnknownKeys(entry, [
    'blockedAmount', 'kind', 'observedAt', 'onHandAmount', 'quality', 'reserveAmount',
    'status', 'unitCost',
  ], `businessSnapshot.inventory[${index}]`));
  snapshot.markets.forEach((entry, index) => rejectUnknownKeys(entry, [
    'bestAsk', 'bestBid', 'kind', 'marketPrice', 'observedAt', 'quality', 'status',
  ], `businessSnapshot.markets[${index}]`));
  snapshot.economics.forEach((entry, index) => rejectUnknownKeys(entry, [
    'alternativeSellNetPerUnit', 'buyNeedAmount', 'buyUseValuePerUnit',
    'contractFeeRate', 'fixedCost', 'kind', 'observedAt', 'quality', 'status',
    'warehouseFreeAmount',
  ], `businessSnapshot.economics[${index}]`));
  rejectUnknownKeys(snapshot.transport, [
    'availableAmount', 'entries', 'observedAt', 'status',
  ], 'businessSnapshot.transport');
  if (!Array.isArray(snapshot.transport.entries) || snapshot.transport.entries.length > 500) {
    throw new TypeError('businessSnapshot.transport.entries is invalid or unbounded');
  }
  snapshot.transport.entries.forEach((entry, index) => rejectUnknownKeys(entry, [
    'kind', 'opportunityCostPerUnit', 'unitsPerItem',
  ], `businessSnapshot.transport.entries[${index}]`));
  rejectUnknownKeys(snapshot.finance, [
    'cashAvailable', 'cashReserve', 'observedAt', 'status',
  ], 'businessSnapshot.finance');
}

function publicActionParts(parts) {
  return parts.map(part => part.type === 'text'
    ? { type: 'text', value: part.value, kind: null, name: null }
    : { type: 'resource', value: null, kind: part.kind, name: part.name ?? null });
}

function minimalPublicParts(parts) {
  if (!Array.isArray(parts)) throw new TypeError('public parts must be an array');
  return parts.map((part, index) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new TypeError(`parts[${index}] must be an object`);
    }
    if (part.type === 'text') {
      return { type: 'text', value: boundedString(part.value, `parts[${index}].value`, { max: 60, trim: false }) };
    }
    if (part.type === 'resource') {
      const kind = Number(part.kind);
      if (!Number.isSafeInteger(kind) || kind <= 0) {
        throw new TypeError(`parts[${index}].kind must be a positive integer`);
      }
      const name = part.name == null
        ? null
        : boundedString(part.name, `parts[${index}].name`, { max: 120 });
      return { type: 'resource', kind, ...(name == null ? {} : { name }) };
    }
    throw new TypeError(`parts[${index}].type is invalid`);
  });
}

function normalizeExecutionBinding(actionName, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('execution params must be an object');
  }
  const attemptId = attemptIdentifier(params.attemptId);
  if (params.confirm !== true) throw new TypeError('communication authorization is only consumed for confirm:true');
  if (actionName === 'chat_room_post' || actionName === 'chat_room_reply') {
    const room = boundedString(params.room, 'room', { max: 120 });
    const parts = minimalPublicParts(params.parts);
    let company = null;
    let bodyContains = null;
    let conversationHref = null;
    let sourceMessageId = null;
    let sourceCreatedAt = null;
    let sourceCompanyId = null;
    let prefix = '';
    if (actionName === 'chat_room_reply') {
      company = boundedString(params.company, 'company', { max: 80 });
      bodyContains = boundedString(params.bodyContains, 'bodyContains', { min: 4, max: 240 });
      conversationHref = normalizeConversationHref(
        params.conversationHref,
        'conversationHref',
        true,
      );
      sourceMessageId = boundedString(params.sourceMessageId, 'sourceMessageId', { max: 160 });
      sourceCreatedAt = timestamp(params.sourceCreatedAt, 'sourceCreatedAt');
      sourceCompanyId = positiveCompanyNumber(params.sourceCompanyId, 'sourceCompanyId');
      prefix = replyPrefix(company);
    }
    const plan = buildPublicPostPlan(parts, { replyPrefix: prefix });
    return {
      actionName,
      attemptId,
      room,
      company,
      bodyContains,
      conversationHref,
      sourceCompanyId,
      sourceMessageId,
      sourceCreatedAt,
      parts,
      reason: boundedString(params.reason, 'reason', { max: 80 }),
      finalMarkup: plan.finalMarkup,
    };
  }
  if (actionName === 'chat_private_send') {
    return {
      actionName,
      attemptId,
      targetCompany: boundedString(params.targetCompany, 'targetCompany', { max: 160 }),
      targetCompanyId: positiveCompanyNumber(params.targetCompanyId, 'targetCompanyId'),
      text: boundedString(params.text, 'text', { max: 180, trim: false }),
      inReplyToText: boundedString(
        params.inReplyToText,
        'inReplyToText',
        { min: 4, max: 500 },
      ),
      sourceMessageId: boundedString(params.sourceMessageId, 'sourceMessageId', { max: 160 }),
      sourceCreatedAt: timestamp(params.sourceCreatedAt, 'sourceCreatedAt'),
    };
  }
  throw new TypeError('only public post/reply and private send can consume communication authorization');
}

function auditSource(source) {
  return {
    conversationType: source.conversationType,
    conversationId: source.conversationId,
    messageId: source.messageId,
    counterpartyCompanyId: source.counterpartyCompanyId,
    counterpartyCompanyName: source.counterpartyCompanyName,
    observedAt: source.observedAt,
    createdAt: source.createdAt,
    visibleTextFingerprint: digest(source.visibleText),
    conversationHrefFingerprint: source.conversationHref == null
      ? null
      : digest(source.conversationHref),
  };
}

function sourceMatchesEconomicLead(source, offer, intent, agreementEvidence, delivery) {
  const offerSource = offer?.source;
  if (!offerSource || !['untrusted-external', 'internal-business-intent'].includes(offerSource.trust)) {
    throw new TypeError('offer must retain an explicit external or internal source binding');
  }
  if (source.counterpartyCompanyId !== String(offerSource.counterpartyCompanyId)
      || source.counterpartyCompanyName !== offerSource.counterpartyCompanyName
      || source.conversationType !== offerSource.conversationType
      || source.conversationId !== offerSource.conversationId) {
    throw new Error('source counterparty or conversation differs from the evaluated offer');
  }
  if (offerSource.trust === 'internal-business-intent') {
    if (intent !== 'public-offer' || delivery !== 'public-post'
        || source.messageId !== offerSource.messageId
        || source.createdAt !== timestamp(offerSource.createdAt, 'offer.source.createdAt')
        || source.observedAt !== timestamp(offerSource.observedAt, 'offer.source.observedAt')) {
      throw new Error('internal business intent is not bound to an exact proactive public post');
    }
    return;
  }
  if (intent === 'agreement') {
    if (source.messageId !== agreementEvidence?.sourceMessageId
        || source.observedAt !== timestamp(agreementEvidence?.observedAt, 'agreementEvidence.observedAt')) {
      throw new Error('agreement source does not match the explicit agreement evidence');
    }
    return;
  }
  if (source.messageId !== offerSource.messageId
      || source.createdAt !== timestamp(offerSource.createdAt, 'offer.source.createdAt')
      || source.observedAt !== timestamp(offerSource.observedAt, 'offer.source.observedAt')) {
    throw new Error('source message does not match the evaluated offer');
  }
}

function assertFreshSource(source, nowMs, maxAgeMs) {
  const observedMs = Date.parse(source.observedAt);
  const createdMs = Date.parse(source.createdAt);
  const observedAgeMs = nowMs - observedMs;
  const createdAgeMs = nowMs - createdMs;
  if (!Number.isFinite(observedMs) || !Number.isFinite(createdMs)
      || observedAgeMs < -MAX_CLOCK_SKEW_MS || observedAgeMs > maxAgeMs
      || createdAgeMs < -MAX_CLOCK_SKEW_MS || createdAgeMs > maxAgeMs) {
    throw new Error('source message evidence is stale or invalid');
  }
}

function assertFreshLeadSource(offer, nowMs, maxAgeMs) {
  const observedAt = timestamp(offer?.source?.observedAt, 'offer.source.observedAt');
  const ageMs = nowMs - Date.parse(observedAt);
  if (ageMs < -MAX_CLOCK_SKEW_MS || ageMs > maxAgeMs) {
    throw new Error('evaluated lead source message is stale or invalid');
  }
}

function requiredPostcondition(delivery, destination, contentFingerprint) {
  if (delivery === 'private-reply') {
    return {
      kind: 'private-rendered-send',
      maxClicks: 1,
      retryAfterConsumption: false,
      exactDestination: {
        targetCompany: destination.targetCompany,
        targetCompanyId: destination.targetCompanyId,
      },
      contentFingerprint,
      proof: 'unique-added-own-node+cleared-composer+exact-destination',
    };
  }
  return {
    kind: delivery === 'public-reply' ? 'public-rendered-reply' : 'public-rendered-post',
    maxClicks: 1,
    retryAfterConsumption: false,
    exactDestination: { room: destination.room },
    contentFingerprint,
    proof: delivery === 'public-reply'
      ? 'unique-explicit-source-id+exact-body+exact-rendered-message-count-increment+cleared-composer+exact-room'
      : 'exact-rendered-message-count-increment+cleared-composer+exact-room',
  };
}

function normalizeIssueRequest(request, nowMs, maxAgeMs) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('authorization request must be an object');
  }
  exactKeys(request, [
    'agreementEvidence',
    'attemptId',
    'businessSnapshot',
    'delivery',
    'destination',
    'intent',
    'offer',
    'source',
    'terms',
    'trustedResourceCatalog',
  ], 'authorization request');
  const attemptId = attemptIdentifier(request.attemptId);
  if (!ALLOWED_INTENTS.has(request.intent)) throw new TypeError('authorization intent is invalid');
  if (!ALLOWED_DELIVERIES.has(request.delivery)) throw new TypeError('authorization delivery is invalid');
  if (request.intent === 'agreement' && request.delivery !== 'private-reply') {
    throw new Error('agreement text is authorized only as an exact private reply');
  }
  if (request.intent === 'public-offer' && !request.delivery.startsWith('public-')) {
    throw new Error('public-offer intent requires public delivery');
  }
  const source = normalizeSource(request.source, { requireHref: request.delivery === 'public-reply' });
  if (request.delivery === 'public-reply' && !/^[1-9]\d*$/u.test(source.messageId)) {
    throw new Error('public economic reply requires an explicit numeric server source message ID');
  }
  const destination = normalizeDestination(request.destination, request.delivery, source);
  assertFreshSource(source, nowMs, maxAgeMs);
  const terms = normalizeTerms(request.terms);
  if (terms.counterpartyCompanyId !== source.counterpartyCompanyId) {
    throw new Error('terms counterparty differs from the exact source counterparty');
  }
  if (request.intent === 'supply-promise' && terms.ourSide !== 'sell') {
    throw new Error('a supply promise requires ourSide sell');
  }
  sourceMatchesEconomicLead(
    source,
    request.offer,
    request.intent,
    request.agreementEvidence,
    request.delivery,
  );
  return { attemptId, source, destination, terms };
}

function actionBindingForDraft({ attemptId, delivery, destination, source, draft }) {
  if (delivery === 'public-post') {
    return normalizeExecutionBinding('chat_room_post', {
      room: destination.room,
      parts: publicActionParts(draft.parts),
      reason: 'verified-offer',
      attemptId,
      confirm: true,
    });
  }
  if (delivery === 'public-reply') {
    return normalizeExecutionBinding('chat_room_reply', {
      room: destination.room,
      company: source.counterpartyCompanyName,
      bodyContains: source.visibleText,
      conversationHref: source.conversationHref,
      sourceCompanyId: positiveCompanyNumber(source.counterpartyCompanyId, 'source.counterpartyCompanyId'),
      sourceMessageId: source.messageId,
      sourceCreatedAt: source.createdAt,
      parts: publicActionParts(draft.parts),
      reason: 'reply',
      attemptId,
      confirm: true,
    });
  }
  return normalizeExecutionBinding('chat_private_send', {
    targetCompany: destination.targetCompany,
    targetCompanyId: destination.targetCompanyId,
    text: draft.text,
    inReplyToText: source.visibleText,
    sourceMessageId: source.messageId,
    sourceCreatedAt: source.createdAt,
    attemptId,
    confirm: true,
  });
}

function executionParamsFromBinding(binding) {
  if (binding.actionName === 'chat_room_post') {
    return {
      room: binding.room,
      parts: publicActionParts(binding.parts),
      reason: binding.reason,
      attemptId: binding.attemptId,
      confirm: true,
    };
  }
  if (binding.actionName === 'chat_room_reply') {
    return {
      room: binding.room,
      company: binding.company,
      bodyContains: binding.bodyContains,
      conversationHref: binding.conversationHref,
      sourceCompanyId: binding.sourceCompanyId,
      sourceMessageId: binding.sourceMessageId,
      sourceCreatedAt: binding.sourceCreatedAt,
      parts: publicActionParts(binding.parts),
      reason: binding.reason,
      attemptId: binding.attemptId,
      confirm: true,
    };
  }
  return {
    targetCompany: binding.targetCompany,
    targetCompanyId: binding.targetCompanyId,
    text: binding.text,
    inReplyToText: binding.inReplyToText,
    sourceMessageId: binding.sourceMessageId,
    sourceCreatedAt: binding.sourceCreatedAt,
    attemptId: binding.attemptId,
    confirm: true,
  };
}

function buildAuthorization(request, { now = Date.now(), maxAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS } = {}) {
  const nowMs = parseNow(now);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0
      || maxAgeMs > DEFAULT_MAX_EVIDENCE_AGE_MS) {
    throw new TypeError(`maxAgeMs must be within 1..${DEFAULT_MAX_EVIDENCE_AGE_MS}`);
  }
  assertTypedBusinessSnapshot(request?.businessSnapshot);
  const normalized = normalizeIssueRequest(request, nowMs, maxAgeMs);
  assertFreshLeadSource(request.offer, nowMs, maxAgeMs);
  let evaluation;
  let verifiedBusinessIntent = null;
  if (request.offer?.source?.trust === 'internal-business-intent') {
    verifiedBusinessIntent = verifyProactivePublicIntent({
      schemaVersion: 1,
      intentId: request.offer.internalIntentId,
      trust: 'internal-verified-business-intent',
      instructionAuthority: 'none',
      roomId: request.offer.source.conversationId,
      offer: request.offer,
      terms: normalized.terms,
    }, request.businessSnapshot, {
      roomId: request.offer.source.conversationId,
      trustedResourceCatalog: request.trustedResourceCatalog,
      now: nowMs,
      maxAgeMs,
    });
    evaluation = evaluateBusinessIntentOpportunity(
      verifiedBusinessIntent.offer,
      request.businessSnapshot,
      { now: nowMs, maxAgeMs },
    );
  } else {
    evaluation = evaluateLeadOpportunity(request.offer, request.businessSnapshot, {
      now: nowMs,
      maxAgeMs,
    });
  }
  if (evaluation.status !== 'evaluated' || evaluation.evidenceComplete !== true) {
    throw new Error(`economic evidence is incomplete: ${(evaluation.unknowns || []).join('; ')}`);
  }
  const operation = request.intent === 'agreement' ? 'accept' : 'send';
  const preview = evaluateContractGate({
    mode: 'preview',
    operation,
    confirm: false,
    terms: normalized.terms,
    leadEvaluation: evaluation,
    agreementEvidence: request.agreementEvidence,
    now: nowMs,
    maxAgeMs,
  });
  if (!preview.ok) throw new Error(`economic gate refused communication: ${preview.reason}`);

  let draft;
  let gateResult = preview;
  if (request.intent === 'agreement') {
    gateResult = evaluateContractGate({
      mode: 'confirm',
      operation,
      confirm: true,
      terms: normalized.terms,
      leadEvaluation: evaluation,
      agreementEvidence: request.agreementEvidence,
      preview: preview.preview,
      now: nowMs,
      maxAgeMs,
    });
    if (!gateResult.ok) throw new Error(`agreement gate refused communication: ${gateResult.reason}`);
    draft = draftPrivateAcceptance({
      terms: normalized.terms,
      gateResult,
      trustedResourceCatalog: request.trustedResourceCatalog,
    });
  } else if (request.delivery.startsWith('public-')) {
    draft = draftLeadResponse({
      offer: request.offer,
      scope: 'room',
      gateResult,
      terms: normalized.terms,
      trustedResourceCatalog: request.trustedResourceCatalog,
    });
  } else {
    draft = draftPrivateQuote({
      terms: normalized.terms,
      gateResult,
      trustedResourceCatalog: request.trustedResourceCatalog,
    });
  }

  const executionBinding = actionBindingForDraft({
    ...normalized,
    delivery: request.delivery,
    draft,
  });
  const contentText = executionBinding.actionName === 'chat_private_send'
    ? executionBinding.text
    : executionBinding.finalMarkup;
  const contentFingerprint = digest(contentText);
  const sourceExpiryMs = Date.parse(normalized.source.observedAt) + maxAgeMs;
  const gateExpiryMs = Date.parse(preview.preview.expiresAt);
  const expiresMs = Math.min(sourceExpiryMs, gateExpiryMs);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw new Error('economic communication authorization would already be expired');
  }

  const core = {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    commitmentId: `commitment:${crypto.randomUUID()}`,
    attemptId: normalized.attemptId,
    intent: request.intent,
    delivery: request.delivery,
    counterparty: {
      companyId: normalized.source.counterpartyCompanyId,
      companyName: normalized.source.counterpartyCompanyName,
    },
    source: auditSource(normalized.source),
    destination: normalized.destination,
    terms: normalized.terms,
    termsHash: contractTermsHash(normalized.terms),
    content: {
      fingerprint: contentFingerprint,
      characters: Array.from(contentText).length,
      resourceKinds: executionBinding.actionName === 'chat_private_send'
        ? [normalized.terms.resourceKind]
        : buildPublicPostPlan(executionBinding.parts, {
          replyPrefix: executionBinding.actionName === 'chat_room_reply'
            ? replyPrefix(executionBinding.company)
            : '',
        }).resourceKinds,
      generatedBy: request.intent === 'agreement'
        ? 'draftPrivateAcceptance'
        : executionBinding.actionName === 'chat_private_send'
          ? 'draftPrivateQuote'
          : 'draftLeadResponse',
      plaintextStored: false,
    },
    executionBindingHash: digest(executionBinding),
    economics: {
      evaluator: verifiedBusinessIntent == null
        ? 'lead-engine-v1+contract-gate-v1'
        : 'business-intent-v1+lead-engine-v1+contract-gate-v1',
      offerId: evaluation.offerId,
      leadSourceMessageId: evaluation.messageId,
      snapshotId: evaluation.snapshotId,
      snapshotObservedAt: evaluation.snapshotObservedAt,
      evaluatedAt: evaluation.evaluatedAt,
      offerFingerprint: digest(request.offer),
      businessSnapshotFingerprint: digest(request.businessSnapshot),
      evaluationFingerprint: digest(evaluation),
      contractPreviewId: preview.preview.previewId,
      economicFingerprint: preview.preview.economicFingerprint,
      agreementEvidenceFingerprint: request.agreementEvidence == null
        ? null
        : digest(request.agreementEvidence),
      inputs: evaluation.economicsInputs,
      market: evaluation.market,
      metrics: gateResult.economics,
    },
    requiredPostcondition: requiredPostcondition(
      request.delivery,
      normalized.destination,
      contentFingerprint,
    ),
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    maxUses: 1,
    retryAfterConsumption: false,
  };
  const artifact = Object.freeze({ ...core, integrityHash: digest(core) });
  return {
    artifact,
    actionName: executionBinding.actionName,
    actionParams: executionParamsFromBinding(executionBinding),
  };
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('communication authorization artifact is malformed');
  }
  const { integrityHash, ...core } = artifact;
  if (artifact.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION
      || typeof integrityHash !== 'string' || !/^[0-9a-f]{64}$/u.test(integrityHash)
      || integrityHash !== digest(core)
      || typeof artifact.commitmentId !== 'string'
      || !artifact.commitmentId.startsWith('commitment:')
      || attemptIdentifier(artifact.attemptId) !== artifact.attemptId
      || !ALLOWED_INTENTS.has(artifact.intent)
      || !ALLOWED_DELIVERIES.has(artifact.delivery)
      || artifact.termsHash !== contractTermsHash(artifact.terms)
      || typeof artifact.executionBindingHash !== 'string'
      || !/^[0-9a-f]{64}$/u.test(artifact.executionBindingHash)
      || artifact.maxUses !== 1
      || artifact.retryAfterConsumption !== false
      || artifact.requiredPostcondition?.maxClicks !== 1
      || artifact.requiredPostcondition?.retryAfterConsumption !== false
      || artifact.content?.plaintextStored !== false
      || artifact.content?.fingerprint !== artifact.requiredPostcondition?.contentFingerprint) {
    throw new Error('communication authorization artifact integrity or schema failed');
  }
  timestamp(artifact.issuedAt, 'artifact.issuedAt');
  timestamp(artifact.expiresAt, 'artifact.expiresAt');
  return artifact;
}

function emptyStore() {
  return { schemaVersion: STORE_SCHEMA_VERSION, updatedAt: null, recordsByAttemptId: {} };
}

function safeExistingStoreFile(file, maxBytes = MAX_STORE_BYTES) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
      throw new Error('communication authorization store is not a regular bounded file');
    }
    return stat;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function validateRecord(record, key) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`communication authorization record ${key} is malformed`);
  }
  exactKeys(record, ['artifact', 'lifecycle'], `record ${key}`);
  const artifact = validateArtifact(record.artifact);
  if (artifact.attemptId !== key || !record.lifecycle || typeof record.lifecycle !== 'object'
      || !LIFECYCLE_STATUSES.has(record.lifecycle.status)) {
    throw new Error(`communication authorization record ${key} binding is malformed`);
  }
  return record;
}

function readAuthorizationStore(file, { maxBytes = MAX_STORE_BYTES } = {}) {
  if (!safeExistingStoreFile(file, maxBytes)) return emptyStore();
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`communication authorization store is invalid JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('communication authorization store is malformed');
  }
  exactKeys(value, ['recordsByAttemptId', 'schemaVersion', 'updatedAt'], 'authorization store');
  if (value.schemaVersion !== STORE_SCHEMA_VERSION
      || !value.recordsByAttemptId || typeof value.recordsByAttemptId !== 'object'
      || Array.isArray(value.recordsByAttemptId)) {
    throw new Error('communication authorization store schema is invalid');
  }
  const entries = Object.entries(value.recordsByAttemptId);
  if (entries.length > MAX_RECORDS) throw new Error('communication authorization store has too many records');
  for (const [key, record] of entries) {
    if (attemptIdentifier(key) !== key) throw new Error('authorization store has an invalid attemptId key');
    validateRecord(record, key);
  }
  if (value.updatedAt != null) timestamp(value.updatedAt, 'authorization store updatedAt');
  return value;
}

function writeAuthorizationStore(file, store) {
  safeExistingStoreFile(file);
  atomicWriteJson(file, store);
  fs.chmodSync(file, 0o600);
}

function issueCommunicationAuthorization(file, request, options = {}) {
  const built = buildAuthorization(request, options);
  return withFileLock(file, () => {
    const store = readAuthorizationStore(file);
    if (store.recordsByAttemptId[built.artifact.attemptId]) {
      throw new Error('attemptId already has a durable communication record; never reuse it');
    }
    if (Object.keys(store.recordsByAttemptId).length >= MAX_RECORDS) {
      throw new Error('communication authorization store is full; archive it deliberately');
    }
    store.recordsByAttemptId[built.artifact.attemptId] = {
      artifact: built.artifact,
      lifecycle: {
        status: 'AUTHORIZED',
        authorizedAt: built.artifact.issuedAt,
        consumedAt: null,
        completedAt: null,
        actionName: built.actionName,
        outcome: null,
      },
    };
    store.updatedAt = built.artifact.issuedAt;
    writeAuthorizationStore(file, store);
    return { ok: true, ...built };
  });
}

function inspectRecordForExecution(record, actionName, params, nowMs) {
  validateRecord(record, record?.artifact?.attemptId ?? 'unknown');
  if (record.lifecycle.status !== 'AUTHORIZED') {
    return {
      ok: false,
      reason: 'communication authorization was already consumed; never replay it',
      doNotRetry: true,
      status: record.lifecycle.status,
    };
  }
  const artifact = record.artifact;
  const issuedMs = Date.parse(artifact.issuedAt);
  const expiresMs = Date.parse(artifact.expiresAt);
  if (nowMs < issuedMs - MAX_CLOCK_SKEW_MS || nowMs > expiresMs) {
    return { ok: false, reason: 'communication authorization is expired or not yet valid' };
  }
  let binding;
  try { binding = normalizeExecutionBinding(actionName, params); }
  catch (error) { return { ok: false, reason: `communication execution binding is invalid: ${error.message}` }; }
  if (binding.attemptId !== artifact.attemptId
      || digest(binding) !== artifact.executionBindingHash) {
    return {
      ok: false,
      reason: 'action, counterparty, source, destination, terms, or exact generated content differs from the durable authorization',
    };
  }
  const contentText = actionName === 'chat_private_send' ? binding.text : binding.finalMarkup;
  if (digest(contentText) !== artifact.content.fingerprint) {
    return { ok: false, reason: 'outgoing content differs from the authorized generated content' };
  }
  return { ok: true, artifact, binding };
}

function inspectCommunicationAuthorization(file, actionName, params, { now = Date.now() } = {}) {
  const attemptId = attemptIdentifier(params?.attemptId);
  const store = readAuthorizationStore(file);
  const record = store.recordsByAttemptId[attemptId];
  if (!record) return { ok: false, reason: 'no durable economic communication authorization exists for attemptId' };
  return inspectRecordForExecution(record, actionName, params, parseNow(now));
}

function consumeCommunicationAuthorization(file, actionName, params, { now = Date.now() } = {}) {
  const attemptId = attemptIdentifier(params?.attemptId);
  const nowMs = parseNow(now);
  return withFileLock(file, () => {
    const store = readAuthorizationStore(file);
    const record = store.recordsByAttemptId[attemptId];
    if (!record) return { ok: false, reason: 'no durable economic communication authorization exists for attemptId' };
    const inspection = inspectRecordForExecution(record, actionName, params, nowMs);
    if (!inspection.ok) return inspection;
    record.lifecycle = {
      ...record.lifecycle,
      status: 'CONSUMED',
      consumedAt: new Date(nowMs).toISOString(),
      completedAt: null,
      actionName,
      outcome: null,
    };
    store.updatedAt = record.lifecycle.consumedAt;
    writeAuthorizationStore(file, store);
    return {
      ok: true,
      commitmentId: record.artifact.commitmentId,
      attemptId,
      sourceMessageId: record.artifact.source.messageId,
      requiredPostcondition: record.artifact.requiredPostcondition,
      expiresAt: record.artifact.expiresAt,
    };
  });
}

function assessOutcome(artifact, actionName, result) {
  const verified = actionName === 'chat_private_send'
    ? result?.posted === true
      && result?.attemptId === artifact.attemptId
      && String(result?.targetCompanyId) === artifact.counterparty.companyId
      && result?.targetCompany === artifact.counterparty.companyName
      && result?.postcondition === artifact.requiredPostcondition.proof
    : result?.posted === true
      && result?.attemptId === artifact.attemptId
      && result?.room === artifact.destination.room
      && (actionName !== 'chat_room_reply' || (
        result?.replyTargetVerified === true
        && String(result?.replySourceMessageIdVerified) === artifact.source.messageId
      ));
  if (verified) return { status: 'VERIFIED', postconditionVerified: true };
  const clickPossible = result?.mutationAttempted === true
    || result?.sendClicked === true
    || result?.posted === false
    || result?.posted === null;
  return {
    status: clickPossible ? 'AMBIGUOUS' : 'FAILED_PRE_CLICK',
    postconditionVerified: false,
  };
}

function recordCommunicationOutcome(file, {
  actionName,
  attemptId,
  commitmentId,
  result,
  now = Date.now(),
}) {
  const normalizedAttemptId = attemptIdentifier(attemptId);
  const nowMs = parseNow(now);
  return withFileLock(file, () => {
    const store = readAuthorizationStore(file);
    const record = store.recordsByAttemptId[normalizedAttemptId];
    if (!record || record.artifact.commitmentId !== commitmentId) {
      throw new Error('communication outcome does not match its commitmentId and attemptId');
    }
    if (record.lifecycle.status !== 'CONSUMED') {
      return { ok: false, reason: 'only a consumed authorization can receive one outcome' };
    }
    const assessment = assessOutcome(record.artifact, actionName, result);
    const completedAt = new Date(nowMs).toISOString();
    record.lifecycle = {
      ...record.lifecycle,
      status: assessment.status,
      completedAt,
      outcome: {
        postconditionVerified: assessment.postconditionVerified,
        doNotRetry: true,
        resultFingerprint: digest(result ?? null),
      },
    };
    store.updatedAt = completedAt;
    writeAuthorizationStore(file, store);
    return {
      ok: assessment.postconditionVerified,
      status: assessment.status,
      doNotRetry: true,
      postconditionVerified: assessment.postconditionVerified,
    };
  });
}

function requiresEconomicCommunicationAuthorization(actionName, params, renderedText = null) {
  if (!['chat_room_post', 'chat_room_reply', 'chat_private_send'].includes(actionName)) return false;
  if (params?.confirm !== true) return false;
  if (['verified-offer', 'explicit-buy-request'].includes(params?.reason)) return true;
  if ((actionName === 'chat_room_post' || actionName === 'chat_room_reply')
      && Array.isArray(params?.parts)
      && params.parts.some(part => part?.type === 'resource')) return true;
  const text = renderedText == null ? params?.text : renderedText;
  return hasEconomicCommunicationLanguage(text);
}

module.exports = {
  ALLOWED_DELIVERIES,
  ALLOWED_INTENTS,
  AUTHORIZATION_SCHEMA_VERSION,
  MAX_STORE_BYTES,
  STORE_SCHEMA_VERSION,
  buildAuthorization,
  consumeCommunicationAuthorization,
  inspectCommunicationAuthorization,
  issueCommunicationAuthorization,
  normalizeExecutionBinding,
  readAuthorizationStore,
  recordCommunicationOutcome,
  requiresEconomicCommunicationAuthorization,
};
