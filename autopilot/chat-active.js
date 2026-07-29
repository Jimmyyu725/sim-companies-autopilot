#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ActiveChatStore, DEFAULT_ACTIVE_ROOT } = require('./chat/active-store.js');
const {
  ALLOWED_ERROR_REASONS,
  ALLOWED_ERROR_STAGES,
  ChatDiaryStore,
  DEFAULT_CHAT_DIARY_ROOT,
} = require('./chat/chat-diary.js');
const { runActiveChatCycle } = require('./chat/active-worker.js');
const { createBusinessSnapshotLoader } = require('./chat/business-snapshot.js');
const {
  createFileCommunicationAuthorizationAdapter,
} = require('./chat/active-worker.js');
const { readAuthorizationStore } = require('./chat/communication-authorization.js');
const { createLlmDecisionProvider } = require('./chat/llm-decision-provider.js');
const { PrivateSendOutbox } = require('./chat/private-outbox.js');
const { readPublicHistory } = require('./chat/public-history.js');
const { loadTrustedResourceCatalog } = require('./chat/resource-catalog.js');
const { authorizeChatAction, CHAT_MODES } = require('./chat/runtime-mode.js');
const {
  BRAIN_LOCK,
  BRAIN_LOCK_FD,
  INTERNAL_LOCK_PROOF_ENV,
  STAGE_BOTH,
  STAGE_BRAIN,
  TICK_LOCK,
  TICK_LOCK_FD,
  evaluateRunPermission,
  parseLastJsonLine,
  verifyLockStageProof,
} = (() => {
  const shadowCli = require('./chat-shadow.js');
  const shadowWorker = require('./chat/shadow-worker.js');
  return { ...shadowCli, evaluateRunPermission: shadowWorker.evaluateRunPermission };
})();
const { deterministicDecisionProvider } = require('./chat/shadow-worker.js');

const AUTOPILOT_ROOT = __dirname;
const SIM_ROOT = path.dirname(AUTOPILOT_ROOT);
const ACT_FILE = path.join(AUTOPILOT_ROOT, 'act.js');
const NEXT_WAKE_FILE = path.join(AUTOPILOT_ROOT, 'next-wake.json');
const PRIVATE_OUTBOX_ROOT = path.join(AUTOPILOT_ROOT, '.chat-private-outbox');
const COMMUNICATION_AUTH_FILE = path.join(
  AUTOPILOT_ROOT,
  '.chat-communication-authorizations.json',
);
const PUBLIC_HISTORY_FILE = path.join(AUTOPILOT_ROOT, '.chat-posts.jsonl');
const INTERNAL_DEADLINE_ENV = 'SIM_CHAT_ACTIVE_DEADLINE_AT_MS';
const MODE_ENV = 'SIM_CHAT_ACTIVE_MODE';
const REAL_SEND_ENV = 'SIM_CHAT_REAL_SEND_ENABLED';
const LLM_ENABLED_ENV = 'SIM_CHAT_LLM_ENABLED';
const EXECUTION_TOKEN_ENV = 'SIM_CHAT_EXECUTION_CLAIM_TOKEN';
const CHAT_DIARY_ROOT_ENV = 'SIM_CHAT_DIARY_ROOT';
const DEFAULT_CYCLE_DEADLINE_MS = 4 * 60 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30 * 1000;
const MINIMUM_WAKE_LEAD_MS = 6 * 60 * 1000;
const MAX_ROOMS = 4;
const MAX_CONTACTS = 12;
const LOCK_CONTENTION_EXIT_CODE = 75;
const CHILD_ENV_ALLOWLIST = Object.freeze(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
const TEST_PATH_ENV_ALLOWLIST = Object.freeze([
  'SIM_CHAT_ACTIVE_ROOT',
  'SIM_CHAT_COMMUNICATION_AUTH_FILE',
  'SIM_CHAT_HISTORY_FILE',
  'SIM_CHAT_PRIVATE_OUTBOX_ROOT',
  CHAT_DIARY_ROOT_ENV,
]);
const DISCOVERY_ACTIONS = new Set(['chat_rooms_discover', 'chat_contact_list']);
const CYCLE_ACTIONS = new Set([
  'chat_room_read',
  'chat_private_read',
  'chat_room_post',
  'chat_room_reply',
  'chat_private_send',
  'chat_contract_list',
  'chat_contract_preview',
  'contract_accept',
]);
const MUTATION_ACTIONS = new Set([
  'chat_room_post',
  'chat_room_reply',
  'chat_private_send',
  'contract_accept',
]);
const HEALTHY_SKIP_REASONS = new Set([
  'brain-lock-held',
  'tick-lock-held',
  'next-wake-too-close',
  'next-wake-safety-margin',
  'chat-runtime-off',
]);

function safeError(error) {
  return String(error?.message || error || 'unknown error').slice(0, 300);
}

function emit(value, write = text => process.stdout.write(text)) {
  write(`${JSON.stringify(value)}\n`);
  return value;
}

function normalizeLauncherResult(value, mode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, skipped: true, mode, reason: 'active-stage-result-invalid' };
  }
  if (value.ok === true && value.skipped === true
      && !HEALTHY_SKIP_REASONS.has(value.reason)) {
    return {
      ok: false,
      skipped: true,
      mode,
      reason: 'unexpected-healthy-skip',
      upstreamReason: typeof value.reason === 'string' ? value.reason : null,
    };
  }
  return value;
}

function permissionResult(permission, mode) {
  if (permission?.ok === true) return null;
  const healthy = permission?.reason === 'next-wake-too-close';
  return {
    ...(permission && typeof permission === 'object' ? permission : {}),
    ok: healthy,
    skipped: true,
    mode,
    reason: typeof permission?.reason === 'string'
      ? permission.reason : 'run-permission-invalid',
  };
}

function resolveActiveMode(environment = process.env) {
  if (environment?.[MODE_ENV] == null || environment[MODE_ENV] === '') return 'shadow';
  const mode = String(environment[MODE_ENV]).trim().toLowerCase();
  if (!CHAT_MODES.includes(mode)) throw new TypeError(`${MODE_ENV} is invalid`);
  return mode;
}

function validateRolloutConfiguration(mode, environment = process.env) {
  const llmEnabled = environment?.[LLM_ENABLED_ENV] === 'true';
  const realSendEnabled = environment?.[REAL_SEND_ENV] === 'true';
  if (llmEnabled && (typeof environment.OPENAI_API_KEY !== 'string'
      || !environment.OPENAI_API_KEY.trim())) {
    throw new Error('LLM was requested but its credential is unavailable');
  }
  if (mode === 'safe-reply' || mode === 'full') {
    if (!realSendEnabled) throw new Error('active sends require the explicit rollout switch');
    if (!llmEnabled) throw new Error('active sends require the configured LLM decision provider');
  }
  return Object.freeze({ llmEnabled, realSendEnabled });
}

function readNextWakeStrict(file = NEXT_WAKE_FILE) {
  const flags = fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 64 * 1024) {
      throw new Error('next-wake.json is not a regular bounded file');
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    return JSON.parse(text);
  } finally {
    fs.closeSync(descriptor);
  }
}

function openSafeLockFile(file) {
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('chat lock path is not a regular file');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT
    | Number(fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file, flags, 0o600);
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile()) {
    fs.closeSync(descriptor);
    throw new Error('chat lock descriptor is not a regular file');
  }
  fs.fchmodSync(descriptor, 0o600);
  return descriptor;
}

function lockChildArgs(stage) {
  if (stage === STAGE_BRAIN) {
    return ['-c', `/usr/bin/flock -n 3 || exit ${LOCK_CONTENTION_EXIT_CODE}; exec "$@"`,
      'chat-active-brain-lock', process.execPath, __filename, STAGE_BRAIN];
  }
  if (stage === STAGE_BOTH) {
    return ['-c', `/usr/bin/flock -n 4 || exit ${LOCK_CONTENTION_EXIT_CODE}; exec "$@"`,
      'chat-active-tick-lock', process.execPath, __filename, STAGE_BOTH];
  }
  throw new TypeError('unknown active chat lock stage');
}

function spawnLockStage(stage, {
  spawnSync = childProcess.spawnSync,
  environment = process.env,
  timeoutMs = DEFAULT_CYCLE_DEADLINE_MS,
  openLockFile = openSafeLockFile,
  closeSync = fs.closeSync,
} = {}) {
  const lockFile = stage === STAGE_BRAIN ? BRAIN_LOCK : TICK_LOCK;
  const descriptor = openLockFile(lockFile);
  const stdio = stage === STAGE_BRAIN
    ? ['ignore', 'pipe', 'pipe', descriptor]
    : ['ignore', 'pipe', 'pipe', BRAIN_LOCK_FD, descriptor];
  try {
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

function buildActChildEnvironment({
  environment = process.env,
  mode = 'shadow',
  executionClaimToken = null,
} = {}) {
  const childEnvironment = { SIM_CHAT_MODE: mode };
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof environment?.[key] === 'string') childEnvironment[key] = environment[key];
  }
  if (executionClaimToken != null) {
    if (!/^[a-f0-9]{64}$/u.test(executionClaimToken)) {
      throw new TypeError('execution claim token is invalid');
    }
    childEnvironment[EXECUTION_TOKEN_ENV] = executionClaimToken;
  }
  if (environment?.NODE_ENV === 'test') {
    childEnvironment.NODE_ENV = 'test';
    for (const key of TEST_PATH_ENV_ALLOWLIST) {
      if (typeof environment[key] === 'string') childEnvironment[key] = environment[key];
    }
  }
  return childEnvironment;
}

function makeActActionRunner({
  allowedActions = CYCLE_ACTIONS,
  execFileSync = childProcess.execFileSync,
  environment = process.env,
  mode = 'shadow',
  realSendEnabled = false,
  permissionGuard = null,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
} = {}) {
  const allowlist = new Set(allowedActions);
  return async (action, params = {}, control = {}) => {
    if (!allowlist.has(action)) throw new Error('active launcher action is not allowlisted');
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new TypeError('action params must be an object');
    }
    const mutationAction = MUTATION_ACTIONS.has(action);
    const zeroClickContractPreview = action === 'chat_contract_preview' && params.confirm === false;
    if (!mutationAction && Object.prototype.hasOwnProperty.call(params, 'confirm')
        && !zeroClickContractPreview) {
      throw new Error('read actions cannot contain confirm');
    }
    if (mutationAction && typeof params.confirm !== 'boolean') {
      throw new Error('chat mutation preview/confirm must be explicit');
    }
    const confirming = mutationAction && params.confirm === true;
    if (confirming) {
      if (!realSendEnabled || !['safe-reply', 'full'].includes(mode)) {
        throw new Error('confirmed chat execution is not enabled');
      }
      const authorization = authorizeChatAction(action, params, mode);
      if (!authorization.ok || authorization.previewOnly === true) {
        throw new Error('runtime mode refused the confirmed chat action');
      }
      if (!/^[a-f0-9]{64}$/u.test(String(control.executionClaimToken || ''))) {
        throw new Error('confirmed chat execution has no worker claim token');
      }
    }
    if (typeof permissionGuard !== 'function') {
      throw new Error('action runner requires a live lock permission guard');
    }
    const permission = await permissionGuard({
      label: `act-child:${action}`,
      mode,
      mutation: confirming,
    });
    if (permission?.ok !== true || permission.brainLockHeld !== true
        || permission.tickLockHeld !== true
        || (confirming && permission.mutationAllowed !== true)) {
      throw new Error('action runner lock permission was denied');
    }
    const guardTimeout = Number(control.timeoutMs);
    const childTimeout = Number.isSafeInteger(guardTimeout) && guardTimeout > 0
      ? Math.min(timeoutMs, guardTimeout)
      : timeoutMs;
    const output = execFileSync(process.execPath, [ACT_FILE, action, JSON.stringify(params)], {
      cwd: SIM_ROOT,
      encoding: 'utf8',
      timeout: childTimeout,
      maxBuffer: 2 * 1024 * 1024,
      env: buildActChildEnvironment({
        environment,
        mode,
        executionClaimToken: confirming ? control.executionClaimToken : null,
      }),
    });
    return parseLastJsonLine(output);
  };
}

function normalizeRooms(result) {
  if (result?.ok !== true || !Array.isArray(result.rooms)) {
    throw new Error('public room discovery was not successful');
  }
  const rooms = [];
  const seen = new Set();
  for (const entry of result.rooms) {
    const room = String(entry?.room ?? '').normalize('NFKC').trim();
    if (!room || room.length > 120) continue;
    if (!seen.has(room)) { seen.add(room); rooms.push(room); }
  }
  return rooms.sort((left, right) => left.localeCompare(right, 'en')).slice(0, MAX_ROOMS);
}

function normalizeContacts(result) {
  if (result?.ok !== true || !Array.isArray(result.contacts)) {
    throw new Error('private contact discovery was not successful');
  }
  const contacts = new Map();
  for (const entry of result.contacts) {
    const companyId = Number(entry?.companyId);
    const company = String(entry?.company ?? '').normalize('NFKC').trim();
    const unread = Number(entry?.unread);
    if (!Number.isSafeInteger(companyId) || companyId <= 0 || !company || company.length > 160
        || !Number.isSafeInteger(unread) || unread < 0) continue;
    const prior = contacts.get(companyId);
    if (prior && prior.company !== company) {
      throw new Error('contact discovery returned conflicting stable identities');
    }
    contacts.set(companyId, { companyId, company, unread, pinned: entry?.pinned === true });
  }
  return [...contacts.values()].sort((left, right) => right.unread - left.unread
    || Number(right.pinned) - Number(left.pinned)
    || left.companyId - right.companyId).slice(0, MAX_CONTACTS);
}

function publicRoomPriority(room) {
  const normalized = String(room).normalize('NFKC').trim().toLocaleLowerCase('en');
  if (normalized === 'sales') return 0;
  if (/\b(?:sales?|trade|market)\b/u.test(normalized)) return 1;
  return 2;
}

function publicProposalCounts(proposals) {
  const values = Array.isArray(proposals) ? proposals : [];
  const publicActions = new Set(['chat_room_reply', 'chat_room_post']);
  return {
    publicReplyProposals: values.filter(entry => entry?.action === 'chat_room_reply').length,
    proactivePublicPostProposals: values.filter(entry => entry?.action === 'chat_room_post').length,
    economicPublicProposals: values.filter(entry => publicActions.has(entry?.action)
      && entry?.economicAuthorizationRequired === true).length,
    buyProposals: values.filter(entry => entry?.tradeSide === 'buy').length,
    sellProposals: values.filter(entry => entry?.tradeSide === 'sell').length,
    exactShadowPreviews: values.filter(entry => entry?.previewStatus === 'VERIFIED').length,
  };
}

function fixedLauncherErrorCodes(errors) {
  return [...new Set((Array.isArray(errors) ? errors : []).map(entry => {
    const stage = typeof entry?.stage === 'string' && ALLOWED_ERROR_STAGES.has(entry.stage)
      ? entry.stage : 'UNKNOWN';
    const reason = typeof entry?.reason === 'string' && ALLOWED_ERROR_REASONS.has(entry.reason)
      ? entry.reason : 'UNKNOWN';
    return `${stage}:${reason}`;
  }))].slice(0, 12);
}

async function discoverReadRequests({ actionRunner, guardControl }) {
  const roomsResult = await actionRunner('chat_rooms_discover', {}, guardControl);
  const contactsResult = await actionRunner('chat_contact_list', {}, guardControl);
  const rooms = normalizeRooms(roomsResult);
  const contacts = normalizeContacts(contactsResult);
  const prioritizedRooms = [...rooms].sort((left, right) => publicRoomPriority(left)
    - publicRoomPriority(right) || left.localeCompare(right, 'en'));
  const unreadContacts = contacts.filter(contact => contact.unread > 0);
  const remainingContacts = contacts.filter(contact => contact.unread === 0);
  const privateRequest = contact => ({
    action: 'chat_private_read',
    params: {
      targetCompany: contact.company,
      targetCompanyId: contact.companyId,
      previousSnapshotFingerprint: null,
      cursorTail: null,
      loadFull: false,
      maxScrolls: 1,
    },
    conversationType: 'private',
    conversationId: `company-${contact.companyId}`,
  });
  return {
    rooms,
    contacts,
    readRequests: [
      ...unreadContacts.map(privateRequest),
      ...prioritizedRooms.map(room => ({
        action: 'chat_room_read',
        params: { room },
        conversationType: 'room',
        conversationId: room,
      })),
      ...remainingContacts.map(privateRequest),
    ],
  };
}

function buildPublicSafetyByRoom(rooms, history, observedAt) {
  const recentPublicMessages = history.filter(entry => entry.status !== 'FAILED_PRE_CLICK').map(entry => ({
    roomId: entry.roomId,
    text: entry.text,
    sentAt: entry.sentAt,
  }));
  return Object.fromEntries(rooms.map(room => [room, Object.freeze({
    status: 'ok',
    observedAt,
    roomId: room,
    recentPublicMessages,
    knownHumanNames: [],
  })]));
}

function createPermissionGuard({
  environment,
  mode,
  realSendEnabled,
  deadlineAtMs,
  clock,
  nextWakeReader,
  lockProofVerifier,
  spawnSync,
}) {
  return async ({ mutation = false }) => {
    const nowMs = Number(clock());
    if (!Number.isFinite(nowMs) || nowMs >= deadlineAtMs
        || lockProofVerifier(STAGE_BOTH, { environment, spawnSync }) !== true) {
      return { ok: false, brainLockHeld: false, tickLockHeld: false };
    }
    let permission;
    try {
      permission = evaluateRunPermission({
        brainLockAvailable: true,
        tickLockAvailable: true,
        nextWake: nextWakeReader(),
        now: new Date(nowMs),
        minimumWakeLeadMs: MINIMUM_WAKE_LEAD_MS,
      });
    } catch {
      return { ok: false, brainLockHeld: true, tickLockHeld: true };
    }
    const mutationAllowed = mutation
      && realSendEnabled
      && ['safe-reply', 'full'].includes(mode);
    return {
      ok: permission.ok === true && (!mutation || mutationAllowed),
      brainLockHeld: true,
      tickLockHeld: true,
      mutationAllowed,
    };
  };
}

async function runBothLocksStage(options) {
  const {
    environment,
    mode,
    rollout,
    deadlineAtMs,
    clock,
    nextWakeReader,
    lockProofVerifier,
    spawnSync,
    execFileSync,
  } = options;
  const nowMs = Number(clock());
  const permissionGuard = createPermissionGuard({
    environment,
    mode,
    realSendEnabled: rollout.realSendEnabled,
    deadlineAtMs,
    clock,
    nextWakeReader,
    lockProofVerifier,
    spawnSync,
  });

  // Validate every local durable dependency before constructing a runner that can open Chrome.
  const store = options.storeFactory
    ? options.storeFactory()
    : new ActiveChatStore(DEFAULT_ACTIVE_ROOT);
  store.initialize(new Date(nowMs));
  store.readAttempts();
  const configuredDiaryRoot = environment?.NODE_ENV === 'test'
    ? environment?.[CHAT_DIARY_ROOT_ENV] : null;
  const chatDiaryStore = options.chatDiaryStore
    || ((options.runCycle == null && (environment?.NODE_ENV !== 'test' || configuredDiaryRoot))
      ? new ChatDiaryStore(configuredDiaryRoot
        ? path.resolve(configuredDiaryRoot) : DEFAULT_CHAT_DIARY_ROOT)
      : null);
  if (chatDiaryStore) chatDiaryStore.initialize();
  const privateOutbox = options.privateOutboxFactory
    ? options.privateOutboxFactory()
    : new PrivateSendOutbox(PRIVATE_OUTBOX_ROOT);
  privateOutbox.read();
  const authorizationFile = options.communicationAuthorizationFile || COMMUNICATION_AUTH_FILE;
  readAuthorizationStore(authorizationFile);
  const authorizationAdapter = options.authorizationAdapter
    || createFileCommunicationAuthorizationAdapter(authorizationFile);
  const history = (options.publicHistoryReader || readPublicHistory)(
    options.publicHistoryFile || PUBLIC_HISTORY_FILE,
  );
  const snapshotLoader = options.businessSnapshotLoader
    || createBusinessSnapshotLoader({ clock: () => new Date(Number(clock())) });
  const businessSnapshot = snapshotLoader.load({ now: new Date(Number(clock())) });
  const trustedResourceCatalog = options.trustedResourceCatalog
    || (options.resourceCatalogLoader || loadTrustedResourceCatalog)();
  const decisionProvider = options.decisionProvider
    || (rollout.llmEnabled
      ? (options.providerFactory || createLlmDecisionProvider)({ env: environment })
      : deterministicDecisionProvider);

  const discoveryRunner = (options.actionRunnerFactory || makeActActionRunner)({
    allowedActions: DISCOVERY_ACTIONS,
    execFileSync,
    environment,
    mode,
    realSendEnabled: false,
    permissionGuard,
  });
  const cycleRunner = (options.actionRunnerFactory || makeActActionRunner)({
    allowedActions: CYCLE_ACTIONS,
    execFileSync,
    environment,
    mode,
    realSendEnabled: rollout.realSendEnabled,
    permissionGuard,
  });
  const discovery = await discoverReadRequests({
    actionRunner: discoveryRunner,
    guardControl: {
      timeoutMs: Math.max(1, Math.min(
        DEFAULT_OPERATION_TIMEOUT_MS,
        deadlineAtMs - Number(clock()),
      )),
    },
  });
  const observedAt = new Date(Number(clock())).toISOString();
  const cycleInput = {
    mode,
    actionRunner: cycleRunner,
    store,
    privateOutbox,
    authorizationAdapter,
    decisionProvider,
    businessSnapshot,
    trustedResourceCatalog,
    readRequests: discovery.readRequests,
    proactiveRoomIds: [...discovery.rooms]
      .filter(room => publicRoomPriority(room) <= 1)
      .sort((left, right) => publicRoomPriority(left) - publicRoomPriority(right)
        || left.localeCompare(right, 'en')),
    publicSafetyByRoom: buildPublicSafetyByRoom(discovery.rooms, history, observedAt),
    permissionGuard,
    nextWakeReader,
    clock,
    deadlineAtMs,
    wakeSafetyMarginMs: MINIMUM_WAKE_LEAD_MS,
  };
  let result;
  try {
    result = await (options.runCycle || runActiveChatCycle)(cycleInput);
  } catch (error) {
    // Best-effort aggregate failure diary: never copy the exception text, and never replace the
    // original exception if the independent diary itself is unavailable.
    try {
      chatDiaryStore?.write({
        startedAt: new Date(nowMs),
        completedAt: new Date(Number(clock())),
        mode,
        discovery,
        result: {
          observations: [],
          proposals: [],
          outcomes: [],
          errors: [{ stage: 'decision', reason: 'active-cycle-unhandled-error' }],
          reason: 'active-cycle-unhandled-error',
          metrics: {},
        },
      });
    } catch {}
    throw error;
  }
  const diary = chatDiaryStore?.write({
    startedAt: new Date(nowMs),
    completedAt: new Date(Number(clock())),
    mode,
    discovery,
    result,
  }) ?? null;
  const errorCodes = fixedLauncherErrorCodes(result.errors);
  const proposalCounts = publicProposalCounts(result.proposals);
  const normalized = normalizeLauncherResult({
    ok: result.ok === true,
    skipped: result.skipped === true,
    mode,
    reason: result.reason || null,
    actionCount: (result.actions?.length || 0) + 2,
    discoveryActionCount: 2,
    observationCount: result.observations?.length || 0,
    proposalCount: result.proposals?.length || 0,
    ...proposalCounts,
    outcomeCount: result.outcomes?.length || 0,
    errorCount: result.errors?.length || 0,
    errorCodes,
    strictInboundMessages: Number.isSafeInteger(result.strictInboundMessages)
      ? result.strictInboundMessages : null,
    metrics: result.metrics && typeof result.metrics === 'object'
      ? {
        reads: Number.isSafeInteger(result.metrics.reads) ? result.metrics.reads : null,
        decisionCalls: Number.isSafeInteger(result.metrics.decisionCalls)
          ? result.metrics.decisionCalls : null,
        previews: Number.isSafeInteger(result.metrics.previews) ? result.metrics.previews : null,
        confirmAttempts: Number.isSafeInteger(result.metrics.confirmAttempts)
          ? result.metrics.confirmAttempts : null,
        ...(result.metrics.decisionUsage && typeof result.metrics.decisionUsage === 'object'
          ? { decisionUsage: result.metrics.decisionUsage } : {}),
      }
      : null,
    chatDiary: diary == null ? null : {
      durable: diary.durable === true,
      file: path.basename(diary.file),
    },
  }, mode);
  return normalized;
}

async function runCliStage({
  stage = process.argv[2] || 'root',
  environment = process.env,
  clock = Date.now,
  cycleDeadlineMs = DEFAULT_CYCLE_DEADLINE_MS,
  spawnSync = childProcess.spawnSync,
  execFileSync = childProcess.execFileSync,
  write = text => process.stdout.write(text),
  nextWakeReader = readNextWakeStrict,
  spawnLockStageFn = spawnLockStage,
  lockProofVerifier = verifyLockStageProof,
  ...injected
} = {}) {
  try {
    const mode = resolveActiveMode(environment);
    const rollout = validateRolloutConfiguration(mode, environment);
    if (mode === 'off') return emit({ ok: true, skipped: true, mode, reason: 'chat-runtime-off' }, write);
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
        return emit({ ok: false, skipped: true, mode,
          reason: 'internal-stage-lock-proof-invalid' }, write);
      }
    }
    const remainingMs = Math.floor(deadlineAtMs - currentMs);
    if (remainingMs <= 0) {
      return emit({ ok: false, skipped: true, mode, reason: 'active-cycle-deadline-exceeded' }, write);
    }
    if (stage === 'root') {
      const child = spawnLockStageFn(STAGE_BRAIN, {
        spawnSync,
        environment: stageEnvironment,
        timeoutMs: remainingMs,
      });
      if (child.error) return emit({ ok: false, skipped: true, mode,
        reason: 'brain-lock-check-failed', error: safeError(child.error) }, write);
      if (child.status === LOCK_CONTENTION_EXIT_CODE) {
        return emit({ ok: true, skipped: true, mode, reason: 'brain-lock-held' }, write);
      }
      if (child.signal || child.status !== 0) {
        return emit({ ok: false, skipped: true, mode, reason: 'brain-lock-child-failed' }, write);
      }
      let parsed;
      try { parsed = parseLastJsonLine(child.stdout); }
      catch { return emit({ ok: false, skipped: true, mode, reason: 'brain-lock-child-output-invalid' }, write); }
      write(String(child.stdout || ''));
      return normalizeLauncherResult(parsed, mode);
    }
    if (stage === STAGE_BRAIN) {
      const permission = evaluateRunPermission({
        brainLockAvailable: true,
        tickLockAvailable: true,
        nextWake: nextWakeReader(),
        now: new Date(currentMs),
        minimumWakeLeadMs: MINIMUM_WAKE_LEAD_MS,
      });
      if (!permission.ok) return emit(permissionResult(permission, mode), write);
      const child = spawnLockStageFn(STAGE_BOTH, {
        spawnSync,
        environment: stageEnvironment,
        timeoutMs: remainingMs,
      });
      if (child.error) return emit({ ok: false, skipped: true, mode,
        reason: 'tick-lock-check-failed', error: safeError(child.error) }, write);
      if (child.status === LOCK_CONTENTION_EXIT_CODE) {
        return emit({ ok: true, skipped: true, mode, reason: 'tick-lock-held' }, write);
      }
      if (child.signal || child.status !== 0) {
        return emit({ ok: false, skipped: true, mode, reason: 'tick-lock-child-failed' }, write);
      }
      let parsed;
      try { parsed = parseLastJsonLine(child.stdout); }
      catch { return emit({ ok: false, skipped: true, mode, reason: 'tick-lock-child-output-invalid' }, write); }
      write(String(child.stdout || ''));
      return normalizeLauncherResult(parsed, mode);
    }
    if (stage !== STAGE_BOTH) {
      return emit({ ok: false, skipped: true, mode, reason: 'invalid-cli-stage' }, write);
    }
    const initialPermission = evaluateRunPermission({
      brainLockAvailable: true,
      tickLockAvailable: true,
      nextWake: nextWakeReader(),
      now: new Date(currentMs),
      minimumWakeLeadMs: MINIMUM_WAKE_LEAD_MS,
    });
    if (!initialPermission.ok) return emit(permissionResult(initialPermission, mode), write);
    const result = await runBothLocksStage({
      ...injected,
      environment: stageEnvironment,
      mode,
      rollout,
      deadlineAtMs,
      clock,
      nextWakeReader,
      lockProofVerifier,
      spawnSync,
      execFileSync,
    });
    return emit(result, write);
  } catch (error) {
    return emit({ ok: false, skipped: true, reason: 'active-chat-cli-error',
      error: safeError(error) }, write);
  }
}

if (require.main === module) runCliStage();

module.exports = {
  ACT_FILE,
  CHAT_DIARY_ROOT_ENV,
  CHILD_ENV_ALLOWLIST,
  COMMUNICATION_AUTH_FILE,
  CYCLE_ACTIONS,
  DEFAULT_CYCLE_DEADLINE_MS,
  DISCOVERY_ACTIONS,
  EXECUTION_TOKEN_ENV,
  INTERNAL_DEADLINE_ENV,
  LOCK_CONTENTION_EXIT_CODE,
  MAX_CONTACTS,
  MAX_ROOMS,
  MODE_ENV,
  HEALTHY_SKIP_REASONS,
  PUBLIC_HISTORY_FILE,
  PRIVATE_OUTBOX_ROOT,
  REAL_SEND_ENV,
  TEST_PATH_ENV_ALLOWLIST,
  buildActChildEnvironment,
  buildPublicSafetyByRoom,
  createPermissionGuard,
  discoverReadRequests,
  lockChildArgs,
  makeActActionRunner,
  normalizeLauncherResult,
  normalizeContacts,
  normalizeRooms,
  openSafeLockFile,
  readNextWakeStrict,
  resolveActiveMode,
  runBothLocksStage,
  runCliStage,
  spawnLockStage,
  validateRolloutConfiguration,
};
