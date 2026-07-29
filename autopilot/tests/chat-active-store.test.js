'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  ActiveChatStore,
  emptyRegistry,
  migrateLegacyActiveChatStore,
} = require('../chat/active-store.js');
const { executionBindingHash } = require('../chat/execution-claim.js');
const { prepareChatIngest } = require('../chat/ingest.js');

const NOW = Date.parse('2026-07-27T08:00:00.000Z');

function temporaryStore() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-active-store-'));
  const root = path.join(parent, 'active');
  const store = new ActiveChatStore(root, { allowedRoots: [parent] });
  store.initialize(new Date(NOW));
  return { parent, root, store };
}

function temporaryLegacyStore() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-active-legacy-'));
  const root = path.join(parent, 'active');
  fs.mkdirSync(root, { mode: 0o700 });
  const attemptFile = path.join(root, 'attempts.json');
  fs.writeFileSync(attemptFile, `${JSON.stringify(emptyRegistry(), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(attemptFile, 0o600);
  const store = new ActiveChatStore(root, { allowedRoots: [parent] });
  return { parent, root, store, attemptFile };
}

function privateActionParams(attemptId = 'active-test-attempt-0001') {
  return {
    targetCompany: 'Buyer Corp',
    targetCompanyId: 42,
    text: 'Acknowledged.',
    inReplyToText: 'Do you have stock?',
    sourceMessageId: '1001',
    sourceCreatedAt: new Date(NOW - 30_000).toISOString(),
    attemptId,
    confirm: true,
  };
}

function roomPostActionParams(attemptId = 'active-room-post-0001') {
  return {
    room: 'Sales',
    parts: [{ type: 'text', value: 'Market update available.', kind: null, name: null }],
    reason: 'material-update',
    attemptId,
    confirm: true,
  };
}

function shadowPreview(overrides = {}) {
  return {
    schemaVersion: 1,
    attemptId: 'shadow-preview-attempt-0001',
    sourceKey: 'room:Sales:proactive-sell-110-0-20260727',
    actionName: 'chat_room_post',
    contentFingerprint: crypto.createHash('sha256').update('shadow-output').digest('hex'),
    previewedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function claim(overrides = {}) {
  const actionParams = privateActionParams(overrides.attemptId);
  return {
    schemaVersion: 1,
    attemptId: 'active-test-attempt-0001',
    sourceKey: 'private:company-42:1001',
    state: 'ARMED',
    actionName: 'chat_private_send',
    contentFingerprint: crypto.createHash('sha256').update('reply').digest('hex'),
    executionBindingHash: executionBindingHash('chat_private_send', actionParams),
    snapshotId: 'bs1:offline-test',
    economicAuthorization: false,
    rateLimit: { windowStartedAtMs: NOW - 900_000, maxAttempts: 1 },
    armedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

test('active store persists strict observations and owner-only replay evidence', () => {
  const { parent, root, store } = temporaryStore();
  try {
    const prepared = prepareChatIngest({
      conversationType: 'private',
      conversationId: 'company-42',
      observedAt: new Date(NOW),
      result: { thread: { messages: [{
        serverMessageId: 1001,
        idStatus: 'VERIFIED_RENDERED_COMPONENT_ID',
        authorCompany: 'Buyer Corp',
        authorCompanyId: 42,
        authorStatus: 'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER',
        direction: 'INCOMING',
        directionStatus: 'VERIFIED_RENDERED_COMPONENT_AND_STYLE',
        visibleBody: 'Do you have stock?',
        exactCreatedAt: new Date(NOW - 30_000).toISOString(),
        timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
      }] } },
    });
    const persisted = store.ingestObservation({
      readRequest: { conversationType: 'private', conversationId: 'company-42' },
      prepared,
    });
    assert.equal(persisted.ok, true);
    assert.equal(persisted.durable, true);
    assert.equal(persisted.ledger.inserted, 1);
    assert.deepEqual(persisted.newMessageIds, ['1001']);
    const duplicateIngest = store.ingestObservation({
      readRequest: { conversationType: 'private', conversationId: 'company-42' },
      prepared,
    });
    assert.deepEqual(duplicateIngest.newMessageIds, []);

    const armed = store.claimAttempt(claim());
    assert.equal(armed.ok, true);
    assert.match(armed.executionClaimToken, /^[a-f0-9]{64}$/u);
    const consumed = store.consumeExecutionClaim({
      attemptId: 'active-test-attempt-0001',
      actionName: 'chat_private_send',
      actionParams: privateActionParams(),
      token: armed.executionClaimToken,
      consumedAt: new Date(NOW + 500),
    });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.state, 'CONFIRMING');
    assert.equal(store.getSourceState('private:company-42:1001'), 'CONFIRMING');
    assert.equal(fs.statSync(root).mode & 0o077, 0);
    assert.equal(fs.statSync(store.attemptFile).mode & 0o077, 0);
    assert.equal(fs.statSync(store.layoutMarkerFile).mode & 0o077, 0);
    assert.equal(store.readLayoutMarker().establishment, 'new-store-initialization');
    const attemptText = fs.readFileSync(store.attemptFile, 'utf8');
    assert.equal(attemptText.includes('Do you have stock?'), false);
    assert.equal(attemptText.includes('reply'), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a versioned layout marker makes deleted registries terminal instead of reconstructing them', () => {
  const first = temporaryStore();
  try {
    fs.unlinkSync(first.store.attemptFile);
    const restarted = new ActiveChatStore(first.root, { allowedRoots: [first.parent] });
    assert.throws(() => restarted.initialize(new Date(NOW + 1000)),
      /attempt registry is missing; refusing silent reconstruction/);
    assert.equal(fs.existsSync(restarted.attemptFile), false);
    assert.throws(() => restarted.claimAttempt(claim()),
      /attempt registry is missing; refusing silent reconstruction/);
    assert.equal(fs.existsSync(restarted.attemptFile), false);
  } finally {
    fs.rmSync(first.parent, { recursive: true, force: true });
  }

  const second = temporaryStore();
  try {
    fs.unlinkSync(second.store.shadowPreviewFile);
    const restarted = new ActiveChatStore(second.root, { allowedRoots: [second.parent] });
    assert.throws(() => restarted.initialize(new Date(NOW + 1000)),
      /shadow preview registry is missing; refusing silent reconstruction/);
    assert.equal(fs.existsSync(restarted.shadowPreviewFile), false);
    assert.throws(() => restarted.claimAttempt(claim()),
      /shadow preview registry is missing; refusing silent reconstruction/);
    assert.equal(fs.existsSync(restarted.shadowPreviewFile), false);
  } finally {
    fs.rmSync(second.parent, { recursive: true, force: true });
  }
});

test('legacy attempts require an explicit migration that preserves evidence and creates the marker last', () => {
  const { parent, root, store, attemptFile } = temporaryLegacyStore();
  try {
    const before = crypto.createHash('sha256').update(fs.readFileSync(attemptFile)).digest('hex');
    assert.throws(() => store.initialize(new Date(NOW)), /explicit legacy migration/);
    assert.equal(fs.existsSync(store.shadowPreviewFile), false);
    assert.equal(fs.existsSync(store.layoutMarkerFile), false);

    const migrated = migrateLegacyActiveChatStore(root, {
      allowedRoots: [parent],
      now: new Date(NOW),
    });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.durable, true);
    assert.equal(migrated.attemptsPreserved, 0);
    assert.equal(migrated.shadowPreviewsPreserved, 0);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(attemptFile)).digest('hex'), before);
    assert.equal(fs.statSync(store.shadowPreviewFile).mode & 0o077, 0);
    assert.equal(fs.statSync(store.layoutMarkerFile).mode & 0o077, 0);
    assert.equal(store.readLayoutMarker().establishment, 'explicit-legacy-migration');
    assert.doesNotThrow(() => store.initialize(new Date(NOW + 1000)));
    assert.throws(() => migrateLegacyActiveChatStore(root, {
      allowedRoots: [parent],
      now: new Date(NOW + 2000),
    }), /already has a layout marker/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('migration CLI requires explicit confirmation and supports an explicitly allowlisted root', () => {
  const { parent, root, store } = temporaryLegacyStore();
  try {
    const cli = path.resolve(__dirname, '..', 'chat', 'migrate-active-store-layout.js');
    const refused = spawnSync(process.execPath, [cli, '--root', root, '--allowed-root', parent], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /literal --confirm/);
    assert.equal(fs.existsSync(store.layoutMarkerFile), false);

    const migrated = spawnSync(process.execPath, [
      cli,
      '--confirm',
      '--root', root,
      '--allowed-root', parent,
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(migrated.status, 0, migrated.stderr);
    const result = JSON.parse(migrated.stdout.trim());
    assert.equal(result.ok, true);
    assert.equal(result.migrated, true);
    assert.equal(store.readLayoutMarker().establishment, 'explicit-legacy-migration');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('active store atomically blocks duplicate outbound content in one conversation', () => {
  const { parent, store } = temporaryStore();
  try {
    const fingerprint = crypto.createHash('sha256').update('same-output').digest('hex');
    const first = claim({
      contentFingerprint: fingerprint,
      rateLimit: { windowStartedAtMs: NOW - 900_000, maxAttempts: 10 },
    });
    assert.equal(store.claimAttempt(first).ok, true);
    assert.equal(store.hasRecentContentAttempt({
      sourceKey: 'private:company-42:2002',
      actionName: 'chat_private_send',
      contentFingerprint: fingerprint,
      sinceMs: NOW - 86_400_000,
    }), true);
    const sameConversation = claim({
      attemptId: 'active-test-attempt-0002',
      sourceKey: 'private:company-42:2002',
      contentFingerprint: fingerprint,
      rateLimit: { windowStartedAtMs: NOW - 900_000, maxAttempts: 10 },
    });
    assert.equal(store.claimAttempt(sameConversation).reason, 'content-is-replay-blocked');
    const otherConversation = claim({
      attemptId: 'active-test-attempt-0003',
      sourceKey: 'private:company-7:9000',
      contentFingerprint: fingerprint,
      rateLimit: { windowStartedAtMs: NOW - 900_000, maxAttempts: 10 },
    });
    assert.equal(store.claimAttempt(otherConversation).ok, true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('shadow previews are private, durable, bounded, and join the 24-hour content replay guard', () => {
  const { parent, store } = temporaryStore();
  try {
    const candidate = shadowPreview();
    const recorded = store.recordShadowPreview(candidate);
    assert.equal(recorded.ok, true);
    assert.equal(recorded.durable, true);
    assert.deepEqual(store.readShadowPreviews().previews, [candidate]);
    assert.equal(fs.statSync(store.shadowPreviewFile).mode & 0o077, 0);
    assert.equal(store.hasRecentContentAttempt({
      sourceKey: 'room:Sales:another-message',
      actionName: candidate.actionName,
      contentFingerprint: candidate.contentFingerprint,
      sinceMs: NOW - 86_400_000,
    }), true);
    assert.equal(store.hasRecentContentAttempt({
      sourceKey: 'room:Game:another-message',
      actionName: candidate.actionName,
      contentFingerprint: candidate.contentFingerprint,
      sinceMs: NOW - 86_400_000,
    }), false);
    assert.equal(store.recordShadowPreview(candidate).reason, 'already-recorded');
    assert.equal(store.recordShadowPreview(shadowPreview({
      attemptId: 'shadow-preview-attempt-0002',
      sourceKey: 'room:Sales:proactive-sell-110-0-second',
    })).reason, 'content-is-replay-blocked');
    assert.equal(store.recordShadowPreview(shadowPreview({
      attemptId: 'shadow-preview-attempt-0003',
      sourceKey: 'room:Game:proactive-sell-110-0-second',
    })).ok, true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('shadow preview retention expires old content without forgetting a current 24-hour guard', () => {
  const { parent, store } = temporaryStore();
  try {
    const old = shadowPreview({
      attemptId: 'shadow-preview-old-0001',
      previewedAt: new Date(NOW - 86_400_001).toISOString(),
    });
    assert.equal(store.recordShadowPreview(old).ok, true);
    assert.equal(store.hasRecentContentAttempt({
      sourceKey: 'room:Sales:new-source',
      actionName: old.actionName,
      contentFingerprint: old.contentFingerprint,
      sinceMs: NOW - 86_400_000,
    }), false);
    const current = shadowPreview({ attemptId: 'shadow-preview-current-0001' });
    assert.equal(store.recordShadowPreview(current).ok, true);
    assert.deepEqual(store.readShadowPreviews().previews, [current]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('shadow preview registry fails closed on public permissions, malformed data, and symlinks', () => {
  const { parent, store } = temporaryStore();
  try {
    fs.chmodSync(store.shadowPreviewFile, 0o644);
    assert.throws(() => store.readShadowPreviews(), /private regular bounded file/);
    fs.chmodSync(store.shadowPreviewFile, 0o600);
    fs.writeFileSync(store.shadowPreviewFile, '{broken', { encoding: 'utf8', mode: 0o600 });
    assert.throws(() => store.readShadowPreviews(), /Cannot read valid JSON/);
    fs.unlinkSync(store.shadowPreviewFile);
    fs.symlinkSync('/dev/null', store.shadowPreviewFile);
    assert.throws(() => store.readShadowPreviews(), /private regular bounded file/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('active store atomically blocks source replay and the global confirm rate', () => {
  const { parent, store } = temporaryStore();
  try {
    const firstClaim = store.claimAttempt(claim());
    assert.equal(firstClaim.ok, true);
    assert.equal(store.claimAttempt(claim({ attemptId: 'active-test-attempt-0002' })).reason,
      'source-is-replay-blocked');
    assert.equal(store.claimAttempt(claim({
      attemptId: 'active-test-attempt-0003',
      sourceKey: 'private:company-7:9000',
    })).reason, 'atomic-confirm-rate-limit');
    assert.equal(store.completeAttempt({
      attemptId: 'active-test-attempt-0001',
      sourceKey: 'private:company-42:1001',
      state: 'VERIFIED',
      outcomeCode: 'exact-private-postcondition',
      postconditionVerified: true,
      completedAt: new Date(NOW + 500).toISOString(),
    }).reason, 'verified-requires-consumed-execution-claim');
    assert.equal(store.consumeExecutionClaim({
      attemptId: 'active-test-attempt-0001',
      actionName: 'chat_private_send',
      actionParams: privateActionParams(),
      token: firstClaim.executionClaimToken,
      consumedAt: new Date(NOW + 750),
    }).ok, true);
    const completed = store.completeAttempt({
      attemptId: 'active-test-attempt-0001',
      sourceKey: 'private:company-42:1001',
      state: 'VERIFIED',
      outcomeCode: 'exact-private-postcondition',
      postconditionVerified: true,
      completedAt: new Date(NOW + 1000).toISOString(),
    });
    assert.equal(completed.ok, true);
    assert.equal(store.getSourceState('private:company-42:1001'), 'VERIFIED');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('active store fails closed on a public, symlinked, or malformed registry', () => {
  const { parent, store } = temporaryStore();
  try {
    fs.chmodSync(store.attemptFile, 0o644);
    assert.throws(() => store.readAttempts(), /private regular bounded file/);
    fs.chmodSync(store.attemptFile, 0o600);
    fs.writeFileSync(store.attemptFile, '{broken', { encoding: 'utf8', mode: 0o600 });
    assert.throws(() => store.readAttempts(), /Cannot read valid JSON/);
    fs.unlinkSync(store.attemptFile);
    fs.symlinkSync('/dev/null', store.attemptFile);
    assert.throws(() => store.readAttempts(), /private regular bounded file/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('custom storage roots require an explicit canonical allowlist', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-active-root-'));
  try {
    assert.throws(() => new ActiveChatStore(path.join(parent, 'active')), /allowlist/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('act refuses a wrong worker token before Chrome and leaves the claim ARMED', () => {
  const { parent, root, store } = temporaryStore();
  try {
    const params = privateActionParams();
    const armed = store.claimAttempt(claim());
    assert.equal(armed.ok, true);
    const child = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'act.js'),
      'chat_private_send',
      JSON.stringify(params),
    ], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SIM_CHAT_MODE: 'full',
        SIM_CHAT_ACTIVE_ROOT: root,
        SIM_CHAT_PRIVATE_OUTBOX_ROOT: path.join(parent, 'private-outbox'),
        SIM_CHAT_EXECUTION_CLAIM_TOKEN: 'f'.repeat(64),
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(output.ok, false);
    assert.equal(output.mutationAuthorized, false);
    assert.match(output.reason, /worker execution claim/u);
    assert.equal(store.getAttemptState(params.attemptId), 'ARMED');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('confirmed public room posts require and bind the worker execution claim before Chrome', () => {
  const { parent, root, store } = temporaryStore();
  try {
    const params = roomPostActionParams();
    const armed = store.claimAttempt(claim({
      attemptId: params.attemptId,
      sourceKey: 'room:Sales:proactive-material-update-20260727',
      actionName: 'chat_room_post',
      executionBindingHash: executionBindingHash('chat_room_post', params),
      rateLimit: { windowStartedAtMs: NOW - 900_000, maxAttempts: 10 },
    }));
    assert.equal(armed.ok, true);
    const child = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'act.js'),
      'chat_room_post',
      JSON.stringify(params),
    ], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SIM_CHAT_MODE: 'full',
        SIM_CHAT_ACTIVE_ROOT: root,
        SIM_CHAT_HISTORY_FILE: path.join(parent, 'public-history.jsonl'),
        SIM_CHAT_EXECUTION_CLAIM_TOKEN: 'f'.repeat(64),
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(output.ok, false);
    assert.equal(output.mutationAuthorized, false);
    assert.match(output.reason, /worker execution claim/u);
    assert.equal(store.getAttemptState(params.attemptId), 'ARMED');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
