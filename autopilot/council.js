'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { councilVoteSchema, validateCouncilVote } = require('./council-verdict.js');

const ROLE_MAX_ATTEMPTS = 2;
const DEEPSEEK_COUNCIL_JSON_INSTRUCTION = [
  'Return only one valid JSON object with exactly these keys: verdict, summary, metrics, unknowns, conditions.',
  'JSON shape example only: {"verdict":"UNKNOWN","summary":"Evidence is incomplete.",',
  '"metrics":[{"pointer":"/exact/path/from/evidence","value":"exact primitive from evidence"}],',
  '"unknowns":["Required evidence is unavailable."],"conditions":[]}.',
  'Do not copy the example pointer or value. Cite only an exact pointer and primitive value present in the supplied evidence.',
].join(' ');

const ROLES = Object.freeze([
  ['CFO', 'You are a skeptical CFO. Evaluate cash, working capital, debt service, payback, and measured-vs-assumed figures. Outstanding debt is debt.principalOutstanding reconciled against debt.balanceSheetPayable. The bond offer form and bondOffer API describe only the current unsold offer; their amount can be 0 while debt remains outstanding and must never override debt.'],
  ['COO', 'You are a pragmatic COO. Evaluate slots, downtime, production continuity, inputs, and end-to-end bottlenecks.'],
  ['CMO', 'You are a market CMO. Evaluate retail absorption, weather, saturation, live order-book depth, net margin, and transition revenue loss.'],
]);

function redactSecrets(value) {
  return String(value || '').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
}

function resolveCouncilProvider(value = process.env.COUNCIL_PROVIDER || 'openai') {
  const provider = String(value || '').trim().toLowerCase();
  if (!['openai', 'deepseek'].includes(provider)) {
    throw new Error('COUNCIL_PROVIDER must be openai or deepseek');
  }
  return provider;
}

function buildCouncilRequest({
  provider,
  model,
  messages,
  effort = 'max',
  maxTokens = 16384,
}) {
  const resolvedProvider = resolveCouncilProvider(provider);
  if (resolvedProvider === 'deepseek') {
    if (!['high', 'max'].includes(effort)) {
      throw new Error('DeepSeek COUNCIL_EFFORT must be high or max');
    }
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1024 || maxTokens > 384000) {
      throw new Error('DeepSeek COUNCIL_MAX_TOKENS must be an integer from 1024 to 384000');
    }
    return {
      model,
      messages,
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled' },
      reasoning_effort: effort,
      max_tokens: maxTokens,
    };
  }
  return {
    model,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'council_vote', strict: true, schema: councilVoteSchema },
    },
  };
}

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
    unknowns: [redactSecrets(error?.message || error || 'unknown council role error').slice(0, 300)],
    conditions: [],
  };
}

async function runWithRetry(operation, options = {}) {
  const maxAttempts = Math.min(ROLE_MAX_ATTEMPTS,
    Math.max(1, Number(options.maxAttempts ?? ROLE_MAX_ATTEMPTS)));
  const shouldRetry = options.shouldRetry || isTimeoutError;
  let attempts = 0;
  let lastError = new Error('Council role did not return a usable vote.');
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const value = await operation({ attempt: attempts });
      return { ok: true, value, attempts };
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempts >= maxAttempts) break;
    }
  }
  return { ok: false, error: lastError, attempts };
}

function writeCouncilUsage(brainDir, role, councilModel, json, provider = 'openai') {
  const usage = json.usage || {};
  const details = usage.prompt_tokens_details || {};
  const cached = provider === 'deepseek'
    ? usage.prompt_cache_hit_tokens
    : (Object.prototype.hasOwnProperty.call(details, 'cached_tokens')
      ? details.cached_tokens
      : null);
  const cacheWrite = provider === 'deepseek'
    ? 0
    : (Object.prototype.hasOwnProperty.call(details, 'cache_write_tokens')
      ? details.cache_write_tokens
      : null);
  fs.appendFileSync(path.join(brainDir, 'usage.jsonl'), JSON.stringify({
    t: new Date().toISOString(),
    model: 'council',
    billing_model: councilModel,
    billing_provider: provider,
    wake_id: process.env.WAKE_ID || null,
    role,
    ...usage,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    usage_schema: 'chat_completions',
    service_tier: provider === 'openai' ? (json.service_tier || null) : null,
    reasoning_effort: provider === 'deepseek'
      ? (process.env.COUNCIL_EFFORT || 'max')
      : null,
    cached: cached ?? null,
    cache_miss: provider === 'deepseek'
      ? (usage.prompt_cache_miss_tokens ?? null)
      : null,
    cache_write: cacheWrite,
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
    const councilProvider = resolveCouncilProvider(
      dependencies.provider || process.env.COUNCIL_PROVIDER || 'openai');
    const councilModel = process.env.COUNCIL_MODEL ||
      (councilProvider === 'deepseek' ? 'deepseek-v4-pro' : 'gpt-5.6-luna');
    const councilEffort = process.env.COUNCIL_EFFORT ||
      (councilProvider === 'deepseek' ? 'max' : 'high');
    const councilMaxTokens = Number(process.env.COUNCIL_MAX_TOKENS) || 16384;
    const councilApiUrl = councilProvider === 'deepseek'
      ? `${String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/u, '')}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
    const fetchImpl = dependencies.fetch || globalThis.fetch;
    const writeUsage = dependencies.writeUsage || writeCouncilUsage;
    let validationFeedback = null;
    let initialValidationError = null;
    let repairAttempted = false;
    const request = await runWithRetry(async () => {
      const repairFeedback = validationFeedback;
      repairAttempted ||= Boolean(repairFeedback);
      const systemContent = `${system} Use only the automatic evidence below as facts. ` +
        'If a required field is missing, stale, contradictory, or non-200, use UNKNOWN and do not infer a number. ' +
        'Every metric must cite an exact RFC 6901 pointer and copy its primitive value exactly. ' +
        'Put no digits in summary, unknowns, or conditions; numeric facts belong only in metrics. ' +
        `The owner-approved strategy is not yours to re-litigate.${councilProvider === 'deepseek'
          ? ` ${DEEPSEEK_COUNCIL_JSON_INSTRUCTION}`
          : ''}`;
      const messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: `PROPOSAL:\n${args.proposal}\n\nAUTOMATIC ${role} EVIDENCE:\n${JSON.stringify(evidenceView)}\n\nOPERATOR CONTEXT (supporting only; unverified claims are not facts):\n${operatorContext}${repairFeedback ? `\n\nREPAIR REQUIRED: The previous vote failed deterministic validation: ${repairFeedback}. Return a new complete vote using only exact evidence pointers and primitive values; do not reuse an unsupported claim.` : ''}` },
      ];
      const response = await fetchImpl(councilApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildCouncilRequest({
          provider: councilProvider,
          model: councilModel,
          messages,
          effort: councilEffort,
          maxTokens: councilMaxTokens,
        })),
      });
      let json;
      try { json = await response.json(); }
      catch (error) {
        throw new Error(`Council ${role} response JSON was invalid: ${redactSecrets(error.message || error)}`);
      }
      writeUsage(brainDir, role, councilModel, json, councilProvider);
      if (!response.ok || json.error) {
        throw new Error(redactSecrets(
          json.error?.message || `Council ${role} API returned HTTP ${response.status}`));
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
  ROLE_MAX_ATTEMPTS,
  ROLES,
  buildCouncilRequest,
  collectEvidence,
  failClosedRoleVote,
  isTimeoutError,
  prepareEvidenceView,
  redactSecrets,
  resolveCouncilProvider,
  reviewCouncilRole,
  runCouncil,
  runWithRetry,
  writeCouncilAudit,
  writeCouncilUsage,
};
