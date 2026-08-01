'use strict';

const fs = require('fs');
const path = require('path');

const BRAIN_DIR = __dirname;
const ACTIVE_PROVIDER_FILE = path.join(BRAIN_DIR, '.active-brain-provider');
const HEALTH_FILE = path.join(BRAIN_DIR, '.brain-provider-health.json');
// The fallback used to be permanent: once a DeepSeek failure streak switched the active provider to
// OpenAI, nothing ever switched it back, so the owner's chosen primary stayed off and every wake
// cost about seven times more (measured 2026-08-01: $0.69 versus $0.09). Recovery is half-open —
// after enough consecutive successful fallback wakes the primary is tried again, and the existing
// failure threshold simply falls back once more if it is still broken. The required number of
// successes doubles per fallback so a genuinely broken primary is not retried in a tight loop.
const FALLBACK_RECOVERY_SUCCESSES = 2;
const MAX_FALLBACK_RECOVERY_SUCCESSES = 16;
const DEEPSEEK_KEY_FILE = '/home/jimmy/.config/sim-benchmark/deepseek-v4-pro.txt';
const OPENAI_ENV_FILE = '/srv/appdata/ledgerwall/.env';
const PROVIDERS = new Set(['openai', 'deepseek']);
const FAILURE_THRESHOLD = 2;

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error('provider must be openai or deepseek');
  return provider;
}

function writeAtomic(filePath, content, mode = 0o600) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
}

function readActiveProvider(filePath = ACTIVE_PROVIDER_FILE) {
  if (!fs.existsSync(filePath)) return 'openai';
  return normalizeProvider(fs.readFileSync(filePath, 'utf8'));
}

function providerReadiness(provider) {
  const resolved = normalizeProvider(provider);
  if (resolved === 'deepseek') {
    if (!fs.existsSync(DEEPSEEK_KEY_FILE)) {
      return { ok: false, provider: resolved, reason: 'DeepSeek key file is missing.' };
    }
    const stats = fs.statSync(DEEPSEEK_KEY_FILE);
    if ((stats.mode & 0o777) !== 0o600) {
      return { ok: false, provider: resolved, reason: 'DeepSeek key file mode must be 0600.' };
    }
    const value = fs.readFileSync(DEEPSEEK_KEY_FILE, 'utf8').trim();
    if (!value.startsWith('sk-') || value.length < 16) {
      return { ok: false, provider: resolved, reason: 'DeepSeek key file is empty or malformed.' };
    }
    return { ok: true, provider: resolved, credentialSource: DEEPSEEK_KEY_FILE };
  }
  if (!fs.existsSync(OPENAI_ENV_FILE)) {
    return { ok: false, provider: resolved, reason: 'OpenAI environment file is missing.' };
  }
  const environment = fs.readFileSync(OPENAI_ENV_FILE, 'utf8');
  if (!/^OPENAI_API_KEY=.+$/mu.test(environment)) {
    return { ok: false, provider: resolved, reason: 'OpenAI key entry is missing.' };
  }
  return { ok: true, provider: resolved, credentialSource: OPENAI_ENV_FILE };
}

function resetHealth(provider, now = new Date().toISOString(), filePath = HEALTH_FILE) {
  writeAtomic(filePath, `${JSON.stringify({
    schemaVersion: 1,
    provider: normalizeProvider(provider),
    consecutiveFailures: 0,
    updatedAt: now,
  })}\n`);
}

function switchProvider(provider, options = {}) {
  const resolved = normalizeProvider(provider);
  if (options.confirm !== true) throw new Error('switch requires confirm:true');
  const readinessCheck = options.readinessCheck || providerReadiness;
  const readiness = readinessCheck(resolved);
  if (!readiness.ok) throw new Error(readiness.reason);
  const activeProviderFile = options.activeProviderFile || ACTIVE_PROVIDER_FILE;
  const healthFile = options.healthFile || HEALTH_FILE;
  writeAtomic(activeProviderFile, `${resolved}\n`);
  resetHealth(resolved, options.now, healthFile);
  return {
    ok: true,
    provider: resolved,
    activeProviderFile,
    credentialSource: readiness.credentialSource,
  };
}

function readHealth(filePath = HEALTH_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const health = {
      schemaVersion: 1,
      provider: normalizeProvider(value.provider),
      consecutiveFailures: Math.max(0, Number(value.consecutiveFailures) || 0),
      updatedAt: value.updatedAt || null,
    };
    // Fallback bookkeeping must survive this normalization: recovery reads it back on the next
    // wake, and dropping it silently pinned the account to the fallback provider forever.
    const attempts = Math.max(0, Number(value.fallbackAttempts) || 0);
    if (attempts > 0) health.fallbackAttempts = attempts;
    const successes = Math.max(0, Number(value.fallbackSuccesses) || 0);
    if (attempts > 0) health.fallbackSuccesses = successes;
    if (value.fallbackProvider) health.fallbackProvider = normalizeProvider(value.fallbackProvider);
    if (value.primaryRestoredAt) health.primaryRestoredAt = value.primaryRestoredAt;
    return health;
  } catch (_) {
    return null;
  }
}

function recordProviderResult(provider, rc, options = {}) {
  const resolved = normalizeProvider(provider);
  const exitCode = Number(rc);
  if (!Number.isInteger(exitCode)) throw new Error('rc must be an integer');
  const now = options.now || new Date().toISOString();
  const activeProviderFile = options.activeProviderFile || ACTIVE_PROVIDER_FILE;
  const healthFile = options.healthFile || HEALTH_FILE;
  const readinessCheck = options.readinessCheck || providerReadiness;
  const previous = readHealth(healthFile);
  const consecutiveFailures = exitCode === 0
    ? 0
    : (previous?.provider === resolved ? previous.consecutiveFailures : 0) + 1;
  const state = {
    schemaVersion: 1,
    provider: resolved,
    consecutiveFailures,
    lastRc: exitCode,
    updatedAt: now,
  };
  // Carry the fallback bookkeeping through every write. A wake that neither falls back nor counts
  // toward recovery must not silently reset the backoff.
  const carriedAttempts = Math.max(0, Number(previous?.fallbackAttempts) || 0);
  if (carriedAttempts > 0) {
    state.fallbackAttempts = carriedAttempts;
    state.fallbackSuccesses = Math.max(0, Number(previous?.fallbackSuccesses) || 0);
  }
  let fallbackActivated = false;
  if (resolved === 'deepseek' &&
      consecutiveFailures >= FAILURE_THRESHOLD &&
      readActiveProvider(activeProviderFile) === 'deepseek') {
    const readiness = readinessCheck('openai');
    if (readiness.ok) {
      writeAtomic(activeProviderFile, 'openai\n');
      state.fallbackProvider = 'openai';
      state.fallbackActivatedAt = now;
      fallbackActivated = true;
    } else {
      state.fallbackBlocked = readiness.reason;
    }
  }
  let primaryRestored = false;
  const fallbackAttempts = Math.max(1, carriedAttempts);
  if (fallbackActivated) {
    state.fallbackAttempts = fallbackAttempts;
    state.fallbackSuccesses = 0;
  } else if (resolved === 'openai' && readActiveProvider(activeProviderFile) === 'openai' &&
      Number(previous?.fallbackAttempts) > 0) {
    state.fallbackAttempts = Number(previous.fallbackAttempts);
    const successes = exitCode === 0 ? (Number(previous?.fallbackSuccesses) || 0) + 1 : 0;
    state.fallbackSuccesses = successes;
    const required = Math.min(MAX_FALLBACK_RECOVERY_SUCCESSES,
      FALLBACK_RECOVERY_SUCCESSES * state.fallbackAttempts);
    if (successes >= required && readinessCheck('deepseek').ok) {
      writeAtomic(activeProviderFile, 'deepseek\n');
      state.fallbackAttempts += 1;
      state.fallbackSuccesses = 0;
      state.primaryRestoredAt = now;
      primaryRestored = true;
    }
  }
  writeAtomic(healthFile, `${JSON.stringify(state)}\n`);
  return {
    ok: true,
    provider: resolved,
    rc: exitCode,
    consecutiveFailures,
    fallbackActivated,
    primaryRestored,
    activeProvider: readActiveProvider(activeProviderFile),
  };
}

function main(argv = process.argv.slice(2)) {
  const [command, value, confirmation] = argv;
  if (command === 'current') {
    process.stdout.write(`${readActiveProvider()}\n`);
    return;
  }
  if (command === 'check') {
    const result = providerReadiness(value || readActiveProvider());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'switch') {
    const result = switchProvider(value, { confirm: confirmation === '--confirm' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'record') {
    const result = recordProviderResult(value, argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error('usage: brain-provider.js current | check [provider] | switch <provider> --confirm | record <provider> <rc>');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`BRAIN PROVIDER ERR ${String(error.message || error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ACTIVE_PROVIDER_FILE,
  DEEPSEEK_KEY_FILE,
  FAILURE_THRESHOLD,
  FALLBACK_RECOVERY_SUCCESSES,
  HEALTH_FILE,
  OPENAI_ENV_FILE,
  normalizeProvider,
  providerReadiness,
  readActiveProvider,
  readHealth,
  recordProviderResult,
  switchProvider,
};
