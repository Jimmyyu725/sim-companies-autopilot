'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ALLOWED_ERROR_REASONS,
  ChatDiaryStore,
  buildChatDiaryRecord,
} = require('../chat/chat-diary.js');
const {
  PROVIDER_FAIL_CLOSED_REASONS,
  PROVIDER_FAILURE_CODES,
  WORKER_ERROR_REASONS,
} = require('../chat/diagnostic-codes.js');

test('provider fail-closed diagnostics share one bounded allowlist across durable boundaries', () => {
  assert.equal(PROVIDER_FAILURE_CODES.length > 0, true);
  assert.equal(new Set(PROVIDER_FAILURE_CODES).size, PROVIDER_FAILURE_CODES.length);
  assert.equal(new Set(PROVIDER_FAIL_CLOSED_REASONS).size, PROVIDER_FAIL_CLOSED_REASONS.length);
  for (const reason of PROVIDER_FAIL_CLOSED_REASONS) {
    assert.equal(ALLOWED_ERROR_REASONS.has(reason), true, reason);
  }
  const workerReasons = Object.values(WORKER_ERROR_REASONS);
  assert.equal(new Set(workerReasons).size, workerReasons.length);
  for (const reason of workerReasons) {
    assert.equal(ALLOWED_ERROR_REASONS.has(reason), true, reason);
  }
});

test('writes an owner-only aggregate chat diary in its independent directory', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-chat-diary-'));
  const root = path.join(parent, 'chat-diaries');
  try {
    const store = new ChatDiaryStore(root);
    store.initialize();
    const written = store.write({
      startedAt: '2026-07-27T10:00:00.000Z',
      completedAt: '2026-07-27T10:00:03.000Z',
      mode: 'shadow',
      discovery: { rooms: ['Sales'], contacts: [{ company: 'SECRET BUYER' }] },
      result: {
        strictInboundMessages: 4,
        observations: [{}],
        proposals: [
          {
            action: 'chat_room_reply',
            economicAuthorizationRequired: true,
            tradeSide: 'buy',
            previewStatus: 'VERIFIED',
            params: { text: 'PRIVATE MESSAGE BODY PRIVATEBODY123' },
          },
          {
            action: 'chat_room_post',
            economicAuthorizationRequired: true,
            tradeSide: 'sell',
            previewStatus: 'VERIFIED',
            params: { text: 'PRIVATEBODY123' },
          },
          {
            action: 'ignore',
            rationale: 'PRIVATEBODY123',
            tradeSide: 'buy',
            economicAuthorizationRequired: true,
            previewStatus: 'VERIFIED',
          },
          {
            action: 'request_evidence',
            rationale: 'PRIVATEBODY123',
            tradeSide: 'sell',
            economicAuthorizationRequired: true,
            previewStatus: 'VERIFIED',
          },
          {
            action: 'chat_room_reply',
            economicAuthorizationRequired: false,
            tradeSide: 'PRIVATEBODY123',
            previewStatus: 'PRIVATEBODY123',
            params: { text: 'PRIVATEBODY123' },
          },
        ],
        outcomes: [],
        metrics: {
          previews: 0,
          confirmAttempts: 0,
          decisionCalls: 1,
          actionCalls: 1,
          decisionUsage: {
            knownCalls: 1,
            inputTokens: 800,
            outputTokens: 200,
            totalTokens: 1000,
            cachedInputTokens: 300,
            reasoningTokens: 100,
          },
        },
        errors: [
          { stage: 'decision', reason: 'provider failed: PRIVATE MESSAGE BODY' },
          {
            stage: 'decision',
            reason: 'provider-fail-closed-responses-schema-rejected',
            detail: 'PRIVATEBODY123',
          },
          {
            stage: 'plan',
            reason: 'plan-public-source-binding-invalid',
            detail: 'PRIVATEBODY123',
          },
          { stage: 'PRIVATEBODY123', reason: 'PRIVATEBODY123' },
        ],
        reason: 'PRIVATEBODY123',
      },
    });
    assert.equal(written.ok, true);
    assert.equal(fs.statSync(root).mode & 0o077, 0);
    assert.equal(fs.statSync(written.file).mode & 0o077, 0);
    const text = fs.readFileSync(written.file, 'utf8');
    assert.equal(text.includes('PRIVATE MESSAGE BODY'), false);
    assert.equal(text.includes('PRIVATEBODY123'), false);
    assert.equal(text.includes('SECRET BUYER'), false);
    assert.match(text, /UNKNOWN:UNKNOWN/u);
    assert.match(text, /decision:provider-fail-closed-responses-schema-rejected/u);
    assert.match(text, /plan:plan-public-source-binding-invalid/u);
    assert.match(text, /Stop reason: UNKNOWN/u);
    assert.match(text, /Mode: shadow/u);
    assert.match(text, /Rooms discovered: 1/u);
    assert.doesNotMatch(text, /Rooms read:/u);
    assert.match(text, /Strict inbound messages: 4/u);
    assert.match(text, /Outbound draft proposals: 3/u);
    assert.match(text, /Public reply proposals: 2/u);
    assert.match(text, /Proactive public post proposals: 1/u);
    assert.match(text, /Economic public proposals: 2/u);
    assert.match(text, /Buy proposals: 1/u);
    assert.match(text, /Sell proposals: 1/u);
    assert.match(text, /Exact shadow previews: 2/u);
    assert.match(text, /Decision total tokens: 1000/u);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('diary record contains only aggregate fields', () => {
  const record = buildChatDiaryRecord({
    startedAt: '2026-07-27T10:00:00.000Z',
    completedAt: '2026-07-27T10:00:01.000Z',
    mode: 'read-only',
    discovery: { rooms: [], contacts: [] },
    result: {},
  });
  assert.equal(record.includesMessageBodies, false);
  assert.equal(record.includesPrivateIdentities, false);
  assert.equal(record.publicReplyProposals, 0);
  assert.equal(record.proactivePublicPostProposals, 0);
  assert.equal(record.economicPublicProposals, 0);
  assert.equal(record.buyProposals, 0);
  assert.equal(record.sellProposals, 0);
  assert.equal(record.exactShadowPreviews, 0);
});
