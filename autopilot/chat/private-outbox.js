'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  atomicWriteJson,
  readJson,
  withFileLock,
} = require('./persistence.js');

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 10000;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/u;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/u;
const STATUS_VALUES = new Set(['armed', 'sent', 'pre-click-failed', 'ambiguous']);
const TERMINAL_OUTCOME_CODES = Object.freeze({
  sent: new Set(['unique-ui-postcondition']),
  'pre-click-failed': new Set(['ui-refused-before-click']),
  ambiguous: new Set(['click-outcome-unproven', 'ui-evaluate-error']),
});

function exactKeys(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} has unexpected fields`);
  }
  return value;
}

function canonicalText(value, field, maximum) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${field} must contain 1..${maximum} characters`);
  }
  return normalized;
}

function canonicalPrivateMessageText(value) {
  const normalized = canonicalText(value, 'messageText', 180);
  if (normalized.split('\n').length > 3) throw new RangeError('messageText must contain at most 3 lines');
  return normalized;
}

function canonicalPrivateCompany(value) {
  return canonicalText(value, 'targetCompany', 160).replace(/\s+/gu, ' ');
}

function canonicalSourceText(value) {
  return value == null ? null : canonicalText(value, 'sourceText', 500);
}

function isoTimestamp(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return parsed.toISOString();
}

function positiveCompanyId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('targetCompanyId must be a positive integer');
  return id;
}

function normalizeSource(value) {
  exactKeys(value, [
    'authorCompany', 'authorCompanyId', 'createdAt', 'evidenceStatus', 'exactText', 'kind',
    'matchCount', 'messageId', 'observationFingerprint',
  ], 'source');
  if (!['proactive', 'reply'].includes(value.kind)) throw new TypeError('source.kind is invalid');
  const exactText = canonicalSourceText(value.exactText);
  const matchCount = Number(value.matchCount);
  if (!Number.isSafeInteger(matchCount) || matchCount < 0 || matchCount > 10) {
    throw new TypeError('source.matchCount is invalid');
  }
  const observationFingerprint = value.observationFingerprint == null
    ? null
    : String(value.observationFingerprint);
  if (observationFingerprint != null && !FINGERPRINT_PATTERN.test(observationFingerprint)) {
    throw new TypeError('source.observationFingerprint is invalid');
  }
  if (value.kind === 'reply') {
    if (exactText == null || value.evidenceStatus !== 'EXACT_RENDERED_INBOUND' || matchCount !== 1
        || typeof value.messageId !== 'string' || !value.messageId.trim() || value.messageId.length > 160
        || typeof value.authorCompany !== 'string'
        || canonicalPrivateCompany(value.authorCompany) !== value.authorCompany
        || positiveCompanyId(value.authorCompanyId) !== value.authorCompanyId
        || isoTimestamp(value.createdAt, 'source.createdAt') !== value.createdAt) {
      throw new TypeError('reply source requires one exact rendered inbound match');
    }
  } else if (exactText != null || value.evidenceStatus !== 'NOT_APPLICABLE_PROACTIVE' || matchCount !== 0
      || observationFingerprint != null || value.messageId != null || value.createdAt != null
      || value.authorCompany != null || value.authorCompanyId != null) {
    throw new TypeError('proactive source evidence is invalid');
  }
  return {
    kind: value.kind,
    exactText,
    evidenceStatus: value.evidenceStatus,
    matchCount,
    observationFingerprint,
    messageId: value.kind === 'reply' ? value.messageId : null,
    createdAt: value.kind === 'reply' ? value.createdAt : null,
    authorCompany: value.kind === 'reply' ? value.authorCompany : null,
    authorCompanyId: value.kind === 'reply' ? value.authorCompanyId : null,
  };
}

function normalizeEvidence(value) {
  exactKeys(value, [
    'capturedAt',
    'composerEmpty',
    'destinationRoute',
    'destinationVerified',
    'exactOwnMessageAbsent',
    'runtimeMode',
    'targetIdVerified',
  ], 'evidence');
  if (!['full', 'safe-reply'].includes(value.runtimeMode)) {
    throw new TypeError('evidence.runtimeMode is invalid');
  }
  const destinationRoute = canonicalText(value.destinationRoute, 'evidence.destinationRoute', 320);
  for (const field of [
    'composerEmpty',
    'destinationVerified',
    'exactOwnMessageAbsent',
    'targetIdVerified',
  ]) {
    if (value[field] !== true) throw new TypeError(`evidence.${field} must be true`);
  }
  return {
    runtimeMode: value.runtimeMode,
    destinationRoute,
    destinationVerified: true,
    targetIdVerified: true,
    composerEmpty: true,
    exactOwnMessageAbsent: true,
    capturedAt: isoTimestamp(value.capturedAt, 'evidence.capturedAt'),
  };
}

function immutableAttemptShape(value) {
  return {
    attemptId: value.attemptId,
    target: value.target,
    source: value.source,
    message: value.message,
    evidence: value.evidence,
    armedAt: value.armedAt,
  };
}

function integrityHash(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(immutableAttemptShape(value)))
    .digest('hex');
}

function replayPayloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify({
    target: value.target,
    source: {
      kind: value.source.kind,
      exactText: value.source.exactText,
      messageId: value.source.messageId,
      createdAt: value.source.createdAt,
      authorCompanyId: value.source.authorCompanyId,
    },
    message: value.message,
  })).digest('hex');
}

function normalizeAttempt(value) {
  exactKeys(value, [
    'armedAt',
    'attemptId',
    'evidence',
    'integritySha256',
    'message',
    'outcomeCode',
    'replayBlocked',
    'schemaVersion',
    'source',
    'status',
    'target',
    'updatedAt',
  ], 'private outbox attempt');
  if (value.schemaVersion !== SCHEMA_VERSION) throw new TypeError('private outbox schemaVersion is invalid');
  if (typeof value.attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(value.attemptId)) {
    throw new TypeError('private outbox attemptId is invalid');
  }
  if (!STATUS_VALUES.has(value.status)) throw new TypeError('private outbox status is invalid');
  if (value.replayBlocked !== true) throw new TypeError('private outbox replayBlocked must be true');
  exactKeys(value.target, ['company', 'companyId'], 'target');
  exactKeys(value.message, ['exactText'], 'message');
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    attemptId: value.attemptId,
    status: value.status,
    replayBlocked: true,
    target: {
      company: canonicalPrivateCompany(value.target.company),
      companyId: positiveCompanyId(value.target.companyId),
    },
    source: normalizeSource(value.source),
    message: { exactText: canonicalPrivateMessageText(value.message.exactText) },
    evidence: normalizeEvidence(value.evidence),
    armedAt: isoTimestamp(value.armedAt, 'armedAt'),
    updatedAt: isoTimestamp(value.updatedAt, 'updatedAt'),
    outcomeCode: value.outcomeCode == null ? null : String(value.outcomeCode),
    integritySha256: String(value.integritySha256 || ''),
  };
  if (normalized.status === 'armed') {
    if (normalized.outcomeCode !== null) throw new TypeError('armed attempt cannot have an outcomeCode');
  } else if (!TERMINAL_OUTCOME_CODES[normalized.status]?.has(normalized.outcomeCode)) {
    throw new TypeError('private outbox outcomeCode is invalid for status');
  }
  if (!/^[a-f0-9]{64}$/u.test(normalized.integritySha256)
      || normalized.integritySha256 !== integrityHash(normalized)) {
    throw new Error('private outbox immutable attempt integrity check failed');
  }
  return normalized;
}

function normalizeRegistry(value, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  exactKeys(value, ['attempts', 'schemaVersion'], 'private outbox registry');
  if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.attempts)
      || value.attempts.length > maxAttempts) {
    throw new TypeError('private outbox registry is malformed or full');
  }
  const attempts = value.attempts.map(normalizeAttempt);
  const ids = new Set();
  for (const attempt of attempts) {
    if (ids.has(attempt.attemptId)) throw new Error('private outbox contains a duplicate attemptId');
    ids.add(attempt.attemptId);
  }
  return { schemaVersion: SCHEMA_VERSION, attempts };
}

function emptyRegistry() {
  return { schemaVersion: SCHEMA_VERSION, attempts: [] };
}

function ensureSafeRoot(root, { create = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) return false;
    const parent = path.dirname(root);
    const parentStat = fs.lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error('private outbox parent must be a real directory');
    }
    fs.mkdirSync(root, { mode: 0o700 });
    stat = fs.lstatSync(root);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('private outbox root must be a private real directory');
  }
  return true;
}

class PrivateSendOutbox {
  constructor(root, {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new TypeError('private outbox root must be an absolute path');
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive integer');
    }
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'outbox.json');
    this.maxAttempts = maxAttempts;
    this.maxBytes = maxBytes;
  }

  read() {
    if (!ensureSafeRoot(this.root)) return emptyRegistry();
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0
          || stat.size > this.maxBytes) {
        throw new Error('private outbox file must be a private regular bounded file');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return normalizeRegistry(
      readJson(this.file, emptyRegistry, { maxBytes: this.maxBytes }),
      this.maxAttempts,
    );
  }

  getAttempt(attemptId) {
    if (typeof attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(attemptId)) {
      throw new TypeError('attemptId is invalid');
    }
    return this.read().attempts.find(entry => entry.attemptId === attemptId) || null;
  }

  armAttempt(input, now = new Date()) {
    const armedAt = isoTimestamp(now, 'now');
    const source = normalizeSource(input.source);
    const evidence = normalizeEvidence(input.evidence);
    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      attemptId: String(input.attemptId || ''),
      status: 'armed',
      replayBlocked: true,
      target: {
        company: canonicalPrivateCompany(input.targetCompany),
        companyId: positiveCompanyId(input.targetCompanyId),
      },
      source,
      message: { exactText: canonicalPrivateMessageText(input.messageText) },
      evidence,
      armedAt,
      updatedAt: armedAt,
      outcomeCode: null,
      integritySha256: '',
    };
    candidate.integritySha256 = integrityHash(candidate);
    const normalized = normalizeAttempt(candidate);
    ensureSafeRoot(this.root, { create: true });
    return withFileLock(this.file, () => {
      const registry = this.read();
      const existing = registry.attempts.find(entry => entry.attemptId === normalized.attemptId);
      if (existing) return { inserted: false, attempt: existing, replayBlocked: true };
      const payloadReplay = registry.attempts.find(entry => entry.status !== 'pre-click-failed'
        && replayPayloadHash(entry) === replayPayloadHash(normalized));
      if (payloadReplay) {
        return {
          inserted: false,
          attempt: payloadReplay,
          replayBlocked: true,
          conflict: 'exact-target-source-message',
        };
      }
      if (registry.attempts.length >= this.maxAttempts) {
        throw new Error('private outbox is full; refusing to forget replay guards');
      }
      registry.attempts.push(normalized);
      atomicWriteJson(this.file, registry);
      return { inserted: true, attempt: normalized, replayBlocked: true };
    });
  }

  transitionAttempt(attemptId, status, outcomeCode, now = new Date()) {
    if (!TERMINAL_OUTCOME_CODES[status]?.has(outcomeCode)) {
      throw new TypeError('terminal private outbox outcome is invalid');
    }
    return withFileLock(this.file, () => {
      const registry = this.read();
      const index = registry.attempts.findIndex(entry => entry.attemptId === attemptId);
      if (index < 0) throw new Error('private outbox attempt is missing');
      const current = registry.attempts[index];
      if (current.status !== 'armed') {
        if (current.status === status && current.outcomeCode === outcomeCode) return current;
        throw new Error(`invalid private outbox transition ${current.status} -> ${status}`);
      }
      const updated = normalizeAttempt({
        ...current,
        status,
        outcomeCode,
        updatedAt: isoTimestamp(now, 'now'),
      });
      registry.attempts[index] = updated;
      atomicWriteJson(this.file, registry);
      return updated;
    });
  }
}

function validatePreflightProof(result, attempt) {
  if (!result || result.ok !== true || result.dry !== true
      || result.destinationVerified !== true || result.targetIdVerified !== true
      || result.composerEmpty !== true || result.exactOwnMessageAbsent !== true
      || result.attemptId !== attempt.attemptId
      || canonicalPrivateCompany(result.targetCompany) !== canonicalPrivateCompany(attempt.targetCompany)
      || positiveCompanyId(result.targetCompanyId) !== positiveCompanyId(attempt.targetCompanyId)
      || canonicalPrivateMessageText(result.wouldSend) !== canonicalPrivateMessageText(attempt.messageText)
      || typeof result.destinationRoute !== 'string' || !result.destinationRoute.trim()) {
    throw new Error('private send preflight did not bind the exact durable attempt');
  }
  return {
    runtimeMode: attempt.runtimeMode,
    destinationRoute: result.destinationRoute,
    destinationVerified: true,
    targetIdVerified: true,
    composerEmpty: true,
    exactOwnMessageAbsent: true,
    capturedAt: new Date().toISOString(),
  };
}

function classifyPrivateSendResult(result) {
  if (result?.ok === true && result?.posted === true && result?.mutationAttempted === true) {
    return { status: 'sent', outcomeCode: 'unique-ui-postcondition' };
  }
  if (result?.mutationAttempted === true || result?.ambiguous === true || result?.doNotRetry === true) {
    return { status: 'ambiguous', outcomeCode: 'click-outcome-unproven' };
  }
  return { status: 'pre-click-failed', outcomeCode: 'ui-refused-before-click' };
}

function replayRefusal(existing) {
  return {
    ok: false,
    guard: true,
    doNotRetry: true,
    replayBlocked: true,
    privateOutboxStatus: existing.status,
    reason: 'private send attemptId or exact target/source/message already exists in the durable NAS outbox; it cannot be replayed',
  };
}

async function runDurablePrivateSendAttempt({
  outbox,
  attempt,
  preflight,
  send,
  now = () => new Date(),
}) {
  if (!(outbox instanceof PrivateSendOutbox)) throw new TypeError('outbox must be a PrivateSendOutbox');
  if (typeof preflight !== 'function' || typeof send !== 'function') {
    throw new TypeError('preflight and send callbacks are required');
  }
  let existing;
  try {
    existing = outbox.getAttempt(attempt.attemptId);
  } catch (_) {
    return {
      ok: false,
      guard: true,
      preClickFailure: true,
      reason: 'private send durable NAS outbox is unreadable; no click is authorized',
    };
  }
  if (existing) return replayRefusal(existing);

  let proof;
  try {
    proof = validatePreflightProof(await preflight(), attempt);
    proof.capturedAt = isoTimestamp(now(), 'now');
  } catch (_) {
    return {
      ok: false,
      guard: true,
      preClickFailure: true,
      reason: 'private send exact destination preflight failed; no click was authorized',
    };
  }

  let armed;
  try {
    armed = outbox.armAttempt({ ...attempt, evidence: proof }, now());
  } catch (_) {
    return {
      ok: false,
      guard: true,
      preClickFailure: true,
      reason: 'private send durable NAS outbox could not be armed; no click was authorized',
    };
  }
  if (!armed.inserted) return replayRefusal(armed.attempt);

  let result;
  let classification;
  try {
    result = await send(armed.attempt);
    classification = classifyPrivateSendResult(result);
  } catch (_) {
    result = {
      ok: false,
      mutationAttempted: true,
      ambiguous: true,
      doNotRetry: true,
      reason: 'private send UI execution failed after durable arming; replay is blocked',
    };
    classification = { status: 'ambiguous', outcomeCode: 'ui-evaluate-error' };
  }

  try {
    outbox.transitionAttempt(
      attempt.attemptId,
      classification.status,
      classification.outcomeCode,
      now(),
    );
  } catch (_) {
    return {
      ok: false,
      mutationAttempted: classification.status !== 'pre-click-failed',
      ambiguous: true,
      doNotRetry: true,
      replayBlocked: true,
      privateOutboxStatus: 'armed',
      reason: 'private send outcome persistence failed; the durable armed record blocks replay',
    };
  }
  return {
    ...result,
    replayBlocked: true,
    privateOutboxStatus: classification.status,
  };
}

module.exports = {
  ATTEMPT_ID_PATTERN,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BYTES,
  PrivateSendOutbox,
  canonicalPrivateCompany,
  canonicalPrivateMessageText,
  canonicalSourceText,
  classifyPrivateSendResult,
  runDurablePrivateSendAttempt,
};
