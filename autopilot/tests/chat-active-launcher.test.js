'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildActChildEnvironment,
  discoverReadRequests,
  makeActActionRunner,
  normalizeLauncherResult,
  resolveActiveMode,
  runCliStage,
  validateRolloutConfiguration,
} = require('../chat-active.js');
const { STAGE_BOTH, STAGE_BRAIN } = require('../chat-shadow.js');

const NOW = Date.parse('2026-07-27T08:00:00.000Z');
const FAR_WAKE = {
  at: NOW + 30 * 60 * 1000,
  atIso: new Date(NOW + 30 * 60 * 1000).toISOString(),
  reason: 'offline launcher test',
};

function permission() {
  return async ({ mutation }) => ({
    ok: true,
    brainLockHeld: true,
    tickLockHeld: true,
    mutationAllowed: mutation ? true : false,
  });
}

test('launcher mode and rollout switches are explicit and fail closed', () => {
  assert.equal(resolveActiveMode({}), 'shadow');
  assert.equal(resolveActiveMode({ SIM_CHAT_ACTIVE_MODE: 'read-only' }), 'read-only');
  assert.throws(() => resolveActiveMode({ SIM_CHAT_ACTIVE_MODE: 'banana' }), /invalid/);
  assert.throws(() => validateRolloutConfiguration('safe-reply', {}), /rollout switch/);
  assert.throws(() => validateRolloutConfiguration('safe-reply', {
    SIM_CHAT_REAL_SEND_ENABLED: 'true',
  }), /LLM/);
  const rollout = validateRolloutConfiguration('safe-reply', {
    SIM_CHAT_REAL_SEND_ENABLED: 'true',
    SIM_CHAT_LLM_ENABLED: 'true',
    OPENAI_API_KEY: 'test-only-placeholder',
  });
  assert.deepEqual(rollout, { llmEnabled: true, realSendEnabled: true });
});

test('act child environment never inherits credentials, arbitrary env, or lock proof', () => {
  const child = buildActChildEnvironment({
    mode: 'safe-reply',
    executionClaimToken: 'a'.repeat(64),
    environment: {
      OPENAI_API_KEY: 'must-not-leak',
      CLOUDFLARE_API_TOKEN: 'must-not-leak',
      NODE_OPTIONS: '--require bad.js',
      SIM_CHAT_SHADOW_LOCK_PROOF: 'b'.repeat(64),
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    },
  });
  assert.deepEqual(child, {
    SIM_CHAT_MODE: 'safe-reply',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    SIM_CHAT_EXECUTION_CLAIM_TOKEN: 'a'.repeat(64),
  });
});

test('active act runner allowlists actions and injects claim token only for confirm', async () => {
  const calls = [];
  const execFileSync = (_file, args, options) => {
    calls.push({ args, options });
    return `${JSON.stringify({ ok: true, action: args[1] })}\n`;
  };
  const runner = makeActActionRunner({
    execFileSync,
    environment: { OPENAI_API_KEY: 'never-child' },
    mode: 'safe-reply',
    realSendEnabled: true,
    permissionGuard: permission(),
  });
  await runner('chat_room_read', { room: 'Sales' }, { timeoutMs: 2345 });
  await runner('chat_private_send', {
    targetCompany: 'Buyer Corp', targetCompanyId: 42, text: 'Acknowledged.',
    inReplyToText: 'Are you there?', sourceMessageId: '1001',
    sourceCreatedAt: '2026-07-27T07:59:00.000Z',
    attemptId: 'active-test-0001', confirm: false,
  }, { timeoutMs: 3456 });
  await runner('chat_private_send', {
    targetCompany: 'Buyer Corp', targetCompanyId: 42, text: 'Acknowledged.',
    inReplyToText: 'Are you there?', sourceMessageId: '1001',
    sourceCreatedAt: '2026-07-27T07:59:00.000Z',
    attemptId: 'active-test-0001', confirm: true,
  }, { timeoutMs: 4567, executionClaimToken: 'c'.repeat(64) });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.timeout, 2345);
  assert.equal(calls[0].options.env.SIM_CHAT_EXECUTION_CLAIM_TOKEN, undefined);
  assert.equal(calls[1].options.env.SIM_CHAT_EXECUTION_CLAIM_TOKEN, undefined);
  assert.equal(calls[2].options.env.SIM_CHAT_EXECUTION_CLAIM_TOKEN, 'c'.repeat(64));
  assert.equal(calls[2].options.env.OPENAI_API_KEY, undefined);
  await assert.rejects(() => runner('collect', {}, {}), /allowlisted/);
  await assert.rejects(() => runner('chat_private_send', {
    targetCompany: 'Buyer Corp', targetCompanyId: 42, text: 'Acknowledged.',
    inReplyToText: 'Are you there?', sourceMessageId: '1001',
    sourceCreatedAt: '2026-07-27T07:59:00.000Z',
    attemptId: 'active-test-0002', confirm: true,
  }, {}), /claim token/);
  assert.equal(calls.length, 3);
});

test('launcher exposes proactive room posts as previews and claimed sends in full mode', async () => {
  const calls = [];
  const runner = makeActActionRunner({
    execFileSync: (_file, args, options) => {
      calls.push({ args, options });
      return `${JSON.stringify({ ok: true, action: args[1] })}\n`;
    },
    environment: {},
    mode: 'full',
    realSendEnabled: true,
    permissionGuard: permission(),
  });
  const params = {
    room: 'Sales',
    parts: [{ type: 'text', value: 'SELL', kind: null, name: null }],
    reason: 'verified-offer',
    attemptId: 'proactive-preview-test-0001',
  };
  await runner('chat_room_post', { ...params, confirm: false }, { timeoutMs: 1000 });
  await runner(
    'chat_room_post',
    { ...params, confirm: true },
    { timeoutMs: 1000, executionClaimToken: 'd'.repeat(64) },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.SIM_CHAT_EXECUTION_CLAIM_TOKEN, undefined);
  assert.equal(calls[1].options.env.SIM_CHAT_EXECUTION_CLAIM_TOKEN, 'd'.repeat(64));
  assert.equal(JSON.parse(calls[1].args[2]).confirm, true);
});

test('discovery creates canonical bounded room and private read requests', async () => {
  const result = await discoverReadRequests({
    guardControl: { timeoutMs: 1000 },
    actionRunner: async action => action === 'chat_rooms_discover'
      ? { ok: true, rooms: [{ room: 'Sales' }, { room: 'Sales' }, { room: 'General' }] }
      : { ok: true, contacts: [
        { company: 'B Corp', companyId: 9, unread: 2, pinned: false },
        { company: 'A Corp', companyId: 7, unread: 0, pinned: true },
      ] },
  });
  assert.deepEqual(result.rooms, ['General', 'Sales']);
  assert.equal(result.readRequests.length, 4);
  assert.deepEqual(result.readRequests.map(entry => entry.conversationId), [
    'company-9', 'Sales', 'General', 'company-7',
  ]);
  const privateRequests = result.readRequests.filter(entry => entry.conversationType === 'private');
  assert.deepEqual(privateRequests.map(entry => entry.conversationId), ['company-9', 'company-7']);
});

test('root and brain stages delegate in brain-then-tick order without running Chrome', async () => {
  const stages = [];
  const root = await runCliStage({
    stage: 'root',
    environment: {},
    clock: () => NOW,
    write: () => {},
    spawnLockStageFn: stage => {
      stages.push(stage);
      return { status: 0, stdout: '{"ok":true,"delegated":"brain"}\n' };
    },
  });
  assert.equal(root.ok, true);
  assert.deepEqual(stages, [STAGE_BRAIN]);

  const brain = await runCliStage({
    stage: STAGE_BRAIN,
    environment: { SIM_CHAT_ACTIVE_DEADLINE_AT_MS: String(NOW + 90_000) },
    clock: () => NOW,
    write: () => {},
    nextWakeReader: () => FAR_WAKE,
    lockProofVerifier: () => true,
    spawnLockStageFn: stage => {
      stages.push(stage);
      return { status: 0, stdout: '{"ok":true,"delegated":"both"}\n' };
    },
  });
  assert.equal(brain.ok, true);
  assert.deepEqual(stages, [STAGE_BRAIN, STAGE_BOTH]);
});

test('only dedicated flock contention is a healthy skip; crashes and malformed output fail', async () => {
  async function rootWith(child) {
    return runCliStage({
      stage: 'root', environment: {}, clock: () => NOW, write: () => {},
      spawnLockStageFn: () => child,
    });
  }
  assert.equal((await rootWith({ status: 75, stdout: '' })).reason, 'brain-lock-held');
  const crashed = await rootWith({ status: 2, stdout: '' });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.reason, 'brain-lock-child-failed');
  const signalled = await rootWith({ status: null, signal: 'SIGTERM', stdout: '' });
  assert.equal(signalled.ok, false);
  assert.equal(signalled.reason, 'brain-lock-child-failed');
  const malformed = await rootWith({ status: 0, stdout: 'not-json\n' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'brain-lock-child-output-invalid');
});

test('invalid internal proof and close wake fail before action runner construction', async () => {
  let factories = 0;
  const invalid = await runCliStage({
    stage: STAGE_BOTH,
    environment: { SIM_CHAT_ACTIVE_DEADLINE_AT_MS: String(NOW + 90_000) },
    clock: () => NOW,
    write: () => {},
    lockProofVerifier: () => false,
    actionRunnerFactory: () => { factories += 1; return async () => ({}); },
  });
  assert.equal(invalid.reason, 'internal-stage-lock-proof-invalid');
  const close = await runCliStage({
    stage: STAGE_BOTH,
    environment: { SIM_CHAT_ACTIVE_DEADLINE_AT_MS: String(NOW + 90_000) },
    clock: () => NOW,
    write: () => {},
    lockProofVerifier: () => true,
    nextWakeReader: () => ({
      at: NOW + 60_000,
      atIso: new Date(NOW + 60_000).toISOString(),
      reason: 'offline close wake',
    }),
    actionRunnerFactory: () => { factories += 1; return async () => ({}); },
  });
  assert.equal(close.reason, 'next-wake-too-close');
  assert.equal(close.ok, true);
  const unknownWake = await runCliStage({
    stage: STAGE_BOTH,
    environment: { SIM_CHAT_ACTIVE_DEADLINE_AT_MS: String(NOW + 90_000) },
    clock: () => NOW,
    write: () => {},
    lockProofVerifier: () => true,
    nextWakeReader: () => ({ reason: 'missing timestamp' }),
    actionRunnerFactory: () => { factories += 1; return async () => ({}); },
  });
  assert.equal(unknownWake.ok, false);
  assert.equal(unknownWake.reason, 'next-wake-unknown');
  assert.equal(factories, 0);
});

test('unknown internal skips cannot masquerade as healthy launcher results', () => {
  const result = normalizeLauncherResult({
    ok: true,
    skipped: true,
    reason: 'permission-or-read-failed',
  }, 'shadow');
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'unexpected-healthy-skip');
  assert.equal(result.upstreamReason, 'permission-or-read-failed');
});

test('all local durable dependencies are validated before discovery can open Chrome', async () => {
  let runnerFactories = 0;
  const result = await runCliStage({
    stage: STAGE_BOTH,
    environment: { SIM_CHAT_ACTIVE_DEADLINE_AT_MS: String(NOW + 90_000) },
    clock: () => NOW,
    write: () => {},
    lockProofVerifier: () => true,
    nextWakeReader: () => FAR_WAKE,
    storeFactory: () => ({
      initialize() {},
      readAttempts() { throw new Error('corrupt attempt registry'); },
    }),
    actionRunnerFactory: () => { runnerFactories += 1; return async () => ({}); },
  });
  assert.equal(result.reason, 'active-chat-cli-error');
  assert.equal(runnerFactories, 0);
});

test('both-lock stage wires store, snapshot, provider, safety, reads, and worker offline', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-active-launcher-'));
  try {
    const captured = {};
    const fakeStore = {
      initialize() { captured.initialized = true; },
      readAttempts() { return { attempts: [] }; },
    };
    const result = await runCliStage({
      stage: STAGE_BOTH,
      environment: { SIM_CHAT_ACTIVE_DEADLINE_AT_MS: String(NOW + 90_000) },
      clock: () => NOW,
      write: () => {},
      lockProofVerifier: () => true,
      nextWakeReader: () => FAR_WAKE,
      storeFactory: () => fakeStore,
      chatDiaryStore: {
        initialize() { captured.diaryInitialized = true; },
        write(input) {
          captured.diaryInput = input;
          return { ok: true, durable: true, file: path.join(directory, 'chat-diary-test.md') };
        },
      },
      privateOutboxFactory: () => ({ read: () => ({ attempts: [] }) }),
      communicationAuthorizationFile: path.join(directory, 'auth.json'),
      authorizationAdapter: { build() {}, issue() {} },
      publicHistoryFile: path.join(directory, 'history.jsonl'),
      publicHistoryReader: () => [],
      businessSnapshotLoader: { load: () => ({
        schemaVersion: 1, snapshotId: 'bs1:launcher', observedAt: new Date(NOW).toISOString(),
        inventory: [], markets: [], economics: [],
        transport: { status: 'unknown', observedAt: new Date(NOW).toISOString(), entries: [] },
        finance: { status: 'unknown', observedAt: new Date(NOW).toISOString() },
      }) },
      decisionProvider: { decide: async () => ({ action: 'ignore' }) },
      actionRunnerFactory: ({ allowedActions }) => async action => {
        if (allowedActions.has('chat_rooms_discover')) {
          if (action === 'chat_rooms_discover') return { ok: true, rooms: [{ room: 'Sales' }] };
          if (action === 'chat_contact_list') {
            return { ok: true, contacts: [{ company: 'Buyer Corp', companyId: 42, unread: 1 }] };
          }
        }
        throw new Error('cycle runner must be consumed only by the worker stub');
      },
      runCycle: async options => {
        captured.cycle = options;
        return {
          ok: false,
          actions: [],
          observations: [],
          proposals: [
            {
              action: 'chat_room_reply', economicAuthorizationRequired: true,
              tradeSide: 'sell', previewStatus: 'VERIFIED',
            },
            {
              action: 'chat_room_post', economicAuthorizationRequired: true,
              tradeSide: 'buy', previewStatus: 'VERIFIED',
            },
          ],
          outcomes: [],
          strictInboundMessages: 7,
          metrics: { reads: 2, decisionCalls: 1, previews: 0, confirmAttempts: 0 },
          errors: [
            { stage: 'decision', reason: 'provider-decision-not-validated' },
            { stage: 'PRIVATEBODY123', reason: 'PRIVATEBODY123' },
          ],
        };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCount, 2);
    assert.deepEqual(result.errorCodes, [
      'decision:provider-decision-not-validated',
      'UNKNOWN:UNKNOWN',
    ]);
    assert.equal(JSON.stringify(result).includes('PRIVATEBODY123'), false);
    assert.equal(result.strictInboundMessages, 7);
    assert.equal(result.publicReplyProposals, 1);
    assert.equal(result.proactivePublicPostProposals, 1);
    assert.equal(result.economicPublicProposals, 2);
    assert.equal(result.buyProposals, 1);
    assert.equal(result.sellProposals, 1);
    assert.equal(result.exactShadowPreviews, 2);
    assert.deepEqual(result.metrics, {
      reads: 2,
      decisionCalls: 1,
      previews: 0,
      confirmAttempts: 0,
    });
    assert.equal(captured.initialized, true);
    assert.equal(captured.diaryInitialized, true);
    assert.equal(captured.diaryInput.mode, 'shadow');
    assert.equal(captured.diaryInput.result.strictInboundMessages, 7);
    assert.deepEqual(result.chatDiary, { durable: true, file: 'chat-diary-test.md' });
    assert.equal(captured.cycle.mode, 'shadow');
    assert.deepEqual(captured.cycle.readRequests.map(entry => entry.conversationId),
      ['company-42', 'Sales']);
    assert.deepEqual(captured.cycle.proactiveRoomIds, ['Sales']);
    assert.equal(captured.cycle.publicSafetyByRoom.Sales.status, 'ok');
    assert.equal(captured.cycle.store, fakeStore);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cycle exceptions write only a fixed aggregate diary and retain the original exception', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-active-launcher-error-'));
  try {
    let failureDiary = null;
    const result = await runCliStage({
      stage: STAGE_BOTH,
      environment: { SIM_CHAT_ACTIVE_DEADLINE_AT_MS: String(NOW + 90_000) },
      clock: () => NOW,
      write: () => {},
      lockProofVerifier: () => true,
      nextWakeReader: () => FAR_WAKE,
      storeFactory: () => ({ initialize() {}, readAttempts: () => ({ attempts: [] }) }),
      chatDiaryStore: {
        initialize() {},
        write(input) {
          failureDiary = input;
          throw new Error('secondary diary failure');
        },
      },
      privateOutboxFactory: () => ({ read: () => ({ attempts: [] }) }),
      communicationAuthorizationFile: path.join(directory, 'auth.json'),
      authorizationAdapter: { build() {}, issue() {} },
      publicHistoryFile: path.join(directory, 'history.jsonl'),
      publicHistoryReader: () => [],
      businessSnapshotLoader: { load: () => ({
        schemaVersion: 1, snapshotId: 'bs1:launcher-error', observedAt: new Date(NOW).toISOString(),
        inventory: [], markets: [], economics: [],
        transport: { status: 'unknown', observedAt: new Date(NOW).toISOString(), entries: [] },
        finance: { status: 'unknown', observedAt: new Date(NOW).toISOString() },
      }) },
      decisionProvider: { decide: async () => ({ action: 'ignore' }) },
      actionRunnerFactory: ({ allowedActions }) => async action => {
        if (allowedActions.has('chat_rooms_discover')) {
          if (action === 'chat_rooms_discover') return { ok: true, rooms: [{ room: 'Sales' }] };
          if (action === 'chat_contact_list') return { ok: true, contacts: [] };
        }
        throw new Error('cycle runner must not be called by the throwing stub');
      },
      runCycle: async () => { throw new Error('PRIVATEBODY123'); },
    });
    assert.equal(result.reason, 'active-chat-cli-error');
    assert.equal(result.error, 'PRIVATEBODY123');
    assert.ok(failureDiary);
    assert.deepEqual(failureDiary.result.errors, [{
      stage: 'decision', reason: 'active-cycle-unhandled-error',
    }]);
    assert.equal(JSON.stringify(failureDiary).includes('PRIVATEBODY123'), false);
    assert.equal(JSON.stringify(failureDiary).includes('secondary diary failure'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
