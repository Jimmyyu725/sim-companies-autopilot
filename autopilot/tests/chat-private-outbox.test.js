'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  PrivateSendOutbox,
  runDurablePrivateSendAttempt,
} = require('../chat/private-outbox.js');

const AUTOPILOT = path.join(__dirname, '..');
const NOW = new Date('2026-07-27T20:00:00.000Z');

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-private-outbox-'));
  const root = path.join(parent, 'runtime');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root, outbox: new PrivateSendOutbox(root) };
}

function attempt(attemptId = 'private-attempt-001', overrides = {}) {
  return {
    attemptId,
    targetCompany: 'Buyer Corp',
    targetCompanyId: 42,
    messageText: 'Still available?',
    sourceText: null,
    source: {
      kind: 'proactive',
      exactText: null,
      messageId: null,
      createdAt: null,
      authorCompany: null,
      authorCompanyId: null,
      evidenceStatus: 'NOT_APPLICABLE_PROACTIVE',
      matchCount: 0,
      observationFingerprint: null,
    },
    runtimeMode: 'full',
    ...overrides,
  };
}

function preflight(value = attempt()) {
  return {
    ok: true,
    dry: true,
    targetCompany: value.targetCompany,
    targetCompanyId: value.targetCompanyId,
    attemptId: value.attemptId,
    wouldSend: value.messageText,
    destinationRoute: value.targetCompany,
    destinationVerified: true,
    targetIdVerified: true,
    composerEmpty: true,
    exactOwnMessageAbsent: true,
  };
}

function evidence(runtimeMode = 'full') {
  return {
    runtimeMode,
    destinationRoute: 'Buyer Corp',
    destinationVerified: true,
    targetIdVerified: true,
    composerEmpty: true,
    exactOwnMessageAbsent: true,
    capturedAt: NOW.toISOString(),
  };
}

test('exact attempt is fsynced before send callback and then durably marked sent', async t => {
  const { root, outbox } = workspace(t);
  const value = attempt();
  const order = [];
  const result = await runDurablePrivateSendAttempt({
    outbox,
    attempt: value,
    now: () => NOW,
    preflight: async () => {
      order.push('preflight');
      return preflight(value);
    },
    send: async armed => {
      order.push('send');
      assert.equal(armed.status, 'armed');
      assert.equal(new PrivateSendOutbox(root).getAttempt(value.attemptId).status, 'armed');
      return { ok: true, posted: true, mutationAttempted: true };
    },
  });
  assert.deepEqual(order, ['preflight', 'send']);
  assert.equal(result.ok, true);
  assert.equal(result.privateOutboxStatus, 'sent');

  const stored = new PrivateSendOutbox(root).getAttempt(value.attemptId);
  assert.equal(stored.status, 'sent');
  assert.deepEqual(stored.target, { company: 'Buyer Corp', companyId: 42 });
  assert.deepEqual(stored.source, value.source);
  assert.deepEqual(stored.message, { exactText: 'Still available?' });
  assert.equal(stored.evidence.destinationVerified, true);
  assert.equal(stored.outcomeCode, 'unique-ui-postcondition');
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'outbox.json')).mode & 0o777, 0o600);
});

test('UI exception becomes ambiguous and a new process cannot replay the attempt', async t => {
  const { root, outbox } = workspace(t);
  const value = attempt('private-attempt-ambiguous');
  const first = await runDurablePrivateSendAttempt({
    outbox,
    attempt: value,
    now: () => NOW,
    preflight: async () => preflight(value),
    send: async () => { throw new Error('browser vanished after possible click'); },
  });
  assert.equal(first.ok, false);
  assert.equal(first.ambiguous, true);
  assert.equal(first.doNotRetry, true);
  assert.equal(first.privateOutboxStatus, 'ambiguous');

  const afterRestart = new PrivateSendOutbox(root);
  assert.equal(afterRestart.getAttempt(value.attemptId).status, 'ambiguous');
  let callbackCalls = 0;
  const replay = await runDurablePrivateSendAttempt({
    outbox: afterRestart,
    attempt: value,
    now: () => NOW,
    preflight: async () => { callbackCalls += 1; return preflight(value); },
    send: async () => { callbackCalls += 1; return { ok: true, posted: true, mutationAttempted: true }; },
  });
  assert.equal(callbackCalls, 0);
  assert.equal(replay.replayBlocked, true);
  assert.equal(replay.privateOutboxStatus, 'ambiguous');

  const newIdSamePayload = attempt('private-attempt-ambiguous-new-id');
  const semanticReplay = await runDurablePrivateSendAttempt({
    outbox: afterRestart,
    attempt: newIdSamePayload,
    now: () => NOW,
    preflight: async () => preflight(newIdSamePayload),
    send: async () => { callbackCalls += 1; return { ok: true, posted: true, mutationAttempted: true }; },
  });
  assert.equal(callbackCalls, 0);
  assert.equal(semanticReplay.replayBlocked, true);
  assert.equal(afterRestart.read().attempts.length, 1);
});

test('a crash-window armed record is replay-blocking after process restart', async t => {
  const { root, outbox } = workspace(t);
  const value = attempt('private-attempt-armed-crash');
  outbox.armAttempt({ ...value, evidence: evidence() }, NOW);

  let sendCalls = 0;
  const afterRestart = new PrivateSendOutbox(root);
  const result = await runDurablePrivateSendAttempt({
    outbox: afterRestart,
    attempt: value,
    now: () => NOW,
    preflight: async () => preflight(value),
    send: async () => { sendCalls += 1; return { ok: true, posted: true, mutationAttempted: true }; },
  });
  assert.equal(sendCalls, 0);
  assert.equal(result.replayBlocked, true);
  assert.equal(result.privateOutboxStatus, 'armed');
  assert.equal(afterRestart.getAttempt(value.attemptId).status, 'armed');
});

test('proven pre-click failure is terminal for its ID but a distinct attempt may proceed', async t => {
  const { outbox } = workspace(t);
  const firstAttempt = attempt('private-attempt-preclick');
  const failed = await runDurablePrivateSendAttempt({
    outbox,
    attempt: firstAttempt,
    now: () => NOW,
    preflight: async () => preflight(firstAttempt),
    send: async () => ({ ok: false, reason: 'composer became unavailable before click' }),
  });
  assert.equal(failed.privateOutboxStatus, 'pre-click-failed');
  assert.equal(outbox.getAttempt(firstAttempt.attemptId).outcomeCode, 'ui-refused-before-click');

  const secondAttempt = attempt('private-attempt-new-id');
  const sent = await runDurablePrivateSendAttempt({
    outbox,
    attempt: secondAttempt,
    now: () => NOW,
    preflight: async () => preflight(secondAttempt),
    send: async () => ({ ok: true, posted: true, mutationAttempted: true }),
  });
  assert.equal(sent.privateOutboxStatus, 'sent');
  assert.equal(outbox.read().attempts.length, 2);
});

test('invalid preflight or unavailable persistence never invokes the send callback', async t => {
  const { parent, root, outbox } = workspace(t);
  const value = attempt('private-attempt-no-arm');
  let sendCalls = 0;
  const invalid = await runDurablePrivateSendAttempt({
    outbox,
    attempt: value,
    now: () => NOW,
    preflight: async () => ({ ...preflight(value), targetIdVerified: false }),
    send: async () => { sendCalls += 1; },
  });
  assert.equal(invalid.preClickFailure, true);
  assert.equal(sendCalls, 0);
  assert.equal(fs.existsSync(root), false);

  const outside = path.join(parent, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, root);
  const symlinked = await runDurablePrivateSendAttempt({
    outbox: new PrivateSendOutbox(root),
    attempt: value,
    now: () => NOW,
    preflight: async () => preflight(value),
    send: async () => { sendCalls += 1; },
  });
  assert.equal(symlinked.preClickFailure, true);
  assert.match(symlinked.reason, /outbox is unreadable/u);
  assert.equal(sendCalls, 0);
});

test('act.js blocks a persisted ambiguous attempt before any browser connection', t => {
  const { root, outbox } = workspace(t);
  const value = attempt('private-attempt-restart');
  outbox.armAttempt({ ...value, evidence: evidence() }, NOW);
  outbox.transitionAttempt(value.attemptId, 'ambiguous', 'click-outcome-unproven', NOW);

  const result = spawnSync(process.execPath, [
    path.join(AUTOPILOT, 'act.js'),
    'chat_private_send',
    JSON.stringify({
      targetCompany: value.targetCompany,
      targetCompanyId: value.targetCompanyId,
      text: value.messageText,
      inReplyToText: null,
      sourceMessageId: '1001',
      sourceCreatedAt: NOW.toISOString(),
      attemptId: value.attemptId,
      confirm: true,
    }),
  ], {
    cwd: path.dirname(AUTOPILOT),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SIM_CHAT_MODE: 'full',
      SIM_CHAT_PRIVATE_OUTBOX_ROOT: root,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.ok, false);
  assert.equal(output.replayBlocked, true);
  assert.equal(output.privateOutboxStatus, 'ambiguous');
  assert.match(output.reason, /durable NAS outbox/u);
});

test('durable status, not sessionStorage or caller claims, gates retry assessment', t => {
  const { root, outbox } = workspace(t);
  const value = attempt('private-attempt-retry-block');
  outbox.armAttempt({ ...value, evidence: evidence() }, NOW);
  outbox.transitionAttempt(value.attemptId, 'ambiguous', 'click-outcome-unproven', NOW);
  const result = spawnSync(process.execPath, [
    path.join(AUTOPILOT, 'act.js'),
    'chat_private_retry_assess',
    JSON.stringify({
      targetCompany: value.targetCompany,
      text: value.messageText,
      originalAttemptId: value.attemptId,
      originalOutcome: 'PRE_CLICK_FAILURE',
    }),
  ], {
    cwd: path.dirname(AUTOPILOT),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SIM_CHAT_MODE: 'full',
      SIM_CHAT_PRIVATE_OUTBOX_ROOT: root,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.ok, false);
  assert.equal(output.replayBlocked, true);
  assert.equal(output.privateOutboxStatus, 'ambiguous');
});
