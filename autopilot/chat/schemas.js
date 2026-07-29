'use strict';

const SCHEMA_VERSION = 1;
const CONVERSATION_TYPES = new Set(['private', 'room']);
const DIRECTIONS = new Set(['inbound', 'outbound']);

function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function boundedString(value, field, { min = 1, max = 4000, trim = true } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length < min || normalized.length > max) {
    throw new RangeError(`${field} must contain ${min}..${max} characters`);
  }
  return normalized;
}

function optionalString(value, field, max = 500) {
  if (value == null) return null;
  return boundedString(value, field, { max });
}

function identifier(value, field) {
  return boundedString(value, field, { max: 160 });
}

function timestamp(value, field) {
  const normalized = boundedString(value, field, { max: 64 });
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value, field) {
  return value == null ? null : timestamp(value, field);
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function stringArray(value, field, { maxItems = 20, itemMax = 1000 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${field} must be an array with at most ${maxItems} entries`);
  }
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, { max: itemMax }));
}

function cloneBoundedJsonObject(value, field, maxSerializedLength = 20000) {
  plainObject(value, field);
  function validate(entry, entryField, depth) {
    if (depth > 8) throw new RangeError(`${field} exceeds maximum nesting depth`);
    if (entry == null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new TypeError(`${entryField} must be a finite number`);
      return;
    }
    if (typeof entry === 'string') {
      if (entry.length > 6000) throw new RangeError(`${entryField} is too long`);
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length > 100) throw new RangeError(`${entryField} has too many entries`);
      entry.forEach((child, index) => validate(child, `${entryField}[${index}]`, depth + 1));
      return;
    }
    plainObject(entry, entryField);
    const keys = Object.keys(entry);
    if (keys.length > 100) throw new RangeError(`${entryField} has too many keys`);
    for (const key of keys) {
      if (!key || key.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new TypeError(`${entryField} contains an unsafe key`);
      }
      validate(entry[key], `${entryField}.${key}`, depth + 1);
    }
  }
  validate(value, field, 0);
  const serialized = JSON.stringify(value);
  if (serialized.length > maxSerializedLength) throw new RangeError(`${field} is too large`);
  return JSON.parse(serialized);
}

function normalizeConversationType(value) {
  if (!CONVERSATION_TYPES.has(value)) throw new TypeError('conversationType must be private or room');
  return value;
}

function normalizeDirection(value) {
  if (!DIRECTIONS.has(value)) throw new TypeError('direction must be inbound or outbound');
  return value;
}

function normalizeAuthor(value, direction) {
  const author = plainObject(value, 'author');
  const companyId = optionalString(author.companyId, 'author.companyId', 160);
  const companyName = boundedString(author.companyName, 'author.companyName', { max: 200 });
  if (direction === 'inbound' && companyId == null) {
    throw new TypeError('inbound author.companyId is required');
  }
  return { companyId, companyName };
}

function normalizeResourceMentions(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw new TypeError('resourceMentions must contain at most 30 entries');
  }
  return value.map((entry, index) => {
    plainObject(entry, `resourceMentions[${index}]`);
    const kind = Number(entry.kind);
    if (!Number.isSafeInteger(kind) || kind <= 0) {
      throw new TypeError(`resourceMentions[${index}].kind must be a positive integer`);
    }
    return {
      kind,
      name: optionalString(entry.name, `resourceMentions[${index}].name`, 120),
    };
  });
}

function normalizeMessage(value) {
  const message = plainObject(value, 'message');
  const direction = normalizeDirection(message.direction);
  const conversationType = normalizeConversationType(message.conversationType);
  const content = plainObject(message.content, 'content');
  const text = boundedString(content.text, 'content.text', { max: 12000, trim: false });
  if (!text.trim()) throw new RangeError('content.text must not be blank');
  return {
    schemaVersion: SCHEMA_VERSION,
    messageId: identifier(message.messageId, 'messageId'),
    conversationType,
    conversationId: identifier(message.conversationId, 'conversationId'),
    direction,
    author: normalizeAuthor(message.author, direction),
    createdAt: timestamp(message.createdAt, 'createdAt'),
    observedAt: timestamp(message.observedAt, 'observedAt'),
    replyToMessageId: optionalString(message.replyToMessageId, 'replyToMessageId', 160),
    content: {
      text,
      language: optionalString(content.language, 'content.language', 40),
      resourceMentions: normalizeResourceMentions(content.resourceMentions),
    },
    trust: direction === 'inbound' ? 'untrusted-external' : 'internal-output',
  };
}

function normalizeContact(value) {
  const contact = plainObject(value, 'contact');
  const allowedRelations = new Set(['unknown', 'lead', 'customer', 'supplier', 'both', 'blocked']);
  const relation = contact.relation ?? 'unknown';
  if (!allowedRelations.has(relation)) throw new TypeError('contact.relation is invalid');
  return {
    companyId: identifier(contact.companyId, 'contact.companyId'),
    companyName: boundedString(contact.companyName, 'contact.companyName', { max: 200 }),
    relation,
    pinned: contact.pinned == null ? false : boolean(contact.pinned, 'contact.pinned'),
    hidden: contact.hidden == null ? false : boolean(contact.hidden, 'contact.hidden'),
    doNotContact: contact.doNotContact == null
      ? false
      : boolean(contact.doNotContact, 'contact.doNotContact'),
    notes: optionalString(contact.notes, 'contact.notes', 2000),
    lastMessageAt: optionalTimestamp(contact.lastMessageAt, 'contact.lastMessageAt'),
    lastContactedAt: optionalTimestamp(contact.lastContactedAt, 'contact.lastContactedAt'),
    updatedAt: timestamp(contact.updatedAt, 'contact.updatedAt'),
  };
}

function normalizeContacts(value) {
  const registry = plainObject(value, 'contacts registry');
  if (!Array.isArray(registry.contacts)) throw new TypeError('contacts must be an array');
  const contacts = registry.contacts.map(normalizeContact);
  const ids = new Set();
  for (const contact of contacts) {
    if (ids.has(contact.companyId)) throw new Error(`duplicate contact ${contact.companyId}`);
    ids.add(contact.companyId);
  }
  contacts.sort((left, right) => left.companyId.localeCompare(right.companyId));
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: timestamp(registry.updatedAt, 'contacts.updatedAt'),
    contacts,
  };
}

function normalizeCursor(value, field) {
  const cursor = plainObject(value, field);
  return {
    lastMessageId: optionalString(cursor.lastMessageId, `${field}.lastMessageId`, 160),
    lastCreatedAt: optionalTimestamp(cursor.lastCreatedAt, `${field}.lastCreatedAt`),
  };
}

function normalizeCurrent(value) {
  const current = plainObject(value, 'current');
  const cursorsInput = current.cursors == null ? {} : plainObject(current.cursors, 'current.cursors');
  const cursors = {};
  for (const [key, cursor] of Object.entries(cursorsInput)) {
    const normalizedKey = identifier(key, 'cursor key');
    if (['__proto__', 'prototype', 'constructor'].includes(normalizedKey)) {
      throw new TypeError('cursor key is unsafe');
    }
    cursors[normalizedKey] = normalizeCursor(cursor, `cursors.${normalizedKey}`);
  }
  const pending = current.pendingReplies == null ? [] : current.pendingReplies;
  if (!Array.isArray(pending) || pending.length > 1000) {
    throw new TypeError('pendingReplies must be an array with at most 1000 entries');
  }
  const pendingReplies = pending.map((entry, index) => {
    plainObject(entry, `pendingReplies[${index}]`);
    return {
      conversationType: normalizeConversationType(entry.conversationType),
      conversationId: identifier(entry.conversationId, `pendingReplies[${index}].conversationId`),
      messageId: identifier(entry.messageId, `pendingReplies[${index}].messageId`),
      reason: boundedString(entry.reason, `pendingReplies[${index}].reason`, { max: 500 }),
      queuedAt: timestamp(entry.queuedAt, `pendingReplies[${index}].queuedAt`),
    };
  });
  const pendingKeys = new Set();
  for (const entry of pendingReplies) {
    const key = `${entry.conversationType}\0${entry.conversationId}\0${entry.messageId}`;
    if (pendingKeys.has(key)) throw new Error(`duplicate pending reply for ${entry.messageId}`);
    pendingKeys.add(key);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: timestamp(current.updatedAt, 'current.updatedAt'),
    lastSuccessfulSyncAt: optionalTimestamp(current.lastSuccessfulSyncAt, 'current.lastSuccessfulSyncAt'),
    lastError: optionalString(current.lastError, 'current.lastError', 1000),
    cursors,
    pendingReplies,
  };
}

function normalizeOutboxEntry(value) {
  const entry = plainObject(value, 'outbox entry');
  const statuses = new Set(['draft', 'pending', 'sending', 'sent', 'failed', 'ambiguous', 'cancelled']);
  if (!statuses.has(entry.status)) throw new TypeError('outbox status is invalid');
  const scope = normalizeConversationType(entry.conversationType);
  return {
    schemaVersion: SCHEMA_VERSION,
    outboxId: identifier(entry.outboxId, 'outboxId'),
    conversationType: scope,
    conversationId: identifier(entry.conversationId, 'outbox.conversationId'),
    text: boundedString(entry.text, 'outbox.text', { max: 4000, trim: false }),
    status: entry.status,
    createdAt: timestamp(entry.createdAt, 'outbox.createdAt'),
    updatedAt: timestamp(entry.updatedAt, 'outbox.updatedAt'),
    sendAfter: optionalTimestamp(entry.sendAfter, 'outbox.sendAfter'),
    lastAttemptAt: optionalTimestamp(entry.lastAttemptAt, 'outbox.lastAttemptAt'),
    remoteMessageId: optionalString(entry.remoteMessageId, 'outbox.remoteMessageId', 160),
    error: optionalString(entry.error, 'outbox.error', 1000),
    publicReason: scope === 'room'
      ? boundedString(entry.publicReason, 'outbox.publicReason', { max: 80 })
      : null,
  };
}

function normalizeCommitment(value) {
  const entry = plainObject(value, 'commitment');
  const kinds = new Set(['quote', 'delivery', 'contract', 'relationship', 'other']);
  const statuses = new Set(['proposed', 'active', 'fulfilled', 'expired', 'cancelled', 'breached']);
  if (!kinds.has(entry.kind)) throw new TypeError('commitment kind is invalid');
  if (!statuses.has(entry.status)) throw new TypeError('commitment status is invalid');
  return {
    schemaVersion: SCHEMA_VERSION,
    commitmentId: identifier(entry.commitmentId, 'commitmentId'),
    conversationId: identifier(entry.conversationId, 'commitment.conversationId'),
    counterpartyCompanyId: identifier(entry.counterpartyCompanyId, 'commitment.counterpartyCompanyId'),
    kind: entry.kind,
    status: entry.status,
    summary: boundedString(entry.summary, 'commitment.summary', { max: 1200 }),
    terms: entry.terms == null ? {} : cloneBoundedJsonObject(entry.terms, 'commitment.terms'),
    createdAt: timestamp(entry.createdAt, 'commitment.createdAt'),
    updatedAt: timestamp(entry.updatedAt, 'commitment.updatedAt'),
    expiresAt: optionalTimestamp(entry.expiresAt, 'commitment.expiresAt'),
    sourceMessageIds: stringArray(entry.sourceMessageIds ?? [], 'commitment.sourceMessageIds', {
      maxItems: 50,
      itemMax: 160,
    }),
  };
}

function normalizeAuditEvent(value) {
  const entry = plainObject(value, 'audit event');
  const actors = new Set(['chat-sync', 'communication-brain', 'ceo', 'system']);
  if (!actors.has(entry.actor)) throw new TypeError('audit actor is invalid');
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: identifier(entry.eventId, 'audit.eventId'),
    at: timestamp(entry.at, 'audit.at'),
    actor: entry.actor,
    eventType: boundedString(entry.eventType, 'audit.eventType', { max: 120 }),
    outcome: boundedString(entry.outcome, 'audit.outcome', { max: 120 }),
    conversationId: optionalString(entry.conversationId, 'audit.conversationId', 160),
    details: entry.details == null ? {} : cloneBoundedJsonObject(entry.details, 'audit.details'),
  };
}

function normalizeSummary(value) {
  const entry = plainObject(value, 'conversation summary');
  return {
    schemaVersion: SCHEMA_VERSION,
    conversationType: normalizeConversationType(entry.conversationType),
    conversationId: identifier(entry.conversationId, 'summary.conversationId'),
    updatedAt: timestamp(entry.updatedAt, 'summary.updatedAt'),
    throughMessageId: identifier(entry.throughMessageId, 'summary.throughMessageId'),
    throughCreatedAt: timestamp(entry.throughCreatedAt, 'summary.throughCreatedAt'),
    summary: boundedString(entry.summary, 'summary.summary', { max: 6000 }),
    facts: stringArray(entry.facts ?? [], 'summary.facts', { maxItems: 50, itemMax: 1000 }),
    openItems: stringArray(entry.openItems ?? [], 'summary.openItems', { maxItems: 50, itemMax: 1000 }),
    trust: 'derived-untrusted-context',
  };
}

module.exports = {
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
};
