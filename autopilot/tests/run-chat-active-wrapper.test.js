'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const wrapper = path.resolve(__dirname, '..', 'run-chat-active.sh');
const source = fs.readFileSync(wrapper, 'utf8');

test('chat rollout wrapper has valid shell syntax', () => {
  const result = spawnSync('/bin/bash', ['-n', wrapper], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('chat rollout wrapper defaults to a non-mutating no-LLM shadow cycle', () => {
  assert.match(source, /SIM_CHAT_ACTIVE_MODE:-shadow/u);
  assert.match(source, /SIM_CHAT_LLM_ENABLED:-false/u);
  assert.match(source, /SIM_CHAT_REAL_SEND_ENABLED:-false/u);
  assert.match(source, /mutation-capable mode requires the real-send control/u);
  assert.match(source, /mutation-capable mode requires the LLM control/u);
});

test('chat rollout wrapper reads only the named key from an owner-private regular file', () => {
  assert.match(source, /O_NOFOLLOW/u);
  assert.match(source, /stat\.uid !== process\.getuid\(\)/u);
  assert.match(source, /\(stat\.mode & 0o077\) !== 0/u);
  assert.match(source, /matches\.length !== 1/u);
  assert.doesNotMatch(source, /^\s*(?:source|\.)\s+[^\n]*CREDENTIAL_FILE/mu);
});

test('chat rollout wrapper bounds execution and rotates private logs', () => {
  assert.match(source, /OUTER_TIMEOUT_SECONDS=270/u);
  assert.match(source, /--kill-after="\$\{KILL_GRACE_SECONDS\}s"/u);
  assert.match(source, /LOG_LIMIT_BYTES=5242880/u);
  assert.match(source, /LOG_ARCHIVE_COUNT=5/u);
  assert.match(source, /umask 077/u);
  assert.doesNotMatch(source, /\bsleep\b/u);
});
