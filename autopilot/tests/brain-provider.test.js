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
  assert.match(runner, /BRAIN_MODEL=deepseek-v4-pro/);
  assert.match(runner, /BRAIN_EFFORT=max/);
  assert.match(runner, /COUNCIL_PROVIDER=deepseek/);
  assert.match(runner, /COUNCIL_EFFORT=max/);
  assert.match(runner, /BRAIN_PROVIDER=openai/);
  assert.match(runner, /BRAIN_MODEL=gpt-5\.6-terra/);
  assert.match(runner, /COUNCIL_MODEL=gpt-5\.6-luna/);
  assert.match(runner, /brain-provider\.js" record "\$BRAIN_PROVIDER" "\$rc"/);
});
