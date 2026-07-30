'use strict';

const fs = require('fs');
const path = require('path');

const BRAIN_DIR = __dirname;
const ACTIVE_PROVIDER_FILE = path.join(BRAIN_DIR, '.active-brain-provider');
const HEALTH_FILE = path.join(BRAIN_DIR, '.brain-provider-health.json');
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
    return {
      schemaVersion: 1,
      provider: normalizeProvider(value.provider),
      consecutiveFailures: Math.max(0, Number(value.consecutiveFailures) || 0),
      updatedAt: value.updatedAt || null,
    };
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
  writeAtomic(healthFile, `${JSON.stringify(state)}\n`);
  return {
    ok: true,
    provider: resolved,
    rc: exitCode,
    consecutiveFailures,
    fallbackActivated,
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
  HEALTH_FILE,
  OPENAI_ENV_FILE,
  normalizeProvider,
  providerReadiness,
  readActiveProvider,
  readHealth,
  recordProviderResult,
  switchProvider,
};
