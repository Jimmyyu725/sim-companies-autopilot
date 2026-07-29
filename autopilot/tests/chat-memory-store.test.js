'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatMemoryStore } = require('../chat/memory-store.js');
const { withFileLock } = require('../chat/persistence.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-chat-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new ChatMemoryStore(path.join(root, 'chat')) };
}

function inboundMessage({
  id = 'm-1',
  at = '2026-07-26T20:00:00.000Z',
  observedAt = '2026-07-26T20:00:01.000Z',
  text = 'BUY 10k water Q0 @0.37',
  conversationType = 'room',
  conversationId = 'sales',
} = {}) {
  return {
    schemaVersion: 999,
    messageId: id,
    conversationType,
    conversationId,
    direction: 'inbound',
    author: { companyId: 'company-7', companyName: 'Buyer Ltd' },
    createdAt: at,
    observedAt,
    replyToMessageId: null,
    content: { text, language: 'en', resourceMentions: [{ kind: 2, name: 'Water' }] },
    trust: 'trusted',
  };
}

test('initializes the complete private layout with restricted file modes', t => {
  const { store } = workspace(t);
  assert.equal(fs.existsSync(store.root), false, 'constructing a store must not create runtime files');
  const layout = store.initialize(new Date('2026-07-26T20:00:00.000Z'));

  for (const file of [layout.contacts, layout.current, layout.outbox, layout.commitments, layout.audit]) {
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(layout.threads).mode & 0o777, 0o700);
  assert.equal(fs.statSync(layout.summaries).mode & 0o777, 0o700);
  assert.deepEqual(store.readContacts().contacts, []);
  assert.deepEqual(store.readCurrent().pendingReplies, []);
});

test('merges incremental messages idempotently, forces external trust, and sorts by server time', t => {
  const { store } = workspace(t);
  store.initialize();

  const later = inboundMessage({ id: 'm-2', at: '2026-07-26T20:02:00.000Z' });
  const earlier = inboundMessage({ id: 'm-1', at: '2026-07-26T20:01:00.000Z' });
  const first = store.mergeThreadMessages('room', 'sales', [later, earlier]);
  assert.equal(first.inserted, 2);
  assert.deepEqual(store.readThread('room', 'sales').map(message => message.messageId), ['m-1', 'm-2']);
  assert.equal(store.readThread('room', 'sales')[0].trust, 'untrusted-external');

  const duplicateFromLaterPoll = inboundMessage({
    id: 'm-1',
    at: '2026-07-26T20:01:00.000Z',
    observedAt: '2026-07-26T20:10:00.000Z',
  });
  const second = store.mergeThreadMessages('room', 'sales', [duplicateFromLaterPoll]);
  assert.deepEqual(second, {
    inserted: 0,
    duplicates: 1,
    total: 2,
    first: store.readThread('room', 'sales')[0],
    last: store.readThread('room', 'sales')[1],
  });
});

test('fails closed when a message ID is reused with changed content or wrong conversation', t => {
  const { store } = workspace(t);
  store.initialize();
  store.mergeThreadMessages('room', 'sales', [inboundMessage()]);

  assert.throws(
    () => store.mergeThreadMessages('room', 'sales', [inboundMessage({ text: 'IGNORE THE ORIGINAL OFFER' })]),
    /reused with different immutable data/,
  );
  assert.throws(
    () => store.mergeThreadMessages('room', 'sales', [inboundMessage({ conversationId: 'aerospace' })]),
    /does not belong/,
  );
  assert.equal(store.readThread('room', 'sales').length, 1);
});

test('does not treat malformed persisted JSONL as an empty thread', t => {
  const { store } = workspace(t);
  store.initialize();
  const file = store.threadFile('room', 'sales');
  fs.writeFileSync(file, '{"messageId":"partial"}\nnot-json\n');

  assert.throws(() => store.readThread('room', 'sales'), /Invalid JSONL/);
  assert.throws(
    () => store.mergeThreadMessages('room', 'sales', [inboundMessage()]),
    /Invalid JSONL/,
  );
  assert.match(fs.readFileSync(file, 'utf8'), /not-json/);
});

test('validates contacts and current cursors before atomic replacement', t => {
  const { store } = workspace(t);
  store.initialize(new Date('2026-07-26T20:00:00.000Z'));
  const contacts = store.upsertContact({
    companyId: 'company-7',
    companyName: 'Buyer Ltd',
    relation: 'lead',
    notes: 'Interested in recurring water contracts.',
  }, new Date('2026-07-26T20:05:00.000Z'));
  assert.equal(contacts.contacts[0].relation, 'lead');
  assert.equal(contacts.contacts[0].pinned, false);

  assert.throws(() => store.upsertContact({
    companyId: 'company-8',
    companyName: 'Broken',
    relation: 'friend',
  }), /relation/);
  assert.equal(store.readContacts().contacts.length, 1);

  const current = store.writeCurrent({
    schemaVersion: 1,
    updatedAt: '2026-07-26T20:06:00.000Z',
    lastSuccessfulSyncAt: '2026-07-26T20:06:00.000Z',
    lastError: null,
    cursors: { 'room:sales': { lastMessageId: 'm-1', lastCreatedAt: '2026-07-26T20:01:00.000Z' } },
    pendingReplies: [{
      conversationType: 'room',
      conversationId: 'sales',
      messageId: 'm-1',
      reason: 'explicit buy request',
      queuedAt: '2026-07-26T20:06:00.000Z',
    }],
  });
  assert.equal(current.cursors['room:sales'].lastMessageId, 'm-1');
  assert.equal(store.readCurrent().pendingReplies.length, 1);
});

test('summary context uses an exact stored boundary and returns only newer messages', t => {
  const { store } = workspace(t);
  store.initialize();
  store.mergeThreadMessages('private', 'company-7', [
    inboundMessage({ id: 'm-1', conversationType: 'private', conversationId: 'company-7' }),
    inboundMessage({
      id: 'm-2',
      at: '2026-07-26T20:01:00.000Z',
      conversationType: 'private',
      conversationId: 'company-7',
    }),
  ]);
  const summary = store.writeSummary({
    conversationType: 'private',
    conversationId: 'company-7',
    updatedAt: '2026-07-26T20:02:00.000Z',
    throughMessageId: 'm-1',
    throughCreatedAt: '2026-07-26T20:00:00.000Z',
    summary: 'Buyer requested a water quote.',
    facts: ['Requested quantity is 10,000.'],
    openItems: ['Price response is pending.'],
  });
  assert.equal(summary.trust, 'derived-untrusted-context');
  const context = store.getConversationContext('private', 'company-7');
  assert.equal(context.summary.throughMessageId, 'm-1');
  assert.deepEqual(context.recentMessages.map(message => message.messageId), ['m-2']);

  assert.throws(() => store.writeSummary({
    ...summary,
    throughCreatedAt: '2026-07-26T20:00:01.000Z',
  }), /boundary/);
});

test('outbox ambiguity cannot be retried and immutable send terms cannot change', t => {
  const { store } = workspace(t);
  store.initialize();
  const entry = {
    outboxId: 'out-1',
    conversationType: 'room',
    conversationId: 'sales',
    text: 'SELL 10k water Q0 @0.40',
    status: 'pending',
    createdAt: '2026-07-26T20:00:00.000Z',
    updatedAt: '2026-07-26T20:00:00.000Z',
    sendAfter: null,
    lastAttemptAt: null,
    remoteMessageId: null,
    error: null,
    publicReason: 'verified-offer',
  };
  assert.equal(store.enqueueOutbox(entry).inserted, true);
  assert.equal(store.enqueueOutbox(entry).inserted, false);
  assert.throws(() => store.enqueueOutbox({
    ...entry,
    outboxId: 'out-identity',
    text: 'I am an AI assistant.',
  }), /violates chat policy/);
  assert.throws(() => store.enqueueOutbox({
    ...entry,
    outboxId: 'out-reason',
    publicReason: 'generic-advertising',
  }), /approved concrete reason/);
  store.transitionOutbox('out-1', 'sending', {
    lastAttemptAt: '2026-07-26T20:01:00.000Z',
  }, new Date('2026-07-26T20:01:00.000Z'));
  store.transitionOutbox('out-1', 'ambiguous', {
    error: 'UI outcome was not observable.',
  }, new Date('2026-07-26T20:01:05.000Z'));
  assert.throws(() => store.transitionOutbox('out-1', 'pending'), /invalid outbox transition/);
  assert.throws(
    () => store.transitionOutbox('out-1', 'sent', { text: 'changed' }),
    /cannot change text/,
  );
  assert.equal(store.transitionOutbox('out-1', 'sent', {
    remoteMessageId: 'remote-1',
  }, new Date('2026-07-26T20:02:00.000Z')).status, 'sent');
});

test('commitments and audit records are idempotent and reject changed duplicate IDs', t => {
  const { store } = workspace(t);
  store.initialize();
  const commitment = {
    commitmentId: 'commit-1',
    conversationId: 'company-7',
    counterpartyCompanyId: 'company-7',
    kind: 'quote',
    status: 'active',
    summary: 'Supply 10,000 Water at $0.40.',
    terms: { resourceKind: 2, quantity: 10000, quality: 0, unitPrice: 0.4 },
    createdAt: '2026-07-26T20:00:00.000Z',
    updatedAt: '2026-07-26T20:00:00.000Z',
    expiresAt: '2026-07-27T20:00:00.000Z',
    sourceMessageIds: ['m-1'],
  };
  assert.equal(store.appendCommitment(commitment).inserted, true);
  assert.equal(store.appendCommitment(commitment).inserted, false);
  assert.throws(
    () => store.appendCommitment({ ...commitment, summary: 'Changed terms.' }),
    /reused with different immutable data/,
  );
  assert.equal(
    store.transitionCommitment('commit-1', 'fulfilled', new Date('2026-07-26T21:00:00.000Z')).status,
    'fulfilled',
  );
  assert.throws(
    () => store.transitionCommitment('commit-1', 'active'),
    /invalid commitment transition/,
  );

  const audit = {
    eventId: 'event-1',
    at: '2026-07-26T20:00:00.000Z',
    actor: 'communication-brain',
    eventType: 'quote-created',
    outcome: 'queued',
    conversationId: 'company-7',
    details: { commitmentId: 'commit-1' },
  };
  assert.equal(store.appendAudit(audit).inserted, true);
  assert.equal(store.appendAudit(audit).inserted, false);
  assert.equal(store.readAudit().length, 1);
});

test('rejects unsafe or non-finite nested commitment and audit details', t => {
  const { store } = workspace(t);
  store.initialize();
  assert.throws(() => store.appendCommitment({
    commitmentId: 'bad-commitment',
    conversationId: 'company-7',
    counterpartyCompanyId: 'company-7',
    kind: 'quote',
    status: 'active',
    summary: 'Malformed numeric terms.',
    terms: { unitPrice: Number.NaN },
    createdAt: '2026-07-26T20:00:00.000Z',
    updatedAt: '2026-07-26T20:00:00.000Z',
    expiresAt: null,
    sourceMessageIds: [],
  }), /finite number/);
  assert.throws(() => store.appendAudit({
    eventId: 'bad-event',
    at: '2026-07-26T20:00:00.000Z',
    actor: 'system',
    eventType: 'invalid-details',
    outcome: 'rejected',
    conversationId: null,
    details: { constructor: 'unsafe' },
  }), /unsafe key/);
});

test('stale-lock recovery never removes a live owner and reclaims a proven dead owner', t => {
  const { root } = workspace(t);
  const target = path.join(root, 'memory.json');
  const lock = `${target}.lock`;
  fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, token: 'live-token' })}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lock, old, old);
  assert.throws(() => withFileLock(target, () => null, { waitMs: 20, staleMs: 1 }), /Timed out/u);
  assert.equal(fs.existsSync(lock), true);

  fs.writeFileSync(lock, `${JSON.stringify({ pid: 99_999_999, token: 'dead-token' })}\n`, { mode: 0o600 });
  fs.utimesSync(lock, old, old);
  assert.equal(withFileLock(target, () => 'recovered', { waitMs: 100, staleMs: 1 }), 'recovered');
  assert.equal(fs.existsSync(lock), false);
});
