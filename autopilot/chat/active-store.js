'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ChatMemoryStore } = require('./memory-store.js');
const {
  atomicWriteJson,
  readJson,
  withFileLock,
} = require('./persistence.js');
const { persistObservationSnapshot } = require('./ingest.js');
const { resolveNasDataRoot } = require('./shadow-worker.js');
const {
  executionBindingHash,
  executionClaimTokenHash,
} = require('./execution-claim.js');

const STORE_SCHEMA_VERSION = 1;
const LAYOUT_SCHEMA_VERSION = 1;
const DEFAULT_ACTIVE_ROOT = path.resolve(__dirname, '..', '.chat-active');
const DEFAULT_ACTIVE_ROOT_ALLOWLIST = Object.freeze([DEFAULT_ACTIVE_ROOT]);
const MAX_ATTEMPTS = 10000;
const MAX_SHADOW_PREVIEWS = 10000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_LAYOUT_MARKER_BYTES = 4096;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set([
  'chat_private_send',
  'chat_room_reply',
  'chat_room_post',
  'contract_accept',
]);
const STATES = new Set(['ARMED', 'CONFIRMING', 'VERIFIED', 'AMBIGUOUS', 'FAILED_PRE_CLICK']);
const BLOCKING_STATES = new Set(['ARMED', 'CONFIRMING', 'VERIFIED', 'AMBIGUOUS']);
const CONTENT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LAYOUT_ESTABLISHMENTS = new Set([
  'new-store-initialization',
  'explicit-legacy-migration',
]);

function exactKeys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${field} contains unexpected or missing fields`);
  }
}

function boundedString(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value.trim();
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeRateLimit(value) {
  exactKeys(value, ['maxAttempts', 'windowStartedAtMs'], 'rateLimit');
  if (!Number.isSafeInteger(value.windowStartedAtMs) || value.windowStartedAtMs < 0
      || !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 0
      || value.maxAttempts > 100) {
    throw new TypeError('rateLimit is invalid');
  }
  return {
    windowStartedAtMs: value.windowStartedAtMs,
    maxAttempts: value.maxAttempts,
  };
}

function normalizeAttempt(value) {
  exactKeys(value, [
    'actionName',
    'armedAt',
    'attemptId',
    'completedAt',
    'confirmingAt',
    'contentFingerprint',
    'economicAuthorization',
    'executionBindingHash',
    'executionClaimTokenHash',
    'outcomeCode',
    'postconditionVerified',
    'rateLimit',
    'schemaVersion',
    'snapshotId',
    'sourceKey',
    'state',
  ], 'active attempt');
  if (value.schemaVersion !== STORE_SCHEMA_VERSION
      || typeof value.attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(value.attemptId)
      || !ACTIONS.has(value.actionName)
      || typeof value.contentFingerprint !== 'string' || !HASH_PATTERN.test(value.contentFingerprint)
      || typeof value.executionBindingHash !== 'string' || !HASH_PATTERN.test(value.executionBindingHash)
      || typeof value.executionClaimTokenHash !== 'string' || !HASH_PATTERN.test(value.executionClaimTokenHash)
      || typeof value.economicAuthorization !== 'boolean'
      || !STATES.has(value.state)) {
    throw new TypeError('active attempt identity or state is invalid');
  }
  const normalized = {
    schemaVersion: STORE_SCHEMA_VERSION,
    attemptId: value.attemptId,
    sourceKey: boundedString(value.sourceKey, 'sourceKey', 500),
    state: value.state,
    actionName: value.actionName,
    contentFingerprint: value.contentFingerprint,
    executionBindingHash: value.executionBindingHash,
    executionClaimTokenHash: value.executionClaimTokenHash,
    snapshotId: boundedString(value.snapshotId, 'snapshotId', 200),
    economicAuthorization: value.economicAuthorization,
    rateLimit: normalizeRateLimit(value.rateLimit),
    armedAt: timestamp(value.armedAt, 'armedAt'),
    confirmingAt: value.confirmingAt == null ? null : timestamp(value.confirmingAt, 'confirmingAt'),
    completedAt: value.completedAt == null ? null : timestamp(value.completedAt, 'completedAt'),
    outcomeCode: value.outcomeCode == null
      ? null : boundedString(value.outcomeCode, 'outcomeCode', 120),
    postconditionVerified: value.postconditionVerified == null
      ? null : value.postconditionVerified,
  };
  if (normalized.state === 'ARMED') {
    if (normalized.completedAt != null || normalized.outcomeCode != null
        || normalized.postconditionVerified != null || normalized.confirmingAt != null) {
      throw new TypeError('ARMED attempt cannot contain a completion');
    }
  } else if (normalized.state === 'CONFIRMING') {
    if (normalized.completedAt != null || normalized.outcomeCode != null
        || normalized.postconditionVerified != null || normalized.confirmingAt == null) {
      throw new TypeError('CONFIRMING attempt must contain only its consumption time');
    }
  } else if (normalized.completedAt == null || normalized.outcomeCode == null
      || typeof normalized.postconditionVerified !== 'boolean'
      || (normalized.state === 'VERIFIED' && normalized.postconditionVerified !== true)
      || (normalized.state !== 'VERIFIED' && normalized.postconditionVerified !== false)) {
    throw new TypeError('terminal attempt completion is invalid');
  }
  return normalized;
}

function normalizeRegistry(value) {
  exactKeys(value, ['attempts', 'schemaVersion', 'updatedAt'], 'active attempt registry');
  if (value.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(value.attempts)
      || value.attempts.length > MAX_ATTEMPTS) {
    throw new TypeError('active attempt registry is malformed or full');
  }
  const attempts = value.attempts.map(normalizeAttempt);
  const ids = new Set();
  for (const attempt of attempts) {
    if (ids.has(attempt.attemptId)) throw new Error('active attempt registry has a duplicate attemptId');
    ids.add(attempt.attemptId);
  }
  const updatedAt = value.updatedAt == null ? null : timestamp(value.updatedAt, 'updatedAt');
  return { schemaVersion: STORE_SCHEMA_VERSION, updatedAt, attempts };
}

function emptyRegistry() {
  return { schemaVersion: STORE_SCHEMA_VERSION, updatedAt: null, attempts: [] };
}

function normalizeShadowPreview(value) {
  exactKeys(value, [
    'actionName',
    'attemptId',
    'contentFingerprint',
    'previewedAt',
    'schemaVersion',
    'sourceKey',
  ], 'shadow preview');
  if (value.schemaVersion !== STORE_SCHEMA_VERSION
      || typeof value.attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(value.attemptId)
      || !ACTIONS.has(value.actionName)
      || typeof value.contentFingerprint !== 'string'
      || !HASH_PATTERN.test(value.contentFingerprint)) {
    throw new TypeError('shadow preview identity is invalid');
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    attemptId: value.attemptId,
    sourceKey: boundedString(value.sourceKey, 'sourceKey', 500),
    actionName: value.actionName,
    contentFingerprint: value.contentFingerprint,
    previewedAt: timestamp(value.previewedAt, 'previewedAt'),
  };
}

function normalizeShadowPreviewRegistry(value) {
  exactKeys(value, ['previews', 'schemaVersion', 'updatedAt'], 'shadow preview registry');
  if (value.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(value.previews)
      || value.previews.length > MAX_SHADOW_PREVIEWS) {
    throw new TypeError('shadow preview registry is malformed or full');
  }
  const previews = value.previews.map(normalizeShadowPreview);
  const ids = new Set();
  for (const preview of previews) {
    if (ids.has(preview.attemptId)) {
      throw new Error('shadow preview registry has a duplicate attemptId');
    }
    ids.add(preview.attemptId);
  }
  const updatedAt = value.updatedAt == null ? null : timestamp(value.updatedAt, 'updatedAt');
  return { schemaVersion: STORE_SCHEMA_VERSION, updatedAt, previews };
}

function emptyShadowPreviewRegistry() {
  return { schemaVersion: STORE_SCHEMA_VERSION, updatedAt: null, previews: [] };
}

function buildLayoutMarker(establishedAt, establishment) {
  if (!LAYOUT_ESTABLISHMENTS.has(establishment)) {
    throw new TypeError('active store layout establishment is invalid');
  }
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    store: 'sim-chat-active',
    establishedAt: timestamp(establishedAt, 'establishedAt'),
    establishment,
    registries: {
      attempts: { file: 'attempts.json', schemaVersion: STORE_SCHEMA_VERSION },
      shadowPreviews: { file: 'shadow-previews.json', schemaVersion: STORE_SCHEMA_VERSION },
    },
  };
}

function normalizeLayoutMarker(value) {
  exactKeys(value, [
    'establishedAt',
    'establishment',
    'registries',
    'schemaVersion',
    'store',
  ], 'active store layout marker');
  exactKeys(value.registries, ['attempts', 'shadowPreviews'], 'layout registries');
  exactKeys(value.registries.attempts, ['file', 'schemaVersion'], 'attempts layout descriptor');
  exactKeys(value.registries.shadowPreviews, ['file', 'schemaVersion'],
    'shadow previews layout descriptor');
  if (value.schemaVersion !== LAYOUT_SCHEMA_VERSION || value.store !== 'sim-chat-active'
      || !LAYOUT_ESTABLISHMENTS.has(value.establishment)
      || value.registries.attempts.file !== 'attempts.json'
      || value.registries.attempts.schemaVersion !== STORE_SCHEMA_VERSION
      || value.registries.shadowPreviews.file !== 'shadow-previews.json'
      || value.registries.shadowPreviews.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new TypeError('active store layout marker is incompatible');
  }
  return buildLayoutMarker(value.establishedAt, value.establishment);
}

function assertPrivateRootDirectory(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('active store root must be a private real directory');
  }
}

function safeRegistryFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0
        || stat.size > MAX_STORE_BYTES) {
      throw new Error('active attempt registry must be a private regular bounded file');
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function writeRegistry(file, registry) {
  safeRegistryFile(file);
  atomicWriteJson(file, registry);
  fs.chmodSync(file, 0o600);
}

function safeShadowPreviewFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0
        || stat.size > MAX_STORE_BYTES) {
      throw new Error('shadow preview registry must be a private regular bounded file');
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function writeShadowPreviewRegistry(file, registry) {
  safeShadowPreviewFile(file);
  if (Buffer.byteLength(`${JSON.stringify(registry, null, 2)}\n`, 'utf8') > MAX_STORE_BYTES) {
    throw new Error('shadow preview registry exceeds its durable byte limit');
  }
  atomicWriteJson(file, registry);
  fs.chmodSync(file, 0o600);
}

function safeLayoutMarkerFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0
        || stat.size > MAX_LAYOUT_MARKER_BYTES) {
      throw new Error('active store layout marker must be a private regular bounded file');
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function writeLayoutMarker(file, marker) {
  if (safeLayoutMarkerFile(file)) {
    throw new Error('active store layout marker already exists and cannot be overwritten');
  }
  const normalized = normalizeLayoutMarker(marker);
  if (Buffer.byteLength(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      > MAX_LAYOUT_MARKER_BYTES) {
    throw new Error('active store layout marker exceeds its byte limit');
  }
  atomicWriteJson(file, normalized);
  fs.chmodSync(file, 0o600);
}

function latestAttempt(attempts) {
  return [...attempts].sort((left, right) => Date.parse(right.armedAt) - Date.parse(left.armedAt)
    || right.attemptId.localeCompare(left.attemptId))[0] ?? null;
}

function sourceConversationKey(sourceKey) {
  const key = boundedString(sourceKey, 'sourceKey', 500);
  const separator = key.lastIndexOf(':');
  if (separator <= 0 || separator === key.length - 1) {
    throw new TypeError('sourceKey must contain a conversation and message identity');
  }
  return key.slice(0, separator);
}

class ActiveChatStore {
  constructor(root = DEFAULT_ACTIVE_ROOT, {
    allowedRoots = DEFAULT_ACTIVE_ROOT_ALLOWLIST,
  } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new TypeError('active chat root must be an absolute path');
    }
    this.root = resolveNasDataRoot(root, { allowedRoots });
    this.memory = new ChatMemoryStore(path.join(this.root, 'memory'));
    this.attemptFile = path.join(this.root, 'attempts.json');
    this.shadowPreviewFile = path.join(this.root, 'shadow-previews.json');
    this.layoutMarkerFile = path.join(this.root, 'layout.json');
  }

  initialize(now = new Date()) {
    const establishedAt = now instanceof Date ? now.toISOString() : timestamp(now, 'now');
    let rootExisted = true;
    try {
      assertPrivateRootDirectory(this.root);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      rootExisted = false;
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.root, 0o700);
      assertPrivateRootDirectory(this.root);
    }
    withFileLock(this.layoutMarkerFile, () => {
      if (safeLayoutMarkerFile(this.layoutMarkerFile)) {
        this.assertInitializedLayout();
        return;
      }
      if (rootExisted) {
        throw new Error('active store has no layout marker; run the explicit legacy migration');
      }
      if (safeRegistryFile(this.attemptFile) || safeShadowPreviewFile(this.shadowPreviewFile)) {
        throw new Error('new active store has a partial layout; run the explicit migration');
      }
      writeRegistry(this.attemptFile, emptyRegistry());
      writeShadowPreviewRegistry(this.shadowPreviewFile, emptyShadowPreviewRegistry());
      writeLayoutMarker(this.layoutMarkerFile,
        buildLayoutMarker(establishedAt, 'new-store-initialization'));
    });
    this.memory.initialize(now);
    return {
      root: this.root,
      attemptFile: this.attemptFile,
      shadowPreviewFile: this.shadowPreviewFile,
      layoutMarkerFile: this.layoutMarkerFile,
      memory: this.memory.layout(),
    };
  }

  readLayoutMarker() {
    assertPrivateRootDirectory(this.root);
    if (!safeLayoutMarkerFile(this.layoutMarkerFile)) {
      throw new Error('active store layout marker is missing; explicit migration is required');
    }
    return normalizeLayoutMarker(readJson(
      this.layoutMarkerFile,
      null,
      { maxBytes: MAX_LAYOUT_MARKER_BYTES },
    ));
  }

  assertInitializedLayout() {
    const marker = this.readLayoutMarker();
    if (!safeRegistryFile(this.attemptFile)) {
      throw new Error('active attempt registry is missing; refusing silent reconstruction');
    }
    if (!safeShadowPreviewFile(this.shadowPreviewFile)) {
      throw new Error('shadow preview registry is missing; refusing silent reconstruction');
    }
    return marker;
  }

  readAttempts() {
    this.assertInitializedLayout();
    return normalizeRegistry(readJson(this.attemptFile, undefined, { maxBytes: MAX_STORE_BYTES }));
  }

  readShadowPreviews() {
    this.assertInitializedLayout();
    return normalizeShadowPreviewRegistry(readJson(
      this.shadowPreviewFile,
      undefined,
      { maxBytes: MAX_STORE_BYTES },
    ));
  }

  ingestObservation({ readRequest, prepared }) {
    if (!readRequest || !['private', 'room'].includes(readRequest.conversationType)
        || typeof readRequest.conversationId !== 'string' || !readRequest.conversationId.trim()
        || !prepared?.observationSnapshot || !Array.isArray(prepared?.ledgerMessages)) {
      throw new TypeError('a prepared strict chat observation is required');
    }
    const snapshot = prepared.observationSnapshot;
    if (snapshot.conversationType !== readRequest.conversationType
        || snapshot.conversationId !== readRequest.conversationId) {
      throw new Error('observation identity differs from its read request');
    }
    const observationFile = persistObservationSnapshot(this.root, snapshot);
    const existingMessageIds = new Set(this.memory
      .readThread(readRequest.conversationType, readRequest.conversationId)
      .map(message => message.messageId));
    const ledger = prepared.ledgerMessages.length === 0
      ? { inserted: 0, duplicates: 0, total: this.memory
        .readThread(readRequest.conversationType, readRequest.conversationId).length }
      : this.memory.mergeThreadMessages(
        readRequest.conversationType,
        readRequest.conversationId,
        prepared.ledgerMessages,
      );
    return {
      ok: true,
      durable: true,
      observationFile,
      ledger,
      newMessageIds: prepared.ledgerMessages
        .map(message => message.messageId)
        .filter(messageId => !existingMessageIds.has(messageId)),
    };
  }

  getSourceState(sourceKey) {
    const key = boundedString(sourceKey, 'sourceKey', 500);
    const attempts = this.readAttempts().attempts.filter(attempt => attempt.sourceKey === key);
    const blocking = latestAttempt(attempts.filter(attempt => BLOCKING_STATES.has(attempt.state)));
    return blocking?.state ?? latestAttempt(attempts)?.state ?? null;
  }

  getAttemptState(attemptId) {
    const id = boundedString(attemptId, 'attemptId', 100);
    if (!ATTEMPT_ID_PATTERN.test(id)) throw new TypeError('attemptId is invalid');
    return this.readAttempts().attempts.find(attempt => attempt.attemptId === id)?.state ?? null;
  }

  countConfirmAttemptsSince(cutoffMs) {
    const cutoff = Number(cutoffMs);
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
      throw new TypeError('confirm-attempt cutoff must be a non-negative integer timestamp');
    }
    return this.readAttempts().attempts
      .filter(attempt => Date.parse(attempt.armedAt) >= cutoff).length;
  }

  hasRecentContentAttempt({ sourceKey, actionName, contentFingerprint, sinceMs }) {
    const conversationKey = sourceConversationKey(sourceKey);
    const cutoff = Number(sinceMs);
    if (!ACTIONS.has(actionName) || !HASH_PATTERN.test(String(contentFingerprint || ''))
        || !Number.isSafeInteger(cutoff) || cutoff < 0) {
      throw new TypeError('content replay query is invalid');
    }
    const attempted = this.readAttempts().attempts.some(attempt => BLOCKING_STATES.has(attempt.state)
      && attempt.actionName === actionName
      && attempt.contentFingerprint === contentFingerprint
      && sourceConversationKey(attempt.sourceKey) === conversationKey
      && Date.parse(attempt.armedAt) >= cutoff);
    if (attempted) return true;
    return this.readShadowPreviews().previews.some(preview => preview.actionName === actionName
      && preview.contentFingerprint === contentFingerprint
      && sourceConversationKey(preview.sourceKey) === conversationKey
      && Date.parse(preview.previewedAt) >= cutoff);
  }

  recordShadowPreview(record) {
    const candidate = normalizeShadowPreview(record);
    return withFileLock(this.shadowPreviewFile, () => {
      const registry = this.readShadowPreviews();
      const existing = registry.previews.find(preview => preview.attemptId === candidate.attemptId);
      if (existing) {
        const same = JSON.stringify(existing) === JSON.stringify(candidate);
        return {
          ok: same,
          durable: true,
          reason: same ? 'already-recorded' : 'shadow-preview-attempt-id-conflict',
          preview: same ? existing : undefined,
        };
      }
      const cutoff = Date.parse(candidate.previewedAt) - CONTENT_REPLAY_WINDOW_MS;
      registry.previews = registry.previews.filter(preview =>
        Date.parse(preview.previewedAt) >= cutoff);
      if (registry.previews.some(preview => preview.actionName === candidate.actionName
          && preview.contentFingerprint === candidate.contentFingerprint
          && sourceConversationKey(preview.sourceKey) === sourceConversationKey(candidate.sourceKey))) {
        return { ok: false, durable: true, reason: 'content-is-replay-blocked' };
      }
      if (registry.previews.length >= MAX_SHADOW_PREVIEWS) {
        throw new Error('shadow preview registry is full; replay guards cannot be forgotten');
      }
      registry.previews.push(candidate);
      registry.updatedAt = candidate.previewedAt;
      writeShadowPreviewRegistry(this.shadowPreviewFile, registry);
      return { ok: true, durable: true, preview: candidate };
    });
  }

  claimAttempt(record) {
    exactKeys(record, [
      'actionName',
      'armedAt',
      'attemptId',
      'contentFingerprint',
      'economicAuthorization',
      'executionBindingHash',
      'rateLimit',
      'schemaVersion',
      'snapshotId',
      'sourceKey',
      'state',
    ], 'active attempt claim');
    const executionClaimToken = crypto.randomBytes(32).toString('hex');
    const candidate = normalizeAttempt({
      ...record,
      completedAt: null,
      confirmingAt: null,
      outcomeCode: null,
      postconditionVerified: null,
      executionClaimTokenHash: executionClaimTokenHash(executionClaimToken),
    });
    if (candidate.state !== 'ARMED') throw new TypeError('attempt claim must be ARMED');
    return withFileLock(this.attemptFile, () => {
      const registry = this.readAttempts();
      if (registry.attempts.some(attempt => attempt.attemptId === candidate.attemptId)) {
        return { ok: false, durable: true, reason: 'attempt-id-already-exists' };
      }
      if (registry.attempts.some(attempt => attempt.sourceKey === candidate.sourceKey
          && BLOCKING_STATES.has(attempt.state))) {
        return { ok: false, durable: true, reason: 'source-is-replay-blocked' };
      }
      const contentCutoff = Date.parse(candidate.armedAt) - CONTENT_REPLAY_WINDOW_MS;
      if (registry.attempts.some(attempt => BLOCKING_STATES.has(attempt.state)
          && attempt.actionName === candidate.actionName
          && attempt.contentFingerprint === candidate.contentFingerprint
          && sourceConversationKey(attempt.sourceKey) === sourceConversationKey(candidate.sourceKey)
          && Date.parse(attempt.armedAt) >= contentCutoff)) {
        return { ok: false, durable: true, reason: 'content-is-replay-blocked' };
      }
      const count = registry.attempts.filter(attempt =>
        Date.parse(attempt.armedAt) >= candidate.rateLimit.windowStartedAtMs).length;
      if (count >= candidate.rateLimit.maxAttempts) {
        return { ok: false, durable: true, reason: 'atomic-confirm-rate-limit' };
      }
      if (registry.attempts.length >= MAX_ATTEMPTS) {
        throw new Error('active attempt registry is full; replay guards cannot be forgotten');
      }
      registry.attempts.push(candidate);
      registry.updatedAt = candidate.armedAt;
      writeRegistry(this.attemptFile, registry);
      return { ok: true, durable: true, attempt: candidate, executionClaimToken };
    });
  }

  consumeExecutionClaim({ attemptId, actionName, actionParams, token, consumedAt = new Date() }) {
    const bindingHash = executionBindingHash(actionName, actionParams);
    const tokenHash = executionClaimTokenHash(token);
    const at = consumedAt instanceof Date ? consumedAt.toISOString() : timestamp(consumedAt, 'consumedAt');
    return withFileLock(this.attemptFile, () => {
      const registry = this.readAttempts();
      const index = registry.attempts.findIndex(attempt => attempt.attemptId === attemptId);
      if (index < 0) return { ok: false, durable: true, reason: 'execution-claim-missing' };
      const current = registry.attempts[index];
      if (current.state !== 'ARMED') {
        return { ok: false, durable: true, reason: 'execution-claim-not-armed' };
      }
      if (current.actionName !== actionName || current.executionBindingHash !== bindingHash
          || current.executionClaimTokenHash !== tokenHash) {
        return { ok: false, durable: true, reason: 'execution-claim-binding-mismatch' };
      }
      const confirming = normalizeAttempt({ ...current, state: 'CONFIRMING', confirmingAt: at });
      registry.attempts[index] = confirming;
      registry.updatedAt = confirming.confirmingAt;
      writeRegistry(this.attemptFile, registry);
      return { ok: true, durable: true, attemptId, state: 'CONFIRMING' };
    });
  }

  completeAttempt(record) {
    exactKeys(record, [
      'attemptId',
      'completedAt',
      'outcomeCode',
      'postconditionVerified',
      'sourceKey',
      'state',
    ], 'active attempt completion');
    if (!['VERIFIED', 'AMBIGUOUS', 'FAILED_PRE_CLICK'].includes(record.state)) {
      throw new TypeError('attempt completion state is invalid');
    }
    return withFileLock(this.attemptFile, () => {
      const registry = this.readAttempts();
      const index = registry.attempts.findIndex(attempt => attempt.attemptId === record.attemptId);
      if (index < 0) return { ok: false, durable: true, reason: 'attempt-is-missing' };
      const current = registry.attempts[index];
      if (current.sourceKey !== record.sourceKey) {
        throw new Error('attempt completion source differs from the durable claim');
      }
      if (!['ARMED', 'CONFIRMING'].includes(current.state)) {
        const same = current.state === record.state
          && current.completedAt === timestamp(record.completedAt, 'completedAt')
          && current.outcomeCode === record.outcomeCode
          && current.postconditionVerified === record.postconditionVerified;
        return { ok: same, durable: true, reason: same ? 'already-completed' : 'terminal-conflict' };
      }
      if (record.state === 'VERIFIED' && current.state !== 'CONFIRMING') {
        return { ok: false, durable: true, reason: 'verified-requires-consumed-execution-claim' };
      }
      const completed = normalizeAttempt({
        ...current,
        state: record.state,
        completedAt: record.completedAt,
        outcomeCode: record.outcomeCode,
        postconditionVerified: record.postconditionVerified,
      });
      registry.attempts[index] = completed;
      registry.updatedAt = completed.completedAt;
      writeRegistry(this.attemptFile, registry);
      return { ok: true, durable: true, attempt: completed };
    });
  }
}

function migrateLegacyActiveChatStore(root = DEFAULT_ACTIVE_ROOT, {
  allowedRoots = DEFAULT_ACTIVE_ROOT_ALLOWLIST,
  now = new Date(),
} = {}) {
  const store = new ActiveChatStore(root, { allowedRoots });
  const establishedAt = now instanceof Date ? now.toISOString() : timestamp(now, 'now');
  assertPrivateRootDirectory(store.root);
  return withFileLock(store.attemptFile, () => withFileLock(store.shadowPreviewFile, () =>
    withFileLock(store.layoutMarkerFile, () => {
      if (safeLayoutMarkerFile(store.layoutMarkerFile)) {
        throw new Error('active store already has a layout marker; migration is not applicable');
      }
      if (!safeRegistryFile(store.attemptFile)) {
        throw new Error('legacy migration requires the existing private attempts registry');
      }
      const attempts = normalizeRegistry(readJson(
        store.attemptFile,
        undefined,
        { maxBytes: MAX_STORE_BYTES },
      ));
      let shadowPreviews;
      if (safeShadowPreviewFile(store.shadowPreviewFile)) {
        shadowPreviews = normalizeShadowPreviewRegistry(readJson(
          store.shadowPreviewFile,
          undefined,
          { maxBytes: MAX_STORE_BYTES },
        ));
      } else {
        shadowPreviews = emptyShadowPreviewRegistry();
        writeShadowPreviewRegistry(store.shadowPreviewFile, shadowPreviews);
      }
      writeLayoutMarker(store.layoutMarkerFile,
        buildLayoutMarker(establishedAt, 'explicit-legacy-migration'));
      return {
        ok: true,
        durable: true,
        migrated: true,
        root: store.root,
        layoutMarkerFile: store.layoutMarkerFile,
        attemptsPreserved: attempts.attempts.length,
        shadowPreviewsPreserved: shadowPreviews.previews.length,
      };
    })));
}

module.exports = {
  ACTIONS,
  ActiveChatStore,
  BLOCKING_STATES,
  CONTENT_REPLAY_WINDOW_MS,
  DEFAULT_ACTIVE_ROOT,
  DEFAULT_ACTIVE_ROOT_ALLOWLIST,
  LAYOUT_SCHEMA_VERSION,
  MAX_LAYOUT_MARKER_BYTES,
  MAX_ATTEMPTS,
  MAX_SHADOW_PREVIEWS,
  MAX_STORE_BYTES,
  STATES,
  STORE_SCHEMA_VERSION,
  emptyRegistry,
  emptyShadowPreviewRegistry,
  buildLayoutMarker,
  migrateLegacyActiveChatStore,
  normalizeAttempt,
  normalizeRegistry,
  normalizeShadowPreview,
  normalizeShadowPreviewRegistry,
  normalizeLayoutMarker,
  sourceConversationKey,
};
