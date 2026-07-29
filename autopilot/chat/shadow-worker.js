'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseAlarm } = require('../check-alarm.js');
const { ChatMemoryStore } = require('./memory-store.js');
const {
  ingestChatResult,
  prepareChatIngest,
} = require('./ingest.js');
const {
  extractTradeLeads,
  rankLeadOpportunities,
} = require('./lead-engine.js');
const { assertSafeGeneratedText, draftLeadResponse } = require('./negotiation.js');
const { isolateExternalMessage } = require('./injection-guard.js');
const { hasPrivateCommitmentLanguage, windowsExportDecision } = require('./policy.js');
const { normalizeMessage } = require('./schemas.js');
const {
  atomicWriteJsonl,
  readJsonl,
} = require('./persistence.js');

const DEFAULT_MINIMUM_WAKE_LEAD_MS = 5 * 60 * 1000;
const DEFAULT_WAKE_SAFETY_MARGIN_MS = 2 * 60 * 1000;
const DEFAULT_CYCLE_DEADLINE_MS = 90 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 15 * 1000;
const DEFAULT_NAS_DATA_ROOT_ALLOWLIST = Object.freeze([
  path.resolve(__dirname, '..', '.chat-shadow'),
]);
const SHADOW_ALLOWED_DECISION_ACTIONS = Object.freeze([
  'ignore',
  'request_evidence',
  'draft_private',
]);
const READ_ONLY_ACTIONS = Object.freeze([
  'chat_rooms_discover',
  'chat_room_read',
  'chat_contact_list',
  'chat_private_read',
]);
const READ_ONLY_ACTION_SET = new Set(READ_ONLY_ACTIONS);
const DEFAULT_LIMITS = Object.freeze({
  maxActions: 12,
  maxRooms: 4,
  maxPublicPages: 1,
  maxContacts: 6,
  maxPrivatePages: 2,
  maxObservedMessages: 80,
  maxMessageCharacters: 1200,
  maxDrafts: 10,
  maxDecisionCalls: 3,
  maxAuditEntries: 300,
  maxDraftEntries: 300,
  maxAuditBytes: 512 * 1024,
  maxDraftBytes: 512 * 1024,
  maxSnapshotBytes: 256 * 1024,
  maxSnapshotsPerConversation: 8,
  maxSnapshotsTotal: 80,
});

function finiteDate(value, field = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
}

function normalizeShadowMode(value) {
  const mode = String(value == null ? 'shadow' : value).trim().toLowerCase();
  if (!['off', 'read-only', 'shadow'].includes(mode)) {
    throw new TypeError('shadow worker mode must be off, read-only, or shadow');
  }
  return mode;
}

function normalizeLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('limits must be an object');
  }
  return Object.freeze({
    maxActions: boundedInteger(input.maxActions, DEFAULT_LIMITS.maxActions, 1, 40, 'maxActions'),
    maxRooms: boundedInteger(input.maxRooms, DEFAULT_LIMITS.maxRooms, 0, 12, 'maxRooms'),
    // A public read is one rendered page. Cross-process scroll state is deliberately not assumed.
    maxPublicPages: boundedInteger(
      input.maxPublicPages,
      DEFAULT_LIMITS.maxPublicPages,
      1,
      1,
      'maxPublicPages',
    ),
    maxContacts: boundedInteger(input.maxContacts, DEFAULT_LIMITS.maxContacts, 0, 20, 'maxContacts'),
    maxPrivatePages: boundedInteger(
      input.maxPrivatePages,
      DEFAULT_LIMITS.maxPrivatePages,
      1,
      6,
      'maxPrivatePages',
    ),
    maxObservedMessages: boundedInteger(
      input.maxObservedMessages,
      DEFAULT_LIMITS.maxObservedMessages,
      1,
      200,
      'maxObservedMessages',
    ),
    maxMessageCharacters: boundedInteger(
      input.maxMessageCharacters,
      DEFAULT_LIMITS.maxMessageCharacters,
      40,
      4000,
      'maxMessageCharacters',
    ),
    maxDrafts: boundedInteger(input.maxDrafts, DEFAULT_LIMITS.maxDrafts, 0, 30, 'maxDrafts'),
    maxDecisionCalls: boundedInteger(
      input.maxDecisionCalls,
      DEFAULT_LIMITS.maxDecisionCalls,
      0,
      10,
      'maxDecisionCalls',
    ),
    maxAuditEntries: boundedInteger(
      input.maxAuditEntries,
      DEFAULT_LIMITS.maxAuditEntries,
      1,
      2000,
      'maxAuditEntries',
    ),
    maxDraftEntries: boundedInteger(
      input.maxDraftEntries,
      DEFAULT_LIMITS.maxDraftEntries,
      1,
      2000,
      'maxDraftEntries',
    ),
    maxAuditBytes: boundedInteger(
      input.maxAuditBytes,
      DEFAULT_LIMITS.maxAuditBytes,
      4096,
      4 * 1024 * 1024,
      'maxAuditBytes',
    ),
    maxDraftBytes: boundedInteger(
      input.maxDraftBytes,
      DEFAULT_LIMITS.maxDraftBytes,
      4096,
      4 * 1024 * 1024,
      'maxDraftBytes',
    ),
    maxSnapshotBytes: boundedInteger(
      input.maxSnapshotBytes,
      DEFAULT_LIMITS.maxSnapshotBytes,
      4096,
      2 * 1024 * 1024,
      'maxSnapshotBytes',
    ),
    maxSnapshotsPerConversation: boundedInteger(
      input.maxSnapshotsPerConversation,
      DEFAULT_LIMITS.maxSnapshotsPerConversation,
      1,
      50,
      'maxSnapshotsPerConversation',
    ),
    maxSnapshotsTotal: boundedInteger(
      input.maxSnapshotsTotal,
      DEFAULT_LIMITS.maxSnapshotsTotal,
      1,
      500,
      'maxSnapshotsTotal',
    ),
  });
}

function looksLikeWindowsPath(value) {
  const text = String(value || '');
  return /^[a-z]:[\\/]/iu.test(text)
    || /^\\\\/u.test(text)
    || /^\/\/[^/]/u.test(text)
    || /^\/mnt\/[a-z](?:\/|$)/iu.test(text);
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(value) {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('dataRoot cannot contain symlink components');
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new Error('dataRoot parent component must be a directory');
    }
  }
}

function canonicalPathWithMissingTail(value) {
  const missing = [];
  let cursor = path.resolve(value);
  while (true) {
    try {
      const canonical = fs.realpathSync.native(cursor);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function resolveNasDataRoot(value, {
  allowedRoots = DEFAULT_NAS_DATA_ROOT_ALLOWLIST,
} = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('dataRoot is required');
  if (looksLikeWindowsPath(value)) throw new Error('shadow chat data must remain on NAS-local storage');
  if (!path.isAbsolute(value)) throw new Error('dataRoot must be an absolute path');
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new TypeError('allowedRoots must contain at least one absolute canonical root');
  }
  const resolved = path.resolve(value);
  assertNoSymlinkComponents(resolved);
  const canonical = canonicalPathWithMissingTail(resolved);
  const canonicalAllowedRoots = allowedRoots.map((allowedRoot, index) => {
    if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
      throw new TypeError(`allowedRoots[${index}] must be an absolute path`);
    }
    assertNoSymlinkComponents(allowedRoot);
    const allowedCanonical = canonicalPathWithMissingTail(path.resolve(allowedRoot));
    try {
      if (!fs.statSync(allowedCanonical).isDirectory()) {
        throw new Error(`allowedRoots[${index}] must be a directory`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return allowedCanonical;
  });
  if (!canonicalAllowedRoots.some(allowedRoot => pathIsWithin(allowedRoot, canonical))) {
    throw new Error('dataRoot escapes the canonical NAS allowlist');
  }
  return canonical;
}

function secureDirectory(directory) {
  assertNoSymlinkComponents(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(directory);
  try { fs.chmodSync(directory, 0o700); } catch (_) {}
}

function assertSafeShadowLayout(dataRoot) {
  for (const directory of [
    dataRoot,
    path.join(dataRoot, 'memory'),
    path.join(dataRoot, 'memory', 'threads'),
    path.join(dataRoot, 'memory', 'summaries'),
    path.join(dataRoot, 'observations'),
    path.join(dataRoot, 'shadow'),
  ]) assertNoSymlinkComponents(directory);
}

function truncateUnicode(value, maximum) {
  const characters = Array.from(String(value == null ? '' : value).normalize('NFKC'));
  return characters.length <= maximum ? characters.join('') : characters.slice(0, maximum).join('');
}

function safePositiveId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 160 ? text : null;
}

function safeResourceKinds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number)
    .filter(kind => Number.isSafeInteger(kind) && kind > 0))].slice(0, 30);
}

const MESSAGE_ID_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_ID',
  'EXPLICIT_DOM_ATTRIBUTE',
  'UNKNOWN',
]);
const MESSAGE_TIME_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_DATETIME',
  'EXPLICIT_DOM_DATETIME',
  'VERIFIED_RENDERED',
  'UNKNOWN',
]);
const MESSAGE_AUTHOR_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER',
  'VERIFIED_RENDERED_COMPONENT_SELF_ID',
  'EXPLICIT_DOM_ID_AND_VISIBLE_HEADER',
  'VERIFIED_VISIBLE_GROUP_HEADER',
  'UNKNOWN',
]);
const MESSAGE_DIRECTION_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_AND_STYLE',
  'VERIFIED_RENDERED_STYLE',
  'UNKNOWN',
]);
function safeProvenance(value, allowed) {
  return allowed.has(value) ? value : 'UNKNOWN';
}

function boundPublicResult(result, limits) {
  let remaining = limits.maxObservedMessages;
  const groups = [];
  for (const rawGroup of Array.isArray(result?.groups) ? result.groups : []) {
    if (remaining <= 0) break;
    const messages = [];
    for (const rawMessage of Array.isArray(rawGroup?.messages) ? rawGroup.messages : []) {
      if (remaining <= 0) break;
      const text = truncateUnicode(rawMessage?.text ?? rawMessage?.visibleText, limits.maxMessageCharacters);
      const resourceKinds = safeResourceKinds(rawMessage?.resourceKinds);
      if (!text.trim() && resourceKinds.length === 0) continue;
      messages.push({
        messageId: safePositiveId(rawMessage?.messageId),
        idStatus: safeProvenance(rawMessage?.idStatus, MESSAGE_ID_PROVENANCE),
        exactTime: typeof rawMessage?.exactTime === 'string' ? rawMessage.exactTime : null,
        timeStatus: safeProvenance(rawMessage?.timeStatus, MESSAGE_TIME_PROVENANCE),
        text,
        visibleText: truncateUnicode(rawMessage?.visibleText ?? text, limits.maxMessageCharacters),
        resourceKinds,
      });
      remaining -= 1;
    }
    if (!messages.length) continue;
    groups.push({
      company: truncateUnicode(rawGroup?.company, 200).trim() || null,
      companyId: safePositiveId(rawGroup?.companyId),
      authorStatus: safeProvenance(rawGroup?.authorStatus, MESSAGE_AUTHOR_PROVENANCE),
      fromMe: rawGroup?.fromMe === true,
      directionStatus: safeProvenance(rawGroup?.directionStatus, MESSAGE_DIRECTION_PROVENANCE),
      exactTime: typeof rawGroup?.exactTime === 'string' ? rawGroup.exactTime : null,
      timeStatus: safeProvenance(rawGroup?.timeStatus, MESSAGE_TIME_PROVENANCE),
      timeLabel: truncateUnicode(rawGroup?.timeLabel, 120).trim() || null,
      messages,
    });
  }
  return { ok: result?.ok === true, groups };
}

function boundPrivateResult(result, limits, contact) {
  const messages = [];
  for (const rawMessage of Array.isArray(result?.thread?.messages) ? result.thread.messages : []) {
    if (messages.length >= limits.maxObservedMessages) break;
    const visibleBody = truncateUnicode(
      rawMessage?.visibleBody ?? rawMessage?.text,
      limits.maxMessageCharacters,
    );
    const resourceKinds = safeResourceKinds(rawMessage?.resourceKinds);
    if (!visibleBody.trim() && resourceKinds.length === 0) continue;
    const direction = ['INCOMING', 'OUTGOING'].includes(rawMessage?.direction)
      ? rawMessage.direction
      : 'UNKNOWN';
    messages.push({
      serverMessageId: safePositiveId(rawMessage?.serverMessageId ?? rawMessage?.messageId),
      idStatus: safeProvenance(rawMessage?.idStatus, MESSAGE_ID_PROVENANCE),
      observationFingerprint: typeof rawMessage?.observationFingerprint === 'string'
        ? truncateUnicode(rawMessage.observationFingerprint, 200)
        : null,
      authorCompany: direction === 'INCOMING'
        ? truncateUnicode(rawMessage?.authorCompany ?? contact.company, 200).trim() || null
        : null,
      authorCompanyId: direction === 'INCOMING'
        ? safePositiveId(rawMessage?.authorCompanyId ?? contact.companyId)
        : null,
      authorStatus: safeProvenance(rawMessage?.authorStatus, MESSAGE_AUTHOR_PROVENANCE),
      direction,
      directionStatus: safeProvenance(rawMessage?.directionStatus, MESSAGE_DIRECTION_PROVENANCE),
      visibleBody,
      resourceKinds,
      exactCreatedAt: typeof rawMessage?.exactCreatedAt === 'string' ? rawMessage.exactCreatedAt : null,
      timeStatus: safeProvenance(rawMessage?.timeStatus, MESSAGE_TIME_PROVENANCE),
      renderedTime: truncateUnicode(rawMessage?.renderedTime, 120).trim() || null,
    });
  }
  return {
    ok: result?.ok === true,
    targetCompany: contact.company,
    targetCompanyId: contact.companyId,
    thread: { messages },
  };
}

function removeLastObservation(conversationType, result) {
  if (conversationType === 'private') {
    result.thread.messages.pop();
    return result.thread.messages.length > 0;
  }
  const lastGroup = result.groups.at(-1);
  if (!lastGroup) return false;
  lastGroup.messages.pop();
  if (!lastGroup.messages.length) result.groups.pop();
  return result.groups.length > 0;
}

function fitResultForSnapshot({ conversationType, conversationId, result, limits, observedAt,
  ownCompanyId, ownCompanyName }) {
  while (true) {
    const prepared = prepareChatIngest({
      conversationType,
      conversationId,
      result,
      observedAt,
      ownCompanyId,
      ownCompanyName,
    });
    const size = Buffer.byteLength(JSON.stringify(prepared.observationSnapshot), 'utf8');
    if (size <= limits.maxSnapshotBytes) return { result, prepared, size };
    if (!removeLastObservation(conversationType, result)) {
      throw new RangeError('one bounded chat observation still exceeds maxSnapshotBytes');
    }
  }
}

function jsonlBytes(entries) {
  if (!entries.length) return 0;
  return Buffer.byteLength(`${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function appendCappedJsonl(file, incoming, {
  idField,
  timeField,
  maxEntries,
  maxBytes,
}) {
  if (!Array.isArray(incoming)) throw new TypeError('incoming records must be an array');
  secureDirectory(path.dirname(file));
  const existing = readJsonl(file);
  const records = new Map();
  for (const entry of [...existing, ...incoming]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('JSONL record must be an object');
    }
    const id = String(entry[idField] || '').trim();
    if (!id) throw new TypeError(`JSONL record requires ${idField}`);
    if (records.has(id) && JSON.stringify(records.get(id)) !== JSON.stringify(entry)) {
      throw new Error(`${idField} ${id} was reused with different data`);
    }
    records.set(id, entry);
  }
  let retained = [...records.values()].sort((left, right) => {
    const leftTime = Date.parse(left[timeField]);
    const rightTime = Date.parse(right[timeField]);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return String(left[idField]).localeCompare(String(right[idField]));
  });
  if (retained.length > maxEntries) retained = retained.slice(-maxEntries);
  while (retained.length && jsonlBytes(retained) > maxBytes) retained.shift();
  if (incoming.length && !retained.length) {
    throw new RangeError(`${path.basename(file)} cannot retain one record within its byte limit`);
  }
  atomicWriteJsonl(file, retained);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return { total: retained.length, bytes: jsonlBytes(retained) };
}

function pruneObservationSnapshots(observationRoot, limits = DEFAULT_LIMITS) {
  const directory = path.join(path.resolve(observationRoot), 'observations');
  let names;
  try {
    names = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { kept: 0, removed: 0, oversized: 0 };
    throw error;
  }
  const entries = [];
  const remove = new Set();
  let oversized = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    if (stat.size > limits.maxSnapshotBytes) {
      remove.add(file);
      oversized += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`invalid observation snapshot ${file}: ${error.message}`, { cause: error });
    }
    if (parsed?.recordType !== 'ui-observation-snapshot'
        || !['private', 'room'].includes(parsed?.conversationType)
        || typeof parsed?.conversationId !== 'string') {
      throw new Error(`invalid observation snapshot identity in ${file}`);
    }
    entries.push({
      file,
      group: `${parsed.conversationType}\0${parsed.conversationId}`,
      time: Number.isFinite(Date.parse(parsed.observedAt)) ? Date.parse(parsed.observedAt) : stat.mtimeMs,
      name,
    });
  }
  const byGroup = new Map();
  for (const entry of entries) {
    const group = byGroup.get(entry.group) || [];
    group.push(entry);
    byGroup.set(entry.group, group);
  }
  for (const group of byGroup.values()) {
    group.sort((left, right) => left.time - right.time || left.name.localeCompare(right.name));
    for (const entry of group.slice(0, Math.max(0, group.length - limits.maxSnapshotsPerConversation))) {
      remove.add(entry.file);
    }
  }
  const candidates = entries.filter(entry => !remove.has(entry.file))
    .sort((left, right) => left.time - right.time || left.name.localeCompare(right.name));
  for (const entry of candidates.slice(0, Math.max(0, candidates.length - limits.maxSnapshotsTotal))) {
    remove.add(entry.file);
  }
  for (const file of remove) fs.unlinkSync(file);
  return { kept: entries.length + oversized - remove.size, removed: remove.size, oversized };
}

function nextWakeTimestamp(nextWake) {
  return parseAlarm(nextWake)?.at ?? null;
}

function evaluateRunPermission({
  brainLockAvailable,
  tickLockAvailable,
  nextWake,
  now = new Date(),
  minimumWakeLeadMs = DEFAULT_MINIMUM_WAKE_LEAD_MS,
} = {}) {
  if (brainLockAvailable !== true) {
    return { ok: false, skipped: true, reason: 'brain-lock-held' };
  }
  if (tickLockAvailable !== true) {
    return { ok: false, skipped: true, reason: 'tick-lock-held' };
  }
  const nowMs = finiteDate(now, 'now').getTime();
  const wakeMs = nextWakeTimestamp(nextWake);
  if (wakeMs == null) return { ok: false, skipped: true, reason: 'next-wake-unknown' };
  const leadMs = wakeMs - nowMs;
  if (leadMs < minimumWakeLeadMs) {
    return { ok: false, skipped: true, reason: 'next-wake-too-close', leadMs,
      nextWakeAtMs: wakeMs };
  }
  return { ok: true, skipped: false, leadMs, nextWakeAtMs: wakeMs };
}

function clockMilliseconds(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a finite time');
  return milliseconds;
}

function createCycleGuard({
  clock = Date.now,
  deadlineAtMs,
  cycleDeadlineMs = DEFAULT_CYCLE_DEADLINE_MS,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  nextWakeReader = null,
  nextWakeAtMs = null,
  wakeSafetyMarginMs = DEFAULT_WAKE_SAFETY_MARGIN_MS,
} = {}) {
  const startedAtMs = clockMilliseconds(clock);
  const duration = boundedInteger(
    cycleDeadlineMs,
    DEFAULT_CYCLE_DEADLINE_MS,
    100,
    5 * 60 * 1000,
    'cycleDeadlineMs',
  );
  const perOperationTimeoutMs = boundedInteger(
    operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    100,
    30 * 1000,
    'operationTimeoutMs',
  );
  const safetyMarginMs = boundedInteger(
    wakeSafetyMarginMs,
    DEFAULT_WAKE_SAFETY_MARGIN_MS,
    DEFAULT_WAKE_SAFETY_MARGIN_MS,
    30 * 60 * 1000,
    'wakeSafetyMarginMs',
  );
  const absoluteDeadlineMs = deadlineAtMs == null
    ? startedAtMs + duration
    : Number(deadlineAtMs);
  if (!Number.isFinite(absoluteDeadlineMs)) throw new TypeError('deadlineAtMs must be finite');
  let lastWakeAtMs = nextWakeAtMs != null && Number.isFinite(Number(nextWakeAtMs))
    ? Number(nextWakeAtMs) : null;

  return Object.freeze({
    startedAtMs,
    deadlineAtMs: absoluteDeadlineMs,
    wakeSafetyMarginMs: safetyMarginMs,
    check(label = 'operation') {
      const currentMs = clockMilliseconds(clock);
      const deadlineRemainingMs = Math.floor(absoluteDeadlineMs - currentMs);
      if (deadlineRemainingMs <= 0) {
        return { ok: false, reason: 'shadow-cycle-deadline-exceeded', label,
          deadlineRemainingMs };
      }
      if (nextWakeReader != null) {
        if (typeof nextWakeReader !== 'function') {
          return { ok: false, reason: 'next-wake-reader-invalid', label };
        }
        let nextWake;
        try {
          nextWake = nextWakeReader();
        } catch {
          return { ok: false, reason: 'next-wake-read-failed', label };
        }
        lastWakeAtMs = nextWakeTimestamp(nextWake);
        if (lastWakeAtMs == null) {
          return { ok: false, reason: 'next-wake-unknown', label };
        }
      }
      let wakeLeadMs = null;
      let wakeBudgetMs = Number.POSITIVE_INFINITY;
      if (lastWakeAtMs != null) {
        wakeLeadMs = Math.floor(lastWakeAtMs - currentMs);
        wakeBudgetMs = wakeLeadMs - safetyMarginMs;
        if (wakeBudgetMs <= 0) {
          return { ok: false, reason: 'next-wake-safety-margin', label, wakeLeadMs,
            wakeSafetyMarginMs: safetyMarginMs };
        }
      }
      const timeoutMs = Math.max(1, Math.floor(Math.min(
        perOperationTimeoutMs,
        deadlineRemainingMs,
        wakeBudgetMs,
      )));
      return { ok: true, label, timeoutMs, deadlineRemainingMs, wakeLeadMs,
        wakeSafetyMarginMs: safetyMarginMs };
    },
  });
}

async function runBoundedOperation(operation, control) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('shadow operation timed out');
      error.code = 'SHADOW_OPERATION_TIMEOUT';
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

function unavailableBusinessSnapshot(now) {
  return {
    schemaVersion: 1,
    snapshotId: `shadow-unavailable-${now.getTime()}`,
    observedAt: now.toISOString(),
    inventory: [],
    markets: [],
    economics: [],
    transport: { status: 'unknown', observedAt: now.toISOString(), entries: [] },
    finance: { status: 'unknown', observedAt: now.toISOString() },
    evidenceStatus: 'UNAVAILABLE_SHADOW_DEFAULT',
  };
}

const deterministicDecisionProvider = Object.freeze({
  name: 'deterministic-shadow-v1',
  networkAccess: false,
  async decide(input) {
    const offer = input?.businessSnapshot?.decisionContext?.externalLead?.leadOffer;
    if (!offer) {
      return Object.freeze({
        schemaVersion: 1,
        ok: false,
        action: 'request_evidence',
        scope: null,
        text: null,
        rationale: 'structured-lead-offer-required',
        evidenceRefs: [],
        neededEvidence: ['structured-lead-offer'],
        sendAuthorized: false,
        contractMutationAuthorized: false,
        source: 'deterministic-no-network',
      });
    }
    const draft = draftLeadResponse({ offer, scope: 'private' });
    return Object.freeze({
      schemaVersion: 1,
      ok: true,
      action: 'draft_private',
      scope: 'private',
      text: draft.text,
      rationale: 'deterministic-structured-clarification',
      evidenceRefs: Object.freeze(['/businessSnapshot/decisionContext/externalLead/leadOffer']),
      neededEvidence: Object.freeze([]),
      sendAuthorized: false,
      contractMutationAuthorized: false,
      source: 'deterministic-no-network',
    });
  },
});

function normalizeDecisionProvider(provider) {
  const value = provider || deterministicDecisionProvider;
  const decide = typeof value === 'function' ? value : value.decide;
  if (typeof decide !== 'function') throw new TypeError('decisionProvider must provide decide(input)');
  return {
    name: truncateUnicode(value.name || (value === deterministicDecisionProvider
      ? deterministicDecisionProvider.name : 'injected-decision-provider'), 120),
    networkAccess: value.networkAccess === true,
    decide: decide.bind(value),
  };
}

function deepFreezeJson(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreezeJson(child);
  return value;
}

function jsonClone(value, field) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${field} must be JSON-serializable`);
  }
  if (typeof serialized !== 'string') throw new TypeError(`${field} must be JSON-serializable`);
  return JSON.parse(serialized);
}

function sanitizeDecisionOffer(offer) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    throw new TypeError('structured lead offer is required');
  }
  return {
    schemaVersion: offer.schemaVersion,
    offerId: offer.offerId,
    source: {
      messageId: offer.source?.messageId,
      conversationType: offer.source?.conversationType,
      conversationId: offer.source?.conversationId,
      counterpartyCompanyId: offer.source?.counterpartyCompanyId,
      createdAt: offer.source?.createdAt,
      observedAt: offer.source?.observedAt,
      trust: 'untrusted-external',
    },
    instructionAuthority: 'none',
    counterpartySide: offer.counterpartySide,
    ourSide: offer.ourSide,
    resource: {
      status: offer.resource?.status,
      kind: offer.resource?.kind ?? null,
      name: null,
      iconToken: null,
    },
    quantity: jsonClone(offer.quantity, 'offer.quantity'),
    quality: jsonClone(offer.quality, 'offer.quality'),
    price: jsonClone(offer.price, 'offer.price'),
    evidence: Array.isArray(offer.evidence) ? offer.evidence.map(entry => ({
      field: String(entry?.field || ''),
      source: String(entry?.source || ''),
    })) : [],
    unknowns: Array.isArray(offer.unknowns) ? offer.unknowns.map(entry => ({
      field: String(entry?.field || ''),
      status: 'UNKNOWN',
      reason: String(entry?.reason || 'structured field is UNKNOWN').slice(0, 300),
    })) : [],
    complete: offer.complete === true,
    autoActionAuthorized: false,
  };
}

function sanitizeDecisionEvaluation(evaluation) {
  const value = jsonClone(evaluation, 'lead evaluation');
  delete value.resourceName;
  value.autoCommitEligible = false;
  return value;
}

function containsExactString(value, expected) {
  const wanted = String(expected || '').normalize('NFKC').trim();
  if (Array.from(wanted).length < 4) return false;
  const stack = [value];
  while (stack.length) {
    const entry = stack.pop();
    if (typeof entry === 'string') {
      if (entry.normalize('NFKC').trim() === wanted) return true;
    } else if (Array.isArray(entry)) {
      stack.push(...entry);
    } else if (entry && typeof entry === 'object') {
      stack.push(...Object.values(entry));
    }
  }
  return false;
}

const BUSINESS_SNAPSHOT_DTO_KEYS = Object.freeze([
  'economics',
  'evidenceStatus',
  'finance',
  'inventory',
  'markets',
  'observedAt',
  'schemaVersion',
  'snapshotId',
  'transport',
]);
const BUSINESS_SNAPSHOT_DTO_KEY_SET = new Set(BUSINESS_SNAPSHOT_DTO_KEYS);
const SECRET_LIKE_KEY_PATTERN = /(?:api[\s_-]*key|authorization|cookie|credential|password|secret|session|token)/iu;
const INVENTORY_DTO_FIELDS = Object.freeze([
  'blockedAmount', 'kind', 'observedAt', 'onHandAmount', 'quality', 'reserveAmount',
  'status', 'unitCost',
]);
const MARKET_DTO_FIELDS = Object.freeze([
  'bestAsk', 'bestBid', 'kind', 'marketPrice', 'observedAt', 'quality', 'status',
]);
const ECONOMICS_DTO_FIELDS = Object.freeze([
  'alternativeSellNetPerUnit', 'buyNeedAmount', 'buyUseValuePerUnit', 'contractFeeRate',
  'fixedCost', 'kind', 'observedAt', 'quality', 'status', 'warehouseFreeAmount',
]);
const TRANSPORT_DTO_FIELDS = Object.freeze([
  'availableAmount', 'entries', 'observedAt', 'status',
]);
const TRANSPORT_ENTRY_DTO_FIELDS = Object.freeze([
  'kind', 'opportunityCostPerUnit', 'unitsPerItem',
]);
const FINANCE_DTO_FIELDS = Object.freeze([
  'cashAvailable', 'cashReserve', 'observedAt', 'status',
]);
const BUSINESS_DATA_STATUS_VALUES = new Set([
  'known', 'ok', 'partial', 'stale', 'unavailable', 'unknown',
]);
const EVIDENCE_STATUS_VALUES = new Set([
  'UNAVAILABLE_SHADOW_DEFAULT',
]);
const OPAQUE_SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;

function assertNoSecretLikeKeys(value, field = 'businessSnapshot') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_LIKE_KEY_PATTERN.test(key)) {
      throw new Error(`${field} contains a secret-like key`);
    }
    assertNoSecretLikeKeys(child, `${field}.${key}`);
  }
}

function projectTypedDtoObject(value, allowedFields, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const allowed = new Set(allowedFields);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(`${field} contains unknown fields`);
  }
  const projected = {};
  for (const key of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const entry = value[key];
    if (key === 'status') {
      if (typeof entry !== 'string' || !BUSINESS_DATA_STATUS_VALUES.has(entry)) {
        throw new TypeError(`${field}.status is invalid`);
      }
    } else if (key === 'observedAt') {
      if (typeof entry !== 'string' || !Number.isFinite(Date.parse(entry))) {
        throw new TypeError(`${field}.observedAt is invalid`);
      }
    } else if (key === 'kind') {
      if (!Number.isSafeInteger(entry) || entry <= 0) throw new TypeError(`${field}.kind is invalid`);
    } else if (key === 'quality') {
      if (!Number.isSafeInteger(entry) || entry < 0) throw new TypeError(`${field}.quality is invalid`);
    } else if (key !== 'entries') {
      if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
        throw new TypeError(`${field}.${key} is invalid`);
      }
    }
    projected[key] = entry;
  }
  return projected;
}

function projectTypedDtoArray(value, allowedFields, field) {
  if (!Array.isArray(value) || value.length > 200) throw new TypeError(`${field} must be a bounded array`);
  return value.map((entry, index) => projectTypedDtoObject(
    entry,
    allowedFields,
    `${field}[${index}]`,
  ));
}

function buildMinimalBusinessSnapshotDto(snapshot, quotedText) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('business snapshot must be an object');
  }
  if (containsExactString(snapshot, quotedText)) {
    throw new Error('business snapshot must not repeat raw player text');
  }
  assertNoSecretLikeKeys(snapshot);
  const unknownKeys = Object.keys(snapshot)
    .filter(key => !BUSINESS_SNAPSHOT_DTO_KEY_SET.has(key));
  if (unknownKeys.length) throw new Error('business snapshot contains unknown top-level fields');
  if (snapshot.schemaVersion !== 1
      || typeof snapshot.snapshotId !== 'string'
      || !OPAQUE_SNAPSHOT_ID_PATTERN.test(snapshot.snapshotId)
      || typeof snapshot.observedAt !== 'string'
      || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw new TypeError('business snapshot identity is invalid');
  }
  const transport = projectTypedDtoObject(snapshot.transport, TRANSPORT_DTO_FIELDS, 'transport');
  transport.entries = projectTypedDtoArray(
    snapshot.transport.entries,
    TRANSPORT_ENTRY_DTO_FIELDS,
    'transport.entries',
  );
  const dto = {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    observedAt: snapshot.observedAt,
    inventory: projectTypedDtoArray(snapshot.inventory, INVENTORY_DTO_FIELDS, 'inventory'),
    markets: projectTypedDtoArray(snapshot.markets, MARKET_DTO_FIELDS, 'markets'),
    economics: projectTypedDtoArray(snapshot.economics, ECONOMICS_DTO_FIELDS, 'economics'),
    transport,
    finance: projectTypedDtoObject(snapshot.finance, FINANCE_DTO_FIELDS, 'finance'),
  };
  if (Object.prototype.hasOwnProperty.call(snapshot, 'evidenceStatus')) {
    if (typeof snapshot.evidenceStatus !== 'string'
        || !EVIDENCE_STATUS_VALUES.has(snapshot.evidenceStatus)) {
      throw new TypeError('evidenceStatus is invalid');
    }
    dto.evidenceStatus = snapshot.evidenceStatus;
  }
  return dto;
}

function buildDecisionBusinessSnapshot({ snapshot, offer, evaluation, quotedText }) {
  const value = buildMinimalBusinessSnapshotDto(snapshot, quotedText);
  value.chatInputBoundary = {
    schemaVersion: 1,
    externalPlayerStringsTrust: 'untrusted-external-data',
    instructionAuthority: 'none',
    rawPlayerTextRepeated: false,
  };
  value.decisionContext = {
    schemaVersion: 1,
    allowedActions: [...SHADOW_ALLOWED_DECISION_ACTIONS],
    externalLead: {
      trust: 'derived-untrusted-external-data',
      instructionAuthority: 'none',
      leadOffer: sanitizeDecisionOffer(offer),
    },
    leadEvaluation: {
      trust: 'mixed-derived-evidence',
      instructionAuthority: 'none',
      value: sanitizeDecisionEvaluation(evaluation),
    },
    agreementEvidence: null,
  };
  return deepFreezeJson(value);
}

function validateShadowProviderDraft(decision) {
  if (!decision || decision.action !== 'draft_private' || decision.scope !== 'private'
      || typeof decision.text !== 'string') {
    return { ok: false, reason: 'provider did not return a private draft action' };
  }
  let text;
  try {
    text = assertSafeGeneratedText(decision.text, 'private');
  } catch {
    return { ok: false, reason: 'provider private draft failed outgoing policy' };
  }
  if (hasPrivateCommitmentLanguage(text)) {
    return { ok: false, reason: 'shadow private draft cannot contain an economic commitment' };
  }
  return { ok: true, text };
}

function normalizeContactList(result) {
  if (!result?.ok || !Array.isArray(result.contacts)) return [];
  const seen = new Set();
  const contacts = [];
  for (const raw of result.contacts) {
    const companyId = Number(raw?.companyId);
    const company = truncateUnicode(raw?.company, 160).trim();
    const unread = Number(raw?.unread);
    if (!Number.isSafeInteger(companyId) || companyId <= 0 || !company
        || !Number.isSafeInteger(unread) || unread < 0 || seen.has(companyId)) continue;
    seen.add(companyId);
    contacts.push({
      companyId,
      company,
      unread,
      pinned: raw?.pinned === true,
    });
  }
  return contacts.sort((left, right) => right.unread - left.unread
    || Number(right.pinned) - Number(left.pinned)
    || left.companyId - right.companyId);
}

function normalizeRooms(result) {
  if (!result?.ok || !Array.isArray(result.rooms)) return [];
  return [...new Set(result.rooms
    .map(entry => truncateUnicode(entry?.room, 120).trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'en'));
}

function fixedOperationFailure(error, prefix) {
  return error?.code === 'SHADOW_OPERATION_TIMEOUT'
    ? `${prefix}-timeout`
    : `${prefix}-failed`;
}

function safeReadActionFailureCode(action, result) {
  if (action !== 'chat_private_read') return null;
  const reason = String(result?.reason || '');
  const fixedCodes = new Map([
    ['targetCompany is required', 'private-target-required'],
    ['exact private pane header count != 1', 'private-header-count'],
    ['private URL does not contain the exact target company', 'private-route-mismatch'],
    ['visible private-contact sidebar count != 1', 'private-sidebar-count'],
    ['malformed or duplicate contact companyId evidence', 'private-contact-identity-invalid'],
    ['target company name and ID are not bound to one unique contact record', 'private-contact-target-mismatch'],
    ['target private pane was not isolated', 'private-pane-not-isolated'],
    ['target private history scroll container count != 1', 'private-history-scroller-count'],
  ]);
  if (fixedCodes.has(reason)) return fixedCodes.get(reason);
  if (/^contact \d+ lacks exact company or unread evidence$/u.test(reason)) {
    return 'private-contact-record-invalid';
  }
  return 'private-read-unclassified';
}

function addDecisionUsage(total, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;
  for (const key of Object.keys(total)) {
    const value = usage[key];
    if (Number.isSafeInteger(value) && value >= 0) total[key] += value;
  }
}

function stableDraftId(sourceMessageId, targetCompanyId, text) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ sourceMessageId, targetCompanyId, text }))
    .digest('hex');
}

function reuseImmutableDraft(existing, candidate) {
  if (!existing) return candidate;
  if (typeof existing.createdAt !== 'string' || !Number.isFinite(Date.parse(existing.createdAt))) {
    throw new Error('stored shadow draft has an invalid creation time');
  }
  const sameCreationTime = { ...candidate, createdAt: existing.createdAt };
  if (JSON.stringify(existing) !== JSON.stringify(sameCreationTime)) {
    throw new Error('stable draft ID conflicts with immutable stored data');
  }
  return existing;
}

function localObservationIdentity(conversationType, conversationId, observation) {
  const observationFingerprint = String(observation?.observationFingerprint || '').trim();
  if (!observationFingerprint) throw new TypeError('UI observation fingerprint is required');
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    conversationType,
    conversationId,
    observationFingerprint,
  })).digest('hex');
  return `ui-observation-sha256-${digest.slice(0, 32)}`;
}

function prepareObservationLeadMessage({
  conversationType,
  conversationId,
  observation,
  observedAt,
}) {
  if (observation?.direction !== 'INCOMING' || !String(observation?.visibleBody || '').trim()) {
    return null;
  }
  const companyName = truncateUnicode(observation.authorCompany, 200).trim();
  if (!companyName) return null;
  const localMessageId = localObservationIdentity(conversationType, conversationId, observation);
  const explicitCompanyId = safePositiveId(observation.authorCompanyId);
  const localCompanyId = `ui-company-sha256-${crypto.createHash('sha256')
    .update(companyName.toLocaleLowerCase('en-US'))
    .digest('hex').slice(0, 24)}`;
  const exactCreatedAt = Date.parse(observation.exactCreatedAt);
  const createdAt = Number.isFinite(exactCreatedAt)
    ? new Date(exactCreatedAt).toISOString()
    : finiteDate(observedAt, 'observedAt').toISOString();
  const message = normalizeMessage({
    messageId: localMessageId,
    conversationType,
    conversationId,
    direction: 'inbound',
    author: {
      companyId: explicitCompanyId == null ? localCompanyId : String(explicitCompanyId),
      companyName,
    },
    createdAt,
    observedAt: finiteDate(observedAt, 'observedAt').toISOString(),
    replyToMessageId: null,
    content: {
      text: String(observation.visibleBody),
      language: null,
      resourceMentions: safeResourceKinds(observation.resourceKinds)
        .map(kind => ({ kind, name: null })),
    },
  });
  return {
    message,
    identity: Object.freeze({
      idSource: 'UI_DERIVED_NOT_SERVER',
      localObservationId: localMessageId,
      serverMessageId: observation.serverMessageId || null,
      observationFingerprint: observation.observationFingerprint,
      authorIdentityStatus: explicitCompanyId == null
        ? 'UI_COMPANY_NAME_ONLY_LOCAL_REFERENCE'
        : 'EXPLICIT_UI_COMPANY_ID',
      timeStatus: Number.isFinite(exactCreatedAt)
        ? 'EXACT_UI_TIME_WITHOUT_COMPLETE_LEDGER_IDENTITY'
        : 'OBSERVED_AT_NOT_SERVER_TIME',
      strictLedgerEligible: false,
      contractIdentityAuthorized: false,
    }),
  };
}

function blockUiDerivedEvaluation(evaluation, identity) {
  if (identity?.idSource !== 'UI_DERIVED_NOT_SERVER') return evaluation;
  return {
    ...evaluation,
    status: 'UNKNOWN',
    evidenceComplete: false,
    economicallyPositive: false,
    autoCommitEligible: false,
    maxNegotiableQuantity: null,
    canFillAdvertisedQuantity: false,
    economics: null,
    economicsInputs: null,
    identityEvidence: identity,
    unknowns: [...new Set([
      ...(Array.isArray(evaluation.unknowns) ? evaluation.unknowns : []),
      'server message identity is UNKNOWN; UI-derived observation cannot authorize a contract',
      identity.authorIdentityStatus === 'UI_COMPANY_NAME_ONLY_LOCAL_REFERENCE'
        ? 'counterparty server companyId is UNKNOWN'
        : null,
      identity.timeStatus === 'OBSERVED_AT_NOT_SERVER_TIME'
        ? 'exact server message time is UNKNOWN'
        : null,
    ].filter(Boolean))],
  };
}

function rerankEvaluations(evaluations) {
  return [...evaluations].sort((left, right) => {
    if (left.evidenceComplete !== right.evidenceComplete) return left.evidenceComplete ? -1 : 1;
    if (left.economicallyPositive !== right.economicallyPositive) return left.economicallyPositive ? -1 : 1;
    const leftGain = Number(left.economics?.opportunityGain ?? Number.NEGATIVE_INFINITY);
    const rightGain = Number(right.economics?.opportunityGain ?? Number.NEGATIVE_INFINITY);
    if (leftGain !== rightGain) return rightGain - leftGain;
    return String(left.offerId || '').localeCompare(String(right.offerId || ''));
  }).map((evaluation, index) => ({ ...evaluation, rank: index + 1 }));
}

async function runShadowCycle(options = {}) {
  const mode = normalizeShadowMode(options.mode);
  const permission = options.permission;
  if (permission && permission.ok !== true) {
    return { ok: true, skipped: true, reason: permission.reason || 'preflight-denied', actions: [] };
  }
  if (mode === 'off') return { ok: true, skipped: true, reason: 'shadow-worker-off', actions: [] };
  if (typeof options.actionRunner !== 'function') throw new TypeError('actionRunner is required');

  const now = finiteDate(options.now ?? new Date(), 'now');
  const nowIso = now.toISOString();
  const limits = normalizeLimits(options.limits);
  const cycleGuard = createCycleGuard({
    clock: options.clock || Date.now,
    deadlineAtMs: options.deadlineAtMs,
    cycleDeadlineMs: options.cycleDeadlineMs,
    operationTimeoutMs: options.operationTimeoutMs,
    nextWakeReader: options.nextWakeReader,
    nextWakeAtMs: permission?.nextWakeAtMs,
    wakeSafetyMarginMs: options.wakeSafetyMarginMs,
  });
  const cyclePreflight = cycleGuard.check('cycle-start');
  if (!cyclePreflight.ok) {
    return { ok: true, skipped: true, reason: cyclePreflight.reason, actions: [] };
  }
  const dataRoot = resolveNasDataRoot(options.dataRoot, {
    allowedRoots: options.dataRootAllowedRoots,
  });
  const memoryRoot = path.join(dataRoot, 'memory');
  const shadowRoot = path.join(dataRoot, 'shadow');
  const auditFile = path.join(shadowRoot, 'audit.jsonl');
  const draftsFile = path.join(shadowRoot, 'drafts.jsonl');
  assertSafeShadowLayout(dataRoot);
  secureDirectory(dataRoot);
  secureDirectory(shadowRoot);
  const store = options.store || new ChatMemoryStore(memoryRoot);
  store.initialize(now);
  assertSafeShadowLayout(dataRoot);
  const existingDraftsById = new Map(readJsonl(draftsFile).map(entry => {
    const id = typeof entry?.draftId === 'string' ? entry.draftId : '';
    if (!id || id.length > 200) throw new Error('stored shadow draft requires a bounded draftId');
    return [id, entry];
  }));
  const provider = normalizeDecisionProvider(options.decisionProvider);
  const ownCompanyId = options.ownCompanyId == null ? null : String(options.ownCompanyId);
  const ownCompanyName = options.ownCompanyName == null ? null : String(options.ownCompanyName);

  const actions = [];
  const errors = [];
  const observations = [];
  const candidates = [];
  let ledgerInserted = 0;
  let ledgerExcluded = 0;
  let stopReason = null;
  let decisionCalls = 0;
  let decisionFailures = 0;
  const providerUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };

  async function runReadAction(action, params = {}) {
    if (stopReason) return { ok: false, skipped: true, reason: stopReason };
    if (!READ_ONLY_ACTION_SET.has(action)) throw new Error(`shadow worker forbids action ${action}`);
    if (Object.prototype.hasOwnProperty.call(params, 'confirm')) {
      throw new Error('shadow worker read actions must not carry confirm');
    }
    if (actions.length >= limits.maxActions) {
      return { ok: false, skipped: true, reason: 'shadow-action-budget-exhausted' };
    }
    const guard = cycleGuard.check(`action:${action}`);
    if (!guard.ok) {
      stopReason = guard.reason;
      return { ok: false, skipped: true, reason: stopReason };
    }
    actions.push({ action, params: JSON.parse(JSON.stringify(params)) });
    try {
      const result = await runBoundedOperation(control => options.actionRunner(
        action,
        Object.freeze({ ...params }),
        control,
      ), guard);
      const normalized = result && typeof result === 'object'
        ? result
        : { ok: false, reason: 'actionRunner returned a non-object result' };
      if (normalized.ok !== true) {
        const failureCode = safeReadActionFailureCode(action, normalized);
        errors.push({
          action,
          reason: 'read-action-not-successful',
          ...(failureCode ? { failureCode } : {}),
        });
      }
      return normalized;
    } catch (error) {
      const reason = fixedOperationFailure(error, 'read-action');
      if (error?.code === 'SHADOW_OPERATION_TIMEOUT') stopReason = reason;
      errors.push({ action, reason });
      return { ok: false, reason };
    }
  }

  function ingest(conversationType, conversationId, boundedResult) {
    const fitted = fitResultForSnapshot({
      conversationType,
      conversationId,
      result: boundedResult,
      limits,
      observedAt: now,
      ownCompanyId,
      ownCompanyName,
    });
    const result = ingestChatResult({
      store,
      observationRoot: dataRoot,
      conversationType,
      conversationId,
      result: fitted.result,
      observedAt: now,
      ownCompanyId,
      ownCompanyName,
    });
    observations.push({ conversationType, conversationId, ...result.observation });
    ledgerInserted += Number(result.ledger?.inserted || 0);
    ledgerExcluded += Number(result.observation?.explicitlyNotInLedger || 0);
    const strictMessageIds = new Set(fitted.prepared.ledgerMessages.map(message => message.messageId));
    for (const message of fitted.prepared.ledgerMessages) {
      if (message.direction !== 'inbound') continue;
      const extraction = extractTradeLeads(message);
      for (const offer of extraction.offers) {
        candidates.push({ message, extraction, offer, identity: {
          idSource: 'EXPLICIT_SERVER_ID',
          strictLedgerEligible: true,
          contractIdentityAuthorized: false,
        } });
      }
    }
    for (const observation of fitted.prepared.observationSnapshot.observations) {
      if (observation.serverMessageId && strictMessageIds.has(observation.serverMessageId)) continue;
      const preparedObservation = prepareObservationLeadMessage({
        conversationType,
        conversationId,
        observation,
        observedAt: now,
      });
      if (!preparedObservation) continue;
      const extraction = extractTradeLeads(preparedObservation.message);
      for (const extractedOffer of extraction.offers) {
        const offer = {
          ...extractedOffer,
          source: {
            ...extractedOffer.source,
            idSource: 'UI_DERIVED_NOT_SERVER',
            serverMessageId: observation.serverMessageId || null,
            observationFingerprint: observation.observationFingerprint,
            authorIdentityStatus: preparedObservation.identity.authorIdentityStatus,
            timeStatus: preparedObservation.identity.timeStatus,
          },
          autoActionAuthorized: false,
        };
        candidates.push({
          message: preparedObservation.message,
          extraction,
          offer,
          identity: preparedObservation.identity,
        });
      }
    }
  }

  const discovered = await runReadAction('chat_rooms_discover', {});
  const rooms = normalizeRooms(discovered).slice(0, limits.maxRooms);
  for (const room of rooms) {
    if (stopReason || actions.length >= limits.maxActions) break;
    const result = await runReadAction('chat_room_read', { room });
    if (!result?.ok) continue;
    const ingestGuard = cycleGuard.check('ingest:room');
    if (!ingestGuard.ok) { stopReason = ingestGuard.reason; break; }
    ingest('room', room, boundPublicResult(result, limits));
  }

  let contacts = [];
  if (!stopReason && actions.length < limits.maxActions) {
    const contactResult = await runReadAction('chat_contact_list', {});
    contacts = normalizeContactList(contactResult).slice(0, limits.maxContacts);
  }
  for (const contact of contacts) {
    if (stopReason || actions.length >= limits.maxActions) break;
    const result = await runReadAction('chat_private_read', {
      targetCompany: contact.company,
      targetCompanyId: contact.companyId,
      previousSnapshotFingerprint: null,
      cursorTail: null,
      loadFull: limits.maxPrivatePages > 1,
      maxScrolls: Math.max(1, limits.maxPrivatePages - 1),
    });
    if (!result?.ok) continue;
    const ingestGuard = cycleGuard.check('ingest:private');
    if (!ingestGuard.ok) { stopReason = ingestGuard.reason; break; }
    ingest('private', String(contact.companyId), boundPrivateResult(result, limits, contact));
  }

  const snapshot = options.businessSnapshot || unavailableBusinessSnapshot(now);
  let ranked = [];
  if (!stopReason && candidates.length) {
    const rankGuard = cycleGuard.check('rank-leads');
    if (!rankGuard.ok) stopReason = rankGuard.reason;
  }
  if (!stopReason && candidates.length) {
    const initialRank = rankLeadOpportunities(candidates.map(candidate => candidate.offer), snapshot, { now });
    const identityByOfferId = new Map(candidates.map(candidate => [candidate.offer.offerId, candidate.identity]));
    ranked = rerankEvaluations(initialRank.map(evaluation => blockUiDerivedEvaluation(
      evaluation,
      identityByOfferId.get(evaluation.offerId),
    )));
  }
  const candidateByOfferId = new Map(candidates.map(candidate => [candidate.offer.offerId, candidate]));
  const drafts = [];
  if (mode === 'shadow' && !stopReason) {
    for (const evaluation of ranked) {
      if (stopReason || drafts.length >= limits.maxDrafts
          || decisionCalls >= limits.maxDecisionCalls) break;
      const candidate = candidateByOfferId.get(evaluation.offerId);
      if (!candidate || candidate.extraction.injectionAssessment.suspicious) continue;
      const envelope = isolateExternalMessage(candidate.message);
      let decisionSnapshot;
      try {
        decisionSnapshot = buildDecisionBusinessSnapshot({
          snapshot,
          offer: candidate.offer,
          evaluation,
          quotedText: envelope.message.quotedText,
        });
      } catch (error) {
        errors.push({ action: 'decisionProvider', reason: 'decision-input-build-failed' });
        continue;
      }
      const providerGuard = cycleGuard.check('decisionProvider');
      if (!providerGuard.ok) {
        stopReason = providerGuard.reason;
        break;
      }
      let decisionRaw;
      decisionCalls += 1;
      try {
        decisionRaw = await runBoundedOperation(control => provider.decide(
          Object.freeze({
            untrustedEnvelope: envelope,
            businessSnapshot: decisionSnapshot,
          }),
          control,
        ), providerGuard);
      } catch (error) {
        decisionFailures += 1;
        const reason = fixedOperationFailure(error, 'decision-provider');
        if (error?.code === 'SHADOW_OPERATION_TIMEOUT') stopReason = reason;
        errors.push({ action: 'decisionProvider', reason });
        continue;
      }
      addDecisionUsage(providerUsage, decisionRaw?.usage);
      if (decisionRaw?.ok === false) {
        decisionFailures += 1;
        errors.push({ action: 'decisionProvider', reason: 'decision-provider-fail-closed' });
        continue;
      }
      if (!SHADOW_ALLOWED_DECISION_ACTIONS.includes(decisionRaw?.action)) {
        decisionFailures += 1;
        errors.push({ action: 'decisionProvider', reason: 'provider returned an action outside the shadow allowlist' });
        continue;
      }
      if (decisionRaw.action !== 'draft_private') continue;
      const providerDraft = validateShadowProviderDraft(decisionRaw);
      if (!providerDraft.ok) {
        decisionFailures += 1;
        errors.push({ action: 'decisionProvider', reason: providerDraft.reason });
        continue;
      }
      const windowsDecision = windowsExportDecision({
        recordType: 'draft',
        conversationType: 'private',
      });
      const source = candidate.offer.source;
      const draftId = stableDraftId(source.messageId, source.counterpartyCompanyId, providerDraft.text);
      const candidateDraft = {
        schemaVersion: 1,
        recordType: 'shadow-chat-draft',
        draftId,
        createdAt: nowIso,
        provider: provider.name,
        providerNetworkAccessDeclared: provider.networkAccess,
        sourceMessageId: source.messageId,
        sourceConversationType: source.conversationType,
        sourceConversationId: source.conversationId,
        targetCompanyId: candidate.identity.authorIdentityStatus === 'UI_COMPANY_NAME_ONLY_LOCAL_REFERENCE'
          ? null
          : source.counterpartyCompanyId,
        targetCompanyReference: source.counterpartyCompanyId,
        targetCompanyName: source.counterpartyCompanyName,
        idSource: candidate.identity.idSource,
        authorIdentityStatus: candidate.identity.authorIdentityStatus || 'EXPLICIT_SERVER_COMPANY_ID',
        sourceIdentity: candidate.identity,
        scope: 'private',
        intent: 'provider-draft-private',
        providerDecisionAction: decisionRaw.action,
        text: providerDraft.text,
        trust: 'derived-from-untrusted-external-data',
        instructionAuthority: 'none',
        sendAuthorized: false,
        contractMutationAuthorized: false,
        confirm: false,
        windowsExport: windowsDecision,
      };
      try {
        drafts.push(reuseImmutableDraft(existingDraftsById.get(draftId), candidateDraft));
      } catch {
        errors.push({ action: 'decisionProvider', reason: 'stable-draft-conflict' });
      }
    }
  }

  const stoppedResult = () => ({
    ok: false,
    skipped: false,
    stoppedEarly: true,
    reason: stopReason,
    mode,
    dataRoot,
    actions,
    observations,
    ledgerInserted,
    ledgerExcluded,
    ranked,
    drafts: [],
    retention: null,
    auditFile,
    draftsFile,
    windowsWrites: 0,
    decisionCalls,
    decisionFailures,
    providerUsage,
    providerMetrics: { calls: decisionCalls, failures: decisionFailures, usage: providerUsage },
    errors,
  });
  if (stopReason) return stoppedResult();
  const finalGuard = cycleGuard.check('cycle-finalize');
  if (!finalGuard.ok) {
    stopReason = finalGuard.reason;
    return stoppedResult();
  }
  const draftRetention = appendCappedJsonl(draftsFile, drafts, {
    idField: 'draftId',
    timeField: 'createdAt',
    maxEntries: limits.maxDraftEntries,
    maxBytes: limits.maxDraftBytes,
  });
  const snapshotRetention = pruneObservationSnapshots(dataRoot, limits);
  const auditEntry = {
    schemaVersion: 1,
    recordType: 'shadow-chat-cycle',
    eventId: crypto.randomUUID(),
    at: nowIso,
    mode,
    source: 'rendered-browser-ui',
    mutationAuthorized: false,
    confirmTrueCalls: 0,
    contractActions: 0,
    messageSendActions: 0,
    actions: actions.map(entry => entry.action),
    limits,
    roomsDiscovered: normalizeRooms(discovered).length,
    roomsRead: observations.filter(entry => entry.conversationType === 'room').length,
    contactsDiscovered: contacts.length,
    privateThreadsRead: observations.filter(entry => entry.conversationType === 'private').length,
    observationsPersisted: observations.length,
    ledgerInserted,
    observationsExplicitlyExcludedFromStrictLedger: ledgerExcluded,
    offersExtracted: candidates.length,
    strictLedgerOffersExtracted: candidates.filter(candidate =>
      candidate.identity.idSource === 'EXPLICIT_SERVER_ID').length,
    uiObservationOffersExtracted: candidates.filter(candidate =>
      candidate.identity.idSource === 'UI_DERIVED_NOT_SERVER').length,
    offersRanked: ranked.length,
    draftsCreated: drafts.length,
    privateWindowsExports: 0,
    decisionCalls,
    decisionFailures,
    providerUsage,
    provider: {
      name: provider.name,
      networkAccessDeclared: provider.networkAccess,
      networkAccessDeclarationIsSecurityProof: false,
      calls: decisionCalls,
      failures: decisionFailures,
      usage: providerUsage,
    },
    stoppedEarly: stopReason != null,
    stopReason,
    cycleDeadlineAtMs: cycleGuard.deadlineAtMs,
    wakeSafetyMarginMs: cycleGuard.wakeSafetyMarginMs,
    snapshotRetention,
    errors: errors.slice(0, 20),
  };
  const auditRetention = appendCappedJsonl(auditFile, [auditEntry], {
    idField: 'eventId',
    timeField: 'at',
    maxEntries: limits.maxAuditEntries,
    maxBytes: limits.maxAuditBytes,
  });
  return {
    ok: errors.length === 0 && stopReason == null,
    skipped: false,
    stoppedEarly: stopReason != null,
    reason: stopReason,
    mode,
    dataRoot,
    actions,
    observations,
    ledgerInserted,
    ledgerExcluded,
    ranked,
    drafts,
    retention: { audit: auditRetention, drafts: draftRetention, snapshots: snapshotRetention },
    auditFile,
    draftsFile,
    windowsWrites: 0,
    decisionCalls,
    decisionFailures,
    providerUsage,
    providerMetrics: {
      calls: decisionCalls,
      failures: decisionFailures,
      usage: providerUsage,
    },
    errors,
  };
}

module.exports = {
  DEFAULT_CYCLE_DEADLINE_MS,
  DEFAULT_LIMITS,
  DEFAULT_MINIMUM_WAKE_LEAD_MS,
  DEFAULT_NAS_DATA_ROOT_ALLOWLIST,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_WAKE_SAFETY_MARGIN_MS,
  READ_ONLY_ACTIONS,
  SHADOW_ALLOWED_DECISION_ACTIONS,
  appendCappedJsonl,
  boundPrivateResult,
  boundPublicResult,
  buildDecisionBusinessSnapshot,
  buildMinimalBusinessSnapshotDto,
  createCycleGuard,
  deterministicDecisionProvider,
  evaluateRunPermission,
  fitResultForSnapshot,
  looksLikeWindowsPath,
  nextWakeTimestamp,
  normalizeLimits,
  normalizeShadowMode,
  pruneObservationSnapshots,
  resolveNasDataRoot,
  reuseImmutableDraft,
  runShadowCycle,
  safeReadActionFailureCode,
  sanitizeDecisionOffer,
  unavailableBusinessSnapshot,
  validateShadowProviderDraft,
};
