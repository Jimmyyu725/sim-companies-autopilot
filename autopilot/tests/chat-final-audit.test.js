'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHAT_MUTATION_ACTIONS,
  authorizeChatAction,
  resolveChatMode,
} = require('../chat/runtime-mode.js');
const {
  nextWakeTimestamp,
} = require('../chat/shadow-worker.js');
const {
  INTERNAL_LOCK_PROOF_ENV,
  STAGE_BOTH,
  STAGE_BRAIN,
  runCliStage,
  verifyLockStageProof,
} = require('../chat-shadow.js');
const {
  inspectOutgoingText,
} = require('../chat/policy.js');

const CONFIRMED_PARAMS = Object.freeze({
  chat_private_send: {
    confirm: true,
    targetCompanyId: 123,
    inReplyToText: 'Exact rendered incoming message',
  },
});

test('release boundary defaults to shadow and rejects every confirmed chat mutation', () => {
  assert.equal(resolveChatMode({}), 'shadow');
  for (const action of CHAT_MUTATION_ACTIONS) {
    const params = CONFIRMED_PARAMS[action] || { confirm: true };
    const result = authorizeChatAction(action, params, resolveChatMode({}));
    assert.equal(result.ok, false, action);
    assert.equal(result.guard, true, action);
  }
});

test('legacy public posting and direct contracts remain blocked in every runtime mode', () => {
  for (const mode of ['off', 'read-only', 'shadow', 'safe-reply', 'full']) {
    for (const action of ['chat_post', 'contract_send', 'contract_accept']) {
      const result = authorizeChatAction(action, { confirm: true }, mode);
      assert.equal(result.ok, false, `${mode}:${action}`);
    }
  }
});

test('next wake accepts only the shared strict alarm representation', () => {
  const at = Date.parse('2026-07-27T20:00:00.000Z');
  assert.equal(nextWakeTimestamp({
    at,
    atIso: new Date(at).toISOString(),
    reason: 'verified future wake',
  }), at);
  assert.equal(nextWakeTimestamp({ at }), null);
  assert.equal(nextWakeTimestamp({ at, atIso: new Date(at).toISOString() }), null);
  assert.equal(nextWakeTimestamp({ at: at + 1, atIso: new Date(at).toISOString(), reason: 'mismatch' }), null);
  assert.equal(nextWakeTimestamp({ at: 1.5, atIso: new Date(1.5).toISOString(), reason: 'fraction' }), null);
});

test('internal CLI stages cannot be entered without inherited lock proof', async () => {
  for (const stage of [STAGE_BRAIN, STAGE_BOTH]) {
    const output = [];
    const result = await runCliStage({
      stage,
      environment: {},
      lockProofVerifier: () => false,
      nextWakeReader: () => { throw new Error('must not read next wake without lock proof'); },
      write: value => output.push(value),
    });
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: 'internal-stage-lock-proof-invalid',
    });
    assert.equal(output.length, 1);
  }
});

test('a matching lock-file inode is insufficient without an ancestor-owned flock', () => {
  const environment = { [INTERNAL_LOCK_PROOF_ENV]: 'a'.repeat(64) };
  const sameStat = { dev: 1n, ino: 2n };
  assert.equal(verifyLockStageProof(STAGE_BRAIN, {
    environment,
    fstatSync: () => sameStat,
    statSync: () => sameStat,
    lockOwnershipVerifier: () => false,
  }), false);
  assert.equal(verifyLockStageProof(STAGE_BRAIN, {
    environment,
    fstatSync: () => sameStat,
    statSync: () => sameStat,
    lockOwnershipVerifier: () => true,
  }), true);
});

test('outgoing identity policy blocks invented names without blocking trade status', () => {
  for (const text of [
    "I'm Bob.",
    "I'm Bob, buying water.",
    'This is Alice.',
    'This is Alice: checking stock.',
    'Jay here. Still available?',
    '我是小王。',
    'My name is Trade Boss.',
  ]) {
    assert.equal(inspectOutgoingText(text).ok, false, text);
  }
  for (const text of [
    "I'm Buying Water",
    'This is Available',
    'I am Selling 10k Power',
    '我是买家。',
    '我是需要报价。',
  ]) {
    assert.equal(inspectOutgoingText(text).ok, true, text);
  }
});
