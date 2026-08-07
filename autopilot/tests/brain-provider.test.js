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
  // Only when OpenAI is the owner's primary and DeepSeek is the temporary active engine. Owner
  // directive 2026-08-07 retired that fallback in the other direction; see the test below.
  const value = fixture();
  fs.writeFileSync(value.ownerPrimaryFile, 'openai\n');
  switchProvider('deepseek', {
    confirm: true,
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  });
  fs.writeFileSync(value.ownerPrimaryFile, 'openai\n');
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
test('the fallback-and-recover cycle is retired while DeepSeek is the owner primary', () => {
  // This test used to drive the whole cycle: DeepSeek primary -> two failures fall back to OpenAI
  // -> two clean OpenAI wakes restore DeepSeek -> a failure resets the streak, with the recovery
  // requirement doubling each time. Owner directive 2026-08-07 removed the first step, so the rest
  // is unreachable: automatic fallback no longer fires when the owner primary is deepseek, and
  // without a fallback there is nothing to recover from.
  //
  // The mechanism is intact in brain-provider.js for any other owner primary; what is asserted here
  // is that the configuration actually in use does not use it. Keeping the old assertions would have
  // meant pinning a cycle the system is no longer allowed to perform.
  const value = fixture();
  const options = {
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  };
  switchProvider('deepseek', { confirm: true, ...options });

  for (let attempt = 0; attempt < FAILURE_THRESHOLD + 2; attempt += 1) {
    const result = recordProviderResult('deepseek', 1, options);
    assert.equal(result.fallbackActivated, false);
    assert.equal(result.primaryRestored, false);
  }
  assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek',
    'repeated failures must keep failing on the owner\'s engine, not quietly change it');

  // check-alarm is what keeps the machine alive across those failures, not a provider switch.
  assert.ok(readHealth(value.healthFile).consecutiveFailures >= FAILURE_THRESHOLD);
  // Read the file rather than readHealth: that normaliser keeps only the fields recovery reads back
  // and drops diagnostics like this one, so asserting through it would have tested the reader.
  const raw = JSON.parse(fs.readFileSync(value.healthFile, 'utf8'));
  assert.match(String(raw.fallbackBlocked || ''), /retired/u,
    'the refusal must be recorded, so a reader can tell it was a decision');
});
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

// Owner directive 2026-08-07: DeepSeek permanently. Automatic fallback exists for an engine that is
// one of two with a live standby; it is not licence to overrule a standing choice. #88 closed the
// preflight path that rewrote owner intent on a credential error. This is the other one: it fires on
// any two consecutive non-zero exits — a provider 503, a wall-clock kill — and then needs 2, then 4,
// then 8 clean wakes on the wrong engine to come back, with nothing in brain.log to distinguish it
// from a deliberate switch.
test('a retired fallback is not reactivated by failures', () => {
  const value = fixture();
  switchProvider('deepseek', {
    confirm: true,
    activeProviderFile: value.activeProviderFile,
    healthFile: value.healthFile,
    ownerPrimaryFile: value.ownerPrimaryFile,
    readinessCheck: value.readinessCheck,
  });
  assert.equal(fs.readFileSync(value.ownerPrimaryFile, 'utf8').trim(), 'deepseek',
    'switching sets the owner primary, which is what retires the fallback');

  for (const [rc, when] of [[1, '00:01'], [124, '00:02'], [1, '00:03']]) {
    const result = recordProviderResult('deepseek', rc, {
      activeProviderFile: value.activeProviderFile,
      healthFile: value.healthFile,
      ownerPrimaryFile: value.ownerPrimaryFile,
      readinessCheck: value.readinessCheck,
      now: `2026-08-07T${when}:00.000Z`,
    });
    assert.equal(result.fallbackActivated, false, `rc=${rc} must not switch the engine`);
    assert.equal(readActiveProvider(value.activeProviderFile), 'deepseek');
  }
  // The refusal is recorded rather than silent, so a reader can tell it was a decision.
  const health = JSON.parse(fs.readFileSync(value.healthFile, 'utf8'));
  assert.match(String(health.fallbackBlocked || ''), /retired/u);
});
