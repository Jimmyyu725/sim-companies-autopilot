'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { councilVoteSchema, validateCouncilVote } = require('./council-verdict.js');

const ROLE_ATTEMPT_TIMEOUT_MS = 45_000;
const ROLE_TOTAL_TIMEOUT_MS = 90_000;
const ROLE_MAX_ATTEMPTS = 2;

const ROLES = Object.freeze([
  ['CFO', 'You are a skeptical CFO. Evaluate cash, working capital, debt service, payback, and measured-vs-assumed figures. Outstanding debt is debt.principalOutstanding reconciled against debt.balanceSheetPayable. The bond offer form and bondOffer API describe only the current unsold offer; their amount can be 0 while debt remains outstanding and must never override debt.'],
  ['COO', 'You are a pragmatic COO. Evaluate slots, downtime, production continuity, inputs, and end-to-end bottlenecks.'],
  ['CMO', 'You are a market CMO. Evaluate retail absorption, weather, saturation, live order-book depth, net margin, and transition revenue loss.'],
]);

function prepareEvidenceView(evidence, maxBytes = 18000) {
  const serialized = JSON.stringify(evidence);
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  if (totalBytes <= maxBytes) return evidence;
  const view = {
    _transport: {
      truncated: true,
      totalBytes,
      omittedTopLevelFields: [],
      note: 'Evidence fields omitted for transport size are UNKNOWN; request narrower evidence rather than infer them.',
    },
  };
  for (const [key, value] of Object.entries(evidence || {})) {
    const candidate = { ...view, [key]: value };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) view[key] = value;
    else view._transport.omittedTopLevelFields.push(key);
  }
  return view;
}

function collectEvidence(args, brainDir, simDir) {
  try {
    const out = execFileSync('flock', [
      '-w', '90', path.join(simDir, '.tick.lock'),
      'node', path.join(brainDir, 'council-evidence.js'), JSON.stringify({
        buildingId: args.buildingId ?? null,
        marketKinds: args.marketKinds ?? [1, 2, 66, 118, 119],
      }),
    ], { cwd: simDir, timeout: 180000, encoding: 'utf8' });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    if (parsed.ok) return parsed;
    return { ok: false, meta: { status: 'UNKNOWN', error: parsed.error }, roles: {} };
  } catch (error) {
    return { ok: false, meta: { status: 'UNKNOWN', error: String(error.message || error).slice(0, 300) }, roles: {} };
  }
}

function isTimeoutError(error) {
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return name === 'timeouterror' || /\btimeout\b|timed out|aborted due to timeout/.test(message);
}

function timeoutError(message = 'Council role exceeded its bounded request deadline.') {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function failClosedRoleVote(role, error) {
  const timedOut = isTimeoutError(error);
  const validationFailed = error?.name === 'CouncilValidationError';
  return {
    role,
    status: validationFailed ? 'INVALID_EVIDENCE' : 'API_ERROR',
    verdict: 'UNKNOWN',
    summary: validationFailed
      ? 'Council output failed deterministic evidence validation.'
      : (timedOut
        ? 'Council role timed out without a usable vote.'
        : 'Council role failed without a usable vote.'),
    metrics: [],
    unknowns: [String(error?.message || error || 'unknown council role error').slice(0, 300)],
    conditions: [],
  };
}

async function runWithTimeoutRetry(operation, options = {}) {
  const attemptTimeoutMs = Number(options.attemptTimeoutMs ?? ROLE_ATTEMPT_TIMEOUT_MS);
  const totalTimeoutMs = Number(options.totalTimeoutMs ?? ROLE_TOTAL_TIMEOUT_MS);
  const maxAttempts = Math.min(ROLE_MAX_ATTEMPTS,
    Math.max(1, Number(options.maxAttempts ?? ROLE_MAX_ATTEMPTS)));
  const now = options.now || (() => performance.now());
  const makeSignal = options.makeSignal || (timeoutMs => AbortSignal.timeout(timeoutMs));
  const shouldRetry = options.shouldRetry || isTimeoutError;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0 ||
      !Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new TypeError('council timeout bounds must be positive finite numbers');
  }

  const startedAt = Number(now());
  const deadline = startedAt + totalTimeoutMs;
  let attempts = 0;
  let lastError = timeoutError();
  while (attempts < maxAttempts) {
    const remainingMs = deadline - Number(now());
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      lastError = timeoutError('Council role exhausted its hard total deadline.');
      break;
    }
    const timeoutMs = Math.max(1, Math.ceil(Math.min(attemptTimeoutMs, remainingMs)));
    attempts += 1;
    try {
      const context = {
        attempt: attempts,
        timeoutMs,
        signal: makeSignal(timeoutMs),
      };
      let timer;
      const deadlinePromise = new Promise((_, reject) => {
        timer = setTimer(() => reject(timeoutError()), timeoutMs);
      });
      let value;
      try {
        value = await Promise.race([
          Promise.resolve().then(() => operation(context)),
          deadlinePromise,
        ]);
      } finally {
        clearTimer(timer);
      }
      if (Number(now()) > deadline) {
        lastError = timeoutError('Council role completed after its hard total deadline.');
        break;
      }
      return { ok: true, value, attempts };
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempts >= maxAttempts) break;
    }
  }
  return { ok: false, error: lastError, attempts };
}

function writeCouncilUsage(brainDir, role, councilModel, json) {
  const usage = json.usage || {};
  const details = usage.prompt_tokens_details || {};
  fs.appendFileSync(path.join(brainDir, 'usage.jsonl'), JSON.stringify({
    t: new Date().toISOString(),
    model: 'council',
    billing_model: councilModel,
    wake_id: process.env.WAKE_ID || null,
    role,
    ...usage,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    usage_schema: 'chat_completions',
    service_tier: json.service_tier || null,
    cached: Object.prototype.hasOwnProperty.call(details, 'cached_tokens') ? details.cached_tokens : null,
    cache_write: Object.prototype.hasOwnProperty.call(details, 'cache_write_tokens') ? details.cache_write_tokens : null,
  }) + '\n');
}

function writeCouncilAudit(brainDir, role, vote, details = {}) {
  const validationError = details.validationError
    ? String(details.validationError).slice(0, 300)
    : (vote?.status === 'INVALID_EVIDENCE'
      ? String(vote?.unknowns?.[0] || 'deterministic validation failed').slice(0, 300)
      : null);
  fs.appendFileSync(path.join(brainDir, 'council-audit.jsonl'), JSON.stringify({
    t: new Date().toISOString(),
    wake_id: process.env.WAKE_ID || null,
    role,
    status: vote?.status || 'API_ERROR',
    verdict: vote?.verdict || 'UNKNOWN',
    attempts: Number(details.attempts) || 1,
    errorKind: details.errorKind || null,
    repairAttempted: details.repairAttempted === true,
    validationError,
  }) + '\n');
}

async function reviewCouncilRole({ role, system, evidence, args, apiKey, brainDir }, dependencies = {}) {
  const writeAudit = dependencies.writeAudit || writeCouncilAudit;
  try {
    const roleEvidence = evidence.roles?.[role] || {
      meta: evidence.meta || { status: 'UNKNOWN' },
      value: 'UNKNOWN — automatic evidence collection failed',
    };
    const evidenceView = prepareEvidenceView(roleEvidence);
    const rawContext = String(args.context || '');
    const operatorContext = rawContext.length <= 4000
      ? rawContext
      : `${rawContext.slice(0, 4000)}\n[TRUNCATED: ${rawContext.length - 4000} operator-context characters omitted]`;
    const councilModel = process.env.COUNCIL_MODEL || 'gpt-5.6-luna';
    const fetchImpl = dependencies.fetch || globalThis.fetch;
    const writeUsage = dependencies.writeUsage || writeCouncilUsage;
    let validationFeedback = null;
    let initialValidationError = null;
    let repairAttempted = false;
    const request = await runWithTimeoutRetry(async ({ signal }) => {
      const repairFeedback = validationFeedback;
      repairAttempted ||= Boolean(repairFeedback);
      const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: councilModel,
          messages: [
            { role: 'system', content: `${system} Use only the automatic evidence below as facts. If a required field is missing, stale, contradictory, or non-200, use UNKNOWN and do not infer a number. Every metric must cite an exact RFC 6901 pointer and copy its primitive value exactly. Put no digits in summary, unknowns, or conditions; numeric facts belong only in metrics. The owner-approved strategy is not yours to re-litigate.` },
            { role: 'user', content: `PROPOSAL:\n${args.proposal}\n\nAUTOMATIC ${role} EVIDENCE:\n${JSON.stringify(evidenceView)}\n\nOPERATOR CONTEXT (supporting only; unverified claims are not facts):\n${operatorContext}${repairFeedback ? `\n\nREPAIR REQUIRED: The previous vote failed deterministic validation: ${repairFeedback}. Return a new complete vote using only exact evidence pointers and primitive values; do not reuse an unsupported claim.` : ''}` },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'council_vote', strict: true, schema: councilVoteSchema },
          },
        }),
      });
      let json;
      try { json = await response.json(); }
      catch (error) { throw new Error(`Council ${role} response JSON was invalid: ${error.message || error}`); }
      writeUsage(brainDir, role, councilModel, json);
      if (!response.ok || json.error) {
        throw new Error(String(json.error?.message || `Council ${role} API returned HTTP ${response.status}`));
      }
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Council ${role} API returned no structured vote`);
      let parsed;
      try { parsed = JSON.parse(content); }
      catch (error) { throw new Error(`Council ${role} vote JSON was invalid: ${error.message || error}`); }
      const validated = validateCouncilVote(role, parsed, evidenceView);
      if (!validated.ok) {
        validationFeedback = String(validated.value?.unknowns?.[0] ||
          'deterministic evidence validation failed').slice(0, 300);
        initialValidationError ||= validationFeedback;
        const error = new Error(validationFeedback);
        error.name = 'CouncilValidationError';
        throw error;
      }
      return validated.value;
    }, {
      attemptTimeoutMs: dependencies.attemptTimeoutMs,
      totalTimeoutMs: dependencies.totalTimeoutMs,
      now: dependencies.now,
      makeSignal: dependencies.makeSignal,
      setTimer: dependencies.setTimer,
      clearTimer: dependencies.clearTimer,
      shouldRetry: error => isTimeoutError(error) || error?.name === 'CouncilValidationError',
    });
    const vote = request.ok ? request.value : failClosedRoleVote(role, request.error);
    try {
      writeAudit(brainDir, role, vote, {
        attempts: request.attempts,
        errorKind: request.ok ? null : (isTimeoutError(request.error)
          ? 'TIMEOUT' : (request.error?.name === 'CouncilValidationError'
            ? 'VALIDATION' : 'API_OR_JSON')),
        repairAttempted,
        validationError: initialValidationError,
      });
    } catch (_) { /* audit failure cannot turn a valid vote into approval or rejection */ }
    return vote;
  } catch (error) {
    const vote = failClosedRoleVote(role, error);
    try {
      writeAudit(brainDir, role, vote, {
        attempts: 1,
        errorKind: isTimeoutError(error) ? 'TIMEOUT' : 'INTERNAL',
        repairAttempted: false,
      });
    } catch (_) { /* audit failure cannot change a fail-closed vote */ }
    return vote;
  }
}

async function runCouncil({ args, apiKey, brainDir, simDir }, dependencies = {}) {
  const normalizedArgs = args || {};
  const evidenceCollector = dependencies.collectEvidence || collectEvidence;
  const evidence = evidenceCollector(normalizedArgs, brainDir, simDir);
  const roleReviewer = dependencies.reviewRole || reviewCouncilRole;
  const votes = await Promise.all(ROLES.map(async ([role, system]) => {
    try {
      return await roleReviewer({
        role,
        system,
        evidence,
        args: normalizedArgs,
        apiKey,
        brainDir,
      }, dependencies);
    } catch (error) {
      return failClosedRoleVote(role, error);
    }
  }));
  return { evidence: evidence.meta || { status: 'UNKNOWN' }, council: votes };
}

module.exports = {
  ROLE_ATTEMPT_TIMEOUT_MS,
  ROLE_MAX_ATTEMPTS,
  ROLE_TOTAL_TIMEOUT_MS,
  ROLES,
  collectEvidence,
  failClosedRoleVote,
  isTimeoutError,
  prepareEvidenceView,
  reviewCouncilRole,
  runCouncil,
  runWithTimeoutRetry,
  writeCouncilAudit,
  writeCouncilUsage,
};
