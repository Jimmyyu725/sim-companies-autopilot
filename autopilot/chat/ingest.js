'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./persistence.js');
const { conversationFileStem } = require('./memory-store.js');
const { normalizeMessage } = require('./schemas.js');

function isoTimestamp(value, fallback = null) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  if (fallback == null) return null;
  const fallbackParsed = fallback instanceof Date ? fallback.getTime() : Date.parse(fallback);
  return Number.isFinite(fallbackParsed) ? new Date(fallbackParsed).toISOString() : null;
}

function explicitServerId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= 160 ? id : null;
}

function observationDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const ID_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_ID',
  'EXPLICIT_DOM_ATTRIBUTE',
]);
const TIME_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_DATETIME',
  'EXPLICIT_DOM_DATETIME',
]);
const AUTHOR_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER',
  'EXPLICIT_DOM_ID_AND_VISIBLE_HEADER',
]);
const DIRECTION_PROVENANCE = new Set([
  'VERIFIED_RENDERED_COMPONENT_AND_STYLE',
  'VERIFIED_RENDERED_STYLE',
]);
function provenance(value, allowlist) {
  return allowlist.has(value) ? value : 'UNKNOWN';
}

function normalizeObservationMessage(raw, index) {
  const serverMessageId = explicitServerId(raw?.serverMessageId ?? raw?.messageId);
  const resourceKinds = [...new Set((raw?.resourceKinds || [])
    .map(Number)
    .filter(kind => Number.isSafeInteger(kind) && kind > 0))];
  const suppliedFingerprint = typeof raw?.observationFingerprint === 'string'
    && /^ui-observation-[a-z0-9-]{8,160}$/u.test(raw.observationFingerprint)
    ? raw.observationFingerprint
    : null;
  return {
    serverMessageId,
    idStatus: provenance(raw?.idStatus, ID_PROVENANCE),
    observationFingerprint: suppliedFingerprint
      ? suppliedFingerprint
      : `ui-observation-sha256-${observationDigest({ index, raw }).slice(0, 24)}`,
    authorCompany: typeof raw?.authorCompany === 'string' ? raw.authorCompany.trim() || null : null,
    authorCompanyId: explicitServerId(raw?.authorCompanyId ?? raw?.companyId),
    authorStatus: provenance(raw?.authorStatus, AUTHOR_PROVENANCE),
    direction: ['INCOMING', 'OUTGOING'].includes(raw?.direction) ? raw.direction : 'UNKNOWN',
    directionStatus: provenance(raw?.directionStatus, DIRECTION_PROVENANCE),
    visibleBody: String(raw?.visibleBody ?? raw?.text ?? '').normalize('NFKC').trim(),
    resourceKinds,
    exactCreatedAt: isoTimestamp(raw?.exactCreatedAt ?? raw?.exactTime),
    timeStatus: provenance(raw?.timeStatus, TIME_PROVENANCE),
    renderedTime: typeof raw?.renderedTime === 'string' ? raw.renderedTime.trim() || null : null,
    trust: raw?.direction === 'OUTGOING'
      ? 'LOCAL_COMPANY_MESSAGE'
      : 'EXTERNAL_OR_UNATTRIBUTED_UNTRUSTED_DATA',
    instructionAuthority: raw?.direction === 'OUTGOING' ? 'local-output' : 'none',
  };
}

function flattenUiMessages(conversationType, result) {
  if (conversationType === 'private') {
    return Array.isArray(result?.thread?.messages) ? result.thread.messages : [];
  }
  const flattened = [];
  for (const group of Array.isArray(result?.groups) ? result.groups : []) {
    for (const message of Array.isArray(group?.messages) ? group.messages : []) {
      flattened.push({
        ...message,
        serverMessageId: message?.messageId,
        authorCompany: group?.company,
        authorCompanyId: group?.companyId,
        authorStatus: group?.authorStatus,
        direction: group?.fromMe === true ? 'OUTGOING' : 'INCOMING',
        directionStatus: group?.directionStatus,
        exactCreatedAt: message?.exactTime ?? group?.exactTime,
        timeStatus: message?.timeStatus ?? group?.timeStatus,
        renderedTime: group?.timeLabel,
        visibleBody: message?.text ?? message?.visibleText,
      });
    }
  }
  return flattened;
}

function strictLedgerMessage(raw, {
  conversationType,
  conversationId,
  observedAt,
  ownCompanyId = null,
  ownCompanyName = null,
} = {}) {
  const messageId = explicitServerId(raw.serverMessageId);
  const createdAt = isoTimestamp(raw.exactCreatedAt);
  const incoming = raw.direction === 'INCOMING';
  const outgoing = raw.direction === 'OUTGOING';
  const companyId = incoming
    ? explicitServerId(raw.authorCompanyId)
    : explicitServerId(ownCompanyId);
  const companyName = incoming
    ? raw.authorCompany
    : (typeof ownCompanyName === 'string' ? ownCompanyName.trim() || null : null);
  const identityProven = ID_PROVENANCE.has(raw.idStatus);
  const timeProven = TIME_PROVENANCE.has(raw.timeStatus);
  const directionProven = DIRECTION_PROVENANCE.has(raw.directionStatus);
  const authorProven = !incoming || AUTHOR_PROVENANCE.has(raw.authorStatus);
  if (!messageId || !identityProven || !createdAt || !timeProven || !directionProven
      || !authorProven || (!incoming && !outgoing) || !companyName || (incoming && !companyId)) {
    return null;
  }
  const text = String(raw.visibleBody || '').trim();
  if (!text) return null;
  return normalizeMessage({
    messageId,
    conversationType,
    conversationId,
    direction: incoming ? 'inbound' : 'outbound',
    author: { companyId, companyName },
    createdAt,
    observedAt,
    replyToMessageId: null,
    content: {
      text,
      language: null,
      resourceMentions: raw.resourceKinds.map(kind => ({ kind, name: null })),
    },
  });
}

function prepareChatIngest({
  conversationType,
  conversationId,
  result,
  observedAt = new Date(),
  ownCompanyId = null,
  ownCompanyName = null,
} = {}) {
  if (!['private', 'room'].includes(conversationType)) {
    throw new TypeError('conversationType must be private or room');
  }
  const id = String(conversationId ?? '').trim();
  if (!id || id.length > 160) throw new TypeError('conversationId must contain 1..160 characters');
  const observationTime = isoTimestamp(observedAt instanceof Date ? observedAt.toISOString() : observedAt);
  if (!observationTime) throw new TypeError('observedAt must be a valid timestamp');
  const observations = flattenUiMessages(conversationType, result)
    .map(normalizeObservationMessage);
  const ledgerMessages = observations
    .map(message => strictLedgerMessage(message, {
      conversationType,
      conversationId: id,
      observedAt: observationTime,
      ownCompanyId,
      ownCompanyName,
    }))
    .filter(Boolean);
  const snapshotBody = {
    schemaVersion: 1,
    recordType: 'ui-observation-snapshot',
    conversationType,
    conversationId: id,
    observedAt: observationTime,
    source: 'rendered-browser-ui',
    messageLedgerPolicy: 'only-allowlisted-id-time-author-direction-provenance-enters-ledger',
    observations,
    ledgerEligibleCount: ledgerMessages.length,
    ledgerIneligibleCount: observations.length - ledgerMessages.length,
  };
  return {
    ledgerMessages,
    observationSnapshot: {
      ...snapshotBody,
      observationId: `ui-snapshot-sha256-${observationDigest(snapshotBody)}`,
    },
  };
}

function persistObservationSnapshot(root, snapshot) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('observation root is required');
  if (!snapshot || snapshot.recordType !== 'ui-observation-snapshot'
      || typeof snapshot.observationId !== 'string') {
    throw new TypeError('a prepared UI observation snapshot is required');
  }
  const directory = path.join(path.resolve(root), 'observations');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stem = conversationFileStem(snapshot.conversationType, snapshot.conversationId);
  const file = path.join(directory, `${stem}-${snapshot.observationId.slice(-24)}.json`);
  atomicWriteJson(file, snapshot);
  return file;
}

function ingestChatResult({ store, observationRoot, ...input } = {}) {
  const prepared = prepareChatIngest(input);
  const ledger = prepared.ledgerMessages.length
    ? store?.mergeThreadMessages(
      input.conversationType,
      input.conversationId,
      prepared.ledgerMessages,
    )
    : { inserted: 0, duplicates: 0, total: null };
  const observationFile = observationRoot
    ? persistObservationSnapshot(observationRoot, prepared.observationSnapshot)
    : null;
  return {
    ledger,
    observation: {
      observationId: prepared.observationSnapshot.observationId,
      persisted: Boolean(observationFile),
      file: observationFile,
      messageCount: prepared.observationSnapshot.observations.length,
      ledgerEligibleCount: prepared.observationSnapshot.ledgerEligibleCount,
      explicitlyNotInLedger: prepared.observationSnapshot.ledgerIneligibleCount,
    },
  };
}

module.exports = {
  explicitServerId,
  ingestChatResult,
  normalizeObservationMessage,
  observationDigest,
  persistObservationSnapshot,
  prepareChatIngest,
};
