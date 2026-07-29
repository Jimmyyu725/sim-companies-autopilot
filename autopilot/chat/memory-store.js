'use strict';

const fs = require('fs');
const path = require('path');
const {
  atomicWriteJson,
  atomicWriteJsonl,
  readJson,
  readJsonl,
  withFileLock,
} = require('./persistence.js');
const {
  SCHEMA_VERSION,
  normalizeAuditEvent,
  normalizeCommitment,
  normalizeContact,
  normalizeContacts,
  normalizeConversationType,
  normalizeCurrent,
  normalizeMessage,
  normalizeOutboxEntry,
  normalizeSummary,
} = require('./schemas.js');
const { inspectOutgoingText, PUBLIC_REASONS } = require('./policy.js');

const OUTBOX_TRANSITIONS = Object.freeze({
  draft: new Set(['pending', 'cancelled']),
  pending: new Set(['sending', 'cancelled']),
  sending: new Set(['sent', 'failed', 'ambiguous']),
  failed: new Set(['pending', 'cancelled']),
  ambiguous: new Set(['sent', 'cancelled']),
  sent: new Set(),
  cancelled: new Set(),
});

const COMMITMENT_TRANSITIONS = Object.freeze({
  proposed: new Set(['active', 'expired', 'cancelled']),
  active: new Set(['fulfilled', 'expired', 'cancelled', 'breached']),
  fulfilled: new Set(),
  expired: new Set(),
  cancelled: new Set(),
  breached: new Set(),
});

function isoNow(now = new Date()) {
  const parsed = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('now must be a valid date');
  return parsed.toISOString();
}

function encodeConversationId(conversationId) {
  return Buffer.from(String(conversationId), 'utf8').toString('base64url');
}

function conversationFileStem(conversationType, conversationId) {
  const type = normalizeConversationType(conversationType);
  const id = String(conversationId);
  if (!id.trim() || id.length > 160) throw new TypeError('conversationId must contain 1..160 characters');
  return `${type}-${encodeConversationId(id.trim())}`;
}

function compareMessages(left, right) {
  const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return time || left.messageId.localeCompare(right.messageId);
}

function immutableMessageJson(message) {
  const copy = { ...message };
  delete copy.observedAt;
  return JSON.stringify(copy);
}

function mergeById(existing, incoming, idField, normalize, { compare = null, immutable = JSON.stringify } = {}) {
  const byId = new Map();
  for (const raw of existing) {
    const entry = normalize(raw);
    if (byId.has(entry[idField])) throw new Error(`stored ${idField} is duplicated: ${entry[idField]}`);
    byId.set(entry[idField], entry);
  }
  let inserted = 0;
  let duplicates = 0;
  for (const raw of incoming) {
    const entry = normalize(raw);
    const prior = byId.get(entry[idField]);
    if (prior) {
      if (immutable(prior) !== immutable(entry)) {
        throw new Error(`${idField} ${entry[idField]} was reused with different immutable data`);
      }
      duplicates += 1;
      continue;
    }
    byId.set(entry[idField], entry);
    inserted += 1;
  }
  const values = [...byId.values()];
  if (compare) values.sort(compare);
  return { values, inserted, duplicates };
}

class ChatMemoryStore {
  constructor(root) {
    if (typeof root !== 'string' || !root.trim()) throw new TypeError('chat memory root is required');
    this.root = path.resolve(root);
    this.paths = Object.freeze({
      contacts: path.join(this.root, 'contacts.json'),
      current: path.join(this.root, 'CURRENT.json'),
      threads: path.join(this.root, 'threads'),
      summaries: path.join(this.root, 'summaries'),
      outbox: path.join(this.root, 'outbox.jsonl'),
      commitments: path.join(this.root, 'commitments.jsonl'),
      audit: path.join(this.root, 'audit.jsonl'),
    });
  }

  layout() {
    return { ...this.paths };
  }

  initialize(now = new Date()) {
    const at = isoNow(now);
    fs.mkdirSync(this.paths.threads, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.summaries, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.paths.contacts)) {
      atomicWriteJson(this.paths.contacts, { schemaVersion: SCHEMA_VERSION, updatedAt: at, contacts: [] });
    }
    if (!fs.existsSync(this.paths.current)) {
      atomicWriteJson(this.paths.current, {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: at,
        lastSuccessfulSyncAt: null,
        lastError: null,
        cursors: {},
        pendingReplies: [],
      });
    }
    for (const file of [this.paths.outbox, this.paths.commitments, this.paths.audit]) {
      if (!fs.existsSync(file)) atomicWriteJsonl(file, []);
    }
    return this.layout();
  }

  threadFile(conversationType, conversationId) {
    return path.join(this.paths.threads, `${conversationFileStem(conversationType, conversationId)}.jsonl`);
  }

  summaryFile(conversationType, conversationId) {
    return path.join(this.paths.summaries, `${conversationFileStem(conversationType, conversationId)}.json`);
  }

  readContacts() {
    const raw = readJson(this.paths.contacts, () => ({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date(0).toISOString(),
      contacts: [],
    }));
    return normalizeContacts(raw);
  }

  writeContacts(registry) {
    const normalized = normalizeContacts(registry);
    atomicWriteJson(this.paths.contacts, normalized);
    return normalized;
  }

  upsertContact(contact, now = new Date()) {
    return withFileLock(this.paths.contacts, () => {
      const registry = this.readContacts();
      const at = isoNow(now);
      const index = registry.contacts.findIndex(entry => entry.companyId === contact.companyId);
      const candidate = index >= 0
        ? { ...registry.contacts[index], ...contact, companyId: registry.contacts[index].companyId, updatedAt: at }
        : { ...contact, updatedAt: at };
      const normalized = normalizeContact(candidate);
      if (index >= 0) registry.contacts[index] = normalized;
      else registry.contacts.push(normalized);
      registry.updatedAt = at;
      return this.writeContacts(registry);
    });
  }

  readCurrent() {
    const raw = readJson(this.paths.current, () => ({
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date(0).toISOString(),
      lastSuccessfulSyncAt: null,
      lastError: null,
      cursors: {},
      pendingReplies: [],
    }));
    return normalizeCurrent(raw);
  }

  writeCurrent(current) {
    const normalized = normalizeCurrent(current);
    atomicWriteJson(this.paths.current, normalized);
    return normalized;
  }

  readThread(conversationType, conversationId) {
    const type = normalizeConversationType(conversationType);
    const id = String(conversationId).trim();
    const messages = readJsonl(this.threadFile(type, id)).map(normalizeMessage);
    for (const message of messages) {
      if (message.conversationType !== type || message.conversationId !== id) {
        throw new Error(`thread contains a message for a different conversation: ${message.messageId}`);
      }
    }
    const ids = new Set();
    for (const message of messages) {
      if (ids.has(message.messageId)) throw new Error(`thread contains duplicate messageId ${message.messageId}`);
      ids.add(message.messageId);
    }
    return messages.sort(compareMessages);
  }

  mergeThreadMessages(conversationType, conversationId, incoming) {
    if (!Array.isArray(incoming)) throw new TypeError('incoming messages must be an array');
    const type = normalizeConversationType(conversationType);
    const id = String(conversationId).trim();
    const normalizedIncoming = incoming.map(normalizeMessage);
    for (const message of normalizedIncoming) {
      if (message.conversationType !== type || message.conversationId !== id) {
        throw new Error(`message ${message.messageId} does not belong to ${type}:${id}`);
      }
    }
    const file = this.threadFile(type, id);
    return withFileLock(file, () => {
      const merged = mergeById(
        this.readThread(type, id),
        normalizedIncoming,
        'messageId',
        normalizeMessage,
        { compare: compareMessages, immutable: immutableMessageJson },
      );
      if (merged.inserted > 0) atomicWriteJsonl(file, merged.values);
      return {
        inserted: merged.inserted,
        duplicates: merged.duplicates,
        total: merged.values.length,
        first: merged.values[0] ?? null,
        last: merged.values.at(-1) ?? null,
      };
    });
  }

  readSummary(conversationType, conversationId) {
    const type = normalizeConversationType(conversationType);
    const id = String(conversationId).trim();
    let raw;
    try {
      raw = readJson(this.summaryFile(type, id));
    } catch (error) {
      if (error.cause?.code === 'ENOENT') return null;
      throw error;
    }
    const summary = normalizeSummary(raw);
    if (summary.conversationType !== type || summary.conversationId !== id) {
      throw new Error('summary belongs to a different conversation');
    }
    return summary;
  }

  writeSummary(summary) {
    const normalized = normalizeSummary(summary);
    const messages = this.readThread(normalized.conversationType, normalized.conversationId);
    const through = messages.find(message => message.messageId === normalized.throughMessageId);
    if (!through || through.createdAt !== normalized.throughCreatedAt) {
      throw new Error('summary boundary must match a stored message exactly');
    }
    atomicWriteJson(
      this.summaryFile(normalized.conversationType, normalized.conversationId),
      normalized,
    );
    return normalized;
  }

  getConversationContext(conversationType, conversationId, { limit = 30 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError('context limit must be an integer from 1 to 200');
    }
    const messages = this.readThread(conversationType, conversationId);
    const summary = this.readSummary(conversationType, conversationId);
    let unsummarized = messages;
    if (summary) {
      const boundary = messages.findIndex(message => message.messageId === summary.throughMessageId);
      if (boundary < 0 || messages[boundary].createdAt !== summary.throughCreatedAt) {
        throw new Error('stored summary boundary no longer matches the thread');
      }
      unsummarized = messages.slice(boundary + 1);
    }
    return {
      conversationType: normalizeConversationType(conversationType),
      conversationId: String(conversationId).trim(),
      trust: 'contains-untrusted-external-data',
      summary,
      recentMessages: unsummarized.slice(-limit),
      omittedUnsummarizedMessages: Math.max(0, unsummarized.length - limit),
    };
  }

  readOutbox() {
    return readJsonl(this.paths.outbox).map(normalizeOutboxEntry);
  }

  enqueueOutbox(entry) {
    const candidate = normalizeOutboxEntry(entry);
    const policy = inspectOutgoingText(candidate.text, { scope: candidate.conversationType });
    if (!policy.ok) throw new Error(`outbox text violates chat policy: ${policy.violations.join(',')}`);
    if (candidate.conversationType === 'room' && !PUBLIC_REASONS.has(candidate.publicReason)) {
      throw new Error('outbox publicReason is not an approved concrete reason');
    }
    return withFileLock(this.paths.outbox, () => {
      const merged = mergeById(
        this.readOutbox(),
        [candidate],
        'outboxId',
        normalizeOutboxEntry,
        { compare: (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) },
      );
      if (merged.inserted > 0) atomicWriteJsonl(this.paths.outbox, merged.values);
      return { inserted: merged.inserted === 1, entry: merged.values.find(value => value.outboxId === candidate.outboxId) };
    });
  }

  transitionOutbox(outboxId, status, patch = {}, now = new Date()) {
    return withFileLock(this.paths.outbox, () => {
      const entries = this.readOutbox();
      const index = entries.findIndex(entry => entry.outboxId === outboxId);
      if (index < 0) throw new Error(`unknown outboxId ${outboxId}`);
      const current = entries[index];
      if (!OUTBOX_TRANSITIONS[current.status]?.has(status)) {
        throw new Error(`invalid outbox transition ${current.status} -> ${status}`);
      }
      const allowedPatch = new Set(['lastAttemptAt', 'remoteMessageId', 'error']);
      for (const key of Object.keys(patch)) {
        if (!allowedPatch.has(key)) throw new Error(`outbox transition cannot change ${key}`);
      }
      const updated = normalizeOutboxEntry({
        ...current,
        ...patch,
        status,
        updatedAt: isoNow(now),
      });
      entries[index] = updated;
      atomicWriteJsonl(this.paths.outbox, entries);
      return updated;
    });
  }

  readCommitments() {
    return readJsonl(this.paths.commitments).map(normalizeCommitment);
  }

  appendCommitment(entry) {
    return withFileLock(this.paths.commitments, () => {
      const merged = mergeById(
        this.readCommitments(),
        [entry],
        'commitmentId',
        normalizeCommitment,
        { compare: (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) },
      );
      if (merged.inserted > 0) atomicWriteJsonl(this.paths.commitments, merged.values);
      return { inserted: merged.inserted === 1, entry: merged.values.find(value => value.commitmentId === entry.commitmentId) };
    });
  }

  transitionCommitment(commitmentId, status, now = new Date()) {
    return withFileLock(this.paths.commitments, () => {
      const entries = this.readCommitments();
      const index = entries.findIndex(entry => entry.commitmentId === commitmentId);
      if (index < 0) throw new Error(`unknown commitmentId ${commitmentId}`);
      const current = entries[index];
      if (!COMMITMENT_TRANSITIONS[current.status]?.has(status)) {
        throw new Error(`invalid commitment transition ${current.status} -> ${status}`);
      }
      const updated = normalizeCommitment({ ...current, status, updatedAt: isoNow(now) });
      entries[index] = updated;
      atomicWriteJsonl(this.paths.commitments, entries);
      return updated;
    });
  }

  readAudit() {
    return readJsonl(this.paths.audit).map(normalizeAuditEvent);
  }

  appendAudit(entry) {
    return withFileLock(this.paths.audit, () => {
      const merged = mergeById(
        this.readAudit(),
        [entry],
        'eventId',
        normalizeAuditEvent,
        { compare: (left, right) => Date.parse(left.at) - Date.parse(right.at) },
      );
      if (merged.inserted > 0) atomicWriteJsonl(this.paths.audit, merged.values);
      return { inserted: merged.inserted === 1, entry: merged.values.find(value => value.eventId === entry.eventId) };
    });
  }
}

module.exports = {
  ChatMemoryStore,
  COMMITMENT_TRANSITIONS,
  OUTBOX_TRANSITIONS,
  compareMessages,
  conversationFileStem,
  mergeById,
};
