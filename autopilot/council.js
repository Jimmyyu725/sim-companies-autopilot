'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  councilVoteSchema,
  strategyCouncilVoteSchema,
  validateCouncilVote,
  validateStrategyCouncilVote,
} = require('./council-verdict.js');

const ROLE_MAX_ATTEMPTS = 2;
const DEEPSEEK_COUNCIL_JSON_INSTRUCTION = [
  'Return only one valid JSON object with exactly these keys: verdict, summary, metrics, unknowns, conditions.',
  'JSON shape example only: {"verdict":"UNKNOWN","summary":"Evidence is incomplete.",',
  '"metrics":[{"pointer":"/exact/path/from/evidence","value":"exact primitive from evidence"}],',
  '"unknowns":["Required evidence is unavailable."],"conditions":[]}.',
  'Do not copy the example pointer or value. Cite only an exact pointer and primitive value present in the supplied evidence.',
].join(' ');
const DEEPSEEK_STRATEGY_JSON_INSTRUCTION = [
  'Return only one valid JSON object with exactly these keys: verdict, optionId, summary, metrics, unknowns, conditions.',
  'Use verdict RECOMMEND with one exact supplied optionId, or UNKNOWN with optionId null.',
  'Cite only exact evidence pointers and primitive values present in the supplied evidence.',
].join(' ');
const STRATEGY_ACTIONS = new Set([
  'hold',
  'build',
  'upgrade',
  'scrap',
  'rebuild',
  'bonds',
  'robots',
  'pivot',
  'other',
]);
const strategyCouncilToolParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 1000 },
    context: { type: 'string', maxLength: 4000 },
    focusBuildingId: { type: ['integer', 'null'], minimum: 1 },
    marketKinds: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      items: { type: 'integer', minimum: 1 },
    },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,79}$' },
          label: { type: 'string', minLength: 1, maxLength: 300 },
          action: {
            type: 'string',
            enum: ['hold', 'build', 'upgrade', 'scrap', 'rebuild', 'bonds', 'robots', 'pivot', 'other'],
          },
          buildingId: { type: ['integer', 'null'], minimum: 1 },
          target: { type: ['string', 'null'], maxLength: 120 },
        },
        required: ['id', 'label', 'action', 'buildingId', 'target'],
      },
    },
  },
  required: ['question', 'context', 'focusBuildingId', 'marketKinds', 'options'],
};

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
  responseSchema = councilVoteSchema,
  schemaName = 'council_vote',
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
      json_schema: { name: schemaName, strict: true, schema: responseSchema },
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

function failClosedRoleVote(role, error, reviewType = 'authorization') {
  const timedOut = isTimeoutError(error);
  const validationFailed = error?.name === 'CouncilValidationError';
  return {
    role,
    status: validationFailed ? 'INVALID_EVIDENCE' : 'API_ERROR',
    verdict: 'UNKNOWN',
    ...(reviewType === 'strategy' ? { optionId: null } : {}),
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
    reviewType: details.reviewType === 'strategy' ? 'strategy' : 'authorization',
    status: vote?.status || 'API_ERROR',
    verdict: vote?.verdict || 'UNKNOWN',
    optionId: details.reviewType === 'strategy' ? (vote?.optionId || null) : undefined,
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
    const reviewType = args?.reviewType === 'strategy' ? 'strategy' : 'authorization';
    const optionIds = reviewType === 'strategy'
      ? args.options.map(option => option.id)
      : [];
    let validationFeedback = null;
    let initialValidationError = null;
    let repairAttempted = false;
    const request = await runWithRetry(async () => {
      const repairFeedback = validationFeedback;
      repairAttempted ||= Boolean(repairFeedback);
      const reviewInstruction = reviewType === 'strategy'
        ? 'Independently choose the best direction from the supplied options. The CEO has not selected an option. Recommend exactly one option ID; use UNKNOWN only when evidence cannot support any recommendation.'
        : 'Independently review the exact previewed proposal. It is not pre-approved. Approve, amend, reject, or return UNKNOWN from the evidence.';
      const systemContent = `${system} ${reviewInstruction} Use only the automatic evidence below as facts. ` +
        'If a required field is missing, stale, contradictory, or non-200, use UNKNOWN and do not infer a number. ' +
        'Every metric must cite an exact RFC 6901 pointer and copy its primitive value exactly. ' +
        `Put no digits in summary, unknowns, or conditions; numeric facts belong only in metrics.${councilProvider === 'deepseek'
          ? ` ${reviewType === 'strategy'
            ? DEEPSEEK_STRATEGY_JSON_INSTRUCTION
            : DEEPSEEK_COUNCIL_JSON_INSTRUCTION}`
          : ''}`;
      const task = reviewType === 'strategy'
        ? `STRATEGIC QUESTION:\n${args.question}\n\nOPTIONS:\n${JSON.stringify(args.options)}`
        : `PROPOSAL:\n${args.proposal}`;
      const messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: `${task}\n\nAUTOMATIC ${role} EVIDENCE:\n${JSON.stringify(evidenceView)}\n\nOPERATOR CONTEXT (supporting only; unverified claims are not facts):\n${operatorContext}${repairFeedback ? `\n\nREPAIR REQUIRED: The previous vote failed deterministic validation: ${repairFeedback}. Return a new complete vote using only exact evidence pointers and primitive values; do not reuse an unsupported claim.` : ''}` },
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
          responseSchema: reviewType === 'strategy'
            ? strategyCouncilVoteSchema
            : councilVoteSchema,
          schemaName: reviewType === 'strategy'
            ? 'strategy_council_vote'
            : 'council_vote',
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
      const validated = reviewType === 'strategy'
        ? validateStrategyCouncilVote(role, parsed, evidenceView, optionIds)
        : validateCouncilVote(role, parsed, evidenceView);
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
    const vote = request.ok
      ? request.value
      : failClosedRoleVote(role, request.error, reviewType);
    try {
      writeAudit(brainDir, role, vote, {
        attempts: request.attempts,
        errorKind: request.ok ? null : (isTimeoutError(request.error)
          ? 'TIMEOUT' : (request.error?.name === 'CouncilValidationError'
            ? 'VALIDATION' : 'API_OR_JSON')),
        repairAttempted,
        validationError: initialValidationError,
        reviewType,
      });
    } catch (_) { /* audit failure cannot turn a valid vote into approval or rejection */ }
    return vote;
  } catch (error) {
    const reviewType = args?.reviewType === 'strategy' ? 'strategy' : 'authorization';
    const vote = failClosedRoleVote(role, error, reviewType);
    try {
      writeAudit(brainDir, role, vote, {
        attempts: 1,
        errorKind: isTimeoutError(error) ? 'TIMEOUT' : 'INTERNAL',
        repairAttempted: false,
        reviewType,
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

function validateStrategyCouncilArgs(args) {
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('strategy_council arguments must be an object');
    }
    const question = String(args.question || '').trim();
    const context = String(args.context || '').trim();
    if (!question || question.length > 1000) {
      throw new Error('question must contain one to one thousand characters');
    }
    if (context.length > 4000) throw new Error('context exceeds four thousand characters');
    const focusBuildingId = args.focusBuildingId == null ? null : Number(args.focusBuildingId);
    if (focusBuildingId !== null &&
        (!Number.isSafeInteger(focusBuildingId) || focusBuildingId <= 0)) {
      throw new Error('focusBuildingId must be a positive integer or null');
    }
    const marketKinds = [...new Set((Array.isArray(args.marketKinds)
      ? args.marketKinds
      : []).map(Number))];
    if (marketKinds.length < 1 || marketKinds.length > 10 ||
        marketKinds.some(kind => !Number.isSafeInteger(kind) || kind <= 0)) {
      throw new Error('marketKinds must contain one to ten unique positive integers');
    }
    if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 5) {
      throw new Error('options must contain two to five choices');
    }
    const seen = new Set();
    const options = args.options.map(option => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        throw new Error('each strategy option must be an object');
      }
      const id = String(option.id || '').trim();
      const label = String(option.label || '').trim();
      const action = String(option.action || '').trim().toLowerCase();
      const buildingId = option.buildingId == null ? null : Number(option.buildingId);
      const target = option.target == null ? null : String(option.target).trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,79}$/u.test(id) || seen.has(id)) {
        throw new Error('strategy option IDs must be unique stable lowercase identifiers');
      }
      seen.add(id);
      if (!label || label.length > 300) {
        throw new Error('strategy option labels must contain one to three hundred characters');
      }
      if (!STRATEGY_ACTIONS.has(action)) throw new Error(`unsupported strategy action: ${action}`);
      if (buildingId !== null &&
          (!Number.isSafeInteger(buildingId) || buildingId <= 0)) {
        throw new Error('strategy option buildingId must be a positive integer or null');
      }
      if (['upgrade', 'scrap', 'rebuild', 'robots'].includes(action) && buildingId === null) {
        throw new Error(`${action} strategy option requires a buildingId`);
      }
      if (action === 'build' && !target) {
        throw new Error('build strategy option requires a target building type');
      }
      if (target !== null && (!target || target.length > 120)) {
        throw new Error('strategy option target must be null or a bounded non-empty string');
      }
      return { id, label, action, buildingId, target };
    });
    const hold = options.find(option => option.id === 'hold');
    if (!hold || hold.action !== 'hold' || hold.buildingId !== null || hold.target !== null) {
      throw new Error('options must include an exact hold option with action hold and null target');
    }
    return {
      ok: true,
      value: {
        question,
        context,
        focusBuildingId,
        marketKinds,
        options,
      },
    };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

function aggregateStrategyDecision(votes, options) {
  const optionIds = new Set((Array.isArray(options) ? options : []).map(option => option.id));
  const roles = ['CFO', 'COO', 'CMO'];
  const normalizedVotes = Array.isArray(votes) ? votes : [];
  const foundRoles = new Set(normalizedVotes.map(vote => vote?.role));
  if (normalizedVotes.length !== 3 || !roles.every(role => foundRoles.has(role))) {
    return { status: 'INCOMPLETE', optionId: null, method: null, tally: {},
      reason: 'strategy council did not return all three roles' };
  }
  const invalid = normalizedVotes.find(vote => vote?.status !== 'VALIDATED' ||
    vote?.verdict !== 'RECOMMEND' || !optionIds.has(vote?.optionId));
  if (invalid) {
    return { status: 'INCOMPLETE', optionId: null, method: null, tally: {},
      reason: `${invalid?.role || 'council'} did not provide a validated recommendation` };
  }
  const tally = {};
  for (const vote of normalizedVotes) {
    tally[vote.optionId] = (tally[vote.optionId] || 0) + 1;
  }
  const ranked = Object.entries(tally).sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked[0][1] >= 2) {
    return {
      status: 'DECIDED',
      optionId: ranked[0][0],
      method: 'majority',
      tally,
      reason: null,
    };
  }
  if (optionIds.has('hold')) {
    return {
      status: 'DECIDED',
      optionId: 'hold',
      method: 'hold_tiebreak',
      tally,
      reason: null,
    };
  }
  return {
    status: 'INCOMPLETE',
    optionId: null,
    method: null,
    tally,
    reason: 'strategy council tie has no hold option',
  };
}

async function runStrategyCouncil({ args, apiKey, brainDir, simDir }, dependencies = {}) {
  const checked = validateStrategyCouncilArgs(args);
  if (!checked.ok) {
    return {
      ok: false,
      guard: true,
      reason: checked.reason,
      evidence: { status: 'UNKNOWN' },
      council: [],
      decision: {
        status: 'INCOMPLETE',
        optionId: null,
        method: null,
        tally: {},
        reason: checked.reason,
      },
    };
  }
  const normalizedArgs = { ...checked.value, reviewType: 'strategy' };
  const evidenceCollector = dependencies.collectEvidence || collectEvidence;
  const evidence = evidenceCollector({
    ...normalizedArgs,
    buildingId: normalizedArgs.focusBuildingId,
  }, brainDir, simDir);
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
      return failClosedRoleVote(role, error, 'strategy');
    }
  }));
  const decision = aggregateStrategyDecision(votes, normalizedArgs.options);
  return {
    ok: decision.status === 'DECIDED',
    evidence: evidence.meta || { status: 'UNKNOWN' },
    council: votes,
    decision,
  };
}

module.exports = {
  DEEPSEEK_STRATEGY_JSON_INSTRUCTION,
  ROLE_MAX_ATTEMPTS,
  ROLES,
  STRATEGY_ACTIONS,
  aggregateStrategyDecision,
  buildCouncilRequest,
  collectEvidence,
  failClosedRoleVote,
  isTimeoutError,
  prepareEvidenceView,
  redactSecrets,
  resolveCouncilProvider,
  reviewCouncilRole,
  runCouncil,
  runStrategyCouncil,
  runWithRetry,
  strategyCouncilToolParameters,
  validateStrategyCouncilArgs,
  writeCouncilAudit,
  writeCouncilUsage,
};
