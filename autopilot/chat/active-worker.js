'use strict';

// A deliberately dependency-injected chat orchestrator.  This module never schedules itself,
// opens Chrome directly, or enables an active mode.  Its default is shadow and every browser or
// durable-state operation is supplied by the caller, which keeps the full state machine testable
// without network or game access.

const crypto = require('node:crypto');
const path = require('node:path');
const { parseAlarm } = require('../check-alarm.js');
const { buildBusinessSnapshot } = require('./business-snapshot.js');
const {
  buildAuthorization,
  issueCommunicationAuthorization,
  readAuthorizationStore,
  requiresEconomicCommunicationAuthorization,
} = require('./communication-authorization.js');
const { prepareChatIngest } = require('./ingest.js');
const { executionBindingHash } = require('./execution-claim.js');
const { CONTENT_REPLAY_WINDOW_MS } = require('./active-store.js');
const {
  PROVIDER_FAILURE_CODES: PROVIDER_FAILURE_CODE_VALUES,
  WORKER_ERROR_REASONS,
} = require('./diagnostic-codes.js');
const { isolateExternalMessage } = require('./injection-guard.js');
const {
  evaluateLeadOpportunity,
  extractTradeLeads,
} = require('./lead-engine.js');
const {
  evaluatePublicSend,
  inspectOutgoingText,
} = require('./policy.js');
const {
  buildPublicPostPlan,
  replyPrefix,
} = require('./public-ui.js');
const {
  buildPublicStyleProfile,
  validatePublicStyleProfile,
} = require('./public-style.js');
const {
  projectTrustedResourceCatalog,
  validateTrustedResourceCatalog,
} = require('./resource-catalog.js');
const { deriveProactivePublicIntents } = require('./public-economic-intent.js');
const {
  ordinaryDraftUsesAllowedNonEconomicTemplate,
} = require('./reply-templates.js');
const {
  authorizeChatAction,
  normalizeChatMode,
} = require('./runtime-mode.js');
const {
  boundPrivateResult,
  boundPublicResult,
  buildMinimalBusinessSnapshotDto,
  sanitizeDecisionOffer,
} = require('./shadow-worker.js');

const DEFAULT_CYCLE_DEADLINE_MS = 4 * 60 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30 * 1000;
const DEFAULT_WAKE_SAFETY_MARGIN_MS = 2 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_SOURCE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;

const DEFAULT_LIMITS = Object.freeze({
  maxActions: 24,
  maxReads: 16,
  maxObservedMessages: 160,
  maxMessageCharacters: 1200,
  maxDecisionCalls: 8,
  maxDecisionTotalTokens: 48000,
  maxPreviews: 1,
  maxConfirmAttempts: 1,
  maxConfirmAttemptsPerWindow: 1,
});

const READ_ACTIONS = new Set(['chat_private_read', 'chat_room_read']);
const PRIVATE_ALLOWED_ACTIONS = Object.freeze([
  'ignore',
  'request_evidence',
  'draft_private',
  'candidate_contract',
]);
const ROOM_ALLOWED_ACTIONS = Object.freeze([
  'ignore',
  'request_evidence',
  'draft_public',
  'candidate_contract',
]);
const BLOCKING_SOURCE_STATES = new Set([
  'ARMED',
  'CONFIRMING',
  'VERIFIED',
  'SENT',
  'AMBIGUOUS',
  'UNKNOWN',
]);
const PROVIDER_FAILURE_CODES = new Set(PROVIDER_FAILURE_CODE_VALUES);
const PLAN_FAILURE_REASONS = new Set([
  'plan-authorization-action-mismatch',
  'plan-authorization-build-refused',
  'plan-authorization-factory-invalid',
  'plan-authorization-factory-missing',
  'plan-authorization-input-invalid',
  'plan-internal-failure',
  'plan-ordinary-template-rejected',
  'plan-private-source-binding-invalid',
  'plan-public-context-invalid',
  'plan-public-parts-invalid',
  'plan-public-policy-refused',
  'plan-public-source-binding-invalid',
  'plan-public-style-limit',
  'plan-unsupported-action',
]);

const SNAPSHOT_FIELDS = Object.freeze({
  inventory: Object.freeze([
    'blockedAmount', 'kind', 'observedAt', 'onHandAmount', 'quality', 'reserveAmount',
    'status', 'unitCost',
  ]),
  markets: Object.freeze([
    'bestAsk', 'bestBid', 'kind', 'marketPrice', 'observedAt', 'quality', 'status',
  ]),
  economics: Object.freeze([
    'alternativeSellNetPerUnit', 'buyNeedAmount', 'buyUseValuePerUnit',
    'contractFeeRate', 'fixedCost', 'kind', 'observedAt', 'quality', 'status',
    'warehouseFreeAmount',
  ]),
  transport: Object.freeze(['availableAmount', 'entries', 'observedAt', 'status']),
  transportEntry: Object.freeze(['kind', 'opportunityCostPerUnit', 'unitsPerItem']),
  finance: Object.freeze(['cashAvailable', 'cashReserve', 'observedAt', 'status']),
});

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class PlanBuildError extends Error {
  constructor(reason) {
    if (!PLAN_FAILURE_REASONS.has(reason)) throw new TypeError('plan failure reason is invalid');
    super('exact action plan could not be built');
    this.name = 'PlanBuildError';
    this.planFailureReason = reason;
  }
}

function fixedPlanFailureReason(error) {
  return PLAN_FAILURE_REASONS.has(error?.planFailureReason)
    ? error.planFailureReason : 'plan-internal-failure';
}

function planStep(reason, operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PlanBuildError) throw error;
    throw new PlanBuildError(reason);
  }
}

async function planStepAsync(reason, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PlanBuildError) throw error;
    throw new PlanBuildError(reason);
  }
}

function failPlan(reason) {
  throw new PlanBuildError(reason);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function jsonClone(value, field = 'value') {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw new TypeError(`${field} must be JSON-serializable`); }
  if (typeof serialized !== 'string') throw new TypeError(`${field} must be JSON-serializable`);
  return JSON.parse(serialized);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function nowMilliseconds(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('clock must return a Date or millisecond timestamp');
  }
  return milliseconds;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
}

function normalizeLimits(value = {}) {
  if (!plainObject(value)) throw new TypeError('limits must be an object');
  return Object.freeze({
    maxActions: boundedInteger(value.maxActions, DEFAULT_LIMITS.maxActions, 1, 40, 'maxActions'),
    maxReads: boundedInteger(value.maxReads, DEFAULT_LIMITS.maxReads, 0, 20, 'maxReads'),
    maxObservedMessages: boundedInteger(
      value.maxObservedMessages,
      DEFAULT_LIMITS.maxObservedMessages,
      1,
      200,
      'maxObservedMessages',
    ),
    maxMessageCharacters: boundedInteger(
      value.maxMessageCharacters,
      DEFAULT_LIMITS.maxMessageCharacters,
      40,
      4000,
      'maxMessageCharacters',
    ),
    maxDecisionCalls: boundedInteger(
      value.maxDecisionCalls,
      DEFAULT_LIMITS.maxDecisionCalls,
      0,
      10,
      'maxDecisionCalls',
    ),
    maxDecisionTotalTokens: boundedInteger(
      value.maxDecisionTotalTokens,
      DEFAULT_LIMITS.maxDecisionTotalTokens,
      1000,
      1_000_000,
      'maxDecisionTotalTokens',
    ),
    maxPreviews: boundedInteger(value.maxPreviews, DEFAULT_LIMITS.maxPreviews, 0, 4, 'maxPreviews'),
    maxConfirmAttempts: boundedInteger(
      value.maxConfirmAttempts,
      DEFAULT_LIMITS.maxConfirmAttempts,
      0,
      2,
      'maxConfirmAttempts',
    ),
    maxConfirmAttemptsPerWindow: boundedInteger(
      value.maxConfirmAttemptsPerWindow,
      DEFAULT_LIMITS.maxConfirmAttemptsPerWindow,
      0,
      12,
      'maxConfirmAttemptsPerWindow',
    ),
  });
}

function pickFields(value, fields) {
  if (!plainObject(value)) return value;
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) result[field] = value[field];
  }
  return result;
}

function projectBusinessSnapshot(snapshot) {
  if (!plainObject(snapshot)) throw new TypeError('businessSnapshot must be an object');
  const projected = {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    observedAt: snapshot.observedAt,
    inventory: Array.isArray(snapshot.inventory)
      ? snapshot.inventory.map(entry => pickFields(entry, SNAPSHOT_FIELDS.inventory)) : snapshot.inventory,
    markets: Array.isArray(snapshot.markets)
      ? snapshot.markets.map(entry => pickFields(entry, SNAPSHOT_FIELDS.markets)) : snapshot.markets,
    economics: Array.isArray(snapshot.economics)
      ? snapshot.economics.map(entry => pickFields(entry, SNAPSHOT_FIELDS.economics)) : snapshot.economics,
    transport: pickFields(snapshot.transport, SNAPSHOT_FIELDS.transport),
    finance: pickFields(snapshot.finance, SNAPSHOT_FIELDS.finance),
  };
  if (plainObject(projected.transport) && Array.isArray(snapshot.transport?.entries)) {
    projected.transport.entries = snapshot.transport.entries
      .map(entry => pickFields(entry, SNAPSHOT_FIELDS.transportEntry));
  }
  if (snapshot.evidenceStatus === 'UNAVAILABLE_SHADOW_DEFAULT') {
    projected.evidenceStatus = snapshot.evidenceStatus;
  }
  return projected;
}

function resolveBusinessSnapshot(options, nowMs) {
  if (plainObject(options.businessSnapshot)) return options.businessSnapshot;
  if (options.businessSnapshotLoader != null) {
    if (typeof options.businessSnapshotLoader.load !== 'function') {
      throw new TypeError('businessSnapshotLoader must provide load()');
    }
    const loaded = options.businessSnapshotLoader.load({ now: new Date(nowMs) });
    if (!plainObject(loaded)) throw new TypeError('businessSnapshotLoader returned no snapshot');
    return loaded;
  }
  if (plainObject(options.businessSnapshotEvidence)) {
    return buildBusinessSnapshot(options.businessSnapshotEvidence, { now: nowMs });
  }
  return null;
}

function validateBusinessSnapshotFreshness(snapshot, nowMs) {
  if (!plainObject(snapshot) || snapshot.schemaVersion !== 1
      || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId.trim()
      || typeof snapshot.observedAt !== 'string') {
    return false;
  }
  const observedMs = Date.parse(snapshot.observedAt);
  const ageMs = nowMs - observedMs;
  return Number.isFinite(observedMs)
    && ageMs >= -MAX_CLOCK_SKEW_MS
    && ageMs <= 5 * 60 * 1000;
}

function sanitizeEvaluation(evaluation) {
  if (evaluation == null) return null;
  const value = jsonClone(evaluation, 'leadEvaluation');
  delete value.resourceName;
  value.autoCommitEligible = false;
  return value;
}

function normalizeChatSafety(value, roomId) {
  if (value == null) return null;
  if (!plainObject(value) || value.status !== 'ok' || value.roomId !== roomId
      || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))
      || !Array.isArray(value.recentPublicMessages)) {
    throw new TypeError('public chatSafety must be fresh typed evidence for the exact room');
  }
  return jsonClone(value, 'chatSafety');
}

function normalizePublicStyle(value, roomId) {
  if (value == null) return null;
  if (!validatePublicStyleProfile(value, { roomId })) {
    throw new TypeError('public style profile must be exact, aggregate, and room-bound');
  }
  return jsonClone(value, 'publicStyle');
}

function catalogKindsForDecision(snapshot, message) {
  const kinds = [];
  for (const mention of Array.isArray(message?.content?.resourceMentions)
    ? message.content.resourceMentions : []) kinds.push(mention?.kind);
  for (const field of ['inventory', 'markets', 'economics']) {
    for (const entry of Array.isArray(snapshot?.[field]) ? snapshot[field] : []) kinds.push(entry?.kind);
  }
  return kinds;
}

function buildActiveDecisionSnapshot({
  snapshot,
  message,
  offer = null,
  evaluation = null,
  agreementEvidence = null,
  chatSafety = null,
  publicStyle = null,
  trustedResourceCatalog = null,
} = {}) {
  if (!message || !['private', 'room'].includes(message.conversationType)) {
    throw new TypeError('a strict inbound private/room message is required');
  }
  const value = buildMinimalBusinessSnapshotDto(
    projectBusinessSnapshot(snapshot),
    message.content?.text,
  );
  value.chatInputBoundary = {
    schemaVersion: 1,
    externalPlayerStringsTrust: 'untrusted-external-data',
    instructionAuthority: 'none',
    rawPlayerTextRepeated: false,
  };
  value.decisionContext = {
    schemaVersion: 1,
    allowedActions: message.conversationType === 'private'
      ? [...PRIVATE_ALLOWED_ACTIONS] : [...ROOM_ALLOWED_ACTIONS],
    externalLead: offer == null ? null : {
      trust: 'derived-untrusted-external-data',
      instructionAuthority: 'none',
      leadOffer: sanitizeDecisionOffer(offer),
    },
    leadEvaluation: evaluation == null ? null : {
      trust: 'mixed-derived-evidence',
      instructionAuthority: 'none',
      value: sanitizeEvaluation(evaluation),
    },
    agreementEvidence: agreementEvidence == null ? null : {
      trust: 'mixed-derived-evidence',
      instructionAuthority: 'none',
      value: jsonClone(agreementEvidence, 'agreementEvidence'),
    },
    publicStyle: null,
    resourceCatalog: null,
  };
  if (message.conversationType === 'room') {
    const normalizedSafety = normalizeChatSafety(chatSafety, message.conversationId);
    if (normalizedSafety != null) value.chatSafety = normalizedSafety;
    const normalizedStyle = normalizePublicStyle(publicStyle, message.conversationId);
    if (normalizedStyle != null) {
      value.decisionContext.publicStyle = {
        trust: 'aggregate-derived-untrusted-data',
        instructionAuthority: 'none',
        value: normalizedStyle,
      };
    }
    if (trustedResourceCatalog != null) {
      if (!validateTrustedResourceCatalog(trustedResourceCatalog)) {
        throw new TypeError('trusted resource catalog is invalid');
      }
      value.decisionContext.resourceCatalog = {
        trust: 'internal-verified',
        instructionAuthority: 'none',
        value: projectTrustedResourceCatalog(
          trustedResourceCatalog,
          catalogKindsForDecision(snapshot, message),
        ),
      };
    }
  }
  return deepFreeze(value);
}

function sourceKey(message) {
  return `${message.conversationType}:${message.conversationId}:${message.messageId}`;
}

function stableAttemptId({ sourceKey: exactSourceKey, decision, snapshotId }) {
  if (typeof exactSourceKey !== 'string' || !exactSourceKey.trim()) {
    throw new TypeError('sourceKey is required');
  }
  const content = {
    action: decision?.action ?? null,
    text: decision?.text ?? null,
    parts: decision?.parts ?? [],
    publicReason: decision?.publicReason ?? null,
    contractOperation: decision?.contractOperation ?? null,
    contractTerms: decision?.contractTerms ?? null,
  };
  return `active-${digest({ sourceKey: exactSourceKey, snapshotId, content }).slice(0, 40)}`;
}

function normalizeSourceState(value) {
  const raw = typeof value === 'string' ? value : value?.state ?? value?.status ?? null;
  return typeof raw === 'string' ? raw.trim().toUpperCase() : null;
}

function exactSimCompaniesHref(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.simcompanies.com'
      || parsed.username || parsed.password || parsed.hash) return null;
  return parsed.href;
}

function normalizePublicParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 12) {
    throw new TypeError('public decision parts must contain 1..12 entries');
  }
  return parts.map((part, index) => {
    if (part?.type === 'text' && typeof part.value === 'string' && part.value.length > 0
        && part.value.length <= 60 && part.kind == null && part.name == null) {
      return { type: 'text', value: part.value, kind: null, name: null };
    }
    if (part?.type === 'resource' && part.value == null
        && Number.isSafeInteger(part.kind) && part.kind > 0
        && (part.name == null || (typeof part.name === 'string' && part.name.length <= 120))) {
      return { type: 'resource', value: null, kind: part.kind, name: part.name ?? null };
    }
    throw new TypeError(`public decision part ${index} is invalid`);
  });
}

function validateProviderDecision(decision, conversationType) {
  if (!plainObject(decision)) {
    return { ok: false, reason: WORKER_ERROR_REASONS.PROVIDER_DECISION_NOT_VALIDATED };
  }
  if (decision.ok === false) {
    const failureCode = PROVIDER_FAILURE_CODES.has(decision.failureCode)
      ? decision.failureCode : 'unknown';
    return { ok: false, reason: `provider-fail-closed-${failureCode}` };
  }
  if (decision.sendAuthorized !== false) {
    return { ok: false, reason: WORKER_ERROR_REASONS.PROVIDER_DECISION_NOT_VALIDATED };
  }
  const allowed = conversationType === 'private' ? PRIVATE_ALLOWED_ACTIONS : ROOM_ALLOWED_ACTIONS;
  if (!allowed.includes(decision.action)) {
    return { ok: false,
      reason: WORKER_ERROR_REASONS.PROVIDER_ACTION_OUTSIDE_SOURCE_ALLOWLIST };
  }
  if (decision.action === 'draft_private') {
    if (decision.scope !== 'private' || typeof decision.text !== 'string') {
      return { ok: false, reason: WORKER_ERROR_REASONS.PROVIDER_PRIVATE_DRAFT_INVALID };
    }
    const inspection = inspectOutgoingText(decision.text, { scope: 'private' });
    if (!inspection.ok || inspection.normalizedText.length > 180
        || inspection.normalizedText.split('\n').length > 3) {
      return { ok: false,
        reason: WORKER_ERROR_REASONS.PROVIDER_PRIVATE_DRAFT_POLICY_REJECTED };
    }
    return { ok: true, decision: { ...decision, text: inspection.normalizedText } };
  }
  if (decision.action === 'draft_public') {
    if (decision.scope !== 'room' || !['reply', 'direct-mention'].includes(decision.publicReason)) {
      return { ok: false, reason: WORKER_ERROR_REASONS.PROVIDER_PUBLIC_DRAFT_INVALID };
    }
    try { normalizePublicParts(decision.parts); }
    catch { return { ok: false, reason: WORKER_ERROR_REASONS.PROVIDER_PUBLIC_PARTS_INVALID }; }
  }
  if (decision.action === 'candidate_contract') {
    const privateCandidate = conversationType === 'private'
      && decision.scope === 'private'
      && ['send', 'accept'].includes(decision.contractOperation)
      && decision.publicReason == null;
    const publicCandidate = conversationType === 'room'
      && decision.scope === 'room'
      && decision.contractOperation === 'send'
      && decision.publicReason === 'reply';
    if ((!privateCandidate && !publicCandidate) || !plainObject(decision.contractTerms)
        || decision.contractMutationAuthorized !== false) {
      return { ok: false, reason: WORKER_ERROR_REASONS.PROVIDER_CONTRACT_CANDIDATE_INVALID };
    }
  }
  return { ok: true, decision };
}

function exactPublicReplySource(message, sourceBinding) {
  const href = exactSimCompaniesHref(sourceBinding?.conversationHref);
  const exactBody = message.content.text.normalize('NFKC').trim();
  if (!href || exactBody.length < 4 || exactBody.length > 240
      || message.author.companyName.length > 80
      || String(sourceBinding?.bodyContains ?? '').normalize('NFKC').trim() !== exactBody
      || String(sourceBinding?.company ?? '').normalize('NFKC').trim()
        !== message.author.companyName
      || String(sourceBinding?.messageId ?? '') !== message.messageId
      || Number(sourceBinding?.sourceCompanyId) !== Number(message.author.companyId)
      || String(sourceBinding?.sourceCreatedAt ?? '') !== message.createdAt) {
    throw new Error('exact public reply source binding is required');
  }
  return { href, exactBody };
}

function assertFreshPublicContext({ message, publicSafety, publicStyle, businessSnapshot, nowMs }) {
  const safetyObservedMs = Date.parse(publicSafety?.observedAt);
  const snapshotObservedMs = Date.parse(businessSnapshot?.observedAt);
  const safetyAgeMs = nowMs - safetyObservedMs;
  if (publicSafety?.status !== 'ok'
      || publicSafety?.roomId !== message.conversationId
      || !Array.isArray(publicSafety?.recentPublicMessages)
      || !Number.isFinite(safetyObservedMs) || !Number.isFinite(snapshotObservedMs)
      || safetyAgeMs < -MAX_CLOCK_SKEW_MS || safetyAgeMs > 5 * 60 * 1000
      || Math.abs(safetyObservedMs - snapshotObservedMs) > 5 * 60 * 1000
      || !validatePublicStyleProfile(publicStyle, { roomId: message.conversationId })) {
    throw new Error('fresh exact public room context is required');
  }
}

function buildDefaultAuthorizationRequest({
  attemptId,
  decision,
  message,
  offer,
  businessSnapshot,
  agreementEvidence,
  sourceBinding,
  trustedResourceCatalog,
}) {
  if (decision.action !== 'candidate_contract' || !offer) {
    throw new Error('typed candidate contract and one exact offer are required');
  }
  const targetCompanyId = Number(message.author.companyId);
  if (!Number.isSafeInteger(targetCompanyId) || targetCompanyId <= 0) {
    throw new Error('stable target company ID is required');
  }
  const intent = decision.contractOperation === 'accept'
    ? 'agreement'
    : decision.contractTerms.ourSide === 'sell' ? 'supply-promise' : 'quote';
  if (message.conversationType === 'room') {
    if (decision.contractOperation !== 'send' || decision.scope !== 'room'
        || decision.publicReason !== 'reply') {
      throw new Error('public economic candidates must be exact send replies');
    }
    const { href, exactBody } = exactPublicReplySource(message, sourceBinding);
    return {
      attemptId,
      intent,
      delivery: 'public-reply',
      source: {
        conversationType: 'room',
        conversationId: message.conversationId,
        messageId: message.messageId,
        counterpartyCompanyId: String(message.author.companyId),
        counterpartyCompanyName: message.author.companyName,
        createdAt: message.createdAt,
        observedAt: message.observedAt,
        visibleText: exactBody,
        conversationHref: href,
      },
      destination: {
        conversationType: 'room',
        conversationId: message.conversationId,
        room: message.conversationId,
      },
      terms: decision.contractTerms,
      offer,
      businessSnapshot,
      agreementEvidence: null,
      trustedResourceCatalog: trustedResourceCatalog ?? null,
    };
  }
  return {
    attemptId,
    intent,
    delivery: 'private-reply',
    source: {
      conversationType: 'private',
      conversationId: message.conversationId,
      messageId: message.messageId,
      counterpartyCompanyId: String(message.author.companyId),
      counterpartyCompanyName: message.author.companyName,
      createdAt: message.createdAt,
      observedAt: message.observedAt,
      visibleText: message.content.text,
      conversationHref: null,
    },
    destination: {
      conversationType: 'private',
      conversationId: message.conversationId,
      targetCompany: message.author.companyName,
      targetCompanyId,
    },
    terms: decision.contractTerms,
    offer,
    businessSnapshot,
    agreementEvidence: intent === 'agreement' ? agreementEvidence : null,
    trustedResourceCatalog: trustedResourceCatalog ?? null,
  };
}

function createFileCommunicationAuthorizationAdapter(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new TypeError('communication authorization file must be an absolute path');
  }
  const resolved = path.resolve(file);
  return Object.freeze({
    build(request, options) {
      return buildAuthorization(request, options);
    },
    issue(request, options) {
      return issueCommunicationAuthorization(resolved, request, options);
    },
    getAttemptStatus(attemptId) {
      return readAuthorizationStore(resolved).recordsByAttemptId[attemptId]?.lifecycle?.status ?? null;
    },
  });
}

function normalizeAuthorizationAdapter(options) {
  const value = options.authorizationAdapter
    || (options.communicationAuthorizationFile
      ? createFileCommunicationAuthorizationAdapter(options.communicationAuthorizationFile)
      : null);
  if (value == null) return null;
  if (typeof value.build !== 'function' || typeof value.issue !== 'function') {
    throw new TypeError('authorizationAdapter must provide build() and issue()');
  }
  return value;
}

function exactActionParamsEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function ordinaryDraftHasEconomicSignal(
  decision,
  renderedText,
  _inboundOffer,
  trustedResourceCatalog = null,
) {
  // Economic authorization classifies our outbound communication.  An inbound offer is evidence
  // about the other company, not proof that an exact allowlisted request-for-details template
  // contains a quote, acceptance, assurance, or commitment from us.
  const exactDecision = decision?.action === 'draft_private' && decision.text == null
    ? { ...decision, text: renderedText }
    : decision;
  return !ordinaryDraftUsesAllowedNonEconomicTemplate(exactDecision, { trustedResourceCatalog });
}

async function buildActionPlan({
  decision,
  message,
  offer,
  evaluation,
  businessSnapshot,
  agreementEvidence,
  sourceBinding,
  publicSafety,
  publicStyle,
  attemptId,
  authorizationAdapter,
  authorizationRequestFactory,
  trustedResourceCatalog,
  nowMs,
}) {
  let actionName;
  let actionParams;
  let renderedText;
  let authorizationRequest = null;
  let builtAuthorization = null;

  if (decision.action === 'candidate_contract') {
    if (message.conversationType === 'room') {
      planStep('plan-public-source-binding-invalid', () =>
        exactPublicReplySource(message, sourceBinding));
      planStep('plan-public-context-invalid', () => assertFreshPublicContext({
        message,
        publicSafety,
        publicStyle,
        businessSnapshot,
        nowMs,
      }));
    }
    authorizationRequest = planStep('plan-authorization-input-invalid', () =>
      buildDefaultAuthorizationRequest({
      attemptId,
      decision,
      message,
      offer,
      businessSnapshot,
      agreementEvidence,
      sourceBinding,
      trustedResourceCatalog,
      }));
    const builder = authorizationAdapter?.build || buildAuthorization;
    builtAuthorization = await planStepAsync('plan-authorization-build-refused', () =>
      builder.call(authorizationAdapter, authorizationRequest, { now: nowMs }));
    actionName = builtAuthorization.actionName;
    actionParams = builtAuthorization.actionParams;
    if (actionName === 'chat_private_send') {
      renderedText = actionParams.text;
    } else if (actionName === 'chat_room_reply') {
      const parts = planStep('plan-public-parts-invalid', () =>
        normalizePublicParts(actionParams.parts));
      const bodyPlan = planStep('plan-public-parts-invalid', () => buildPublicPostPlan(
        parts.map(part => part.type === 'text'
        ? { type: 'text', value: part.value }
        : { type: 'resource', kind: part.kind, name: part.name })));
      if (bodyPlan.charCount > publicStyle.recommendedBodyMaxCharacters) {
        failPlan('plan-public-style-limit');
      }
      const exactPlan = planStep('plan-public-parts-invalid', () => buildPublicPostPlan(
        parts.map(part => part.type === 'text'
        ? { type: 'text', value: part.value }
        : { type: 'resource', kind: part.kind, name: part.name }), {
        replyPrefix: replyPrefix(message.author.companyName),
        }));
      const policy = planStep('plan-public-policy-refused', () => evaluatePublicSend({
        text: exactPlan.finalMarkup,
        roomId: message.conversationId,
        reason: 'reply',
        recentPublicMessages: publicSafety.recentPublicMessages,
        now: new Date(nowMs),
        knownHumanNames: publicSafety.knownHumanNames || [],
      }));
      if (!policy.ok) failPlan('plan-public-policy-refused');
      renderedText = exactPlan.finalMarkup;
    } else {
      failPlan('plan-authorization-action-mismatch');
    }
  } else if (decision.action === 'draft_private') {
    const targetCompanyId = Number(message.author.companyId);
    if (!Number.isSafeInteger(targetCompanyId) || targetCompanyId <= 0
        || message.content.text.length < 4 || message.content.text.length > 500) {
      failPlan('plan-private-source-binding-invalid');
    }
    actionName = 'chat_private_send';
    actionParams = {
      targetCompany: message.author.companyName,
      targetCompanyId,
      text: decision.text,
      inReplyToText: message.content.text,
      sourceMessageId: message.messageId,
      sourceCreatedAt: message.createdAt,
      attemptId,
      confirm: true,
    };
    renderedText = decision.text;
  } else if (decision.action === 'draft_public') {
    const { href, exactBody } = planStep('plan-public-source-binding-invalid', () =>
      exactPublicReplySource(message, sourceBinding));
    planStep('plan-public-context-invalid', () => assertFreshPublicContext({
      message,
      publicSafety,
      publicStyle,
      businessSnapshot,
      nowMs,
    }));
    const parts = planStep('plan-public-parts-invalid', () => normalizePublicParts(decision.parts));
    const bodyPlan = planStep('plan-public-parts-invalid', () => buildPublicPostPlan(
      parts.map(part => part.type === 'text'
      ? { type: 'text', value: part.value }
      : { type: 'resource', kind: part.kind, name: part.name })));
    if (publicStyle != null && (!validatePublicStyleProfile(publicStyle, {
      roomId: message.conversationId,
    }) || bodyPlan.charCount > publicStyle.recommendedBodyMaxCharacters)) {
      failPlan('plan-public-style-limit');
    }
    const plan = planStep('plan-public-parts-invalid', () => buildPublicPostPlan(
      parts.map(part => part.type === 'text'
      ? { type: 'text', value: part.value }
      : { type: 'resource', kind: part.kind, name: part.name }), {
      replyPrefix: replyPrefix(message.author.companyName),
      }));
    const policy = planStep('plan-public-policy-refused', () => evaluatePublicSend({
      text: plan.finalMarkup,
      roomId: message.conversationId,
      reason: decision.publicReason,
      recentPublicMessages: publicSafety?.recentPublicMessages || [],
      now: new Date(nowMs),
      knownHumanNames: publicSafety?.knownHumanNames || [],
    }));
    if (!policy.ok) failPlan('plan-public-policy-refused');
    actionName = 'chat_room_reply';
    actionParams = {
      room: message.conversationId,
      company: message.author.companyName,
      bodyContains: exactBody,
      conversationHref: href,
      sourceCompanyId: Number(message.author.companyId),
      sourceMessageId: message.messageId,
      sourceCreatedAt: message.createdAt,
      parts,
      reason: decision.publicReason,
      attemptId,
      confirm: true,
    };
    renderedText = plan.finalMarkup;
  } else {
    failPlan('plan-unsupported-action');
  }

  if (['draft_private', 'draft_public'].includes(decision.action)
      && ordinaryDraftHasEconomicSignal(
        decision,
        renderedText,
        offer,
        trustedResourceCatalog,
      )) {
    failPlan('plan-ordinary-template-rejected');
  }
  const needsAuthorization = requiresEconomicCommunicationAuthorization(
    actionName,
    actionParams,
    renderedText,
  );
  if (needsAuthorization && authorizationRequest == null) {
    if (typeof authorizationRequestFactory !== 'function') {
      failPlan('plan-authorization-factory-missing');
    }
    authorizationRequest = await planStepAsync('plan-authorization-factory-invalid', () =>
      authorizationRequestFactory(Object.freeze({
      attemptId,
      decision,
      message,
      offer,
      evaluation,
      businessSnapshot,
      agreementEvidence,
      sourceBinding,
      actionName,
      actionParams: deepFreeze(jsonClone(actionParams, 'actionParams')),
      })));
    if (!plainObject(authorizationRequest)) {
      failPlan('plan-authorization-factory-invalid');
    }
    const builder = authorizationAdapter?.build || buildAuthorization;
    builtAuthorization = await planStepAsync('plan-authorization-build-refused', () =>
      builder.call(authorizationAdapter, authorizationRequest, { now: nowMs }));
    if (builtAuthorization.actionName !== actionName
        || !exactActionParamsEqual(builtAuthorization.actionParams, actionParams)) {
      failPlan('plan-authorization-action-mismatch');
    }
  }

  return {
    actionName,
    actionParams,
    previewParams: { ...actionParams, confirm: false },
    renderedText,
    needsAuthorization,
    authorizationRequest,
    builtAuthorization,
  };
}

async function buildProactiveActionPlan({
  intent,
  businessSnapshot,
  publicSafety,
  publicStyle,
  attemptId,
  authorizationAdapter,
  trustedResourceCatalog,
  nowMs,
}) {
  const room = String(intent?.roomId ?? '').normalize('NFKC').trim();
  const messageContext = { conversationId: room };
  planStep('plan-public-context-invalid', () => assertFreshPublicContext({
    message: messageContext,
    publicSafety,
    publicStyle,
    businessSnapshot,
    nowMs,
  }));
  const source = intent?.offer?.source;
  if (source?.trust !== 'internal-business-intent'
      || source.conversationType !== 'room'
      || source.conversationId !== room
      || typeof source.messageId !== 'string') {
    failPlan('plan-authorization-input-invalid');
  }
  const authorizationRequest = {
    attemptId,
    intent: 'public-offer',
    delivery: 'public-post',
    source: {
      conversationType: 'room',
      conversationId: room,
      messageId: source.messageId,
      counterpartyCompanyId: String(source.counterpartyCompanyId),
      counterpartyCompanyName: source.counterpartyCompanyName,
      createdAt: source.createdAt,
      observedAt: source.observedAt,
      visibleText: 'Verified internal business intent',
      conversationHref: null,
    },
    destination: {
      conversationType: 'room',
      conversationId: room,
      room,
    },
    terms: intent.terms,
    offer: intent.offer,
    businessSnapshot,
    agreementEvidence: null,
    trustedResourceCatalog,
  };
  const builder = authorizationAdapter?.build || buildAuthorization;
  const builtAuthorization = await planStepAsync('plan-authorization-build-refused', () =>
    builder.call(
      authorizationAdapter,
      authorizationRequest,
      { now: nowMs },
    ));
  if (builtAuthorization.actionName !== 'chat_room_post') {
    failPlan('plan-authorization-action-mismatch');
  }
  const actionParams = builtAuthorization.actionParams;
  const parts = planStep('plan-public-parts-invalid', () =>
    normalizePublicParts(actionParams.parts));
  const exactPlan = planStep('plan-public-parts-invalid', () => buildPublicPostPlan(
    parts.map(part => part.type === 'text'
    ? { type: 'text', value: part.value }
    : { type: 'resource', kind: part.kind, name: part.name })));
  if (exactPlan.charCount > publicStyle.recommendedBodyMaxCharacters) {
    failPlan('plan-public-style-limit');
  }
  const policy = planStep('plan-public-policy-refused', () => evaluatePublicSend({
    text: exactPlan.finalMarkup,
    roomId: room,
    reason: 'verified-offer',
    recentPublicMessages: publicSafety.recentPublicMessages,
    now: new Date(nowMs),
    knownHumanNames: publicSafety.knownHumanNames || [],
  }));
  if (!policy.ok) failPlan('plan-public-policy-refused');
  return {
    actionName: 'chat_room_post',
    actionParams,
    previewParams: { ...actionParams, confirm: false },
    renderedText: exactPlan.finalMarkup,
    needsAuthorization: true,
    authorizationRequest,
    builtAuthorization,
  };
}

function normalizedHref(value) {
  const href = exactSimCompaniesHref(value);
  return href == null ? null : new URL(href).href;
}

function validateExactPreview(plan, result) {
  if (!plainObject(plan) || !plainObject(result)) {
    return { ok: false, reason: 'preview-result-missing' };
  }
  const params = plan.actionParams;
  if (plan.actionName === 'chat_private_send') {
    const ok = result.ok === true && result.dry === true
      && result.attemptId === params.attemptId
      && result.targetCompany === params.targetCompany
      && Number(result.targetCompanyId) === params.targetCompanyId
      && result.wouldSend === params.text
      && result.destinationVerified === true
      && result.targetIdVerified === true
      && result.composerEmpty === true
      && result.exactOwnMessageAbsent === true
      && typeof result.destinationRoute === 'string' && result.destinationRoute.trim().length > 0;
    return ok ? { ok: true } : { ok: false, reason: 'private-preview-binding-mismatch' };
  }
  if (plan.actionName === 'chat_room_reply') {
    const prefix = replyPrefix(params.company);
    const publicPlan = buildPublicPostPlan(params.parts.map(part => part.type === 'text'
      ? { type: 'text', value: part.value }
      : { type: 'resource', kind: part.kind, name: part.name }), { replyPrefix: prefix });
    const ok = result.ok === true && result.dry === true && result.compositeReply === true
      && result.room === params.room && result.company === params.company
      && result.wouldInsert === prefix && result.wouldPost === publicPlan.finalMarkup
      && String(result.sourceMessageIdVerified) === String(params.sourceMessageId)
      && Number(result.sourceCompanyIdVerified) === Number(params.sourceCompanyId)
      && result.sourceCreatedAtVerified === params.sourceCreatedAt
      && normalizedHref(result.conversationHref) === normalizedHref(params.conversationHref);
    return ok ? { ok: true } : { ok: false, reason: 'public-preview-binding-mismatch' };
  }
  if (plan.actionName === 'chat_room_post') {
    const publicPlan = buildPublicPostPlan(params.parts.map(part => part.type === 'text'
      ? { type: 'text', value: part.value }
      : { type: 'resource', kind: part.kind, name: part.name }));
    const sameKinds = Array.isArray(result.resourceKinds)
      && result.resourceKinds.length === publicPlan.resourceKinds.length
      && result.resourceKinds.every((kind, index) => kind === publicPlan.resourceKinds[index]);
    const ok = result.ok === true && result.dry === true && result.paneScoped === true
      && result.room === params.room && result.attemptId === params.attemptId
      && result.wouldPost === publicPlan.finalMarkup
      && result.visibleText === publicPlan.visibleText
      && sameKinds;
    return ok ? { ok: true } : { ok: false, reason: 'public-post-preview-binding-mismatch' };
  }
  return { ok: false, reason: WORKER_ERROR_REASONS.UNSUPPORTED_PREVIEW_ACTION };
}

function economicPostconditionVerified(result) {
  return result?.economicCommunication?.status === 'VERIFIED'
    && result?.economicCommunication?.postconditionVerified === true;
}

function classifyConfirmedOutcome({ plan, result, privateOutbox, sourceMessageId }) {
  const economicRequired = plan.needsAuthorization === true;
  if (plan.actionName === 'chat_private_send') {
    let outboxAttempt = null;
    try { outboxAttempt = privateOutbox?.getAttempt(plan.actionParams.attemptId) ?? null; }
    catch {
      return { state: 'AMBIGUOUS', outcomeCode: 'private-outbox-unreadable', verified: false };
    }
    const exactSuccess = result?.ok === true && result?.posted === true
      && result?.mutationAttempted === true
      && result?.attemptId === plan.actionParams.attemptId
      && result?.targetCompany === plan.actionParams.targetCompany
      && Number(result?.targetCompanyId) === plan.actionParams.targetCompanyId
      && String(result?.sourceMessageIdVerified) === String(plan.actionParams.sourceMessageId)
      && result?.sourceCreatedAtVerified === plan.actionParams.sourceCreatedAt
      && result?.postcondition === 'unique-added-own-node+cleared-composer+exact-destination'
      && outboxAttempt?.status === 'sent'
      && (!economicRequired || economicPostconditionVerified(result));
    if (exactSuccess) {
      return { state: 'VERIFIED', outcomeCode: 'exact-private-postcondition', verified: true };
    }
    if (outboxAttempt == null && result?.preClickFailure === true
        && result?.mutationAttempted !== true && result?.ambiguous !== true
        && result?.doNotRetry !== true) {
      return { state: 'FAILED_PRE_CLICK', outcomeCode: 'private-pre-click-failed', verified: false };
    }
    if (outboxAttempt?.status === 'pre-click-failed'
        && result?.mutationAttempted !== true && result?.ambiguous !== true) {
      return { state: 'FAILED_PRE_CLICK', outcomeCode: 'private-pre-click-failed', verified: false };
    }
    return { state: 'AMBIGUOUS', outcomeCode: 'private-send-unproven', verified: false };
  }

  if (plan.actionName === 'chat_room_reply') {
    const exactSuccess = result?.ok === true && result?.posted === true
      && result?.sendClicked === true && result?.status === 'VERIFIED'
      && result?.room === plan.actionParams.room
      && result?.attemptId === plan.actionParams.attemptId
      && result?.compositeReply === true && result?.replyTargetVerified === true
      && String(result?.replySourceMessageIdVerified) === String(sourceMessageId)
      && Number(result?.replySourceCompanyIdVerified) === Number(plan.actionParams.sourceCompanyId)
      && result?.replySourceCreatedAtVerified === plan.actionParams.sourceCreatedAt
      && (!economicRequired || economicPostconditionVerified(result));
    if (exactSuccess) {
      return { state: 'VERIFIED', outcomeCode: 'exact-public-postcondition', verified: true };
    }
    const explicitlyPreClick = result?.sendClicked === false
      && result?.mutationAttempted !== true && result?.ambiguous !== true
      && result?.doNotRetry !== true && !String(result?.status || '').includes('UNKNOWN');
    if (explicitlyPreClick) {
      return { state: 'FAILED_PRE_CLICK', outcomeCode: 'public-pre-click-failed', verified: false };
    }
    return { state: 'AMBIGUOUS', outcomeCode: 'public-send-unproven', verified: false };
  }
  if (plan.actionName === 'chat_room_post') {
    const expectedKinds = plan.actionParams.parts
      .filter(part => part.type === 'resource')
      .map(part => part.kind);
    const sameKinds = Array.isArray(result?.resourceKinds)
      && result.resourceKinds.length === expectedKinds.length
      && result.resourceKinds.every((kind, index) => kind === expectedKinds[index]);
    const exactSuccess = result?.ok === true && result?.posted === true
      && result?.sendClicked === true && result?.status === 'VERIFIED'
      && result?.room === plan.actionParams.room
      && result?.attemptId === plan.actionParams.attemptId
      && sameKinds
      && (!economicRequired || economicPostconditionVerified(result));
    if (exactSuccess) {
      return { state: 'VERIFIED', outcomeCode: 'exact-public-postcondition', verified: true };
    }
    const explicitlyPreClick = result?.sendClicked === false
      && result?.mutationAttempted !== true && result?.ambiguous !== true
      && result?.doNotRetry !== true && !String(result?.status || '').includes('UNKNOWN');
    if (explicitlyPreClick) {
      return { state: 'FAILED_PRE_CLICK', outcomeCode: 'public-pre-click-failed', verified: false };
    }
    return { state: 'AMBIGUOUS', outcomeCode: 'public-send-unproven', verified: false };
  }
  return { state: 'AMBIGUOUS', outcomeCode: 'unsupported-confirmed-action', verified: false };
}

function createRuntimeGuard(options, mode, startedAtMs) {
  const clock = options.clock || Date.now;
  const cycleDeadlineMs = boundedInteger(
    options.cycleDeadlineMs,
    DEFAULT_CYCLE_DEADLINE_MS,
    100,
    5 * 60 * 1000,
    'cycleDeadlineMs',
  );
  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    100,
    30 * 1000,
    'operationTimeoutMs',
  );
  const wakeSafetyMarginMs = boundedInteger(
    options.wakeSafetyMarginMs,
    DEFAULT_WAKE_SAFETY_MARGIN_MS,
    1000,
    30 * 60 * 1000,
    'wakeSafetyMarginMs',
  );
  const deadlineAtMs = options.deadlineAtMs == null
    ? startedAtMs + cycleDeadlineMs : Number(options.deadlineAtMs);
  if (!Number.isFinite(deadlineAtMs)) throw new TypeError('deadlineAtMs must be finite');

  return Object.freeze({
    deadlineAtMs,
    wakeSafetyMarginMs,
    async check(label, mutation = false) {
      if (typeof options.permissionGuard !== 'function') {
        return { ok: false, reason: 'permission-guard-required', label };
      }
      if (typeof options.nextWakeReader !== 'function') {
        return { ok: false, reason: WORKER_ERROR_REASONS.NEXT_WAKE_READER_REQUIRED, label };
      }
      let permission;
      try {
        permission = await options.permissionGuard(Object.freeze({ label, mode, mutation }));
      } catch {
        return { ok: false, reason: 'permission-guard-failed', label };
      }
      if (permission?.ok !== true || permission.brainLockHeld !== true
          || permission.tickLockHeld !== true || (mutation && permission.mutationAllowed !== true)) {
        return { ok: false, reason: 'lock-or-mutation-permission-denied', label };
      }
      let alarm;
      try { alarm = parseAlarm(await options.nextWakeReader()); }
      catch { return { ok: false, reason: 'next-wake-read-failed', label }; }
      if (!alarm) return { ok: false, reason: 'next-wake-unknown', label };
      const currentMs = nowMilliseconds(clock);
      const deadlineRemainingMs = deadlineAtMs - currentMs;
      const wakeLeadMs = alarm.at - currentMs;
      const wakeBudgetMs = wakeLeadMs - wakeSafetyMarginMs;
      if (deadlineRemainingMs <= 0) {
        return { ok: false, reason: 'active-cycle-deadline-exceeded', label };
      }
      if (wakeBudgetMs <= 0) {
        return { ok: false, reason: 'next-wake-safety-margin', label, wakeLeadMs };
      }
      return {
        ok: true,
        label,
        timeoutMs: Math.max(1, Math.floor(Math.min(
          operationTimeoutMs,
          deadlineRemainingMs,
          wakeBudgetMs,
        ))),
        wakeLeadMs,
      };
    },
  });
}

async function runBoundedOperation(operation, control) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('active chat operation timed out');
      error.code = 'ACTIVE_CHAT_OPERATION_TIMEOUT';
      reject(error);
    }, control.timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(Object.freeze({
        timeoutMs: control.timeoutMs,
        signal: controller.signal,
      }))),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function normalizeReadRequest(value, index) {
  if (!plainObject(value) || !READ_ACTIONS.has(value.action)
      || !plainObject(value.params) || Object.prototype.hasOwnProperty.call(value.params, 'confirm')) {
    throw new TypeError(`readRequests[${index}] is not an allowed read action`);
  }
  const expectedType = value.action === 'chat_private_read' ? 'private' : 'room';
  if (value.conversationType !== expectedType) {
    throw new TypeError(`readRequests[${index}] conversation type does not match its action`);
  }
  const conversationId = String(value.conversationId ?? '').trim();
  if (!conversationId || conversationId.length > 160) {
    throw new TypeError(`readRequests[${index}].conversationId is invalid`);
  }
  if (expectedType === 'room'
      && String(value.params.room ?? '').trim() !== conversationId) {
    throw new TypeError(`readRequests[${index}] room identity is not canonically bound`);
  }
  if (expectedType === 'private') {
    const targetCompany = String(value.params.targetCompany ?? '').trim();
    const targetCompanyId = Number(value.params.targetCompanyId);
    if (!targetCompany || targetCompany.length > 200
        || !Number.isSafeInteger(targetCompanyId) || targetCompanyId <= 0
        || conversationId !== `company-${targetCompanyId}`) {
      throw new TypeError(`readRequests[${index}] private identity is not canonically bound`);
    }
  }
  return {
    action: value.action,
    params: jsonClone(value.params, `readRequests[${index}].params`),
    conversationType: expectedType,
    conversationId,
    ownCompanyId: value.ownCompanyId ?? null,
    ownCompanyName: value.ownCompanyName ?? null,
    sourceBinding: value.sourceBinding ?? null,
    sourceBindings: value.sourceBindings ?? null,
  };
}

function normalizedPublicBody(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function derivePublicSourceBindings(result) {
  const bindings = new Map();
  const ambiguous = new Set();
  for (const group of Array.isArray(result?.groups) ? result.groups : []) {
    if (group?.fromMe === true) continue;
    const company = normalizedPublicBody(group?.company);
    const companyId = Number(group?.companyId);
    const conversationHref = exactSimCompaniesHref(group?.conversationHref);
    if (!company || company.length > 200
        || !Number.isSafeInteger(companyId) || companyId <= 0
        || !Number.isFinite(Date.parse(group?.exactTime)) || !conversationHref) continue;
    for (const message of Array.isArray(group?.messages) ? group.messages : []) {
      const messageId = typeof message?.messageId === 'number'
        ? (Number.isSafeInteger(message.messageId) && message.messageId > 0
          ? String(message.messageId) : null)
        : (typeof message?.messageId === 'string' && message.messageId.trim()
          && message.messageId.length <= 160 ? message.messageId.trim() : null);
      const bodyContains = normalizedPublicBody(message?.text ?? message?.visibleText);
      const sourceCreatedAt = typeof message?.exactTime === 'string'
        ? message.exactTime : group.exactTime;
      if (!messageId || bodyContains.length < 4 || bodyContains.length > 240
          || !Number.isFinite(Date.parse(sourceCreatedAt))) continue;
      if (bindings.has(messageId)) {
        ambiguous.add(messageId);
        bindings.delete(messageId);
        continue;
      }
      if (!ambiguous.has(messageId)) {
        bindings.set(messageId, Object.freeze({
          messageId,
          company,
          sourceCompanyId: companyId,
          sourceCreatedAt: new Date(Date.parse(sourceCreatedAt)).toISOString(),
          bodyContains,
          conversationHref,
        }));
      }
    }
  }
  return bindings;
}

function sourceBindingFor(readRequest, messageId, derivedBindings = null, {
  allowConfiguredFallback = false,
} = {}) {
  const derived = derivedBindings?.get(String(messageId));
  if (derived != null) return derived;
  if (!allowConfiguredFallback) return null;
  if (plainObject(readRequest.sourceBindings)
      && Object.prototype.hasOwnProperty.call(readRequest.sourceBindings, messageId)) {
    return readRequest.sourceBindings[messageId];
  }
  return readRequest.sourceBinding;
}

function agreementEvidenceFor(options, messageId) {
  if (typeof options.agreementEvidenceResolver === 'function') {
    return options.agreementEvidenceResolver(messageId);
  }
  return plainObject(options.agreementEvidenceByMessageId)
    ? options.agreementEvidenceByMessageId[messageId] ?? null : null;
}

function chatSafetyFor(options, roomId) {
  if (typeof options.publicSafetyResolver === 'function') {
    return options.publicSafetyResolver(roomId);
  }
  return plainObject(options.publicSafetyByRoom)
    ? options.publicSafetyByRoom[roomId] ?? null : null;
}

async function runActiveChatCycle(options = {}) {
  const mode = normalizeChatMode(options.mode);
  if (mode === 'off') {
    return {
      ok: true,
      skipped: true,
      mode,
      reason: 'chat-runtime-off',
      mutationAuthorized: false,
      actions: [],
      proposals: [],
      outcomes: [],
    };
  }
  if (typeof options.actionRunner !== 'function') throw new TypeError('actionRunner is required');
  if (!plainObject(options.store) || typeof options.store.ingestObservation !== 'function') {
    throw new TypeError('a durable injected store with ingestObservation() is required');
  }
  if (!Array.isArray(options.readRequests)) throw new TypeError('readRequests must be an array');
  if (mode !== 'read-only') {
    const decide = typeof options.decisionProvider === 'function'
      ? options.decisionProvider : options.decisionProvider?.decide;
    if (typeof decide !== 'function') throw new TypeError('decisionProvider must provide decide()');
  }

  const clock = options.clock || Date.now;
  const startedAtMs = nowMilliseconds(clock);
  const startedAt = new Date(startedAtMs).toISOString();
  const limits = normalizeLimits(options.limits);
  const rateWindowMs = boundedInteger(
    options.rateWindowMs,
    DEFAULT_RATE_WINDOW_MS,
    60 * 1000,
    24 * 60 * 60 * 1000,
    'rateWindowMs',
  );
  const sourceMaxAgeMs = boundedInteger(
    options.sourceMaxAgeMs,
    DEFAULT_SOURCE_MAX_AGE_MS,
    5 * 60 * 1000,
    24 * 60 * 60 * 1000,
    'sourceMaxAgeMs',
  );
  const guard = createRuntimeGuard(options, mode, startedAtMs);
  const authorizationAdapter = normalizeAuthorizationAdapter(options);
  const actionLog = [];
  const errors = [];
  const proposals = [];
  const outcomes = [];
  const observations = [];
  const strictInbound = [];
  const styleInbound = [];
  const seenSources = new Set();
  const seenStyleSources = new Set();
  let actions = 0;
  let reads = 0;
  let decisionCalls = 0;
  const decisionUsage = {
    knownCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  let previews = 0;
  let confirmAttempts = 0;
  let stopReason = null;
  let remainingObservedMessages = limits.maxObservedMessages;

  const initialGuard = await guard.check('cycle-start', false);
  if (!initialGuard.ok) {
    const healthyWakeYield = initialGuard.reason === 'next-wake-safety-margin';
    return {
      ok: healthyWakeYield,
      skipped: true,
      mode,
      reason: initialGuard.reason,
      mutationAuthorized: false,
      actions: [],
      proposals: [],
      outcomes: [],
    };
  }

  const readRequests = options.readRequests.slice(0, limits.maxReads)
    .map(normalizeReadRequest);
  for (const readRequest of readRequests) {
    if (actions >= limits.maxActions || reads >= limits.maxReads
        || remainingObservedMessages <= 0) break;
    const readGuard = await guard.check(`read:${readRequest.action}`, false);
    if (!readGuard.ok) { stopReason = readGuard.reason; break; }
    reads += 1;
    actions += 1;
    actionLog.push({ action: readRequest.action, phase: 'read', confirm: null });
    let result;
    try {
      result = await runBoundedOperation(control => options.actionRunner(
        readRequest.action,
        deepFreeze(jsonClone(readRequest.params, 'read params')),
        control,
      ), readGuard);
    } catch (error) {
      errors.push({ stage: 'read', reason: error?.code === 'ACTIVE_CHAT_OPERATION_TIMEOUT'
        ? 'read-timeout' : 'read-runner-failed' });
      if (error?.code === 'ACTIVE_CHAT_OPERATION_TIMEOUT') stopReason = 'read-timeout';
      continue;
    }
    if (result?.ok !== true) {
      errors.push({ stage: 'read', reason: 'read-not-successful' });
      continue;
    }
    let prepared;
    let derivedPublicBindings = null;
    try {
      if (readRequest.conversationType === 'room') {
        derivedPublicBindings = derivePublicSourceBindings(result);
      }
      const boundedResult = readRequest.conversationType === 'private'
        ? boundPrivateResult(result, {
          ...limits,
          maxObservedMessages: remainingObservedMessages,
        }, {
          company: readRequest.params.targetCompany,
          companyId: readRequest.params.targetCompanyId,
        })
        : boundPublicResult(result, {
          ...limits,
          maxObservedMessages: remainingObservedMessages,
        });
      prepared = prepareChatIngest({
        conversationType: readRequest.conversationType,
        conversationId: readRequest.conversationId,
        result: boundedResult,
        observedAt: new Date(nowMilliseconds(clock)),
        ownCompanyId: readRequest.ownCompanyId,
        ownCompanyName: readRequest.ownCompanyName,
      });
    } catch {
      errors.push({ stage: 'ingest', reason: 'observation-normalization-failed' });
      continue;
    }
    const ingestGuard = await guard.check('persist-observation', false);
    if (!ingestGuard.ok) { stopReason = ingestGuard.reason; break; }
    let persisted;
    try {
      persisted = await runBoundedOperation(control => options.store.ingestObservation({
        readRequest: {
          action: readRequest.action,
          conversationType: readRequest.conversationType,
          conversationId: readRequest.conversationId,
        },
        prepared,
      }, control), ingestGuard);
    } catch {
      errors.push({ stage: 'ingest', reason: 'observation-persistence-failed' });
      continue;
    }
    if (persisted?.ok !== true || persisted.durable !== true) {
      errors.push({ stage: 'ingest', reason: 'observation-not-durable' });
      continue;
    }
    observations.push({
      conversationType: readRequest.conversationType,
      conversationId: readRequest.conversationId,
      observationId: prepared.observationSnapshot.observationId,
      ledgerEligibleCount: prepared.ledgerMessages.length,
      newlyInsertedCount: Array.isArray(persisted.newMessageIds)
        ? persisted.newMessageIds.length : null,
    });
    const newlyInsertedIds = Array.isArray(persisted.newMessageIds)
      ? new Set(persisted.newMessageIds.map(String)) : null;
    remainingObservedMessages -= prepared.observationSnapshot.observations.length;
    for (const message of prepared.ledgerMessages) {
      if (message.direction !== 'inbound') continue;
      const key = sourceKey(message);
      let safeStyleSample = false;
      try { safeStyleSample = isolateExternalMessage(message).injectionAssessment.suspicious !== true; }
      catch { safeStyleSample = false; }
      if (safeStyleSample && !seenStyleSources.has(key)) {
        seenStyleSources.add(key);
        styleInbound.push(message);
      }
      if (strictInbound.length >= limits.maxObservedMessages) continue;
      if (newlyInsertedIds != null && !newlyInsertedIds.has(String(message.messageId))) continue;
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      strictInbound.push({
        message,
        sourceKey: key,
        sourceBinding: sourceBindingFor(readRequest, message.messageId, derivedPublicBindings, {
          allowConfiguredFallback: mode === 'shadow' || mode === 'read-only',
        }),
      });
    }
  }

  if (mode === 'read-only') {
    return {
      ok: errors.length === 0 && stopReason == null,
      skipped: false,
      stoppedEarly: stopReason != null,
      mode,
      reason: stopReason,
      mutationAuthorized: false,
      actions: actionLog,
      observations,
      strictInboundMessages: strictInbound.length,
      proposals,
      outcomes,
      errors,
    };
  }

  strictInbound.sort((left, right) => Date.parse(right.message.createdAt)
    - Date.parse(left.message.createdAt) || left.sourceKey.localeCompare(right.sourceKey));
  const publicStylesByRoom = new Map();
  const observedRoomIds = [...new Set(readRequests
    .filter(request => request.conversationType === 'room')
    .map(request => request.conversationId))];
  for (const roomId of observedRoomIds) {
    publicStylesByRoom.set(roomId, buildPublicStyleProfile(
      styleInbound,
      {
        roomId,
        observedAt: new Date(nowMilliseconds(clock)),
      },
    ));
  }
  const proactiveRoomIds = [];
  if (options.proactiveRoomIds != null) {
    if (!Array.isArray(options.proactiveRoomIds)) {
      throw new TypeError('proactiveRoomIds must be an array');
    }
    const observedRooms = new Set(observedRoomIds);
    for (const value of options.proactiveRoomIds) {
      const room = String(value ?? '').normalize('NFKC').trim();
      if (!room || room.length > 120 || !observedRooms.has(room)) continue;
      if (!proactiveRoomIds.includes(room)) proactiveRoomIds.push(room);
      if (proactiveRoomIds.length >= 4) break;
    }
  }
  const provider = typeof options.decisionProvider === 'function'
    ? { decide: options.decisionProvider } : options.decisionProvider;
  let businessSnapshot;
  try {
    businessSnapshot = resolveBusinessSnapshot(options, nowMilliseconds(clock));
    if (businessSnapshot != null) {
      businessSnapshot = deepFreeze(jsonClone(businessSnapshot, 'businessSnapshot'));
    }
  }
  catch {
    errors.push({ stage: 'decision', reason: 'business-snapshot-load-failed' });
    stopReason ||= 'business-snapshot-load-failed';
  }
  if (!validateBusinessSnapshotFreshness(businessSnapshot, nowMilliseconds(clock))) {
    errors.push({ stage: 'decision', reason: 'business-snapshot-required' });
    stopReason ||= 'business-snapshot-required';
  }

  async function sourceIsBlocked(exactSourceKey) {
    if (typeof options.store.getSourceState !== 'function') {
      throw new Error('durable store getSourceState() is required for active modes');
    }
    const stateGuard = await guard.check('read-source-state', false);
    if (!stateGuard.ok) throw Object.assign(new Error(stateGuard.reason), { guardReason: stateGuard.reason });
    const state = await runBoundedOperation(
      control => options.store.getSourceState(exactSourceKey, control),
      stateGuard,
    );
    const normalized = normalizeSourceState(state);
    if (normalized == null || normalized === 'FAILED_PRE_CLICK') return false;
    if (BLOCKING_SOURCE_STATES.has(normalized)) return true;
    throw new Error('durable source state is unknown or corrupt');
  }

  async function rateAvailable() {
    if (typeof options.store.countConfirmAttemptsSince !== 'function') {
      throw new Error('durable store countConfirmAttemptsSince() is required for active modes');
    }
    const rateGuard = await guard.check('confirm-rate-check', false);
    if (!rateGuard.ok) throw Object.assign(new Error(rateGuard.reason), { guardReason: rateGuard.reason });
    const count = await runBoundedOperation(control => options.store.countConfirmAttemptsSince(
      nowMilliseconds(clock) - rateWindowMs,
      control,
    ), rateGuard);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('confirm rate count is invalid');
    return count < limits.maxConfirmAttemptsPerWindow;
  }

  async function contentIsBlocked(candidate, plan) {
    if (typeof options.store.hasRecentContentAttempt !== 'function') {
      if (mode === 'shadow') return false;
      throw new Error('durable store hasRecentContentAttempt() is required for active modes');
    }
    const contentGuard = await guard.check('content-replay-check', false);
    if (!contentGuard.ok) {
      throw Object.assign(new Error(contentGuard.reason), { guardReason: contentGuard.reason });
    }
    return runBoundedOperation(control => options.store.hasRecentContentAttempt({
      sourceKey: candidate.sourceKey,
      actionName: plan.actionName,
      contentFingerprint: digest(plan.renderedText),
      sinceMs: nowMilliseconds(clock) - CONTENT_REPLAY_WINDOW_MS,
    }, control), contentGuard);
  }

  async function runShadowPublicPreview(candidate, plan, proposal, contentFingerprint) {
    if (mode !== 'shadow'
        || !['chat_room_reply', 'chat_room_post'].includes(plan.actionName)) return false;
    if (previews >= limits.maxPreviews || actions + 1 > limits.maxActions) return false;
    if (typeof options.store.recordShadowPreview !== 'function') {
      errors.push({ stage: 'preview', reason: 'shadow-preview-store-required' });
      return false;
    }
    const runtimeAuthorization = authorizeChatAction(
      plan.actionName,
      plan.previewParams,
      mode,
    );
    if (!runtimeAuthorization.ok || runtimeAuthorization.previewOnly !== true) {
      errors.push({ stage: 'authorize', reason: 'runtime-mode-refused-confirmation' });
      return false;
    }
    const previewGuard = await guard.check(`shadow-preview:${plan.actionName}`, false);
    if (!previewGuard.ok) {
      stopReason ||= previewGuard.reason;
      return false;
    }
    previews += 1;
    actions += 1;
    actionLog.push({ action: plan.actionName, phase: 'shadow-preview', confirm: false,
      attemptId: plan.actionParams.attemptId });
    let previewResult;
    try {
      previewResult = await runBoundedOperation(control => options.actionRunner(
        plan.actionName,
        deepFreeze(jsonClone(plan.previewParams, 'shadow preview params')),
        control,
      ), previewGuard);
    } catch (error) {
      errors.push({ stage: 'preview', reason: error?.code === 'ACTIVE_CHAT_OPERATION_TIMEOUT'
        ? 'preview-timeout' : 'preview-runner-failed' });
      return false;
    }
    const validation = validateExactPreview(plan, previewResult);
    if (!validation.ok) {
      errors.push({ stage: 'preview', reason: validation.reason });
      return false;
    }
    const persistenceGuard = await guard.check('persist-shadow-preview', false);
    if (!persistenceGuard.ok) {
      stopReason ||= persistenceGuard.reason;
      return false;
    }
    let persisted;
    try {
      persisted = await runBoundedOperation(control => options.store.recordShadowPreview({
        schemaVersion: 1,
        attemptId: plan.actionParams.attemptId,
        sourceKey: candidate.sourceKey,
        actionName: plan.actionName,
        contentFingerprint,
        previewedAt: new Date(nowMilliseconds(clock)).toISOString(),
      }, control), persistenceGuard);
    } catch {
      errors.push({ stage: 'preview', reason: 'shadow-preview-persistence-failed' });
      return false;
    }
    if (persisted?.ok !== true || persisted.durable !== true) {
      errors.push({ stage: 'preview', reason: 'shadow-preview-persistence-failed' });
      return false;
    }
    proposal.previewStatus = 'VERIFIED';
    return true;
  }

  async function executePreparedPlan({
    candidate,
    plan,
    proposal,
    contentFingerprint,
    attemptId,
  }) {
    if (previews >= limits.maxPreviews || confirmAttempts >= limits.maxConfirmAttempts
        || actions + 2 > limits.maxActions) return 'continue';

    const authorization = authorizeChatAction(plan.actionName, plan.actionParams, mode);
    if (!authorization.ok || authorization.previewOnly === true) {
      errors.push({ stage: 'authorize', reason: 'runtime-mode-refused-confirmation' });
      return 'continue';
    }
    if (plan.actionName === 'chat_private_send') {
      if (!options.privateOutbox || typeof options.privateOutbox.getAttempt !== 'function') {
        errors.push({ stage: 'authorize', reason: 'private-outbox-required' });
        return 'continue';
      }
      try {
        if (options.privateOutbox.getAttempt(attemptId)) {
          outcomes.push({ sourceKey: candidate.sourceKey, attemptId, state: 'AMBIGUOUS',
            reason: 'private-outbox-replay-blocked' });
          return 'continue';
        }
      } catch {
        errors.push({ stage: 'authorize', reason: 'private-outbox-unreadable' });
        return 'continue';
      }
    }
    if (plan.needsAuthorization && !authorizationAdapter) {
      errors.push({ stage: 'authorize', reason: 'durable-economic-authorization-required' });
      return 'continue';
    }
    if (plan.needsAuthorization && typeof authorizationAdapter.getAttemptStatus === 'function') {
      let existingStatus;
      try { existingStatus = await authorizationAdapter.getAttemptStatus(attemptId); }
      catch {
        errors.push({ stage: 'authorize', reason: 'economic-authorization-store-unreadable' });
        return 'continue';
      }
      if (existingStatus != null) {
        outcomes.push({ sourceKey: candidate.sourceKey, attemptId, state: 'AMBIGUOUS',
          reason: 'economic-authorization-replay-blocked' });
        return 'continue';
      }
    }
    let rateOk;
    try { rateOk = await rateAvailable(); }
    catch (error) {
      errors.push({ stage: 'rate', reason: error.guardReason || 'confirm-rate-unavailable' });
      stopReason = error.guardReason || 'confirm-rate-unavailable';
      return 'break';
    }
    if (!rateOk) {
      errors.push({ stage: 'rate', reason: 'confirm-rate-limit' });
      return 'continue';
    }

    const previewGuard = await guard.check(`preview:${plan.actionName}`, false);
    if (!previewGuard.ok) {
      stopReason = previewGuard.reason;
      return 'break';
    }
    previews += 1;
    actions += 1;
    actionLog.push({ action: plan.actionName, phase: 'preview', confirm: false, attemptId });
    let previewResult;
    try {
      previewResult = await runBoundedOperation(control => options.actionRunner(
        plan.actionName,
        deepFreeze(jsonClone(plan.previewParams, 'preview params')),
        control,
      ), previewGuard);
    } catch (error) {
      errors.push({ stage: 'preview', reason: error?.code === 'ACTIVE_CHAT_OPERATION_TIMEOUT'
        ? 'preview-timeout' : 'preview-runner-failed' });
      return 'continue';
    }
    const previewValidation = validateExactPreview(plan, previewResult);
    if (!previewValidation.ok) {
      errors.push({ stage: 'preview', reason: previewValidation.reason });
      return 'continue';
    }
    proposal.previewStatus = 'VERIFIED';

    try { rateOk = await rateAvailable(); }
    catch (error) {
      errors.push({ stage: 'rate', reason: error.guardReason || 'confirm-rate-unavailable' });
      stopReason = error.guardReason || 'confirm-rate-unavailable';
      return 'break';
    }
    if (!rateOk) {
      errors.push({ stage: 'rate', reason: 'confirm-rate-limit-after-preview' });
      return 'continue';
    }
    if (typeof options.store.claimAttempt !== 'function'
        || typeof options.store.completeAttempt !== 'function') {
      errors.push({ stage: 'claim', reason: 'durable-attempt-store-required' });
      stopReason = 'durable-attempt-store-required';
      return 'break';
    }
    const claimGuard = await guard.check('durable-attempt-claim', true);
    if (!claimGuard.ok) {
      stopReason = claimGuard.reason;
      return 'break';
    }
    const claimRecord = {
      schemaVersion: 1,
      attemptId,
      sourceKey: candidate.sourceKey,
      state: 'ARMED',
      actionName: plan.actionName,
      contentFingerprint,
      executionBindingHash: executionBindingHash(plan.actionName, plan.actionParams),
      snapshotId: businessSnapshot.snapshotId,
      economicAuthorization: plan.needsAuthorization,
      rateLimit: {
        windowStartedAtMs: nowMilliseconds(clock) - rateWindowMs,
        maxAttempts: limits.maxConfirmAttemptsPerWindow,
      },
      armedAt: new Date(nowMilliseconds(clock)).toISOString(),
    };
    let claim;
    try {
      claim = await runBoundedOperation(
        control => options.store.claimAttempt(claimRecord, control),
        claimGuard,
      );
    } catch {
      errors.push({ stage: 'claim', reason: 'durable-attempt-claim-failed' });
      return 'continue';
    }
    if (claim?.ok !== true || claim.durable !== true) {
      errors.push({ stage: 'claim', reason: 'durable-attempt-claim-refused' });
      return 'continue';
    }
    if (typeof claim.executionClaimToken !== 'string'
        || !/^[a-f0-9]{64}$/u.test(claim.executionClaimToken)) {
      errors.push({ stage: 'claim', reason: 'durable-execution-claim-token-missing' });
      stopReason = 'durable-execution-claim-token-missing';
      return 'break';
    }

    let issuedAuthorization = null;
    if (plan.needsAuthorization) {
      const artifactGuard = await guard.check('issue-economic-authorization', true);
      if (!artifactGuard.ok) {
        stopReason = artifactGuard.reason;
        return 'break';
      }
      try {
        issuedAuthorization = await runBoundedOperation(
          () => authorizationAdapter.issue(plan.authorizationRequest, {
            now: nowMilliseconds(clock),
          }),
          artifactGuard,
        );
      } catch {
        errors.push({ stage: 'authorize', reason: 'economic-authorization-issue-failed-after-claim' });
        stopReason = 'economic-authorization-issue-failed-after-claim';
        return 'break';
      }
      if (issuedAuthorization?.ok !== true
          || issuedAuthorization.actionName !== plan.actionName
          || !exactActionParamsEqual(issuedAuthorization.actionParams, plan.actionParams)
          || issuedAuthorization.artifact?.attemptId !== attemptId) {
        errors.push({ stage: 'authorize', reason: 'issued-economic-binding-mismatch-after-claim' });
        stopReason = 'issued-economic-binding-mismatch-after-claim';
        return 'break';
      }
    }

    const confirmGuard = await guard.check(`confirm:${plan.actionName}`, true);
    if (!confirmGuard.ok) {
      outcomes.push({
        sourceKey: candidate.sourceKey,
        attemptId,
        state: 'ARMED',
        outcomeCode: 'permission-lost-before-confirm',
        postconditionVerified: false,
      });
      stopReason = confirmGuard.reason;
      return 'break';
    }
    confirmAttempts += 1;
    actions += 1;
    actionLog.push({ action: plan.actionName, phase: 'confirm', confirm: true, attemptId });
    let classification;
    try {
      const confirmedResult = await runBoundedOperation(control => options.actionRunner(
        plan.actionName,
        deepFreeze(jsonClone(plan.actionParams, 'confirm params')),
        Object.freeze({ ...control, executionClaimToken: claim.executionClaimToken }),
      ), confirmGuard);
      classification = classifyConfirmedOutcome({
        plan,
        result: confirmedResult,
        privateOutbox: options.privateOutbox,
        sourceMessageId: candidate.message?.messageId ?? null,
      });
      if (classification.state === 'VERIFIED') {
        if (typeof options.store.getAttemptState !== 'function') {
          classification = {
            state: 'AMBIGUOUS',
            outcomeCode: 'execution-claim-consumption-unproven',
            verified: false,
          };
        } else {
          const consumedGuard = await guard.check('verify-execution-claim-consumed', false);
          let durableState = null;
          if (consumedGuard.ok) {
            try {
              durableState = await runBoundedOperation(
                control => options.store.getAttemptState(attemptId, control),
                consumedGuard,
              );
            } catch {}
          }
          if (normalizeSourceState(durableState) !== 'CONFIRMING') {
            classification = {
              state: 'AMBIGUOUS',
              outcomeCode: 'execution-claim-consumption-unproven',
              verified: false,
            };
          }
        }
      }
    } catch {
      classification = {
        state: 'AMBIGUOUS',
        outcomeCode: 'confirm-runner-threw-or-timed-out',
        verified: false,
      };
    }
    const completion = {
      attemptId,
      sourceKey: candidate.sourceKey,
      state: classification.state,
      outcomeCode: classification.outcomeCode,
      postconditionVerified: classification.verified,
      completedAt: new Date(nowMilliseconds(clock)).toISOString(),
    };
    let completed = false;
    const completeGuard = await guard.check('persist-confirm-outcome', true);
    if (completeGuard.ok) {
      try {
        const completionResult = await runBoundedOperation(
          control => options.store.completeAttempt(completion, control),
          completeGuard,
        );
        completed = completionResult?.ok === true && completionResult.durable === true;
      } catch {}
    }
    if (!completed) {
      classification = {
        state: 'AMBIGUOUS',
        outcomeCode: 'outcome-persistence-unproven',
        verified: false,
      };
      errors.push({ stage: 'postcondition', reason: 'outcome-persistence-unproven' });
    }
    outcomes.push({
      sourceKey: candidate.sourceKey,
      attemptId,
      state: classification.state,
      outcomeCode: classification.outcomeCode,
      postconditionVerified: classification.verified,
      economicAuthorization: issuedAuthorization == null ? null : {
        commitmentId: issuedAuthorization.artifact.commitmentId,
        durable: true,
      },
    });
    proposal.mutationAuthorized = classification.state === 'VERIFIED';
    if (classification.state === 'AMBIGUOUS') {
      stopReason = 'ambiguous-confirm-outcome';
      return 'break';
    }
    return 'continue';
  }

  for (const candidate of strictInbound) {
    if (stopReason || decisionCalls >= limits.maxDecisionCalls) break;
    if (decisionUsage.totalTokens >= limits.maxDecisionTotalTokens) {
      stopReason = 'decision-token-budget-exhausted';
      break;
    }
    if (mode !== 'shadow') {
      const sourceAgeMs = nowMilliseconds(clock) - Date.parse(candidate.message.createdAt);
      if (!Number.isFinite(sourceAgeMs) || sourceAgeMs < -MAX_CLOCK_SKEW_MS
          || sourceAgeMs > sourceMaxAgeMs) {
        errors.push({ stage: 'source-state', reason: 'source-message-not-fresh' });
        continue;
      }
      try {
        if (await sourceIsBlocked(candidate.sourceKey)) continue;
      } catch (error) {
        errors.push({ stage: 'source-state', reason: error.guardReason || 'source-state-unavailable' });
        stopReason = error.guardReason || 'source-state-unavailable';
        break;
      }
    }

    const envelope = isolateExternalMessage(candidate.message);
    if (envelope.injectionAssessment.suspicious) {
      errors.push({ stage: 'decision', reason: 'prompt-injection-suspected' });
      continue;
    }
    let extraction;
    let offer = null;
    let evaluation = null;
    try {
      extraction = extractTradeLeads(candidate.message);
      if (extraction.offers.length === 1) {
        [offer] = extraction.offers;
        evaluation = evaluateLeadOpportunity(offer, businessSnapshot, {
          now: nowMilliseconds(clock),
        });
      }
    } catch {
      extraction = null;
      offer = null;
      evaluation = null;
    }
    const agreementEvidence = agreementEvidenceFor(options, candidate.message.messageId);
    const publicSafety = candidate.message.conversationType === 'room'
      ? chatSafetyFor(options, candidate.message.conversationId) : null;
    let publicStyle = candidate.message.conversationType === 'room'
      ? publicStylesByRoom.get(candidate.message.conversationId) ?? null : null;
    if (publicStyle != null) {
      let remainingBodyCharacters;
      try {
        remainingBodyCharacters = 60 - replyPrefix(candidate.message.author.companyName).length;
      } catch {
        remainingBodyCharacters = 0;
      }
      if (remainingBodyCharacters < 18) {
        proposals.push({
          sourceKey: candidate.sourceKey,
          action: 'ignore',
          mutationAuthorized: false,
          rationale: 'public-reply-body-budget-insufficient',
        });
        continue;
      }
      publicStyle = deepFreeze({
        ...publicStyle,
        recommendedBodyMaxCharacters: Math.min(
          publicStyle.recommendedBodyMaxCharacters,
          remainingBodyCharacters,
        ),
      });
    }
    let decisionSnapshot;
    try {
      decisionSnapshot = buildActiveDecisionSnapshot({
        snapshot: businessSnapshot,
        message: candidate.message,
        offer,
        evaluation,
        agreementEvidence,
        chatSafety: publicSafety,
        publicStyle,
        trustedResourceCatalog: options.trustedResourceCatalog,
      });
    } catch {
      errors.push({ stage: 'decision', reason: 'decision-snapshot-build-failed' });
      continue;
    }
    const providerGuard = await guard.check('decision-provider', false);
    if (!providerGuard.ok) { stopReason = providerGuard.reason; break; }
    const decisionInput = Object.freeze({
      untrustedEnvelope: envelope,
      businessSnapshot: decisionSnapshot,
    });
    const llmProvider = typeof provider?.name === 'string'
      && provider.name.startsWith('chat-llm-');
    if (llmProvider) {
      if (typeof provider.estimateMaxTotalTokens !== 'function') {
        errors.push({ stage: 'budget', reason: 'decision-token-reservation-unavailable' });
        stopReason = 'decision-token-reservation-unavailable';
        break;
      }
      let maximumCallTokens;
      try { maximumCallTokens = provider.estimateMaxTotalTokens(decisionInput); }
      catch {
        errors.push({ stage: 'budget', reason: 'decision-token-reservation-unavailable' });
        stopReason = 'decision-token-reservation-unavailable';
        break;
      }
      const remainingTokenBudget = limits.maxDecisionTotalTokens - decisionUsage.totalTokens;
      if (!Number.isSafeInteger(maximumCallTokens) || maximumCallTokens <= 0
          || maximumCallTokens > remainingTokenBudget) {
        errors.push({ stage: 'budget', reason: 'decision-token-budget-exhausted' });
        stopReason = 'decision-token-budget-exhausted';
        break;
      }
    }
    let rawDecision;
    decisionCalls += 1;
    try {
      rawDecision = await runBoundedOperation(
        control => provider.decide(decisionInput, control),
        providerGuard,
      );
    } catch (error) {
      errors.push({ stage: 'decision', reason: error?.code === 'ACTIVE_CHAT_OPERATION_TIMEOUT'
        ? 'decision-timeout' : 'decision-provider-failed' });
      if (error?.code === 'ACTIVE_CHAT_OPERATION_TIMEOUT') stopReason = 'decision-timeout';
      continue;
    }
    const providerUsage = rawDecision?.usage;
    const llmUsageRequired = typeof rawDecision?.provider === 'string'
      && rawDecision.provider.startsWith('chat-llm-');
    if (llmUsageRequired && (!plainObject(providerUsage)
        || !Number.isSafeInteger(providerUsage.totalTokens)
        || providerUsage.totalTokens < 0)) {
      errors.push({ stage: 'budget', reason: 'decision-usage-unavailable' });
      stopReason = 'decision-usage-unavailable';
      break;
    }
    if (plainObject(providerUsage) && Number.isSafeInteger(providerUsage.totalTokens)
        && providerUsage.totalTokens >= 0) {
      decisionUsage.knownCalls += 1;
      for (const field of [
        'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens',
      ]) {
        const amount = providerUsage[field];
        if (Number.isSafeInteger(amount) && amount >= 0) decisionUsage[field] += amount;
      }
    }
    if (decisionUsage.totalTokens > limits.maxDecisionTotalTokens) {
      errors.push({ stage: 'budget', reason: 'decision-token-budget-exceeded' });
      stopReason = 'decision-token-budget-exceeded';
      break;
    }
    const validated = validateProviderDecision(rawDecision, candidate.message.conversationType);
    if (!validated.ok) {
      errors.push({ stage: 'decision', reason: validated.reason });
      continue;
    }
    const decision = validated.decision;
    if (['ignore', 'request_evidence'].includes(decision.action)) {
      proposals.push({
        sourceKey: candidate.sourceKey,
        action: decision.action,
        mutationAuthorized: false,
        rationale: String(decision.rationale || '').slice(0, 240),
      });
      continue;
    }

    const attemptId = stableAttemptId({
      sourceKey: candidate.sourceKey,
      decision,
      snapshotId: businessSnapshot.snapshotId,
    });
    let plan;
    try {
      plan = await buildActionPlan({
        decision,
        message: candidate.message,
        offer,
        evaluation,
        businessSnapshot,
        agreementEvidence,
        sourceBinding: candidate.sourceBinding,
        publicSafety,
        publicStyle,
        attemptId,
        authorizationAdapter,
        authorizationRequestFactory: options.authorizationRequestFactory,
        trustedResourceCatalog: options.trustedResourceCatalog,
        nowMs: nowMilliseconds(clock),
      });
    } catch (error) {
      errors.push({ stage: 'plan', reason: fixedPlanFailureReason(error) });
      continue;
    }
    if (!plan) continue;
    let duplicateContent = false;
    try {
      duplicateContent = await contentIsBlocked(candidate, plan);
    } catch (error) {
      errors.push({ stage: 'dedupe', reason: error.guardReason || 'content-replay-state-unavailable' });
      if (mode !== 'shadow') stopReason = error.guardReason || 'content-replay-state-unavailable';
      continue;
    }
    if (duplicateContent) {
      proposals.push({
        sourceKey: candidate.sourceKey,
        action: 'ignore',
        mutationAuthorized: false,
        rationale: 'duplicate-outbound-content-blocked',
      });
      continue;
    }
    const contentFingerprint = digest(plan.renderedText);
    const proposal = {
      sourceKey: candidate.sourceKey,
      attemptId,
      action: plan.actionName,
      params: deepFreeze(jsonClone(plan.previewParams, 'preview proposal')),
      economicAuthorizationRequired: plan.needsAuthorization,
      tradeSide: decision.action === 'candidate_contract'
        ? decision.contractTerms.ourSide : null,
      previewStatus: null,
      mutationAuthorized: false,
    };
    proposals.push(proposal);
    if (mode === 'shadow') {
      await runShadowPublicPreview(candidate, plan, proposal, contentFingerprint);
      continue;
    }
    const executionResult = await executePreparedPlan({
      candidate,
      plan,
      proposal,
      contentFingerprint,
      attemptId,
    });
    if (executionResult === 'break') break;
  }

  // Proactive public trade posts are deterministic host decisions, not free-form model text.
  // Reply work wins the cycle; without a selected public reply, consider at most one fresh,
  // economically positive, fully evidenced intent in the explicitly discovered trade rooms.
  const publicReplySelected = proposals.some(proposal => proposal.action === 'chat_room_reply');
  if (!stopReason && !publicReplySelected && proactiveRoomIds.length > 0
      && decisionUsage.totalTokens < limits.maxDecisionTotalTokens) {
    let selected = null;
    for (const roomId of proactiveRoomIds) {
      const intents = deriveProactivePublicIntents(businessSnapshot, {
        roomId,
        trustedResourceCatalog: options.trustedResourceCatalog,
        now: nowMilliseconds(clock),
      });
      if (intents.length > 0) {
        selected = intents[0];
        break;
      }
    }
    if (selected != null) {
      const dayBucket = new Date(nowMilliseconds(clock)).toISOString().slice(0, 10)
        .replace(/-/gu, '');
      const proactiveSourceKey = `room:${selected.roomId}:proactive-${selected.terms.ourSide}`
        + `-${selected.terms.resourceKind}-${selected.terms.quality}-${dayBucket}`;
      const candidate = { sourceKey: proactiveSourceKey };
      const decision = {
        action: 'candidate_contract',
        scope: 'room',
        publicReason: 'verified-offer',
        contractOperation: 'send',
        contractTerms: selected.terms,
        proactiveIntentId: selected.intentId,
      };
      const attemptId = stableAttemptId({
        sourceKey: proactiveSourceKey,
        decision,
        snapshotId: businessSnapshot.snapshotId,
      });
      let plan = null;
      try {
        plan = await buildProactiveActionPlan({
          intent: selected,
          businessSnapshot,
          publicSafety: chatSafetyFor(options, selected.roomId),
          publicStyle: publicStylesByRoom.get(selected.roomId) ?? null,
          attemptId,
          authorizationAdapter,
          trustedResourceCatalog: options.trustedResourceCatalog,
          nowMs: nowMilliseconds(clock),
        });
      } catch (error) {
        errors.push({ stage: 'plan', reason: fixedPlanFailureReason(error) });
      }
      if (plan != null) {
        let duplicateContent = false;
        let dedupeFailed = false;
        try { duplicateContent = await contentIsBlocked(candidate, plan); }
        catch (error) {
          dedupeFailed = true;
          errors.push({
            stage: 'dedupe',
            reason: error.guardReason || 'content-replay-state-unavailable',
          });
          if (mode !== 'shadow') {
            stopReason ||= error.guardReason || 'content-replay-state-unavailable';
          }
        }
        if (duplicateContent) {
          proposals.push({
            sourceKey: proactiveSourceKey,
            action: 'ignore',
            mutationAuthorized: false,
            rationale: 'duplicate-outbound-content-blocked',
          });
        } else if (!dedupeFailed) {
          const contentFingerprint = digest(plan.renderedText);
          const proposal = {
            sourceKey: proactiveSourceKey,
            attemptId,
            action: 'chat_room_post',
            params: deepFreeze(jsonClone(plan.previewParams, 'proactive preview proposal')),
            economicAuthorizationRequired: true,
            tradeSide: selected.terms.ourSide,
            previewStatus: null,
            mutationAuthorized: false,
          };
          proposals.push(proposal);
          if (mode === 'shadow') {
            await runShadowPublicPreview(
              candidate,
              plan,
              proposal,
              contentFingerprint,
            );
          } else {
            await executePreparedPlan({
              candidate,
              plan,
              proposal,
              contentFingerprint,
              attemptId,
            });
          }
        }
      }
    }
  }

  const healthyWakeYield = errors.length === 0 && stopReason === 'next-wake-safety-margin';
  return {
    ok: (errors.length === 0 && stopReason == null) || healthyWakeYield,
    skipped: false,
    stoppedEarly: stopReason != null,
    mode,
    reason: stopReason,
    mutationAuthorized: mode === 'safe-reply' || mode === 'full',
    startedAt,
    actions: actionLog,
    observations,
    strictInboundMessages: strictInbound.length,
    proposals,
    outcomes,
    metrics: {
      reads,
      decisionCalls,
      previews,
      confirmAttempts,
      actionCalls: actions,
      decisionUsage,
    },
    limits,
    errors,
  };
}

module.exports = {
  BLOCKING_SOURCE_STATES,
  DEFAULT_CYCLE_DEADLINE_MS,
  DEFAULT_LIMITS,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_RATE_WINDOW_MS,
  DEFAULT_SOURCE_MAX_AGE_MS,
  DEFAULT_WAKE_SAFETY_MARGIN_MS,
  PLAN_FAILURE_REASONS,
  PRIVATE_ALLOWED_ACTIONS,
  ROOM_ALLOWED_ACTIONS,
  buildActiveDecisionSnapshot,
  classifyConfirmedOutcome,
  createFileCommunicationAuthorizationAdapter,
  derivePublicSourceBindings,
  fixedPlanFailureReason,
  ordinaryDraftHasEconomicSignal,
  ordinaryDraftUsesAllowedNonEconomicTemplate,
  normalizeLimits,
  resolveBusinessSnapshot,
  runActiveChatCycle,
  stableAttemptId,
  validateExactPreview,
};
