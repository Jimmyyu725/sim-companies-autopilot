'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  councilVoteSchema,
  metricIsAuthoritative,
  resolvePointer,
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
  'Copy citation pairs from the AUTHORITATIVE CITATION MENU; never invent, shorten, or relocate a pointer.',
].join(' ');
const DEEPSEEK_STRATEGY_JSON_INSTRUCTION = [
  'Return only one valid JSON object with exactly these keys: verdict, optionId, summary, metrics, unknowns, conditions.',
  'Use verdict RECOMMEND with one exact supplied optionId, or UNKNOWN with optionId null.',
  'If active options are not justified but current evidence is usable, RECOMMEND the exact hold option; do not return UNKNOWN merely because an investment case is weak.',
  'metrics MUST be a JSON array with one to eight objects; each object has exactly pointer and value.',
  'unknowns and conditions MUST each be a JSON array of non-empty qualitative strings, or an empty array.',
  'summary, unknowns, and conditions MUST contain no digit characters; put every numeric fact only in metrics.',
  'For a recommendation, prefer unknowns:[] and conditions:[] unless a real qualitative caveat remains.',
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
const AUTHORIZATION_ACTIONS = new Set([
  'build',
  'upgrade',
  'scrap',
  'rebuild',
  'bonds',
  'robots',
  'contract_send',
]);
const ROLE_CITATION_ROOTS = Object.freeze({
  CFO: Object.freeze([
    '/decisionModel/candidateComparison',
    '/company',
    '/debt',
    '/financePage',
    '/statements/balanceSheet',
    '/statements/incomeStatement',
    '/statements/cashflowStatement',
    '/statements/cashflowRecent',
  ]),
  COO: Object.freeze([
    '/decisionModel/candidateComparison',
    '/decisionModel/coffeeChain/current',
    '/decisionModel/coffeeChain/afterKnownProductionModifiers',
    '/decisionModel/coffeeChain/currentFarmAllocation',
    '/slots',
    '/portfolioInspections',
    '/buildingInspection',
    '/warehouse',
    '/stock',
    '/modifiers',
    '/printedRates',
  ]),
  CMO: Object.freeze([
    '/decisionModel/candidateComparison',
    '/groceryRetailEvidence',
    '/decisionModel/coffeeChain/retailEvidence',
    '/decisionModel/coffeeChain/current/retail',
    '/marketBooks',
    '/retail',
    '/keyPrices',
    '/volume1h',
    '/volume1hMeta',
    '/weather',
  ]),
});
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
  ['CFO', 'You are a skeptical CFO. Evaluate cash, working capital, debt service, payback, and measured-vs-assumed figures. Start from decisionModel, which automatically reconciles the complete Coffee chain and candidate economics; treat every stated projection and caveat according to its evidenceStatus. Outstanding debt is debt.principalOutstanding reconciled against debt.balanceSheetPayable. The bond offer form and bondOffer API describe only the current unsold offer; their amount can be 0 while debt remains outstanding and must never override debt.'],
  ['COO', 'You are a pragmatic COO. Start from decisionModel and portfolioInspections. Evaluate every owned Farm, Mill, Grocery store, Power plant, and Water reservoir together, including slots, exact current rates, downtime, continuity, input recipes, modifier expiry, and end-to-end bottlenecks. Never infer an absent rate as zero.'],
  ['CMO', 'You are a market CMO. Start from decisionModel and groceryRetailEvidence. Evaluate the current Grocery order or fresh read-only price/profit curve, retail absorption, weather, saturation, live order-book depth, net margin, and transition revenue loss. Distinguish a measured retail point from a full curve.'],
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

function pointerToken(value) {
  return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function citationPriority(pointer) {
  const preferred = /quoted|cashAfter|cashNeeded|liveMissing|withinMaxCost|reserveSatisfied|downtime|effectPct|targetLevel|currentLevel|payback|incremental|profitPer|unitsPerHour|sustainable|bottleneck|freeSlots|principal|dailyInterest|rating|price|amount/iu;
  const supporting = /status|level|capacity|used|free|expiresAt|percent|fresh/iu;
  if (preferred.test(pointer)) return 0;
  if (supporting.test(pointer)) return 1;
  if (/\/(?:ok|dry|preview|source|note|previewVersion)$/u.test(pointer)) return 3;
  return 2;
}

function primitiveCitationsAt(evidence, root, limit = 64) {
  const resolved = resolvePointer(evidence, root);
  if (!resolved.ok) return [];
  const found = [];
  const walk = (value, pointer, depth) => {
    if (found.length >= limit || depth > 8) return;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (value === null || (typeof value === 'string' && value.length > 180)) return;
      if (metricIsAuthoritative(pointer, evidence)) {
        found.push({ pointer, value });
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      walk(child, `${pointer}/${pointerToken(key)}`, depth + 1);
      if (found.length >= limit) break;
    }
  };
  walk(resolved.value, root, 0);
  return found.sort((left, right) =>
    citationPriority(left.pointer) - citationPriority(right.pointer) ||
    left.pointer.localeCompare(right.pointer));
}

function buildAuthoritativeCitationMenu(role, evidence, reviewType = 'authorization') {
  const dedupe = (rows, limit) => {
    const seen = new Set();
    return rows.filter(row => {
      if (seen.has(row.pointer)) return false;
      seen.add(row.pointer);
      return true;
    }).slice(0, limit);
  };
  const preview = reviewType === 'authorization'
    ? dedupe(primitiveCitationsAt(evidence, '/authorizationPreview/preview'), 10)
    : dedupe(primitiveCitationsAt(evidence, '/strategyCandidates'), 10);
  const citationGroups = (ROLE_CITATION_ROOTS[role] || [])
    .map(root => primitiveCitationsAt(evidence, root))
    .filter(group => group.length > 0);
  const interleaved = [];
  for (let index = 0; interleaved.length < 18; index += 1) {
    let added = false;
    for (const group of citationGroups) {
      if (group[index]) {
        interleaved.push(group[index]);
        added = true;
      }
      if (interleaved.length >= 18) break;
    }
    if (!added) break;
  }
  const roleSpecific = dedupe(interleaved, 18);
  return {
    rule: reviewType === 'authorization'
      ? 'Copy at least one exact preview pair and one exact role-specific pair. Never cite /authorizationPreview/terms.'
      : 'Copy at least one exact role-specific pair. Candidate terms are labels, not measured evidence.',
    preview,
    roleSpecific,
  };
}

function normalizeStrategyCandidates(candidates, collectedAt) {
  const collectedAtMs = Date.parse(collectedAt);
  return (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate?.source === 'runtime-verified-structural-preview' &&
      /^[a-z][a-z0-9_-]{0,79}$/u.test(String(candidate?.optionId || '')) &&
      STRATEGY_ACTIONS.has(String(candidate?.action || '').trim().toLowerCase()) &&
      candidate?.terms && typeof candidate.terms === 'object' &&
      candidate?.preview && typeof candidate.preview === 'object' &&
      candidate.preview.ok === true &&
      (candidate.preview.preview === true || candidate.preview.dry === true))
    .slice(0, 5)
    .map(candidate => {
      const previewedAt = String(candidate.previewedAt || '');
      const previewedAtMs = Date.parse(previewedAt);
      const previewAgeSeconds = Number.isFinite(collectedAtMs) && Number.isFinite(previewedAtMs)
        ? Math.round((collectedAtMs - previewedAtMs) / 1000)
        : null;
      return {
        optionId: String(candidate.optionId),
        action: String(candidate.action).trim().toLowerCase(),
        terms: candidate.terms,
        preview: candidate.preview,
        source: candidate.source,
        previewedAt,
        previewAgeSeconds,
        previewVersion: Number.isSafeInteger(Number(candidate.previewVersion))
          ? Number(candidate.previewVersion)
          : null,
      };
    });
}

function attachStrategyCandidateEvidence(evidence, candidates) {
  const collectedAt = evidence?.meta?.collectedAt || new Date().toISOString();
  const normalized = normalizeStrategyCandidates(candidates, collectedAt);
  const candidateStatus = normalized.length ? 'VERIFIED' : 'NOT_PROVIDED';
  const meta = {
    ...(evidence?.meta || { status: 'UNKNOWN' }),
    strategyCandidates: candidateStatus,
    strategyCandidateCount: normalized.length,
  };
  const roles = {};
  for (const [role, roleEvidence] of Object.entries(evidence?.roles || {})) {
    const { meta: roleMeta, ...rest } = roleEvidence || {};
    roles[role] = {
      meta: {
        ...(roleMeta || meta),
        strategyCandidates: candidateStatus,
        strategyCandidateCount: normalized.length,
      },
      // Keep candidate quotes ahead of larger role payloads so bounded transport preserves them.
      strategyCandidates: normalized,
      ...rest,
    };
  }
  return {
    ...(evidence || {}),
    meta,
    roles,
  };
}

function normalizeAuthorizationPreview(preview, collectedAt) {
  if (!preview || preview.source !== 'runtime-verified-structural-preview' ||
      !AUTHORIZATION_ACTIONS.has(String(preview.action || '').trim().toLowerCase()) ||
      !preview.terms || typeof preview.terms !== 'object' ||
      !preview.preview || typeof preview.preview !== 'object' ||
      preview.preview.ok !== true ||
      (preview.preview.preview !== true && preview.preview.dry !== true)) {
    return null;
  }
  const previewedAt = String(preview.previewedAt || '');
  const previewAgeSeconds = Math.round(
    (Date.parse(collectedAt) - Date.parse(previewedAt)) / 1000,
  );
  if (!Number.isFinite(previewAgeSeconds) ||
      previewAgeSeconds < -30 || previewAgeSeconds > 600) {
    return null;
  }
  return {
    action: String(preview.action).trim().toLowerCase(),
    terms: preview.terms,
    preview: preview.preview,
    source: preview.source,
    previewedAt,
    previewAgeSeconds,
    previewVersion: Number.isSafeInteger(Number(preview.previewVersion))
      ? Number(preview.previewVersion)
      : null,
  };
}

function attachAuthorizationPreviewEvidence(evidence, preview) {
  if (!preview) return evidence;
  const collectedAt = evidence?.meta?.collectedAt || new Date().toISOString();
  const normalized = normalizeAuthorizationPreview(preview, collectedAt);
  const status = normalized ? 'VERIFIED' : 'UNKNOWN';
  const meta = {
    ...(evidence?.meta || { status: 'UNKNOWN' }),
    authorizationPreview: status,
  };
  const roles = {};
  for (const [role, roleEvidence] of Object.entries(evidence?.roles || {})) {
    const { meta: roleMeta, ...rest } = roleEvidence || {};
    roles[role] = {
      meta: {
        ...(roleMeta || meta),
        authorizationPreview: status,
      },
      authorizationPreview: normalized || 'UNKNOWN',
      ...rest,
    };
  }
  return {
    ...(evidence || {}),
    meta,
    roles,
  };
}

function staleEvidenceGuard(evidence, reviewType) {
  if (evidence?.meta?.stateFreshness === 'FRESH') return null;
  return {
    ok: false,
    guard: true,
    reason: `${reviewType === 'strategy' ? 'strategy council' : 'council'} state evidence is stale; refresh before asking advisors`,
    requiredTool: 'refresh_state',
    evidence: evidence?.meta || { status: 'UNKNOWN' },
    council: [],
  };
}

function strategyRepairInstruction(feedback, citationMenu = null, reviewType = 'authorization') {
  const value = String(feedback || '');
  const menuReminder = citationMenu
    ? ` Copy exact pointer and value pairs from this menu: ${JSON.stringify(citationMenu)}.`
    : '';
  if (/unknowns has invalid type/u.test(value)) {
    return 'Set unknowns to a JSON array; use [] when there is no qualitative unknown.';
  }
  if (/conditions has invalid type/u.test(value)) {
    return 'Set conditions to a JSON array; use [] when there is no qualitative condition.';
  }
  if (/must not contain numeric claims/u.test(value)) {
    return 'Remove every digit character from summary, unknowns, and conditions; retain numbers only as exact cited metric values.';
  }
  if (/metrics must contain/u.test(value)) {
    return `Return at least one metrics entry copied from an exact automatic-evidence pointer and primitive value.${menuReminder}`;
  }
  if (/authorization preview metric is not authoritative.*\/authorizationPreview\/terms/u.test(value)) {
    return `Do not cite /authorizationPreview/terms. Those are requested limits, not measured results. Cite only /authorizationPreview/preview entries from the menu and also one role-specific entry.${menuReminder}`;
  }
  if (/evidence pointer not found|metric value does not match evidence|metric is not authoritative|lacks an authoritative role-specific metric/u.test(value)) {
    const requirement = reviewType === 'authorization'
      ? 'Use one preview entry and one role-specific entry.'
      : 'Use at least one role-specific entry.';
    return `${requirement} Do not shorten, relocate, or invent paths.${menuReminder}`;
  }
  return 'Correct only the named validation defect while preserving the complete required JSON shape.';
}

function normalizeDeepSeekCouncilVote(vote) {
  if (!vote || typeof vote !== 'object' || Array.isArray(vote)) return vote;
  const qualitativeText = value => {
    if (typeof value !== 'string') return value;
    return value
      .replace(/\S*\d\S*/gu, 'the cited metric')
      .replace(/\s+/gu, ' ')
      .trim();
  };
  const qualitativeList = value => {
    if (value === null) return [];
    if (typeof value === 'string') {
      const normalized = qualitativeText(value);
      return normalized ? [normalized] : [];
    }
    if (!Array.isArray(value)) return value;
    return value
      .map(qualitativeText)
      .filter(item => typeof item === 'string' && item.length > 0);
  };
  return {
    ...vote,
    summary: qualitativeText(vote.summary),
    unknowns: qualitativeList(vote.unknowns),
    conditions: qualitativeList(vote.conditions),
  };
}

function collectEvidence(args, brainDir, simDir) {
  try {
    const out = execFileSync('flock', [
      '-w', '90', path.join(simDir, '.tick.lock'),
      'node', path.join(brainDir, 'council-evidence.js'), JSON.stringify({
        buildingId: args.buildingId ?? null,
        marketKinds: args.marketKinds ?? [1, 2, 66, 118, 119],
        reviewType: args.reviewType === 'strategy' ? 'strategy' : 'authorization',
        strategyCandidates: Array.isArray(args.strategyCandidates)
          ? args.strategyCandidates.slice(0, 5)
          : [],
        authorizationPreview: args.authorizationPreview || null,
      }),
    ], { cwd: simDir, timeout: 360000, encoding: 'utf8' });
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
    const citationMenu = buildAuthoritativeCitationMenu(role, evidenceView, reviewType);
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
        ? 'Independently choose the best direction from the supplied options. The CEO has not selected an option. Recommend exactly one option ID. If active options are not justified but current evidence is usable, recommend hold. Use UNKNOWN only when the automatic evidence is too broken or contradictory even to support hold.'
        : 'Independently review the exact previewed proposal. It is not pre-approved. Approve, amend, reject, or return UNKNOWN from the evidence.';
      const systemContent = `${system} ${reviewInstruction} Use only the automatic evidence below as facts. ` +
        'If a required field is missing, stale, contradictory, or non-200, use UNKNOWN and do not infer a number. ' +
        'Every metric must cite an exact RFC 6901 pointer and copy its primitive value exactly. ' +
        `Put no digits in summary, unknowns, or conditions; numeric facts belong only in metrics.${reviewType === 'authorization'
          ? ' The exact runtime-verified proposal quote is under /authorizationPreview/preview. Never cite /authorizationPreview/terms; those are requested limits, not verified results. A non-UNKNOWN verdict must copy at least one exact preview pair and at least one exact role-specific pair from the supplied citation menu.'
          : ''}${councilProvider === 'deepseek'
          ? ` ${reviewType === 'strategy'
            ? DEEPSEEK_STRATEGY_JSON_INSTRUCTION
            : DEEPSEEK_COUNCIL_JSON_INSTRUCTION}`
          : ''}`;
      const task = reviewType === 'strategy'
        ? `STRATEGIC QUESTION:\n${args.question}\n\nOPTIONS:\n${JSON.stringify(args.options)}`
        : `PROPOSAL:\n${args.proposal}`;
      const repairInstruction = repairFeedback
        ? strategyRepairInstruction(repairFeedback, citationMenu, reviewType)
        : null;
      const messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: `${task}\n\nAUTOMATIC ${role} EVIDENCE:\n${JSON.stringify(evidenceView)}\n\nAUTHORITATIVE CITATION MENU:\n${JSON.stringify(citationMenu)}\n\nOPERATOR CONTEXT (supporting only; unverified claims are not facts):\n${operatorContext}${repairFeedback ? `\n\nREPAIR REQUIRED: The previous vote failed deterministic validation: ${repairFeedback}. ${repairInstruction} Return a new complete vote using only exact evidence pointers and primitive values; do not reuse an unsupported claim.` : ''}` },
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
      if (councilProvider === 'deepseek') {
        parsed = normalizeDeepSeekCouncilVote(parsed);
      }
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
  const collectedEvidence = evidenceCollector(normalizedArgs, brainDir, simDir);
  const evidence = attachAuthorizationPreviewEvidence(
    collectedEvidence,
    normalizedArgs.authorizationPreview,
  );
  const stale = staleEvidenceGuard(evidence, 'authorization');
  if (stale) return stale;
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
    const requestedMarketKinds = (Array.isArray(args.marketKinds)
      ? args.marketKinds
      : []).map(Number);
    const marketKinds = [...new Set(requestedMarketKinds)];
    if (marketKinds.length < 1 || marketKinds.length > 10 ||
        marketKinds.some(kind => !Number.isSafeInteger(kind) || kind <= 0)) {
      throw new Error('marketKinds must contain one to ten unique positive integers');
    }
    if (marketKinds.length !== requestedMarketKinds.length) {
      throw new Error('marketKinds must not contain duplicate values');
    }
    if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 5) {
      throw new Error('options must contain two to five choices');
    }
    const seen = new Set();
    const seenDirections = new Set();
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
      const directionKey = action === 'build'
        ? `${action}:${target}`
        : (['upgrade', 'scrap', 'rebuild', 'robots'].includes(action)
          ? `${action}:${buildingId}`
          : (action === 'bonds' ? action : null));
      if (directionKey && seenDirections.has(directionKey)) {
        throw new Error('strategy options cannot duplicate one executable action target');
      }
      if (directionKey) seenDirections.add(directionKey);
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
  const tally = {};
  for (const vote of normalizedVotes) {
    if (vote?.status === 'VALIDATED' && vote?.verdict === 'RECOMMEND' &&
        optionIds.has(vote?.optionId)) {
      tally[vote.optionId] = (tally[vote.optionId] || 0) + 1;
    }
  }
  const invalid = normalizedVotes.find(vote => vote?.status !== 'VALIDATED' ||
    vote?.verdict !== 'RECOMMEND' || !optionIds.has(vote?.optionId));
  if (invalid) {
    if (optionIds.has('hold')) {
      return {
        status: 'DECIDED',
        optionId: 'hold',
        method: 'safety_hold',
        tally,
        unavailableRoles: normalizedVotes
          .filter(vote => vote?.status !== 'VALIDATED' ||
            vote?.verdict !== 'RECOMMEND' || !optionIds.has(vote?.optionId))
          .map(vote => vote?.role)
          .filter(role => roles.includes(role)),
        reason: 'one or more council roles were unavailable; no structural action is authorized',
      };
    }
    return { status: 'INCOMPLETE', optionId: null, method: null, tally: {},
      reason: `${invalid?.role || 'council'} did not provide a validated recommendation` };
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

async function runStrategyCouncil({
  args,
  apiKey,
  brainDir,
  simDir,
  strategyCandidates = [],
}, dependencies = {}) {
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
  const collectedEvidence = evidenceCollector({
    ...normalizedArgs,
    buildingId: normalizedArgs.focusBuildingId,
    strategyCandidates,
  }, brainDir, simDir);
  const evidence = attachStrategyCandidateEvidence(collectedEvidence, strategyCandidates);
  const stale = staleEvidenceGuard(evidence, 'strategy');
  if (stale) {
    return {
      ...stale,
      decision: {
        status: 'INCOMPLETE',
        optionId: null,
        method: null,
        tally: {},
        reason: stale.reason,
      },
    };
  }
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
  attachAuthorizationPreviewEvidence,
  attachStrategyCandidateEvidence,
  buildAuthoritativeCitationMenu,
  buildCouncilRequest,
  collectEvidence,
  failClosedRoleVote,
  isTimeoutError,
  normalizeStrategyCandidates,
  normalizeAuthorizationPreview,
  normalizeDeepSeekCouncilVote,
  prepareEvidenceView,
  redactSecrets,
  resolveCouncilProvider,
  reviewCouncilRole,
  runCouncil,
  runStrategyCouncil,
  runWithRetry,
  strategyRepairInstruction,
  strategyCouncilToolParameters,
  staleEvidenceGuard,
  validateStrategyCouncilArgs,
  writeCouncilAudit,
  writeCouncilUsage,
};
