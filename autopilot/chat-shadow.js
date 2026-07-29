#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  READ_ONLY_ACTIONS,
  evaluateRunPermission,
  normalizeShadowMode,
  runShadowCycle,
} = require('./chat/shadow-worker.js');
const { createLlmDecisionProvider } = require('./chat/llm-decision-provider.js');

const AUTOPILOT_ROOT = __dirname;
const SIM_ROOT = path.dirname(AUTOPILOT_ROOT);
const BRAIN_LOCK = path.join(AUTOPILOT_ROOT, '.brain.lock');
const TICK_LOCK = path.join(SIM_ROOT, '.tick.lock');
const NEXT_WAKE_FILE = path.join(AUTOPILOT_ROOT, 'next-wake.json');
const ACT_FILE = path.join(AUTOPILOT_ROOT, 'act.js');
const DEFAULT_DATA_ROOT = path.join(AUTOPILOT_ROOT, '.chat-shadow');
const DEFAULT_CLI_CYCLE_DEADLINE_MS = 90 * 1000;
const DEFAULT_ACT_TIMEOUT_MS = 15 * 1000;
const INTERNAL_DEADLINE_ENV = 'SIM_CHAT_SHADOW_DEADLINE_AT_MS';
const INTERNAL_LOCK_PROOF_ENV = 'SIM_CHAT_SHADOW_LOCK_PROOF';
const ACT_CHILD_ENV_ALLOWLIST = Object.freeze(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
const STAGE_BRAIN = '--under-brain-lock';
const STAGE_BOTH = '--under-brain-and-tick-locks';
const BRAIN_LOCK_FD = 3;
const TICK_LOCK_FD = 4;

function readNextWake(file = NEXT_WAKE_FILE) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('next-wake.json is missing or oversized');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseLastJsonLine(output) {
  const lines = String(output || '').trim().split(/\r?\n/u).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch (_) {}
  }
  throw new Error('act.js produced no JSON result');
}

function buildActChildEnvironment(environment = process.env) {
  const childEnvironment = { SIM_CHAT_MODE: 'shadow' };
  for (const key of ACT_CHILD_ENV_ALLOWLIST) {
    if (typeof environment?.[key] === 'string') childEnvironment[key] = environment[key];
  }
  if (environment?.NODE_ENV === 'test') {
    childEnvironment.NODE_ENV = 'test';
    if (typeof environment.SIM_CHAT_HISTORY_FILE === 'string') {
      childEnvironment.SIM_CHAT_HISTORY_FILE = environment.SIM_CHAT_HISTORY_FILE;
    }
  }
  return childEnvironment;
}

function makeActActionRunner({
  execFileSync = childProcess.execFileSync,
  environment = process.env,
  timeoutMs = DEFAULT_ACT_TIMEOUT_MS,
} = {}) {
  const allowed = new Set(READ_ONLY_ACTIONS);
  return async (action, params, control = {}) => {
    if (!allowed.has(action)) throw new Error(`shadow CLI refuses non-read action ${action}`);
    if (params && Object.prototype.hasOwnProperty.call(params, 'confirm')) {
      throw new Error('shadow CLI refuses confirm on read actions');
    }
    const guardTimeoutMs = Number(control?.timeoutMs);
    const childTimeoutMs = Number.isSafeInteger(guardTimeoutMs) && guardTimeoutMs > 0
      ? Math.min(timeoutMs, guardTimeoutMs)
      : timeoutMs;
    const output = execFileSync(process.execPath, [ACT_FILE, action, JSON.stringify(params || {})], {
      cwd: SIM_ROOT,
      encoding: 'utf8',
      timeout: childTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: buildActChildEnvironment(environment),
    });
    return parseLastJsonLine(output);
  };
}

function lockChildArgs(stage) {
  if (stage === STAGE_BRAIN) {
    return ['-c', '/usr/bin/flock -n 3 || exit 1; exec "$@"',
      'chat-shadow-brain-lock', process.execPath, __filename, STAGE_BRAIN];
  }
  if (stage === STAGE_BOTH) {
    return ['-c', '/usr/bin/flock -n 4 || exit 1; exec "$@"',
      'chat-shadow-tick-lock', process.execPath, __filename, STAGE_BOTH];
  }
  throw new TypeError('unknown lock stage');
}

function spawnLockStage(stage, {
  spawnSync = childProcess.spawnSync,
  environment = process.env,
  timeoutMs = DEFAULT_CLI_CYCLE_DEADLINE_MS,
  openSync = fs.openSync,
  closeSync = fs.closeSync,
} = {}) {
  const lockFile = stage === STAGE_BRAIN ? BRAIN_LOCK : TICK_LOCK;
  const descriptor = openSync(lockFile, 'a+', 0o600);
  const stdio = stage === STAGE_BRAIN
    ? ['ignore', 'pipe', 'pipe', descriptor]
    : ['ignore', 'pipe', 'pipe', BRAIN_LOCK_FD, descriptor];
  try {
    // `flock <fd> <command>` treats the numeric value as a pathname when a command is present.
    // Acquire the inherited descriptor first, then exec Node from the same shell so the exact
    // locked open-file description remains at fd 3/4 in the internal stage.
    return spawnSync('/bin/sh', lockChildArgs(stage), {
      cwd: SIM_ROOT,
      encoding: 'utf8',
      timeout: Math.max(1, Math.floor(timeoutMs)),
      maxBuffer: 4 * 1024 * 1024,
      env: environment,
      stdio,
    });
  } finally {
    closeSync(descriptor);
  }
}

function inheritedDescriptorCarriesLock(descriptor, _stat, {
  spawnSync = childProcess.spawnSync,
} = {}) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 32) return false;
  const stdio = ['ignore', 'pipe', 'pipe'];
  while (stdio.length <= descriptor) stdio.push('ignore');
  stdio[descriptor] = descriptor;
  try {
    // With no command argument, util-linux flock interprets the numeric argument as an already
    // open fd. Success means this inherited open-file description can hold/reassert the lock;
    // an independently opened fd conflicts when another process owns the real lock.
    const result = spawnSync('/usr/bin/flock', ['-n', String(descriptor)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function sameFileIdentity(left, right) {
  try {
    return BigInt(left?.dev) === BigInt(right?.dev) && BigInt(left?.ino) === BigInt(right?.ino);
  } catch {
    return false;
  }
}

function linuxDeviceNumbers(device) {
  const value = BigInt(device);
  return {
    major: ((value & 0x00000000000fff00n) >> 8n)
      | ((value & 0xfffff00000000000n) >> 32n),
    minor: (value & 0x00000000000000ffn)
      | ((value & 0x00000ffffff00000n) >> 12n),
  };
}

function processAncestorIds(processId, readFileSync = fs.readFileSync) {
  const ancestors = new Set();
  let current = Number(processId);
  for (let depth = 0; depth < 32 && Number.isSafeInteger(current) && current > 0; depth += 1) {
    if (ancestors.has(current)) break;
    ancestors.add(current);
    if (current === 1) break;
    let stat;
    try { stat = String(readFileSync(`/proc/${current}/stat`, 'utf8')); } catch { break; }
    const closingParenthesis = stat.lastIndexOf(')');
    if (closingParenthesis < 0) break;
    const fields = stat.slice(closingParenthesis + 2).trim().split(/\s+/u);
    const parent = Number(fields[1]);
    if (!Number.isSafeInteger(parent) || parent <= 0) break;
    current = parent;
  }
  return ancestors;
}

function inheritedFdHasAncestorLock(descriptor, stat, {
  processId = process.pid,
  readFileSync = fs.readFileSync,
} = {}) {
  let locks;
  try { locks = String(readFileSync('/proc/locks', 'utf8')); } catch { return false; }
  const { major, minor } = linuxDeviceNumbers(stat.dev);
  const inode = BigInt(stat.ino);
  const ancestorIds = processAncestorIds(processId, readFileSync);
  for (const line of locks.split(/\r?\n/u)) {
    const match = line.match(/^\d+:\s+FLOCK\s+\S+\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+/iu);
    if (!match) continue;
    const holderPid = Number(match[1]);
    if (!ancestorIds.has(holderPid)) continue;
    if (BigInt(`0x${match[2]}`) === major
        && BigInt(`0x${match[3]}`) === minor
        && BigInt(match[4]) === inode) return true;
  }
  return false;
}

function verifyLockStageProof(stage, {
  environment = process.env,
  fstatSync = fs.fstatSync,
  statSync = fs.statSync,
  lockOwnershipVerifier = inheritedDescriptorCarriesLock,
} = {}) {
  const proof = environment?.[INTERNAL_LOCK_PROOF_ENV];
  if (!/^[a-f0-9]{64}$/u.test(String(proof || ''))) return false;
  const required = stage === STAGE_BRAIN
    ? [[BRAIN_LOCK_FD, BRAIN_LOCK]]
    : stage === STAGE_BOTH
      ? [[BRAIN_LOCK_FD, BRAIN_LOCK], [TICK_LOCK_FD, TICK_LOCK]]
      : [];
  if (!required.length) return false;
  try {
    return required.every(([descriptor, file]) => {
      const descriptorStat = fstatSync(descriptor, { bigint: true });
      const fileStat = statSync(file, { bigint: true });
      return sameFileIdentity(descriptorStat, fileStat)
        && lockOwnershipVerifier(descriptor, descriptorStat) === true;
    });
  } catch {
    return false;
  }
}

function safeResultError(error) {
  return String(error?.message || error || 'unknown error').slice(0, 500);
}

function llmDecisionProviderEnabled(environment = process.env) {
  return environment?.SIM_CHAT_LLM_ENABLED === 'true';
}

function createConfiguredDecisionProvider({
  environment = process.env,
  providerFactory = createLlmDecisionProvider,
} = {}) {
  if (!llmDecisionProviderEnabled(environment)) return undefined;
  if (typeof providerFactory !== 'function') throw new TypeError('providerFactory must be a function');
  return providerFactory({ env: environment });
}

function emit(value, write = text => process.stdout.write(text)) {
  write(`${JSON.stringify(value)}\n`);
  return value;
}

async function runCliStage({
  stage = process.argv[2] || 'root',
  now = new Date(),
  clock = Date.now,
  cycleDeadlineMs = DEFAULT_CLI_CYCLE_DEADLINE_MS,
  environment = process.env,
  spawnSync = childProcess.spawnSync,
  execFileSync = childProcess.execFileSync,
  write = text => process.stdout.write(text),
  nextWakeReader = readNextWake,
  spawnLockStageFn = spawnLockStage,
  lockProofVerifier = verifyLockStageProof,
} = {}) {
  try {
    const currentMs = Number(clock());
    if (!Number.isFinite(currentMs)) throw new TypeError('clock must return finite milliseconds');
    let deadlineAtMs;
    let stageEnvironment;
    if (stage === 'root') {
      deadlineAtMs = currentMs + cycleDeadlineMs;
      stageEnvironment = {
        ...environment,
        [INTERNAL_DEADLINE_ENV]: String(deadlineAtMs),
        [INTERNAL_LOCK_PROOF_ENV]: crypto.randomBytes(32).toString('hex'),
      };
    } else {
      deadlineAtMs = Number(environment?.[INTERNAL_DEADLINE_ENV]);
      stageEnvironment = environment;
      if (!Number.isFinite(deadlineAtMs)
          || lockProofVerifier(stage, { environment, spawnSync }) !== true) {
        return emit({ ok: false, skipped: true, reason: 'internal-stage-lock-proof-invalid' }, write);
      }
    }
    const remainingMs = Math.floor(deadlineAtMs - currentMs);
    if (remainingMs <= 0) {
      return emit({ ok: false, skipped: true, reason: 'shadow-cycle-deadline-exceeded' }, write);
    }
    if (stage === 'root') {
      const child = spawnLockStageFn(STAGE_BRAIN, {
        spawnSync,
        environment: stageEnvironment,
        timeoutMs: remainingMs,
      });
      if (child.error) return emit({ ok: false, skipped: true, reason: 'brain-lock-check-failed',
        error: safeResultError(child.error) }, write);
      if (child.status !== 0) {
        return emit({ ok: true, skipped: true, reason: 'brain-lock-held' }, write);
      }
      write(String(child.stdout || ''));
      try { return parseLastJsonLine(child.stdout); } catch (_) { return { ok: true, delegated: true }; }
    }

    if (stage === STAGE_BRAIN) {
      const permission = evaluateRunPermission({
        brainLockAvailable: true,
        tickLockAvailable: true,
        nextWake: nextWakeReader(),
        now,
      });
      if (!permission.ok) return emit(permission, write);
      const child = spawnLockStageFn(STAGE_BOTH, {
        spawnSync,
        environment: stageEnvironment,
        timeoutMs: remainingMs,
      });
      if (child.error) return emit({ ok: false, skipped: true, reason: 'tick-lock-check-failed',
        error: safeResultError(child.error) }, write);
      if (child.status !== 0) return emit({ ok: true, skipped: true, reason: 'tick-lock-held' }, write);
      write(String(child.stdout || ''));
      try { return parseLastJsonLine(child.stdout); } catch (_) { return { ok: true, delegated: true }; }
    }

    if (stage !== STAGE_BOTH) return emit({ ok: false, skipped: true, reason: 'invalid-cli-stage' }, write);
    const permission = evaluateRunPermission({
      brainLockAvailable: true,
      tickLockAvailable: true,
      nextWake: nextWakeReader(),
      now,
    });
    if (!permission.ok) return emit(permission, write);
    const mode = normalizeShadowMode(environment.SIM_CHAT_SHADOW_MODE
      ?? environment.SIM_CHAT_MODE
      ?? 'shadow');
    const dataRoot = environment.SIM_CHAT_SHADOW_ROOT || DEFAULT_DATA_ROOT;
    const result = await runShadowCycle({
      mode,
      permission,
      dataRoot,
      actionRunner: makeActActionRunner({ execFileSync, environment }),
      decisionProvider: createConfiguredDecisionProvider({ environment }),
      now,
      clock,
      deadlineAtMs,
      nextWakeReader,
    });
    return emit({
      ok: result.ok,
      skipped: result.skipped,
      mode: result.mode,
      actionCount: result.actions?.length || 0,
      observationCount: result.observations?.length || 0,
      draftCount: result.drafts?.length || 0,
      errorCount: result.errors?.length || 0,
    }, write);
  } catch (error) {
    return emit({ ok: false, skipped: true, reason: 'shadow-cli-error', error: safeResultError(error) }, write);
  }
}

if (require.main === module) {
  // Handled failures are reported in JSON while retaining exit status 0. This lets the outer
  // flock stage reserve a non-zero status for lock contention or an abnormal child termination.
  runCliStage();
}

module.exports = {
  ACT_FILE,
  BRAIN_LOCK,
  BRAIN_LOCK_FD,
  DEFAULT_ACT_TIMEOUT_MS,
  DEFAULT_CLI_CYCLE_DEADLINE_MS,
  DEFAULT_DATA_ROOT,
  INTERNAL_DEADLINE_ENV,
  INTERNAL_LOCK_PROOF_ENV,
  NEXT_WAKE_FILE,
  SIM_ROOT,
  STAGE_BOTH,
  STAGE_BRAIN,
  TICK_LOCK_FD,
  TICK_LOCK,
  ACT_CHILD_ENV_ALLOWLIST,
  buildActChildEnvironment,
  lockChildArgs,
  createConfiguredDecisionProvider,
  llmDecisionProviderEnabled,
  inheritedFdHasAncestorLock,
  inheritedDescriptorCarriesLock,
  linuxDeviceNumbers,
  makeActActionRunner,
  parseLastJsonLine,
  readNextWake,
  processAncestorIds,
  runCliStage,
  spawnLockStage,
  verifyLockStageProof,
};
