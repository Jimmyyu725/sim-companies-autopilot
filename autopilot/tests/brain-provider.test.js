'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FAILURE_THRESHOLD,
  OWNER_PRIMARY_FILE,
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
    ownerPrimaryFile: value.ownerPrimaryFile,
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
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  });
  const first = recordProviderResult('deepseek', 1, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
    now: '2026-07-30T00:01:00.000Z',
  });
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.fallbackActivated, false);
  assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek');

  const second = recordProviderResult('deepseek', 124, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
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
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  });
  recordProviderResult('deepseek', 1, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  });
  const result = recordProviderResult('deepseek', 0, {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
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

// Regression (2026-08-03, found live): every switchProvider() call in this file supplied
// activeProviderFile and healthFile fixture overrides but omitted ownerPrimaryFile, so each test
// run fell through to the real default and overwrote the operator's live provider choice on disk
// (autopilot/.owner-primary-provider) — twice reverting a manual openai switch back to deepseek,
// purely from running the test suite. This test proves the real file is never touched by a
// fixture-scoped switch, using both content and mtime so a coincidental content match (the real
// file already holding the same provider name the test happens to switch to) cannot mask a write:
// writeAtomic() always replaces the file via rename, which bumps mtime even when the bytes match.
test('switchProvider with a fully injected fixture never touches the real owner-primary file', () => {
  const value = fixture();
  const existedBefore = fs.existsSync(OWNER_PRIMARY_FILE);
  const statBefore = existedBefore ? fs.statSync(OWNER_PRIMARY_FILE) : null;
  const contentBefore = existedBefore ? fs.readFileSync(OWNER_PRIMARY_FILE, 'utf8') : null;

  switchProvider('deepseek', {
    confirm: true,
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  });

  const existedAfter = fs.existsSync(OWNER_PRIMARY_FILE);
  const statAfter = existedAfter ? fs.statSync(OWNER_PRIMARY_FILE) : null;
  const contentAfter = existedAfter ? fs.readFileSync(OWNER_PRIMARY_FILE, 'utf8') : null;

  assert.equal(existedAfter, existedBefore,
    'the real owner-primary file must not be created or deleted by a fixture-scoped switch');
  assert.equal(contentAfter, contentBefore,
    'the real owner-primary file content must not change');
  if (existedBefore) {
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs,
      'the real owner-primary file must not be rewritten, even if the content would coincidentally match');
  }
});
