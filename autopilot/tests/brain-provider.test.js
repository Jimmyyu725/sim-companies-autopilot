'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FAILURE_THRESHOLD,
  readActiveProvider,
  readHealth,
  recordProviderResult,
  switchProvider,
} = require('../brain-provider.js');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-provider-'));
  return {
    directory,
    activeProviderFile: path.join(directory, 'active-provider'),
    healthFile: path.join(directory, 'health.json'),
    ownerPrimaryFile: path.join(directory, 'owner-primary'),
    readinessCheck: provider => ({
      ok: true,
      provider,
      credentialSource: `/test/${provider}`,
    }),
  };
}

test('missing runtime provider file safely defaults to retained OpenAI', () => {
  const value = fixture();
  assert.equal(readActiveProvider(value.activeProviderFile), 'openai');
});

test('confirmed provider switch writes owner-only state and resets health', () => {
  const value = fixture();
  const result = switchProvider('deepseek', {
    confirm: true,
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    readinessCheck: value.readinessCheck,
    now: '2026-07-30T00:00:00.000Z',
  });
  assert.equal(result.provider, 'deepseek');
  assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek');
  assert.equal(fs.statSync(value.activeProviderFile).mode & 0o777, 0o600);
  assert.deepEqual(readHealth(value.healthFile), {
    schemaVersion: 1,
    provider: 'deepseek',
    consecutiveFailures: 0,
    updatedAt: '2026-07-30T00:00:00.000Z',
  });
});

test('two consecutive DeepSeek failures automatically activate retained OpenAI', () => {
  const value = fixture();
  switchProvider('deepseek', {
    confirm: true,
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    readinessCheck: value.readinessCheck,
  });
  const first = recordProviderResult('deepseek', 1, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    readinessCheck: value.readinessCheck,
    now: '2026-07-30T00:01:00.000Z',
  });
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.fallbackActivated, false);
  assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek');

  const second = recordProviderResult('deepseek', 124, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    readinessCheck: value.readinessCheck,
    now: '2026-07-30T00:02:00.000Z',
  });
  assert.equal(FAILURE_THRESHOLD, 2);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.fallbackActivated, true);
  assert.equal(second.activeProvider, 'openai');
});

test('a successful DeepSeek wake resets the consecutive failure count', () => {
  const value = fixture();
  switchProvider('deepseek', {
    confirm: true,
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    readinessCheck: value.readinessCheck,
  });
  recordProviderResult('deepseek', 1, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    readinessCheck: value.readinessCheck,
  });
  const result = recordProviderResult('deepseek', 0, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    readinessCheck: value.readinessCheck,
  });
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(result.activeProvider, 'deepseek');
});

test('wake runner preflights before browser access and retains both provider profiles', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'run-brain.sh'), 'utf8');
  const providerRead = runner.indexOf('brain-provider.js" current');
  const stateCapture = runner.indexOf('node "$AUTOPILOT/state.js"');
  assert.ok(providerRead >= 0 && stateCapture > providerRead);
  assert.match(runner, /BRAIN_PROVIDER=deepseek/);
  assert.match(runner, /BRAIN_MODEL=deepseek-v4-flash/);
  assert.match(runner, /BRAIN_EFFORT=max/);
  assert.match(runner, /COUNCIL_PROVIDER=deepseek/);
  assert.match(runner, /COUNCIL_EFFORT=max/);
  assert.match(runner, /BRAIN_PROVIDER=openai/);
  assert.match(runner, /BRAIN_MODEL=gpt-5\.6-terra/);
  assert.match(runner, /COUNCIL_MODEL=gpt-5\.6-luna/);
  assert.match(runner, /brain-provider\.js" record "\$BRAIN_PROVIDER" "\$rc"/);
});

// Regression (2026-08-01): the DeepSeek fallback was permanent. After two exhausted DeepSeek wakes
// the active provider became OpenAI and nothing ever restored the owner's chosen primary, so every
// later wake cost about seven times more ($0.69 versus $0.09 measured). Recovery must be half-open.
test('successful fallback wakes restore the primary provider, with backoff', () => {
  const value = fixture();
  const options = {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  };
  switchProvider('deepseek', { confirm: true, ...options });

  for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) {
    recordProviderResult('deepseek', 1, options);
  }
  assert.equal(readActiveProvider(value.activeProviderFile), 'openai', 'failures fall back');

  // One success is not enough to hand the wake back to the primary.
  const first = recordProviderResult('openai', 0, options);
  assert.equal(first.primaryRestored, false);
  assert.equal(readActiveProvider(value.activeProviderFile), 'openai');

  const second = recordProviderResult('openai', 0, options);
  assert.equal(second.primaryRestored, true);
  assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek');
  assert.equal(readHealth(value.healthFile).fallbackSuccesses, 0);

  // A failing fallback wake resets the streak instead of counting toward recovery.
  for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) {
    recordProviderResult('deepseek', 1, options);
  }
  assert.equal(readActiveProvider(value.activeProviderFile), 'openai');
  recordProviderResult('openai', 0, options);
  recordProviderResult('openai', 1, options);
  assert.equal(readHealth(value.healthFile).fallbackSuccesses, 0, 'a failure clears the streak');

  // Second fallback needs more successes than the first (backoff).
  recordProviderResult('openai', 0, options);
  recordProviderResult('openai', 0, options);
  assert.equal(readActiveProvider(value.activeProviderFile), 'openai', 'backoff still holding');
  recordProviderResult('openai', 0, options);
  recordProviderResult('openai', 0, options);
  assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek');
});

// Regression (2026-08-01, found live): recovery keyed off bookkeeping that a fallback activated by
// the previous release never wrote, so three consecutive successful wakes left the account stranded
// on the costlier fallback. Recovery must key off the owner's recorded primary instead.
test('a fallback with no recorded bookkeeping still restores the owner primary', () => {
  const value = fixture();
  const options = {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  };
  switchProvider('deepseek', { confirm: true, ...options });
  // Simulate the stranded live state: active is the fallback and the health record carries none of
  // the recovery fields (exactly what the pre-recovery release left behind).
  fs.writeFileSync(value.activeProviderFile, 'openai\n');
  fs.writeFileSync(value.healthFile, `${JSON.stringify({
    schemaVersion: 1, provider: 'openai', consecutiveFailures: 0, lastRc: 0,
    updatedAt: '2026-08-01T12:01:02.050Z',
  })}\n`);

  assert.equal(recordProviderResult('openai', 0, options).primaryRestored, false);
  const restored = recordProviderResult('openai', 0, options);
  assert.equal(restored.primaryRestored, true);
  assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek');
});

test('an owner who chose the fallback provider is never auto-reverted', () => {
  const value = fixture();
  const options = {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  };
  switchProvider('openai', { confirm: true, ...options });
  for (let wake = 0; wake < 6; wake += 1) {
    assert.equal(recordProviderResult('openai', 0, options).primaryRestored, false);
  }
  assert.equal(readActiveProvider(value.activeProviderFile), 'openai');
});
