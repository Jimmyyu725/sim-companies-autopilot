#!/usr/bin/env node
// autopilot/brain.js — provider-aware Chat Completions brain loop. It is the production DeepSeek
// engine and retained OpenAI chat-completions fallback. The Responses API Terra engine remains
// brain56.js. Keys come only from the environment prepared by run-brain.sh and are never logged.
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const BRAIN = __dirname;
const SIM = path.dirname(BRAIN);
const {
  ACTION_NAMES,
  actionTargetKey,
  chatCompletionsActionTools,
  validateActionParams,
} = require(path.join(BRAIN, 'action-contracts.js'));
const { FailureBudget, isActionFailure } = require(path.join(BRAIN, 'failure-budget.js'));
const {
  summarizeCouncilBlockers,
  runCouncil,
  runStrategyCouncil,
  strategyCouncilToolParameters,
} = require(path.join(BRAIN, 'council.js'));
const {
  HISTORY_BASENAME: STRATEGY_COUNCIL_HISTORY,
  loadStrategyCouncilRequirement,
  recordStrategyCouncilDecision,
} = require(path.join(BRAIN, 'council-governance.js'));
const { compareMillUpgradeCandidates } = require(path.join(BRAIN, 'mill-upgrade-policy.js'));
const {
  WakeRuntimeGuard,
  buildSafetyRetryAlarm,
  buildWakeAlarm,
  councilRequiredForStructuralAction,
  validateStrategyCouncilCompletion,
  validateFinishSummary,
  buildAutomaticFinishOnExhaustion,
  closingBudgetActive,
  closingBudgetDirective,
} = require(path.join(BRAIN, 'runtime-guard.js'));
const { currentMemorySchema, readCurrentMemory, validateCurrentMemory, writeCurrentMemory } = require(path.join(BRAIN, 'current-memory.js'));
const { formatWakeSnapshot, journalToolSchema, prepareJournalEntry } = require(path.join(BRAIN, 'journal-entry.js'));
const { buildingUtilizationJournalGate } = require(path.join(BRAIN, 'building-utilization-policy.js'));
const {
  readPendingOwnerDirective,
} = require(path.join(BRAIN, 'owner-directive.js'));
const { formatToolOutput, previewJson } = require(path.join(BRAIN, 'tool-output.js'));
const {
  readPaReview,
  readPendingPa,
} = require(path.join(BRAIN, 'pa-state.js'));
const {
  personalAssistantJournalGate,
} = require(path.join(BRAIN, 'pa-policy.js'));
const {
  authorizeChatAction,
  resolveChatMode,
} = require(path.join(BRAIN, 'chat', 'runtime-mode.js'));
const { DEEPSEEK_EXECUTION_PROMPT } = require(path.join(BRAIN, 'deepseek-execution-prompt.js'));

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

const PROVIDER = process.env.BRAIN_PROVIDER || 'openai';
const MODEL = process.env.BRAIN_MODEL ||
  (PROVIDER === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-5.5');
const EFFORT = process.env.BRAIN_EFFORT || (PROVIDER === 'deepseek' ? 'max' : 'high');
const MAX_TOKENS = boundedInteger(process.env.BRAIN_MAX_TOKENS, 1024, 384000, 32768);
// Owner directive 2026-08-05: no ceiling. 'unlimited' (or 0) removes it; a positive integer still
// pins it for a one-off run. Both the loop condition and the closing-budget bookkeeping already
// carry Infinity — roundsRemaining is initialised to it, and closingBudgetActive/Directive both
// gate on Number.isSafeInteger — so nothing downstream needs to change. What does change: the
// closing-budget pressure never fires, and rounds stop bounding a wake at all. That left nothing
// between a stuck wake and the lock it holds, so run-brain.sh now wraps the engine in
// `timeout -k 30 2700` — 45 minutes, SIGTERM then SIGKILL — and that wall clock is the only bound
// a wake has. It has fired once, on 2026-08-05 02:47: 373 model requests, 59.8M tokens, $15.85,
// rc=124, a close-gate deadlock that rounds would previously have ended at 50.
//
// (This comment claimed the opposite for a day. It was written with the ceiling removal and not
// revisited when the backstop landed an hour later.)
function resolveMaxRounds(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'unlimited' || text === 'infinity' || text === '0') return Number.POSITIVE_INFINITY;
  // Digits only. Number.parseInt('1.5e400') is 1, so a mistyped value would silently cap every wake
  // at a single round and fail it instantly — much worse than falling back to the default.
  const parsed = /^\d+$/u.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 30;
}
const MAX_ROUNDS = resolveMaxRounds(process.env.BRAIN_MAX_ROUNDS);
const REQUEST_TIMEOUT_MS = boundedInteger(
  process.env.BRAIN_REQUEST_TIMEOUT_MS, 1000, 600000, 180000);
const REQUEST_MAX_ATTEMPTS = boundedInteger(
  process.env.BRAIN_REQUEST_MAX_ATTEMPTS, 1, 3, 2);
const REQUEST_RETRY_DELAY_MS = boundedInteger(
  process.env.BRAIN_REQUEST_RETRY_DELAY_MS, 0, 10000, 750);
const DRY = process.env.BRAIN_DRY === '1';
const CHAT_MODE = resolveChatMode();
const KEY = PROVIDER === 'deepseek'
  ? process.env.DEEPSEEK_API_KEY
  : process.env.OPENAI_API_KEY;
const API_URL = PROVIDER === 'deepseek'
  ? `${String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/u, '')}/chat/completions`
  : 'https://api.openai.com/v1/chat/completions';
if (require.main === module && !KEY) {
  console.error(`no ${PROVIDER === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} in env`);
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const writeJsonAtomic = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
};
const readOwnerDirectiveFile = () => {
  try { return JSON.parse(fs.readFileSync(path.join(BRAIN, 'OWNER-DIRECTIVE.json'), 'utf8')); }
  catch (_) { return null; }
};
const ACTION_SET = new Set(ACTION_NAMES);
const failureBudget = new FailureBudget(2);
const runtimeGuard = new WakeRuntimeGuard();
// Rounds left in this wake, refreshed by the main loop so journal gates can yield while closing.
let roundsRemaining = Number.POSITIVE_INFINITY;
let strategyCouncilGovernance = { required: false, status: 'not_required', reasons: [] };
const ownerUpgradeBridgeAuthorizations = new Set();
const UTILITY_KINDS = Object.freeze([1, 2]);

function noteOwnerUpgradeAttempt(params, result) {
  const buildingId = Number(params?.buildingId);
  if (!Number.isSafeInteger(buildingId) || buildingId <= 0) return;
  const directive = readPendingOwnerDirective(
    path.join(BRAIN, 'OWNER-DIRECTIVE.json'),
    path.join(BRAIN, '.state.json'),
  );
  if (directive?.action !== 'fund-and-upgrade-building' ||
      Number(directive.buildingId) !== buildingId) {
    ownerUpgradeBridgeAuthorizations.delete(buildingId);
    return;
  }
  const requiredFloor = Number(directive?.financing?.minimumCashAfter);
  if (Number.isFinite(requiredFloor) && Number(params?.minCashAfter) !== requiredFloor) {
    ownerUpgradeBridgeAuthorizations.delete(buildingId);
    return;
  }
  const reason = String(result?.reason || result?.err || '');
  const previewFundingBlock = params?.confirm === false && result?.preview === true &&
    result?.affordability?.reserveSatisfied === false;
  const verifiedExecutionBlock = result?.ok === false && !result?.guard && !/building busy/i.test(reason);
  if (previewFundingBlock || verifiedExecutionBlock) {
    ownerUpgradeBridgeAuthorizations.add(buildingId);
  } else {
    ownerUpgradeBridgeAuthorizations.delete(buildingId);
  }
}

function utilityKindFromExchangeIdentifier(value) {
  if (Number(value) === 1 || String(value || '').trim().toLowerCase() === 'power') return 1;
  if (Number(value) === 2 || String(value || '').trim().toLowerCase() === 'water') return 2;
  return null;
}

// Two attempts, the same allowance FailureBudget gives every other repeated action.
const MAX_UTILITY_REVIEW_ATTEMPTS = 2;

// Fresh evidence invalidates a review, so the results are rebuilt — but how many times this wake has
// already tried is a fact about the wake, not about the evidence, and erasing it reopens the loop the
// cap closes. Observed 2026-08-05 00:31: two attempts, an inspect_buildings in between, then two more
// before the cap could bite. Pass the previous reviews to carry the tally across the reset.
function createUtilityExchangeReviews(previous = null) {
  return Object.fromEntries(UTILITY_KINDS.map(kind => [String(kind), {
    kind,
    status: 'pending',
    attempts: Number(previous?.[String(kind)]?.attempts) || 0,
    inspected: false,
    sold: false,
    rateLimited: false,
    reviewedAt: null,
  }]));
}

function noteUtilityInspection(reviews, kind, result, nowMs = Date.now()) {
  const normalizedKind = Number(kind);
  if (!UTILITY_KINDS.includes(normalizedKind)) return reviews;
  const liveStatus = Number(result?.book?.live?.status);
  const inspected = result?.ok === true && liveStatus === 200 && result?.uiQuote?.ok === true;
  // A hold normally means the wake fetched a real book and chose not to sell, hence the 200. But a
  // fail-closed refusal that names no corrective action is also a decision not to sell, and it can
  // arrive before the book is ever fetched — so demanding a 200 there would leave it on the terminal
  // 'failed' with nothing the wake could do to move it.
  const unnameable = result?.failureCode === 'RESERVE_RATE_EVIDENCE_UNNAMEABLE';
  const safelyHeld = result?.ok !== true && result?.failClosed === true &&
    (liveStatus === 200 || unnameable) &&
    result?.readOnly === true && result?.submitted === false &&
    result?.uiQuote?.mutationAttempted === false;
  const requiredBuildingIds = Array.isArray(result?.requiredBuildingIds)
    ? [...new Set(result.requiredBuildingIds.map(Number)
      .filter(buildingId => Number.isSafeInteger(buildingId) && buildingId > 0))]
      .sort((left, right) => left - right)
    : [];
  const needsRateRefresh = result?.ok !== true && result?.failClosed === true &&
    ['RESERVE_RATE_EVIDENCE_INCOMPLETE', 'RESERVE_RATE_EVIDENCE_EXPIRES'].includes(result?.failureCode) &&
    result?.readOnly === true && result?.submitted === false &&
    result?.uiQuote?.mutationAttempted === false && requiredBuildingIds.length > 0;
  reviews[String(normalizedKind)] = {
    kind: normalizedKind,
    attempts: Number(reviews?.[String(normalizedKind)]?.attempts || 0) + 1,
    status: liveStatus === 429 ? 'rate_limited'
      : (inspected ? 'inspected' : (safelyHeld ? 'held' : (needsRateRefresh ? 'needs_rate_refresh' : 'failed'))),
    inspected,
    sold: false,
    rateLimited: liveStatus === 429,
    requiredBuildingIds,
    profitable: inspected && Number(result?.uiQuote?.economics?.estimatedProfit) > 0,
    reviewedAt: new Date(Number(nowMs)).toISOString(),
  };
  return reviews;
}

function noteUtilityExchangeSale(reviews, kind, result) {
  const normalizedKind = utilityKindFromExchangeIdentifier(kind);
  if (normalizedKind == null) return reviews;
  if (result?.ok === true && result?.armed === true && Boolean(result?.submitted)) {
    reviews[String(normalizedKind)] = {
      kind: normalizedKind,
      status: 'sold',
      inspected: true,
      sold: true,
      rateLimited: false,
      reviewedAt: new Date().toISOString(),
    };
  }
  return reviews;
}

function rateLimitedUtilityKinds(reviews) {
  return UTILITY_KINDS.filter(kind => reviews?.[String(kind)]?.status === 'rate_limited');
}

function missingMillInspectionIds(state) {
  const capacity = state?.surplusPlan?.millCapacity;
  const explicit = Array.isArray(capacity?.missingBuildingIds)
    ? capacity.missingBuildingIds.map(Number).filter(Number.isInteger)
    : [];
  if (explicit.length) return [...new Set(explicit)].sort((a, b) => a - b);

  const currentMills = (state?.buildings || [])
    .filter(building => String(building?.name || '').toLowerCase() === 'mill' || building?.kindLetter === 'i')
    .map(building => Number(building.id))
    .filter(Number.isInteger);
  const covered = new Set((capacity?.rates || []).map(row => Number(row?.buildingId)).filter(Number.isInteger));
  return [...new Set(currentMills.filter(id => !covered.has(id)))].sort((a, b) => a - b);
}

// A plan item is verified when the policy priced it on its own terms: a known transport cost and a
// finite non-negative sellable quantity. This is deliberately per item. `plan.complete` is one flag
// for the whole warehouse and any single unpriceable row clears it — on 2026-08-05 three tablets and
// one quadcopter, four units of construction leftovers with a transport cost outside the supported
// {0, 0.1, 1}, set it false and took a fully priced 67,293-unit water surplus down with them. No
// protection is lost by checking the item instead: every early-bail path in the reserve policy marks
// *every* item `unknown` with `sellable: 0`, and the exchange sale path already refuses any entry
// whose own status is unknown.
function unverifiedUtilityKinds(state) {
  const items = state?.surplusPlan?.items;
  return UTILITY_KINDS.filter(kind => {
    const item = items?.[String(kind)];
    if (!item || typeof item !== 'object') return true;
    const sellable = item.sellable;
    if (typeof sellable !== 'number' || !Number.isFinite(sellable) || sellable < 0) return true;
    // Deliberately the same predicate the exchange sale path applies to a resource entry. A kind must
    // never clear this gate and then be refused a quote on a ground this gate treated as acceptable.
    return item.allowedToSell === false || item.eligible === false || item.blocked === true ||
      /^(blocked|hold|unknown)$/i.test(String(item.status || ''));
  });
}

function pendingUtilitySurplus(state) {
  if (unverifiedUtilityKinds(state).length) return [];
  return UTILITY_KINDS.filter(kind => Number(state.surplusPlan.items?.[String(kind)]?.sellable) > 0);
}

function ownsAMill(state) {
  return (state?.buildings || []).some(building =>
    String(building?.name || '').toLowerCase() === 'mill' || building?.kindLetter === 'i');
}

function utilityJournalGate(state, reviews, alarm, nowMs = Date.now()) {
  const plan = state?.surplusPlan;
  // A company with no Mill has no Coffee chain, so there is no reserve to protect and nothing here
  // to verify. surplusPlan correctly reports UNKNOWN in that state, and the block below would then
  // demand an inspection of "every current Mill" while naming none — a requirement no sequence of
  // tool calls can satisfy, so the wake could never close its journal.
  if (!ownsAMill(state)) return null;
  // Same shape, different cause: while a production multiplier is running the reserve cannot be
  // computed from printed 1x rates at all, so no number of Mill inspections will complete the plan.
  // Demanding them would loop. Passing here does not authorize a sale — an incomplete plan still
  // yields no verified sellable quantity — it only stops the wake from being trapped.
  if (plan?.accelerationUnmodelled === true) return null;
  const unverifiedKinds = unverifiedUtilityKinds(state);
  if (unverifiedKinds.length) {
    const missingBuildingIds = missingMillInspectionIds(state);
    // Only demand inspections that exist to be done. The old text fell back to "not enumerated;
    // inspect every current Mill" whenever this list was empty, which is an order no sequence of
    // tool calls can carry out: the Mills were already fresh, so each inspection changed nothing and
    // the wake re-read the same guard until it ran out of rounds.
    if (missingBuildingIds.length) {
      return {
        ok: false,
        guard: true,
        reason: `utility surplus is unverified for kind(s) ${unverifiedKinds.join(', ')}; missing or invalid Mill inspection(s): ${missingBuildingIds.join(', ')}. Inspect those Mills and refresh_state before journal. This review does not require a sale.`,
        requiredTool: 'inspect_building',
        missingBuildingIds,
      };
    }
    return {
      ok: false,
      guard: true,
      reason: `utility surplus is unverified for kind(s) ${unverifiedKinds.join(', ')}. Every current Mill is already inspected fresh, so more inspections cannot help — the gap is in the warehouse capture. Call refresh_state before journal. This review does not require a sale.`,
      requiredTool: 'refresh_state',
      missingBuildingIds: [],
      invalidKinds: unverifiedKinds,
    };
  }

  const pendingKinds = pendingUtilitySurplus(state);
  const rateRefreshKinds = pendingKinds.filter(
    kind => reviews?.[String(kind)]?.status === 'needs_rate_refresh');
  if (rateRefreshKinds.length) {
    const missingBuildingIds = [...new Set(rateRefreshKinds.flatMap(
      kind => reviews?.[String(kind)]?.requiredBuildingIds || []))]
      .map(Number)
      .filter(buildingId => Number.isSafeInteger(buildingId) && buildingId > 0)
      .sort((left, right) => left - right);
    return {
      ok: false,
      guard: true,
      reason: `utility reserve evidence will expire before a safe exchange confirmation; inspect Mill(s) ${missingBuildingIds.join(', ')}, refresh_state, then retry inspect_exchange_sale for kind(s) ${rateRefreshKinds.join(', ')}`,
      requiredTool: 'inspect_building',
      missingBuildingIds,
      pendingKinds: rateRefreshKinds,
    };
  }
  const unresolvedKinds = pendingKinds.filter(kind => {
    const review = reviews?.[String(kind)];
    if (review?.status === 'inspected' || review?.status === 'sold' ||
      review?.status === 'rate_limited' || review?.status === 'held') return false;
    // A review that keeps failing is still a review. This gate has never required a sale — its own
    // text says selling is optional — it requires the wake to have looked. Two looks is looking, and
    // the limit matches FailureBudget's, the same judgement applied to every other repeated action.
    //
    // The tally alone decides, deliberately. Keying this on status === 'failed' as well left the cap
    // unreachable: refresh_state rebuilds the reviews and sets status back to 'pending', so every
    // refresh manufactured a fresh obligation even though #72 had preserved the count. The 02:32
    // wake on 2026-08-05 refreshed 14 times, re-closed 8 times and cost $1.26 — more than the
    // unbounded loop this cap was written to stop.
    if (Number(review?.attempts) >= MAX_UTILITY_REVIEW_ATTEMPTS) return false;
    return true;
  });
  if (unresolvedKinds.length) {
    return {
      ok: false,
      guard: true,
      reason: `verified utility surplus still needs a separate inspect_exchange_sale review for kind(s) ${unresolvedKinds.join(', ')}; a review or failure for one utility never clears the other. Selling is optional.`,
      requiredTool: 'inspect_exchange_sale',
      pendingKinds: unresolvedKinds,
    };
  }

  const rateLimitedKinds = pendingKinds.filter(kind => reviews?.[String(kind)]?.status === 'rate_limited');
  if (rateLimitedKinds.length) {
    const retryAt = Number(alarm?.at);
    const alarmSetAt = Date.parse(alarm?.set);
    const boundKinds = new Set((Array.isArray(alarm?.utilityRetryKinds) ? alarm.utilityRetryKinds : []).map(Number));
    const alarmPredatesReview = rateLimitedKinds.some(kind => {
      const reviewedAt = Date.parse(reviews?.[String(kind)]?.reviewedAt);
      return !Number.isFinite(reviewedAt) || !Number.isFinite(alarmSetAt) || alarmSetAt < reviewedAt || retryAt < reviewedAt;
    });
    const alarmMissesKind = rateLimitedKinds.some(kind => !boundKinds.has(kind));
    if (!Number.isFinite(retryAt) || retryAt <= Number(nowMs) || retryAt > Number(nowMs) + 10 * 60e3 ||
        alarmPredatesReview || alarmMissesKind) {
      return {
        ok: false,
        guard: true,
        reason: `utility live book was explicitly rate-limited for kind(s) ${rateLimitedKinds.join(', ')}; set a kind-bound retry alarm after the review and within ten minutes before journal`,
        requiredTool: 'set_alarm',
        pendingKinds: rateLimitedKinds,
      };
    }
  }
  return null;
}

let utilityExchangeReviews = createUtilityExchangeReviews();

function buildIncompleteLoopRetryAlarm(reason, nowMs = Date.now(), reviews = utilityExchangeReviews) {
  return buildSafetyRetryAlarm(reason, nowMs, rateLimitedUtilityKinds(reviews));
}

const TOOLS = [
  ...chatCompletionsActionTools({ chatMode: CHAT_MODE }),
  { type: 'function', function: { name: 'refresh_state', description: 'Re-capture the live game state (cash, buildings, stock). Use after material changes.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_alarm', description: 'Schedule the next wake. atIso must be 2 minutes to 4 hours in the future — wake 1 minute after the earliest completion.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { atIso: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['atIso', 'reason'] } } },
  { type: 'function', function: { name: 'journal', description: 'After refresh_state and set_alarm, write the concise CEO decision brief: opportunity/risk, 2-4 material alternatives, decision, evidence, deferrals, and complete warehouse review. Runtime adds exact cash, debt, slots, and every captured warehouse product.', parameters: journalToolSchema } },
  { type: 'function', function: { name: 'finish', description: 'End this wake with a short summary.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'master', description: 'After set_alarm, append one audit line to MASTER.md and atomically replace CURRENT.json. cash, debt, slots, stateAsOf, and nextDecisionAt are runtime-validated; concise warehouse, upgrade/debt, surplus, and long-term reviews are required. Mandatory once after the latest mutation.', parameters: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 1200 }, current: currentMemorySchema }, required: ['text', 'current'] } } },
  { type: 'function', function: { name: 'read_api', description: 'Read a game API path with source time, HTTP status, explicit pagination, and explicit truncation metadata. Use pointer/offset/limit to narrow large responses.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, pointer: { type: 'string', description: 'Optional RFC 6901 JSON Pointer, for example /data/0.' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['path'] } } },
  { type: 'function', function: { name: 'inspect_building', description: 'P1 read-only inspection of one building page. Returns live printed level, production rates and wages; optionally quote one product quantity without starting it. Use null for both product and qty when no quote is needed.', parameters: { type: 'object', additionalProperties: false, properties: { buildingId: { type: 'integer', minimum: 1 }, product: { type: ['string', 'null'] }, qty: { type: ['number', 'null'], exclusiveMinimum: 0 } }, required: ['buildingId', 'product', 'qty'] } } },
  { type: 'function', function: { name: 'inspect_buildings', description: 'P1 read-only inspection of two to eight building pages in ONE call. Same evidence per building as inspect_building without the quote. Prefer this whenever more than one building needs reading: one call replaces one full round trip per building.', parameters: { type: 'object', additionalProperties: false, properties: { buildingIds: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'integer', minimum: 1 } } }, required: ['buildingIds'] } } },
  { type: 'function', function: { name: 'inspect_exchange_sale', description: 'Read-only exchange-sale inspection. Verifies the current deterministic reserve, live book, 4% fee and Transport, then fills but never submits the exact UI form. Use qty:null for the maximum currently safe quantity. A confirmed exchange_sell must exactly match this result within five minutes.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { kind: { type: 'integer', minimum: 1 }, qty: { type: ['integer', 'null'], minimum: 1 } }, required: ['kind', 'qty'] } } },
  { type: 'function', function: { name: 'rank_mill_upgrades', description: 'Compare two or three evidence-backed next-step Mill upgrades without considering current cash. Returns a unique recommendation only when one candidate Pareto-dominates all alternatives on added rate, cost, downtime, and downtime output loss.', parameters: { type: 'object', additionalProperties: false, properties: { candidates: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, properties: { buildingId: { type: 'integer', minimum: 1 }, currentLevel: { type: 'integer', minimum: 1, maximum: 2 }, currentRate: { type: 'number', exclusiveMinimum: 0 }, productionIncreasePct: { type: 'number', exclusiveMinimum: 0 }, cashCost: { type: 'number', exclusiveMinimum: 0 }, downtimeHours: { type: 'number', exclusiveMinimum: 0 }, evidenceAsOf: { type: 'string', minLength: 1 } }, required: ['buildingId', 'currentLevel', 'currentRate', 'productionIncreasePct', 'cashCost', 'downtimeHours', 'evidenceAsOf'] } } }, required: ['candidates'] } } },
  { type: 'function', function: { name: 'strategy_council', description: 'CFO/COO/CMO independently choose among two to five explicit strategic options using fresh finance, the complete owned portfolio, market routes, bottlenecks, and automatic candidate payback evidence. Include the exact hold option. At a runtime-required portfolio checkpoint, the option set must also include at least one named expansion or pivot outside the current Coffee baseline; this is a comparison requirement, not permission to spend. Before this call, run confirm:false once for every build, upgrade, scrap, rebuild, bonds, or robots option so Council receives verified candidate terms. Runtime requires a portfolio checkpoint at least every twenty successful wakes, daily, and after material strategic changes.', strict: true, parameters: strategyCouncilToolParameters } },
  { type: 'function', function: { name: 'council', description: 'After an exact structural preview, CFO/COO/CMO independently authorize its final terms using a fresh complete portfolio inspection and automatic bottleneck/payback model. Required for every structural action.', parameters: { type: 'object', additionalProperties: false, properties: { proposal: { type: 'string', description: 'The concrete proposal with numbers' }, context: { type: 'string', description: 'Optional supporting context; automatic evidence remains authoritative' }, buildingId: { type: ['integer', 'null'], minimum: 1 }, marketKinds: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'integer', minimum: 1 } } }, required: ['proposal', 'context', 'buildingId', 'marketKinds'] } } },
];

function runAction(action, rawParams) {
  const checked = validateActionParams(action, rawParams);
  const key = checked.ok ? actionTargetKey(action, checked.params) : `${action}:invalid`;
  const previewKey = checked.ok && action === 'produce'
    ? `${key}:qty:${Number(checked.params.qty)}`
    : null;
  const blocked = failureBudget.before(key, previewKey);
  if (blocked) return blocked;
  if (!checked.ok) {
    const result = { ok: false, guard: true, reason: checked.reason };
    const failures = failureBudget.record(key, result, previewKey);
    return { ...result, failureCountThisWake: failures };
  }
  const chatAuthorization = authorizeChatAction(action, checked.params, CHAT_MODE);
  if (!chatAuthorization.ok) return chatAuthorization;
  if (action === 'produce') {
    checked.params.ownerUpgradeAttemptVerified = ownerUpgradeBridgeAuthorizations.has(
      Number(checked.params.buildingId),
    );
  }
  if (DRY) return { ok: true, dry: true, note: 'DRY RUN — action not executed', wouldRun: checked.params };
  let guardState = null;
  try { guardState = JSON.parse(fs.readFileSync(path.join(BRAIN, '.state.json'), 'utf8')); } catch (_) {}
  const ownerDirectiveForAction = readOwnerDirectiveFile();
  const sequencingBlock = runtimeGuard.beforeAction(action, checked.params, {
    state: guardState,
    ownerDirective: ownerDirectiveForAction,
    councilRequired: councilRequiredForStructuralAction(action),
  });
  if (sequencingBlock) return sequencingBlock;

  let result;
  try {
    const out = execFileSync('flock', [
      '-w', '90',
      path.join(SIM, '.tick.lock'),
      'node',
      path.join(BRAIN, 'act.js'),
      action,
      JSON.stringify(checked.params),
    // Includes up to 90s waiting for .tick.lock. Retail sales can then spend about
    // 50s previewing the price curve before the single final click.
    ], { cwd: SIM, timeout: 240000, encoding: 'utf8' });
    const line = out.trim().split('\n').pop();
    try { result = JSON.parse(line); } catch (e) {
      result = { ok: false, err: 'action returned non-JSON output', raw: line.slice(0, 500) };
    }
  } catch (e) {
    result = { ok: false, err: String(e.message).slice(0, 300) };
  }

  if (action === 'exchange_sell') {
    noteUtilityExchangeSale(utilityExchangeReviews, checked.params.name, result);
  }
  if (action === 'upgrade') noteOwnerUpgradeAttempt(checked.params, result);

  const failures = failureBudget.record(key, result, previewKey);
  // Mark a possibly-mutating attempt dirty before returning any failure. UI actions can click and
  // then fail tail verification; allowing another mutation before refresh could duplicate it.
  const refreshRequired = runtimeGuard.afterAction(action, checked.params, result);
  if (isActionFailure(result)) {
    return {
      ...result,
      failureCountThisWake: failures,
      circuitOpen: failures >= failureBudget.limit,
      ...(refreshRequired ? { requiredNextTool: 'refresh_state' } : {}),
    };
  }
  return refreshRequired ? { ...result, requiredNextTool: 'refresh_state' } : result;
}

async function runTool(name, args) {
  try {
    if (ACTION_SET.has(name)) return runAction(name, args || {});
    if (name === 'master') {
      const sequencingBlock = runtimeGuard.beforeMaster();
      if (sequencingBlock) return sequencingBlock;
      const ledgerText = String(args.text || '').trim();
      if (!ledgerText || ledgerText.length > 1200) return { ok: false, guard: true, reason: 'master text must contain 1..1200 characters' };
      const state = JSON.parse(fs.readFileSync(path.join(BRAIN, '.state.json'), 'utf8'));
      let alarm = null; try { alarm = JSON.parse(fs.readFileSync(path.join(BRAIN, 'next-wake.json'), 'utf8')); } catch (e) {}
      const checked = validateCurrentMemory(args.current, state, alarm);
      if (!checked.ok) return checked;
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 16);
      fs.appendFileSync(path.join(BRAIN, 'MASTER.md'), `[${ts} CDT] ${ledgerText}\n`);
      writeCurrentMemory(path.join(BRAIN, 'CURRENT.json'), checked.value);
      runtimeGuard.noteMaster();
      return { ok: true, currentUpdatedAt: checked.value.updatedAt };
    }
    if (name === 'read_api') {
      // A fetch-only probe still shares the single CDP target with collectors that navigate it.
      // Hold the browser lock for the complete request so a page change cannot invalidate the
      // execution context halfway through an otherwise read-only API call.
      const out = execFileSync('flock', [
        '-w', '90', path.join(SIM, '.tick.lock'),
        'node', path.join(BRAIN, 'api.js'), JSON.stringify(args || {}),
      ], { cwd: SIM, timeout: 150000, encoding: 'utf8' });
      const line = out.trim().split('\n').pop();
      try { return JSON.parse(line); } catch (e) {
        return { ok: false, path: String(args.path || ''), error: 'read_api returned non-JSON output', raw: line.slice(0, 500), truncated: false };
      }
    }
    if (name === 'inspect_buildings') {
      const out = execFileSync('flock', [
        '-w', '90', path.join(SIM, '.tick.lock'),
        'node', path.join(BRAIN, 'inspect-building.js'), JSON.stringify(args || {}),
      ], { cwd: SIM, timeout: 300000, encoding: 'utf8' });
      const line = out.trim().split('\n').pop();
      try {
        const result = JSON.parse(line);
        if (result?.ok === true) {
          utilityExchangeReviews = createUtilityExchangeReviews(utilityExchangeReviews);
          runtimeGuard.noteEvidenceChange('inspect_buildings');
        }
        return result;
      } catch (e) {
        return { ok: false, err: 'inspect_buildings returned non-JSON output', raw: line.slice(0, 500) };
      }
    }
    if (name === 'inspect_building') {
      const out = execFileSync('flock', [
        '-w', '90', path.join(SIM, '.tick.lock'),
        'node', path.join(BRAIN, 'inspect-building.js'), JSON.stringify(args || {}),
      ], { cwd: SIM, timeout: 120000, encoding: 'utf8' });
      const line = out.trim().split('\n').pop();
      try {
        const result = JSON.parse(line);
        if (result?.ok === true) {
          utilityExchangeReviews = createUtilityExchangeReviews(utilityExchangeReviews);
          runtimeGuard.noteEvidenceChange('inspect_building');
        }
        return result;
      } catch (e) {
        return { ok: false, error: 'inspect_building returned non-JSON output', raw: line.slice(0, 500) };
      }
    }
    if (name === 'inspect_exchange_sale') {
      const utilityKind = UTILITY_KINDS.includes(Number(args?.kind));
      const out = execFileSync('flock', [
        '-w', '90', path.join(SIM, '.tick.lock'),
        'node', path.join(BRAIN, 'inspect-exchange-sale.js'), JSON.stringify(args || {}),
      ], { cwd: SIM, timeout: 180000, encoding: 'utf8' });
      const line = out.trim().split('\n').pop();
      try {
        const result = JSON.parse(line);
        if (utilityKind) noteUtilityInspection(utilityExchangeReviews, args.kind, result);
        return result;
      } catch (e) {
        if (utilityKind) noteUtilityInspection(utilityExchangeReviews, args.kind, { ok: false });
        return { ok: false, error: 'inspect_exchange_sale returned non-JSON output', raw: line.slice(0, 500) };
      }
    }
    if (name === 'rank_mill_upgrades') return compareMillUpgradeCandidates(args?.candidates);
    if (name === 'strategy_council') {
      const sequencingBlock = runtimeGuard.beforeStrategyCouncil();
      if (sequencingBlock) return sequencingBlock;
      const strategyPreparation = runtimeGuard.prepareStrategyCouncil(args);
      if (!strategyPreparation.ok) {
        return {
          ...strategyPreparation,
          strategyGovernance: runtimeGuard.strategyCouncilStatus(),
        };
      }
      const result = await runStrategyCouncil({
        args,
        apiKey: KEY,
        brainDir: BRAIN,
        simDir: SIM,
        strategyCandidates: strategyPreparation.strategyCandidates,
      });
      const completion = validateStrategyCouncilCompletion(result, {
        buildingInspectionRequired: args?.focusBuildingId != null,
        portfolioInspectionRequired: true,
      });
      if (!completion.ok) {
        runtimeGuard.noteStrategyCouncil(result, args);
        return {
          strategyGovernance: runtimeGuard.strategyCouncilStatus(),
          completion,
          ...result,
        };
      }
      const history = recordStrategyCouncilDecision(
        path.join(BRAIN, STRATEGY_COUNCIL_HISTORY),
        {
          wakeId: process.env.WAKE_ID,
          result,
          args,
          snapshot: strategyCouncilGovernance.snapshot,
          requirement: strategyCouncilGovernance,
        },
      );
      const tracked = runtimeGuard.noteStrategyCouncil(result, args);
      return {
        strategyGovernance: runtimeGuard.strategyCouncilStatus(),
        completion: tracked,
        historyRecorded: history.ok,
        ...result,
      };
    }
    if (name === 'council') {
      // Bind exact preview terms into what the reviewers see even when the model's prose omits a
      // cap, rate, quantity, or specialization. Target authorization still uses the original args.
      const reviewArgs = runtimeGuard.bindCouncilArgs(args);
      if (!reviewArgs.authorizationPreview) {
        return {
          ok: false,
          guard: true,
          reason: 'council requires a current runtime-verified structural preview; rerun the exact action with confirm:false first',
        };
      }
      const result = await runCouncil({ args: reviewArgs, apiKey: KEY, brainDir: BRAIN, simDir: SIM });
      const structuralAuthorization = runtimeGuard.noteCouncil(result, args);
      // Keep the blocking role and its stated gap as a short scalar: the full council array is
      // dropped when the result exceeds the tool-output budget, which previously left the brain
      // retrying the same proposal blindly.
      const authorizationBlockedBy = summarizeCouncilBlockers(result);
      return structuralAuthorization
        ? { structuralAuthorization, authorizationBlockedBy, ...result }
        : (authorizationBlockedBy ? { authorizationBlockedBy, ...result } : result);
    }
    if (name === 'refresh_state') {
      execFileSync('flock', ['-w', '90', path.join(SIM, '.tick.lock'), 'node', path.join(BRAIN, 'state.js')], { cwd: SIM, timeout: 160000, encoding: 'utf8' });
      const nextState = JSON.parse(fs.readFileSync(path.join(BRAIN, '.state.json'), 'utf8'));
      utilityExchangeReviews = createUtilityExchangeReviews(utilityExchangeReviews);
      runtimeGuard.noteRefresh();
      return nextState;
    }
    if (name === 'set_alarm') {
      const nowMs = Date.now();
      const retryKinds = rateLimitedUtilityKinds(utilityExchangeReviews);
      const scheduled = buildWakeAlarm(args, nowMs, retryKinds);
      if (!scheduled.ok) return scheduled;
      writeJsonAtomic(path.join(BRAIN, 'next-wake.json'), scheduled.alarm);
      runtimeGuard.noteAlarm();
      return { ok: true, wakeAt: scheduled.alarm.atIso, clamped: scheduled.clamped,
        utilityRetryKinds: scheduled.alarm.utilityRetryKinds || [] };
    }
    if (name === 'journal') {
      const sequencingBlock = runtimeGuard.beforeJournal();
      if (sequencingBlock) return sequencingBlock;
      const state = JSON.parse(fs.readFileSync(path.join(BRAIN, '.state.json'), 'utf8'));
      let alarm = null; try { alarm = JSON.parse(fs.readFileSync(path.join(BRAIN, 'next-wake.json'), 'utf8')); } catch (e) {}
      const pendingPa = readPendingPa(path.join(BRAIN, '.pa-pending.json'));
      const paBlock = personalAssistantJournalGate(state, {
        pending: pendingPa,
        review: readPaReview(path.join(BRAIN, '.pa-review.json'), pendingPa),
      });
      if (paBlock) return paBlock;
      const utilizationBlock = buildingUtilizationJournalGate(state, Date.now(),
        { exhaustedActions: failureBudget.exhausted() });
      if (utilizationBlock) return utilizationBlock;
      // The utility surplus review is optional by its own definition ("Selling is optional").
      // Live 2026-08-01 wake 11:57: it blocked the journal with two rounds left, the closing budget
      // could not help, and the whole wake was discarded. Defer it to the next wake instead.
      const utilityBlock = closingBudgetActive(roundsRemaining)
        ? null
        : utilityJournalGate(state, utilityExchangeReviews, alarm);
      if (utilityBlock) return utilityBlock;
      const prepared = prepareJournalEntry(args, state);
      if (!prepared.ok) return prepared;
      fs.appendFileSync(path.join(BRAIN, 'JOURNAL.md'), `\n## ${new Date().toISOString()} — BRAIN wake (${PROVIDER}/${MODEL}${DRY ? ', DRY' : ''})\n${prepared.markdown}\n`);
      runtimeGuard.noteJournal();
      return { ok: true, decisionBrief: prepared.markdown };
    }
    return { ok: false, err: 'unknown tool ' + name };
  } catch (e) { return { ok: false, err: String(e.message).slice(0, 300) }; }
}

function redactSecrets(value) {
  return String(value || '').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
}

function buildDeepSeekTools(tools) {
  return tools.map(tool => {
    if (!tool?.function || !Object.prototype.hasOwnProperty.call(tool.function, 'strict')) {
      return tool;
    }
    const { strict: _openAiStrict, ...definition } = tool.function;
    return { ...tool, function: definition };
  });
}

function buildChatCompletionRequest({
  provider = PROVIDER,
  model = MODEL,
  messages,
  tools = TOOLS,
  effort = EFFORT,
  maxTokens = MAX_TOKENS,
  forcedToolName = null,
}) {
  if (!['openai', 'deepseek'].includes(provider)) {
    throw new Error('BRAIN_PROVIDER must be openai or deepseek');
  }
  const availableToolNames = new Set(
    tools.map(tool => tool?.function?.name).filter(Boolean),
  );
  if (provider === 'deepseek' && forcedToolName && !availableToolNames.has(forcedToolName)) {
    throw new Error(`unknown forced DeepSeek tool ${forcedToolName}`);
  }
  const publishedTools = provider === 'deepseek' && forcedToolName
    ? tools.filter(tool => tool?.function?.name === forcedToolName)
    : tools;
  const request = {
    model,
    messages,
    tools: provider === 'deepseek' ? buildDeepSeekTools(publishedTools) : tools,
    tool_choice: 'auto',
  };
  if (provider === 'deepseek') {
    if (!['high', 'max'].includes(effort)) {
      throw new Error('DeepSeek BRAIN_EFFORT must be high or max');
    }
    request.thinking = { type: 'enabled' };
    request.reasoning_effort = effort;
    request.max_tokens = maxTokens;
  } else {
    request.parallel_tool_calls = false;
  }
  return request;
}

function nullableTopLevelFields(toolName, tools = TOOLS) {
  const tool = tools.find(candidate => candidate?.function?.name === toolName);
  const properties = tool?.function?.parameters?.properties || {};
  return Object.entries(properties)
    .filter(([, schema]) => Array.isArray(schema?.type) && schema.type.includes('null'))
    .map(([field]) => field);
}

function normalizeDeepSeekToolArguments(toolName, args, tools = TOOLS) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { args, normalizedFields: [] };
  }
  const normalized = { ...args };
  const normalizedFields = [];
  for (const field of nullableTopLevelFields(toolName, tools)) {
    const value = normalized[field];
    if (typeof value === 'string' && value.trim().toLowerCase() === 'null') {
      normalized[field] = null;
      normalizedFields.push(field);
    }
  }
  return { args: normalized, normalizedFields };
}

function requiredDeepSeekTool(result, tools = TOOLS) {
  const requested = String(result?.requiredNextTool || result?.requiredTool || '').trim();
  if (!requested) return null;
  return tools.some(tool => tool?.function?.name === requested) ? requested : null;
}

function deepSeekMultiToolRecovery(toolCalls, tools = TOOLS) {
  if (!Array.isArray(toolCalls) || toolCalls.length <= 1) return null;
  const availableToolNames = new Set(
    tools.map(tool => tool?.function?.name).filter(Boolean),
  );
  return toolCalls
    .map(call => call?.function?.name)
    .find(name => availableToolNames.has(name)) || null;
}

function normalizeChatUsage(provider, payload) {
  const usage = payload?.usage || {};
  const details = usage.prompt_tokens_details || {};
  const cached = provider === 'deepseek'
    ? usage.prompt_cache_hit_tokens
    : (Object.prototype.hasOwnProperty.call(details, 'cached_tokens')
      ? details.cached_tokens
      : null);
  const cacheMiss = provider === 'deepseek'
    ? usage.prompt_cache_miss_tokens
    : null;
  const cacheWrite = provider === 'deepseek'
    ? 0
    : (Object.prototype.hasOwnProperty.call(details, 'cache_write_tokens')
      ? details.cache_write_tokens
      : null);
  return {
    t: new Date().toISOString(),
    model: MODEL,
    billing_model: MODEL,
    billing_provider: provider,
    wake_id: process.env.WAKE_ID || null,
    ...usage,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    usage_schema: 'chat_completions',
    service_tier: provider === 'openai' ? (payload?.service_tier || null) : null,
    reasoning_effort: provider === 'deepseek' ? EFFORT : null,
    cached: cached ?? null,
    cache_miss: cacheMiss ?? null,
    cache_write: cacheWrite,
  };
}

function buildMultiToolRejections(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length <= 1) return null;
  const reason = 'MULTI_TOOL_TURN_REJECTED: exactly one tool call is allowed per assistant ' +
    'message; no tool from this message was executed. Retry with one tool call.';
  return toolCalls.map(toolCall => ({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: JSON.stringify({
      ok: false,
      guard: true,
      executed: false,
      reason,
    }),
  }));
}

function isRetryableChatTransportError(error) {
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  return name === 'aborterror' ||
    name === 'timeouterror' ||
    (name === 'typeerror' && /\bfetch failed\b/u.test(message)) ||
    /\btimeout\b|timed out|socket hang up|connection reset|network error/u.test(message) ||
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code);
}

function isRetryableChatStatus(status) {
  const value = Number(status);
  return value === 408 || value === 429 || (value >= 500 && value <= 599);
}

async function chat(messages, {
  fetchImpl = globalThis.fetch,
  forcedToolName = null,
  maxAttempts = REQUEST_MAX_ATTEMPTS,
  retryDelayMs = REQUEST_RETRY_DELAY_MS,
  sleepImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  usageWriter = usage => fs.appendFileSync(
    path.join(BRAIN, 'usage.jsonl'),
    `${JSON.stringify(usage)}\n`,
  ),
} = {}) {
  const attempts = boundedInteger(maxAttempts, 1, 3, REQUEST_MAX_ATTEMPTS);
  const baseDelayMs = boundedInteger(retryDelayMs, 0, 10000, REQUEST_RETRY_DELAY_MS);
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(buildChatCompletionRequest({ messages, forcedToolName })),
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retry = async reason => {
      if (attempt >= attempts) return false;
      const delayMs = Math.min(10000, baseDelayMs * attempt);
      log('MODEL_REQUEST_RETRY', `${PROVIDER} attempt ${attempt}/${attempts}`,
        redactSecrets(reason));
      if (delayMs > 0) await sleepImpl(delayMs);
      return true;
    };
    let res;
    try {
      res = await fetchImpl(API_URL, {
        ...request,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isRetryableChatTransportError(error) &&
          await retry(error.message || error)) {
        continue;
      }
      throw new Error(`${PROVIDER} request failed: ${redactSecrets(error.message || error)}`);
    }
    let payload;
    try {
      payload = await res.json();
    } catch (_) {
      if ((isRetryableChatStatus(res.status) || Number(res.status) === 200) &&
          await retry(`non-JSON HTTP ${res.status}`)) {
        continue;
      }
      throw new Error(`${PROVIDER} returned non-JSON HTTP ${res.status}`);
    }
    if (!res.ok || payload?.error) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${res.status}`;
      if (isRetryableChatStatus(res.status) &&
          await retry(`HTTP ${res.status}: ${detail}`)) {
        continue;
      }
      throw new Error(`${PROVIDER} API error: ${redactSecrets(detail)}`);
    }
    const message = payload?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') {
      if (await retry('response did not contain choices[0].message')) continue;
      throw new Error(`${PROVIDER} response did not contain choices[0].message`);
    }
    usageWriter(normalizeChatUsage(PROVIDER, payload));
    return message;
  }
  throw new Error(`${PROVIDER} request failed after bounded retries`);
}

async function main() {
  const baseSystem = fs.readFileSync(path.join(BRAIN, 'BRAIN.md'), 'utf8');
  const system = PROVIDER === 'deepseek'
    ? `${DEEPSEEK_EXECUTION_PROMPT}\n\n${baseSystem}`
    : baseSystem;
  const stateObject = JSON.parse(fs.readFileSync(path.join(BRAIN, '.state.json'), 'utf8'));
  const state = JSON.stringify(stateObject);
  const current = readCurrentMemory(path.join(BRAIN, 'CURRENT.json'));
  strategyCouncilGovernance = loadStrategyCouncilRequirement({
    brainDir: BRAIN,
    state: stateObject,
    current,
  });
  runtimeGuard.configureStrategyCouncil(strategyCouncilGovernance);
  const strategyGovernancePrompt = JSON.stringify({
    required: strategyCouncilGovernance.required,
    status: strategyCouncilGovernance.status,
    reasons: strategyCouncilGovernance.reasons,
    materialChanges: strategyCouncilGovernance.materialChanges,
    completedWakesSinceDecision: strategyCouncilGovernance.completedWakesSinceDecision,
    currentWakeOrdinal: strategyCouncilGovernance.currentWakeOrdinal,
    wakeInterval: strategyCouncilGovernance.wakeInterval,
    lastDecisionAt: strategyCouncilGovernance.lastDecisionAt,
  });
  const ownerDirective = readPendingOwnerDirective(
    path.join(BRAIN, 'OWNER-DIRECTIVE.json'),
    path.join(BRAIN, '.state.json'),
  );
  let wakeReason = '';
  try { wakeReason = JSON.parse(fs.readFileSync(path.join(BRAIN, '.last-wake.json'), 'utf8')).reason || ''; } catch (e) {}
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `WAKE ${new Date().toISOString()}${DRY ? ' (DRY RUN — plan and narrate, act is a no-op)' : ''}.\nYOU WERE WOKEN BECAUSE: ${wakeReason||"(scheduled check)"}\nSTRATEGY COUNCIL GOVERNANCE (runtime-enforced; when required, call strategy_council before journal with explicit alternatives including hold and at least one named non-baseline expansion or pivot):\n${strategyGovernancePrompt}\nPENDING OWNER DIRECTIVE (highest priority; execute safely and keep pending until verified complete):\n${ownerDirective ? JSON.stringify(ownerDirective) : '(none)'}\nCURRENT MEMORY (authoritative cross-wake plan; current state still wins if newer):\n${current ? JSON.stringify(current) : '(missing — create it with master this wake)'}\n\nCurrent state:\n${state}` },
  ];
  // Wake transcript — the brain's visible thinking and every action. The runner mirrors operating
  // journals to the configured Windows log destination.
  const DIARY = [
    `\n════ WAKE ${new Date().toISOString()} (${PROVIDER}/${MODEL} · ${EFFORT}${DRY ? ' DRY' : ''}) ════`,
    formatWakeSnapshot(stateObject, wakeReason),
    `🏛️ STRATEGY COUNCIL: ${strategyCouncilGovernance.required
      ? `required (${strategyCouncilGovernance.reasons.join(', ')})`
      : `not required (wake ${strategyCouncilGovernance.currentWakeOrdinal}/${strategyCouncilGovernance.wakeInterval})`}`,
  ];
  // One file PER WAKE (owner: unique names, Chicago timestamp to the second). Runner exports
  // DIARY_FILE and pushes the same file; fallback keeps a per-wake name if env is absent.
  const diaryFile = process.env.DIARY_FILE || path.join(BRAIN, 'diaries', 'diary-' + new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).replace(' ', '-').replace(/:/g, '') + '.md');
  let diaryFlushed = false;
  const diaryFlush = () => {
    if (diaryFlushed) return;
    try {
      const target = path.resolve(SIM, diaryFile);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.appendFileSync(target, DIARY.join('\n') + '\n');
      diaryFlushed = true;
    } catch (e) {}
  };
  const handleTerm = () => { diaryFlush(); process.exit(143); };
  process.once('SIGTERM', handleTerm);
  let finished = false;
  let forcedToolName = null;
  try {
    for (let i = 0; i < MAX_ROUNDS; i++) {
    // Reserve the final rounds for the closing sequence so a productive wake is not discarded for
    // running out before `master` writes the checkpoint.
    roundsRemaining = MAX_ROUNDS - i;
    const closing = closingBudgetDirective(roundsRemaining, runtimeGuard.finishCheck());
    if (closing) {
      log('CLOSING_BUDGET', closing.roundsRemaining, closing.missing.join('; '));
      messages.push({ role: 'user', content: closing.message });
      if (PROVIDER === 'deepseek' && closing.requiredTool) forcedToolName = closing.requiredTool;
    }
    const msg = await chat(messages, { forcedToolName });
    forcedToolName = null;
    messages.push(msg);
    if (msg.content && msg.content.trim()) { log('THINK:', msg.content.slice(0, 300)); DIARY.push(`🧠 ${msg.content.trim()}`); }
    if (!msg.tool_calls || !msg.tool_calls.length) {
      log('BRAIN said (no tool):', (msg.content || '').slice(0, 400));
      messages.push({ role: 'user', content: 'Use the tools. If you are done, call finish(summary). Always set_alarm before finishing.' });
      continue;
    }
    const multiToolRejections = buildMultiToolRejections(msg.tool_calls);
    if (multiToolRejections) {
      const names = msg.tool_calls.map(call => call?.function?.name || 'unknown').join(', ');
      log('MULTI_TOOL_TURN_REJECTED', names);
      DIARY.push(`🛡️ Multi-tool turn rejected without execution: ${names}`);
      messages.push(...multiToolRejections);
      if (PROVIDER === 'deepseek') {
        forcedToolName = deepSeekMultiToolRecovery(msg.tool_calls);
        if (forcedToolName) {
          log('DEEPSEEK_NEXT_TOOL_FORCED', forcedToolName, 'after multi-tool rejection');
        }
      }
      continue;
    }
    let done = false;
    for (const tc of msg.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = {}; }
      if (PROVIDER === 'deepseek') {
        const normalized = normalizeDeepSeekToolArguments(tc.function.name, args);
        args = normalized.args;
        if (normalized.normalizedFields.length) {
          log('DEEPSEEK_ARGS_NORMALIZED', tc.function.name,
            normalized.normalizedFields.join(','));
          DIARY.push(`🛡️ DeepSeek JSON null normalized for ${tc.function.name}: ${
            normalized.normalizedFields.join(', ')}`);
        }
      }
      log('TOOL', tc.function.name, previewJson(args, 200));
      if (tc.function.name === 'finish') {
        const validatedFinish = validateFinishSummary(args.summary);
        if (!validatedFinish.ok) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(validatedFinish) });
          continue;
        }
        const summary = validatedFinish.summary;
        const finishCheck = runtimeGuard.finishCheck();
        if (!finishCheck.ok) {
          log('  ->', JSON.stringify(finishCheck));
          DIARY.push(`🛡️ finish blocked: ${finishCheck.reason}`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(finishCheck) });
          if (PROVIDER === 'deepseek') {
            forcedToolName = requiredDeepSeekTool(finishCheck);
          }
          continue;
        }
        log('FINISH:', summary);
        DIARY.push(`✅ FINISH: ${summary}`); diaryFlush();
        done = true;
        finished = true;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: '{"ok":true}' });
        break;
      }
      const result = await runTool(tc.function.name, args);
      if (PROVIDER === 'deepseek') {
        forcedToolName = requiredDeepSeekTool(result);
        if (forcedToolName) {
          log('DEEPSEEK_NEXT_TOOL_FORCED', forcedToolName,
            `after ${tc.function.name}`);
        }
      }
      log('  ->', previewJson(result, 300));
      if (tc.function.name === 'journal' && result.ok && result.decisionBrief) {
        DIARY.push(`🧠 DECISION BRIEF\n${result.decisionBrief}`);
      } else {
        DIARY.push(`🔧 ${tc.function.name} ${previewJson(args, 180)}\n   → ${previewJson(result, 220)}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: formatToolOutput(tc.function.name, result) });
    }
    if (done) break;
    }
    if (!finished) {
      const automaticFinish = buildAutomaticFinishOnExhaustion(runtimeGuard);
      if (automaticFinish.ok) {
        log('FINISH:', automaticFinish.summary);
        DIARY.push(`✅ FINISH: ${automaticFinish.summary}`);
        diaryFlush();
        finished = true;
      }
    }
    if (!finished) {
      const reason = `chat-completions tool loop exhausted ${MAX_ROUNDS} rounds without a successful finish call`;
      const retryAlarm = buildIncompleteLoopRetryAlarm(reason);
      writeJsonAtomic(path.join(BRAIN, 'next-wake.json'), retryAlarm);
      DIARY.push(`🛡️ SAFE FAILURE: ${reason}; retry at ${retryAlarm.atIso}`);
      throw new Error(reason);
    }
  } finally {
    diaryFlush();
    process.removeListener('SIGTERM', handleTerm);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('BRAIN ERR', e.message); process.exit(1); });
}

module.exports = {
  buildChatCompletionRequest,
  buildDeepSeekTools,
  deepSeekMultiToolRecovery,
  buildIncompleteLoopRetryAlarm,
  buildMultiToolRejections,
  chat,
  createUtilityExchangeReviews,
  isRetryableChatStatus,
  isRetryableChatTransportError,
  normalizeDeepSeekToolArguments,
  normalizeChatUsage,
  redactSecrets,
  requiredDeepSeekTool,
  utilityKindFromExchangeIdentifier,
  missingMillInspectionIds,
  noteUtilityExchangeSale,
  noteUtilityInspection,
  pendingUtilitySurplus,
  resolveMaxRounds,
  unverifiedUtilityKinds,
  rateLimitedUtilityKinds,
  utilityJournalGate,
};
