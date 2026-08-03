'use strict';

const MUTATING_ACTIONS = new Set([
  'collect',
  'produce',
  'buy',
  'sell',
  'build',
  'upgrade',
  'scrap',
  'rebuild',
  'bonds',
  'exchange_sell',
  'pa_read',
  'pa_reply',
  'chat_post',
  'chat_room_post',
  'chat_room_reply',
  'chat_private_open',
  'chat_private_start',
  'chat_private_send',
  'chat_contact_manage',
  'chat_contact_note',
  'chat_contact_report',
  'chat_subscription_toggle',
  'chat_message_translate',
  'chat_message_retract',
  'robots',
  'contract_accept',
  'contract_send',
]);
const STRUCTURAL_ACTIONS = new Set([
  'build',
  'upgrade',
  'scrap',
  'rebuild',
  'bonds',
  'robots',
  'contract_send',
]);
const STRATEGY_DIRECTION_ACTIONS = new Set([
  'build',
  'upgrade',
  'scrap',
  'rebuild',
  'bonds',
  'robots',
]);
const CURRENT_BASELINE_BUILD_TARGETS = new Set([
  'farm',
  'mill',
  'grocery',
  'grocery store',
  'power plant',
  'water reservoir',
]);
const STRATEGY_PREVIEW_OMIT_KEYS = new Set([
  'after',
  'buttons',
  'raw',
  'resultTail',
  'sample',
  'state',
]);
const CHAT_PREVIEW_ACTIONS = new Set([
  'chat_room_post',
  'chat_room_reply',
  'chat_private_open',
  'chat_private_start',
  'chat_private_send',
  'chat_contact_manage',
  'chat_contact_note',
  'chat_contact_report',
  'chat_subscription_toggle',
  'chat_message_translate',
  'chat_message_retract',
]);
const DEFAULT_LOOP_RETRY_MS = 5 * 60 * 1000;
const MIN_ALARM_DELAY_MS = 2 * 60 * 1000;
const MAX_ALARM_DELAY_MS = 4 * 60 * 60 * 1000;
const OWNER_DIRECTIVE_MAX_STATE_AGE_MS = 5 * 60 * 1000;
const FARM_UPGRADE_REVIEW_MAX_BRIDGE_MS = 60 * 60 * 1000;
// Two refusals prove the block is systematic rather than a single transient role failure.
const STRUCTURAL_AUTHORIZATION_BRIDGE_THRESHOLD = 2;

function canonicalBuildingName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildWakeAlarm(args = {}, nowMs = Date.now(), retryKinds = []) {
  const now = Number(nowMs);
  const requestedAt = typeof args?.atIso === 'string' ? Date.parse(args.atIso) : NaN;
  const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
  if (!Number.isSafeInteger(now) || !Number.isFinite(requestedAt) ||
      !reason || reason.length > 500) {
    return {
      ok: false,
      guard: true,
      reason: 'set_alarm requires a valid atIso and a non-empty reason of at most 500 characters',
    };
  }
  const at = Math.max(now + MIN_ALARM_DELAY_MS,
    Math.min(now + MAX_ALARM_DELAY_MS, requestedAt));
  const alarm = {
    at,
    atIso: new Date(at).toISOString(),
    reason,
    set: new Date(now).toISOString(),
  };
  const normalizedKinds = [...new Set((Array.isArray(retryKinds) ? retryKinds : [])
    .map(Number)
    .filter(kind => Number.isSafeInteger(kind) && kind > 0))]
    .sort((left, right) => left - right);
  if (normalizedKinds.length) alarm.utilityRetryKinds = normalizedKinds;
  return { ok: true, alarm, clamped: at !== requestedAt };
}

function validateFinishSummary(value) {
  const summary = typeof value === 'string' ? value.trim() : '';
  return summary && summary.length <= 1000
    ? { ok: true, summary }
    : { ok: false, guard: true,
      reason: 'finish requires a non-empty summary of at most 1000 characters' };
}

// A wake that spends every round on useful work still fails if it reaches the cap before the
// closing sequence: on 2026-08-01 wake 05:16 the model finished its business, wrote the alarm and
// the decision brief on round 30, and never reached `master` — so CURRENT was left stale, the
// automatic finish correctly refused, and the whole wake was retried. Reserve the last rounds for
// closing instead of discarding completed work.
const CLOSING_BUDGET_ROUNDS = 4;

// True while the wake is inside its reserved closing rounds. Optional journal gates must yield
// then: an OPTIONAL review that blocks the mandatory closing sequence discards the whole wake.
function closingBudgetActive(roundsRemaining) {
  return Number.isSafeInteger(roundsRemaining) && roundsRemaining >= 0 &&
    roundsRemaining <= CLOSING_BUDGET_ROUNDS;
}

function closingBudgetDirective(roundsRemaining, finishCheck) {
  if (!Number.isSafeInteger(roundsRemaining) || roundsRemaining > CLOSING_BUDGET_ROUNDS ||
      roundsRemaining < 0) return null;
  if (!finishCheck || finishCheck.ok) return null;
  const missing = Array.isArray(finishCheck.missing) ? finishCheck.missing.filter(Boolean) : [];
  if (!missing.length) return null;
  const firstTool = String(missing[0]).trim().split(/\s+/u)[0];
  return {
    roundsRemaining,
    missing,
    requiredTool: ['set_alarm', 'journal', 'master'].includes(firstTool) ? firstTool : null,
    message: `CLOSING BUDGET: ${roundsRemaining} tool rounds remain in this wake. Start no new ` +
      'work, previews, or inspections. Complete only these closing steps, one per turn, in this ' +
      `order: ${missing.join('; ')}. Then call finish. An unfinished wake leaves the checkpoint ` +
      'stale and forces a full retry.',
  };
}

function buildAutomaticFinishOnExhaustion(runtimeGuard) {
  if (!runtimeGuard || typeof runtimeGuard.finishCheck !== 'function') {
    return { ok: false, reason: 'runtime finish guard is unavailable' };
  }
  const finishCheck = runtimeGuard.finishCheck();
  if (!finishCheck?.ok) return { ok: false, finishCheck };
  return {
    ok: true,
    summary: 'Wake completed every enforced close step; detailed verified actions are recorded in the decision brief and current memory.',
  };
}

function structuralTerms(action, params = {}) {
  const number = (value) => Number(value);
  const text = (value) => String(value ?? '').trim().toLowerCase();
  switch (action) {
    case 'build':
      return {
        building: text(params.building),
        maxCost: number(params.maxCost),
        minCashAfter: number(params.minCashAfter),
      };
    case 'upgrade':
      return {
        buildingId: number(params.buildingId),
        maxCost: number(params.maxCost),
        minCashAfter: number(params.minCashAfter),
      };
    case 'scrap':
    case 'rebuild':
      return { buildingId: number(params.buildingId) };
    case 'bonds':
      return { amount: number(params.amount), interest: number(params.interest) };
    case 'robots':
      return {
        buildingId: number(params.buildingId),
        specialization: params.specialization == null ? null : text(params.specialization),
        buyMissing: params.buyMissing === true,
        maxCost: params.maxCost == null ? null : number(params.maxCost),
        minCashAfter: params.minCashAfter == null ? null : number(params.minCashAfter),
      };
    case 'contract_send':
      return {
        name: text(params.name),
        company: text(params.company),
        qty: number(params.qty),
        price: number(params.price),
        lot: params.lot == null ? 0 : number(params.lot),
      };
    default:
      return null;
  }
}

function sameStructuralTarget(action, preview, confirmation) {
  if (!preview || !confirmation) return false;
  if (action === 'build') return preview.building === confirmation.building;
  if (['upgrade', 'scrap', 'rebuild', 'robots'].includes(action)) {
    return preview.buildingId === confirmation.buildingId;
  }
  if (action === 'bonds') return true;
  if (action === 'contract_send') {
    return preview.name === confirmation.name && preview.company === confirmation.company;
  }
  return false;
}

function structuralTermsAreNoRiskier(action, preview, confirmation) {
  if (!sameStructuralTarget(action, preview, confirmation)) return false;
  if (action === 'build' || action === 'upgrade') {
    return confirmation.maxCost <= preview.maxCost &&
      confirmation.minCashAfter >= preview.minCashAfter;
  }
  return JSON.stringify(preview) === JSON.stringify(confirmation);
}

function strategyDecisionMatchesAction(decision, action, params = {}) {
  if (!decision || decision.consumed === true || decision.action !== action) return false;
  if (action === 'build') {
    return String(decision.target || '').trim().toLowerCase() ===
      String(params.building || '').trim().toLowerCase();
  }
  if (['upgrade', 'scrap', 'rebuild', 'robots'].includes(action)) {
    return Number(decision.buildingId) === Number(params.buildingId);
  }
  return action === 'bonds';
}

function structuralAttemptIsExplicitlyRetrySafe(action, params = {}, result = {}) {
  return STRATEGY_DIRECTION_ACTIONS.has(action) && params.confirm === true &&
    result?.ok === false && result?.safeToRetry === true &&
    result?.mutationAttempted === false && result?.commitClicked !== true &&
    result?.doNotRetry !== true && result?.ambiguous !== true && !result?.err;
}

function strategyDirectionKey(action, params = {}) {
  const terms = structuralTerms(action, params);
  if (!terms || !STRATEGY_DIRECTION_ACTIONS.has(action)) return null;
  if (action === 'build') return `${action}:${terms.building}`;
  if (['upgrade', 'scrap', 'rebuild', 'robots'].includes(action)) {
    return `${action}:${terms.buildingId}`;
  }
  return action === 'bonds' ? action : null;
}

function strategyOptionKey(option = {}) {
  const action = String(option?.action || '').trim().toLowerCase();
  if (!STRATEGY_DIRECTION_ACTIONS.has(action)) return null;
  if (action === 'build') {
    return strategyDirectionKey(action, { building: option.target });
  }
  if (['upgrade', 'scrap', 'rebuild', 'robots'].includes(action)) {
    return strategyDirectionKey(action, { buildingId: option.buildingId });
  }
  return action === 'bonds' ? action : null;
}

function isNonBaselinePortfolioOption(option = {}) {
  const action = String(option?.action || '').trim().toLowerCase();
  const target = String(option?.target || '').trim().toLowerCase();
  if (!target) return false;
  if (action === 'pivot') return true;
  return action === 'build' && !CURRENT_BASELINE_BUILD_TARGETS.has(target);
}

function sanitizeStrategyPreviewValue(value, depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'string' ? value.slice(0, 500) : value;
  }
  if (depth >= 5) return '[DEPTH_LIMIT]';
  if (Array.isArray(value)) {
    return value.slice(0, 25).map(item => sanitizeStrategyPreviewValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return String(value).slice(0, 500);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (STRATEGY_PREVIEW_OMIT_KEYS.has(key)) continue;
    result[key] = sanitizeStrategyPreviewValue(item, depth + 1);
  }
  return result;
}

function buildStrategyCandidate(action, params, result, version, previewedAt = new Date().toISOString()) {
  const key = strategyDirectionKey(action, params);
  const preview = buildStructuralPreviewEvidence(
    action, params, result, version, previewedAt);
  if (!key || !preview) return null;
  return {
    key,
    ...preview,
  };
}

function buildStructuralPreviewEvidence(
  action,
  params,
  result,
  version,
  previewedAt = new Date().toISOString(),
) {
  if (!STRUCTURAL_ACTIONS.has(action) || result?.ok !== true ||
      (result?.preview !== true && result?.dry !== true)) {
    return null;
  }
  return {
    action,
    terms: structuralTerms(action, params),
    preview: sanitizeStrategyPreviewValue(result),
    source: 'runtime-verified-structural-preview',
    previewedAt,
    previewVersion: version,
  };
}

function chatMutationTerms(action, params = {}) {
  const copyParts = parts => Array.isArray(parts)
    ? parts.map(part => ({
        type: part?.type,
        value: part?.value,
        kind: part?.kind,
        name: part?.name,
      }))
    : null;
  switch (action) {
    case 'chat_room_post':
      return {
        room: params.room,
        parts: copyParts(params.parts),
        reason: params.reason,
        attemptId: params.attemptId,
      };
    case 'chat_room_reply':
      return {
        room: params.room,
        company: params.company,
        bodyContains: params.bodyContains,
        conversationHref: params.conversationHref,
        parts: copyParts(params.parts),
        reason: params.reason,
        attemptId: params.attemptId,
      };
    case 'chat_private_open':
      return {
        room: params.room,
        targetCompany: params.targetCompany,
        targetCompanyId: params.targetCompanyId,
        sourceText: params.sourceText,
      };
    case 'chat_private_start':
      return {
        targetCompany: params.targetCompany,
        targetCompanyId: params.targetCompanyId,
        targetRealmId: params.targetRealmId,
      };
    case 'chat_private_send':
      return {
        targetCompany: params.targetCompany,
        targetCompanyId: params.targetCompanyId,
        text: params.text,
        inReplyToText: params.inReplyToText,
        attemptId: params.attemptId,
      };
    case 'chat_contact_manage':
      return {
        targetCompany: params.targetCompany,
        targetCompanyId: params.targetCompanyId,
        contactAction: params.contactAction,
        attemptId: params.attemptId,
      };
    case 'chat_contact_note':
      return {
        targetCompany: params.targetCompany,
        targetCompanyId: params.targetCompanyId,
        note: params.note,
        attemptId: params.attemptId,
      };
    case 'chat_contact_report':
      return {
        targetCompany: params.targetCompany,
        targetCompanyId: params.targetCompanyId,
        attemptId: params.attemptId,
      };
    case 'chat_subscription_toggle':
      return {
        realmId: params.realmId,
        dbLetter: params.dbLetter,
        name: params.name,
        subscribe: params.subscribe,
        attemptId: params.attemptId,
      };
    case 'chat_message_translate':
      return {
        targetCompany: params.targetCompany,
        sourceText: params.sourceText,
        attemptId: params.attemptId,
      };
    case 'chat_message_retract':
      return {
        room: params.room,
        sourceText: params.sourceText,
        attemptId: params.attemptId,
      };
    default:
      return null;
  }
}

function sameChatMutationTerms(action, preview, confirmation) {
  if (!CHAT_PREVIEW_ACTIONS.has(action) || !preview || !confirmation) return false;
  return JSON.stringify(preview) === JSON.stringify(confirmation);
}

function chatPreviewEvidenceIsExact(action, result, terms) {
  if (!result || result.ok !== true || !terms) return false;
  switch (action) {
    case 'chat_room_post':
      return result.dry === true && result.paneScoped === true
        && result.room === terms.room && result.attemptId === terms.attemptId;
    case 'chat_room_reply':
      return result.dry === true && result.compositeReply === true
        && result.room === terms.room && result.company === terms.company
        && typeof result.conversationHref === 'string' && result.conversationHref.length > 0;
    case 'chat_private_open':
      return result.dry === true && result.targetCompany === terms.targetCompany
        && result.targetCompanyId === terms.targetCompanyId
        && typeof result.envelopeHref === 'string' && result.envelopeHref.length > 0;
    case 'chat_private_start':
      // The current preview proves only the Search input, not a unique company result/profile.
      // Keep confirmation closed until a future preview returns exact target evidence.
      return result.exactTargetEvidence === true;
    case 'chat_private_send':
      return result.dry === true && result.targetCompany === terms.targetCompany
        && result.targetCompanyId === terms.targetCompanyId
        && result.attemptId === terms.attemptId && result.wouldSend === terms.text;
    case 'chat_contact_manage':
    case 'chat_contact_note':
    case 'chat_contact_report':
    case 'chat_message_retract':
      return result.exactTargetEvidence === true;
    case 'chat_subscription_toggle':
      return result.dry === true && result.realmId === terms.realmId
        && result.dbLetter === terms.dbLetter && result.name === terms.name
        && result.wouldSubscribe === terms.subscribe;
    case 'chat_message_translate':
      return result.dry === true && result.targetCompany === terms.targetCompany
        && result.sourceText === terms.sourceText && result.wouldTranslate === true;
    default:
      return false;
  }
}

function validateCouncilAuthorization(result, requirements = {}) {
  const evidence = result?.evidence;
  if (evidence?.stateFreshness !== 'FRESH') {
    return { ok: false, reason: 'council evidence is not fresh' };
  }
  if (Number(evidence?.financePage) !== 200) {
    return { ok: false, reason: 'council finance evidence is not verified' };
  }
  if (requirements.buildingInspectionRequired === true && evidence?.buildingInspection !== 'OK') {
    return { ok: false, reason: 'council did not inspect the structural target building' };
  }
  if (requirements.portfolioInspectionRequired === true && evidence?.portfolioInspection !== 'OK') {
    return { ok: false, reason: 'council did not inspect the complete Coffee operating portfolio' };
  }
  if (evidence?.buildingInspection === 'UNKNOWN') {
    return { ok: false, reason: 'council building evidence is unknown' };
  }
  const votes = Array.isArray(result?.council) ? result.council : [];
  const roles = new Set(votes.map(vote => vote?.role));
  if (votes.length !== 3 || !['CFO', 'COO', 'CMO'].every(role => roles.has(role))) {
    return { ok: false, reason: 'council did not return all three roles' };
  }
  const invalid = votes.find(vote => vote?.status !== 'VALIDATED' ||
    !['APPROVE', 'AMEND'].includes(vote?.verdict));
  if (invalid) {
    return {
      ok: false,
      reason: `${invalid.role || 'council'} did not provide a validated non-rejecting verdict`,
    };
  }
  return { ok: true };
}

function validateStrategyCouncilCompletion(result, requirements = {}) {
  const evidence = result?.evidence;
  if (evidence?.stateFreshness !== 'FRESH') {
    return { ok: false, reason: 'strategy council evidence is not fresh' };
  }
  if (Number(evidence?.financePage) !== 200) {
    return { ok: false, reason: 'strategy council finance evidence is not verified' };
  }
  if (requirements.buildingInspectionRequired === true &&
      evidence?.buildingInspection !== 'OK') {
    return { ok: false, reason: 'strategy council did not inspect the focus building' };
  }
  if (requirements.portfolioInspectionRequired === true &&
      evidence?.portfolioInspection !== 'OK') {
    return { ok: false, reason: 'strategy council did not inspect the complete Coffee operating portfolio' };
  }
  if (evidence?.buildingInspection === 'UNKNOWN') {
    return { ok: false, reason: 'strategy council building evidence is unknown' };
  }
  const votes = Array.isArray(result?.council) ? result.council : [];
  const roles = new Set(votes.map(vote => vote?.role));
  if (votes.length !== 3 || !['CFO', 'COO', 'CMO'].every(role => roles.has(role))) {
    return { ok: false, reason: 'strategy council did not return all three roles' };
  }
  const decision = result?.decision;
  const optionId = String(decision?.optionId || '').trim();
  const invalid = votes.find(vote => vote?.status !== 'VALIDATED' ||
    vote?.verdict !== 'RECOMMEND' || !String(vote?.optionId || '').trim());
  if (decision?.method === 'safety_hold') {
    if (decision?.status !== 'DECIDED' || optionId !== 'hold' || !invalid) {
      return { ok: false, reason: 'strategy council safety hold is inconsistent with its votes' };
    }
    return { ok: true, optionId: 'hold', method: 'safety_hold' };
  }
  if (invalid) {
    return {
      ok: false,
      reason: `${invalid?.role || 'council'} did not provide a validated recommendation`,
    };
  }
  if (decision?.status !== 'DECIDED' || !optionId) {
    return { ok: false, reason: 'strategy council did not reach a decision' };
  }
  const counts = new Map();
  for (const vote of votes) counts.set(vote.optionId, (counts.get(vote.optionId) || 0) + 1);
  if (decision.method === 'majority') {
    if ((counts.get(optionId) || 0) < 2) {
      return { ok: false, reason: 'strategy council majority decision does not match its votes' };
    }
  } else if (decision.method === 'hold_tiebreak') {
    if (optionId !== 'hold' || counts.size !== 3) {
      return { ok: false, reason: 'strategy council hold tiebreak is not a three-way tie' };
    }
  } else {
    return { ok: false, reason: 'strategy council decision method is invalid' };
  }
  return { ok: true, optionId, method: decision.method };
}

function councilArgsMatchPreview(preview, args = {}) {
  if (!preview) return { ok: false, reason: 'no structural preview is active' };
  const action = preview.action;
  const proposal = String(args.proposal || '').toLowerCase().replace(/,/g, '');
  if (!proposal.trim()) return { ok: false, reason: 'council proposal is empty' };
  if (action === 'build' && !proposal.includes(preview.terms.building)) {
    return { ok: false, reason: 'council proposal does not name the previewed building' };
  }
  if (['upgrade', 'scrap', 'rebuild', 'robots'].includes(action)) {
    const buildingId = Number(preview.terms.buildingId);
    if (Number(args.buildingId) !== buildingId || !proposal.includes(String(buildingId))) {
      return { ok: false, reason: 'council target does not match the previewed building' };
    }
  }
  return { ok: true };
}

function bindStructuralPreviewToCouncilArgs(preview, args = {}) {
  if (!preview) return { ...args };
  const boundTerms = JSON.stringify({
    action: preview.action,
    terms: preview.terms,
    previewVersion: preview.version,
  });
  return {
    ...args,
    proposal: `${String(args.proposal || '').trim()}\n\nRUNTIME-BOUND PREVIEW TERMS: ${boundTerms}`.trim(),
    authorizationPreview: preview.evidence?.previewVersion === preview.version
      ? preview.evidence
      : null,
  };
}

function isApprovedRollingMillUpgrade(state, params = {}) {
  const buildings = Array.isArray(state?.buildings) ? state.buildings : [];
  const mills = buildings.filter(building =>
    String(building?.name || '').trim().toLowerCase() === 'mill' || building?.kindLetter === 'i');
  const target = mills.find(building => Number(building?.id) === Number(params.buildingId));
  const level = Number(target?.size);
  return mills.length === 3 && Boolean(target) && Number.isInteger(level) && level >= 1 && level < 3 &&
    mills.every(building => Number.isInteger(Number(building?.size)) && Number(building.size) <= 3);
}

// Every structural action needs council now. The Prospector campaign used to exempt its REBUILD
// and target-pool enrolment; the owner retired it on 2026-08-02 and no exemption replaced it.
function councilRequiredForStructuralAction(action) {
  return STRUCTURAL_ACTIONS.has(action);
}

function buildSafetyRetryAlarm(reason, nowMs = Date.now(), retryKinds = []) {
  const baseMs = Number(nowMs);
  if (!Number.isFinite(baseMs)) throw new TypeError('nowMs must be finite');
  const kinds = [...new Set((Array.isArray(retryKinds) ? retryKinds : [])
    .map(Number)
    .filter(kind => Number.isInteger(kind) && kind > 0))]
    .sort((a, b) => a - b);
  const at = baseMs + DEFAULT_LOOP_RETRY_MS;
  const alarm = {
    at,
    atIso: new Date(at).toISOString(),
    reason: `brain loop incomplete; retry safely: ${String(reason || 'unknown reason').slice(0, 240)}`,
    set: new Date(baseMs).toISOString(),
    safetyRetry: true,
  };
  if (kinds.length) alarm.utilityRetryKinds = kinds;
  return alarm;
}

function actionChangedState(action, params = {}, result = {}) {
  if (!result || result.dry === true || result.preview === true) return false;
  switch (action) {
    case 'collect': return result.collected === true;
    case 'produce': return result.started === true;
    case 'buy': return Number(result.bought) > 0;
    case 'sell': return result.clicked === true;
    case 'exchange_sell': return result.ok === true && result.armed === true && Boolean(result.submitted);
    case 'bonds': return params.confirm === true && result.clicked === true;
    case 'robots': return params.confirm === true && result.installed === true;
    case 'pa_read': return result.ok === true;
    case 'pa_reply': return result.ok === true;
    case 'chat_post': return params.confirm === true && Object.prototype.hasOwnProperty.call(result, 'posted');
    case 'chat_room_post':
    case 'chat_room_reply':
    case 'chat_private_send':
      return params.confirm === true && result.posted === true;
    case 'chat_private_start': return params.confirm === true && result.opened === true;
    case 'chat_contact_manage':
    case 'chat_contact_note':
    case 'chat_contact_report':
    case 'chat_subscription_toggle':
    case 'chat_message_translate':
      return params.confirm === true && result.verified === true;
    case 'chat_message_retract': return params.confirm === true && result.retracted === true;
    case 'contract_accept': return params.confirm === true && result.accepted === true;
    case 'contract_send': return params.confirm === true && result.sent === true;
    case 'build':
    case 'upgrade':
    case 'scrap':
    case 'rebuild':
      return params.confirm === true && result.ok === true;
    default:
      return false;
  }
}

function actionRequiresRefresh(action, params = {}, result = {}) {
  if (!result || result.dry === true || result.preview === true || result.guard === true) return false;
  if (actionChangedState(action, params, result)) return true;
  if (['collect', 'produce', 'buy', 'sell', 'pa_read', 'pa_reply'].includes(action)) return true;
  return MUTATING_ACTIONS.has(action) && params.confirm === true;
}

class WakeRuntimeGuard {
  constructor() {
    this.mutationVersion = 0;
    this.dirty = false;
    this.lastMutation = null;
    this.lastEvidenceChange = null;
    this.alarmVersion = -1;
    this.journalVersion = -1;
    this.masterVersion = -1;
    this.structuralPreview = null;
    this.strategyCandidates = new Map();
    this.chatPreview = null;
    this.strategyCouncilRequirement = {
      required: false,
      reasons: [],
      status: 'not_required',
    };
    this.strategyCouncilAttempted = false;
    this.strategyCouncilCompleted = false;
    this.strategyCouncilDecision = null;
    this.strategyCouncilConsideredDirections = new Set();
    // How often the execution council refused to authorize a selected direction this wake, keyed by
    // direction. A repeatedly unauthorized selection must not also block bridge work (see the
    // produce guard): on 2026-08-01 the COO returned VALIDATED/UNKNOWN five times for one Farm
    // upgrade while the produce path stayed blocked, so the Farm could neither upgrade nor work.
    this.structuralAuthorizationFailures = new Map();
  }

  configureStrategyCouncil(requirement = {}) {
    this.strategyCouncilRequirement = {
      required: requirement?.required === true,
      reasons: Array.isArray(requirement?.reasons) ? [...requirement.reasons] : [],
      status: requirement?.required === true ? 'required' : 'not_required',
      currentWakeOrdinal: Number(requirement?.currentWakeOrdinal) || null,
      wakeInterval: Number(requirement?.wakeInterval) || null,
      materialChanges: Array.isArray(requirement?.materialChanges)
        ? [...requirement.materialChanges]
        : [],
    };
    this.strategyCouncilAttempted = false;
    this.strategyCouncilCompleted = false;
    this.strategyCouncilDecision = null;
    this.strategyCouncilConsideredDirections.clear();
    this.strategyCandidates.clear();
    return this.strategyCouncilStatus();
  }

  noteStrategyCouncil(result, args = {}) {
    this.strategyCouncilAttempted = true;
    this.strategyCouncilConsideredDirections = new Set(
      (Array.isArray(args?.options) ? args.options : [])
        .map(strategyOptionKey)
        .filter(Boolean),
    );
    const completion = validateStrategyCouncilCompletion(result, {
      buildingInspectionRequired: args?.focusBuildingId != null,
      portfolioInspectionRequired: true,
    });
    this.strategyCouncilCompleted = completion.ok;
    const selected = completion.ok
      ? (Array.isArray(args?.options)
          ? args.options.find(option => option?.id === completion.optionId)
          : null)
      : null;
    if (completion.ok && !selected) {
      this.strategyCouncilCompleted = false;
      this.strategyCouncilDecision = null;
      return { ok: false, reason: 'strategy council decision is not in the submitted option set' };
    }
    this.strategyCouncilDecision = completion.ok ? {
      optionId: completion.optionId,
      method: completion.method,
      action: String(selected.action || '').trim().toLowerCase(),
      buildingId: selected.buildingId == null ? null : Number(selected.buildingId),
      target: selected.target == null ? null : String(selected.target).trim().toLowerCase(),
      consumed: false,
    } : null;
    if (completion.ok) {
      // A candidate quote informed the direction vote. It is never sufficient for execution:
      // the selected action must be previewed again after the vote before final authorization.
      this.structuralPreview = null;
    }
    return completion;
  }

  prepareStrategyCouncil(args = {}) {
    if (!Array.isArray(args?.options)) {
      return { ok: true, strategyCandidates: [] };
    }
    if (this.strategyCouncilRequirement.required &&
        !args.options.some(isNonBaselinePortfolioOption)) {
      return {
        ok: false,
        guard: true,
        reason: 'a required portfolio strategy checkpoint must compare at least one named non-baseline expansion or pivot option',
        requiredNextStep: 'add a pivot option with a concrete target, or preview a build outside the current Coffee baseline; Council may still select hold',
        currentBaselineBuildTargets: [...CURRENT_BASELINE_BUILD_TARGETS],
      };
    }
    const candidates = [];
    const missing = [];
    const seenDirectionKeys = new Set();
    for (const option of args.options) {
      const key = strategyOptionKey(option);
      if (!key) continue;
      if (seenDirectionKeys.has(key)) {
        return {
          ok: false,
          guard: true,
          reason: 'strategy options cannot reuse one executable action target with different labels',
          duplicateDirection: key,
        };
      }
      seenDirectionKeys.add(key);
      const candidate = this.strategyCandidates.get(key);
      if (!candidate || candidate.previewVersion !== this.mutationVersion) {
        missing.push({
          optionId: String(option?.id || '').trim() || null,
          action: String(option?.action || '').trim().toLowerCase() || null,
          buildingId: option?.buildingId == null ? null : Number(option.buildingId),
          target: option?.target == null ? null : String(option.target).trim().toLowerCase(),
        });
        continue;
      }
      candidates.push({
        ...candidate,
        optionId: String(option?.id || '').trim(),
      });
    }
    if (missing.length) {
      return {
        ok: false,
        guard: true,
        reason: 'every executable strategy option requires a successful same-wake read-only candidate preview',
        requiredNextStep: 'run each missing structural action with confirm:false, then call strategy_council again',
        missingCandidates: missing,
      };
    }
    return { ok: true, strategyCandidates: candidates };
  }

  beforeStrategyCouncil() {
    if (this.strategyCouncilCompleted) {
      return {
        ok: false,
        guard: true,
        reason: 'this wake already has a validated strategy council decision; it cannot be rerolled',
        strategyGovernance: this.strategyCouncilStatus(),
      };
    }
    return null;
  }

  strategyCouncilStatus() {
    if (!this.strategyCouncilRequirement.required && !this.strategyCouncilCompleted) {
      return {
        required: false,
        status: 'not_required',
        reasons: this.strategyCouncilRequirement.reasons,
      };
    }
    return {
      required: this.strategyCouncilRequirement.required,
      status: this.strategyCouncilCompleted
        ? (this.strategyCouncilRequirement.required
            ? 'required_and_completed'
            : 'completed_proactively')
        : (this.strategyCouncilAttempted ? 'required_but_failed' : 'required_but_skipped'),
      reasons: this.strategyCouncilRequirement.reasons,
      currentWakeOrdinal: this.strategyCouncilRequirement.currentWakeOrdinal,
      wakeInterval: this.strategyCouncilRequirement.wakeInterval,
      materialChanges: this.strategyCouncilRequirement.materialChanges,
      candidatePreviewCount: this.strategyCandidates.size,
      decision: this.strategyCouncilDecision,
    };
  }

  beforeAction(action, params = {}, options = {}) {
    if (this.dirty && MUTATING_ACTIONS.has(action)) {
      return {
        ok: false,
        guard: true,
        reason: `live state changed after ${this.lastMutation}; call refresh_state before another state-changing action`,
        requiredTool: 'refresh_state',
      };
    }
    if (action === 'produce') {
      const buildingId = Number(params?.buildingId);
      const building = (Array.isArray(options?.state?.buildings)
        ? options.state.buildings : []).find(row => Number(row?.id) === buildingId);
      const isLowLevelFarm = canonicalBuildingName(building?.name) === 'farm' &&
        Number.isSafeInteger(Number(building?.size)) && Number(building.size) >= 1 &&
        Number(building.size) < 3;
      const ownerUpgradeTarget = options?.ownerDirective?.action === 'fund-and-upgrade-building' &&
        Number(options.ownerDirective?.buildingId) === buildingId;
      if (isLowLevelFarm && !ownerUpgradeTarget) {
        const upgradeKey = strategyDirectionKey('upgrade', { buildingId });
        const considered = this.strategyCouncilConsideredDirections.has(upgradeKey);
        const decision = this.strategyCouncilDecision;
        if (this.strategyCouncilCompleted && considered && decision?.action === 'hold') {
          // Council explicitly chose continued operation after reviewing this exact Farm upgrade.
        } else if (this.strategyCouncilCompleted && considered &&
            decision?.action === 'upgrade' && Number(decision.buildingId) === buildingId) {
          // The selected upgrade normally outranks production. But if the execution council has
          // already refused to authorize it repeatedly this wake, blocking production too leaves
          // the building with no legal move at all while the no-voluntary-idle journal gate still
          // demands work. Allow the same bounded checkpoint bridge used after a council failure.
          const authorizationFailures = this.structuralAuthorizationFailures.get(upgradeKey) || 0;
          const capturedAtMs = Date.parse(options?.state?.t);
          const finishBeforeMs = Date.parse(params?.finishBefore);
          const shortBridge = Number.isFinite(capturedAtMs) && Number.isFinite(finishBeforeMs) &&
            finishBeforeMs > capturedAtMs &&
            finishBeforeMs <= capturedAtMs + FARM_UPGRADE_REVIEW_MAX_BRIDGE_MS;
          if (authorizationFailures >= STRUCTURAL_AUTHORIZATION_BRIDGE_THRESHOLD && shortBridge) {
            // Bridge permitted: the upgrade stays selected and must be retried next wake.
          } else if (authorizationFailures >= STRUCTURAL_AUTHORIZATION_BRIDGE_THRESHOLD) {
            return {
              ok: false,
              guard: true,
              reason: `the selected Farm upgrade failed council authorization ${authorizationFailures} times this wake; keep the upgrade pending and place only a checkpoint-bound bridge of at most one hour`,
              buildingId,
              requiredParameter: 'finishBefore',
              latestAllowedFinishBefore: Number.isFinite(capturedAtMs)
                ? new Date(capturedAtMs + FARM_UPGRADE_REVIEW_MAX_BRIDGE_MS).toISOString()
                : null,
            };
          } else {
            return {
              ok: false,
              guard: true,
              reason: 'strategy_council selected this Farm upgrade; do not hide the upgrade window behind another production order',
              requiredAction: {
                action: 'upgrade', buildingId, confirm: false,
                note: 'refresh the exact quote, fund the measured gap if necessary, then execute the selected upgrade',
              },
            };
          }
        } else {
          const candidate = this.strategyCandidates.get(upgradeKey);
          const candidateIsCurrent = candidate?.previewVersion === this.mutationVersion;
          // The preview requirement is only reachable while an upgrade preview is still legal. Once
          // this wake holds a validated decision for a DIFFERENT direction the direction gate
          // refuses the preview itself, and the wake can no longer be re-rolled — demanding a
          // preview then leaves the Farm with no legal move at all. Live 2026-08-01 wake 11:57: a
          // safety hold that never considered Farm 55345580 blocked its preview, its production and
          // a fresh council in turn, and the Farm sat idle. Allow the bounded checkpoint bridge.
          const decisionBlocksPreview = this.strategyCouncilCompleted && decision &&
            !strategyDecisionMatchesAction(decision, 'upgrade', { buildingId });
          const capturedAtMsForHold = Date.parse(options?.state?.t);
          const finishBeforeMsForHold = Date.parse(params?.finishBefore);
          const holdBridge = Number.isFinite(capturedAtMsForHold) &&
            Number.isFinite(finishBeforeMsForHold) &&
            finishBeforeMsForHold > capturedAtMsForHold &&
            finishBeforeMsForHold <= capturedAtMsForHold + FARM_UPGRADE_REVIEW_MAX_BRIDGE_MS;
          if (decisionBlocksPreview && !candidateIsCurrent && !considered) {
            if (holdBridge) return null;
            return {
              ok: false,
              guard: true,
              reason: `strategy_council selected ${decision.action} this wake, so this Farm upgrade cannot be previewed; place only a checkpoint-bound bridge of at most one hour and revisit the upgrade next wake`,
              buildingId,
              requiredParameter: 'finishBefore',
              latestAllowedFinishBefore: Number.isFinite(capturedAtMsForHold)
                ? new Date(capturedAtMsForHold + FARM_UPGRADE_REVIEW_MAX_BRIDGE_MS).toISOString()
                : null,
            };
          }
          if (!candidateIsCurrent && !considered) {
            return {
              ok: false,
              guard: true,
              reason: 'a level-1 or level-2 Farm must receive an exact upgrade preview before another production commitment',
              requiredAction: {
                action: 'upgrade', buildingId, confirm: false,
                note: 'quote the upgrade before deciding whether to upgrade, finance, or continue production',
              },
            };
          }
          if (!this.strategyCouncilAttempted) {
            return {
              ok: false,
              guard: true,
              reason: 'the Farm upgrade preview must be considered by strategy_council before ordinary production resumes',
              requiredTool: 'strategy_council',
              requiredOptions: [
                { action: 'upgrade', buildingId, target: 'farm' },
                { action: 'hold', buildingId: null, target: null },
              ],
            };
          }
          const capturedAtMs = Date.parse(options?.state?.t);
          const finishBeforeMs = Date.parse(params?.finishBefore);
          const shortBridge = Number.isFinite(capturedAtMs) && Number.isFinite(finishBeforeMs) &&
            finishBeforeMs > capturedAtMs &&
            finishBeforeMs <= capturedAtMs + FARM_UPGRADE_REVIEW_MAX_BRIDGE_MS;
          if (!shortBridge) {
            return {
              ok: false,
              guard: true,
              reason: 'the Farm upgrade decision is unresolved; only a checkpoint-bound bridge of at most one hour is allowed after a Council failure or a different selected direction',
              buildingId,
              requiredParameter: 'finishBefore',
              latestAllowedFinishBefore: Number.isFinite(capturedAtMs)
                ? new Date(capturedAtMs + FARM_UPGRADE_REVIEW_MAX_BRIDGE_MS).toISOString()
                : null,
            };
          }
        }
      }
    }
    if (STRATEGY_DIRECTION_ACTIONS.has(action) && options.councilRequired !== false) {
      if (params.confirm === true && !this.strategyCouncilCompleted) {
        return {
          ok: false,
          guard: true,
          reason: `${action} confirmation requires strategy_council to choose the direction`,
          requiredTool: 'strategy_council',
          strategyGovernance: this.strategyCouncilStatus(),
        };
      }
      if (this.strategyCouncilCompleted && this.strategyCouncilDecision?.consumed === true) {
        return {
          ok: false,
          guard: true,
          reason: `${action} direction was consumed by a prior persistent or ambiguous confirmation attempt; it cannot be replayed this wake`,
          selectedDirection: this.strategyCouncilDecision,
        };
      }
      if (this.strategyCouncilCompleted &&
          !strategyDecisionMatchesAction(this.strategyCouncilDecision, action, params)) {
        return {
          ok: false,
          guard: true,
          reason: `${action} target is not the direction selected by strategy_council`,
          selectedDirection: this.strategyCouncilDecision,
        };
      }
    }
    if (CHAT_PREVIEW_ACTIONS.has(action) && params.confirm === true) {
      const confirmation = chatMutationTerms(action, params);
      const preview = this.chatPreview;
      if (!preview || preview.action !== action || preview.version !== this.mutationVersion) {
        return {
          ok: false,
          guard: true,
          reason: `${action} confirmation requires a successful same-wake exact-target preview after the latest evidence change`,
          requiredAction: { action, confirm: false },
        };
      }
      if (!sameChatMutationTerms(action, preview.terms, confirmation)) {
        return {
          ok: false,
          guard: true,
          reason: `${action} confirmation target or content differs from its exact-target preview`,
          previewTerms: preview.terms,
          confirmationTerms: confirmation,
        };
      }
      // Consume before browser access. An ambiguous UI click can never reuse the preview.
      this.chatPreview = null;
    }
    if (STRUCTURAL_ACTIONS.has(action) && params.confirm === true) {
      const confirmation = structuralTerms(action, params);
      const preview = this.structuralPreview;
      if (!preview || preview.action !== action || preview.version !== this.mutationVersion) {
        return {
          ok: false,
          guard: true,
          reason: `${action} confirmation requires a successful same-wake preview after the latest refresh`,
          requiredAction: { action, confirm: false },
        };
      }
      if (!structuralTermsAreNoRiskier(action, preview.terms, confirmation)) {
        return {
          ok: false,
          guard: true,
          reason: `${action} confirmation target or terms differ from its preview; preview the exact terms again`,
          previewTerms: preview.terms,
          confirmationTerms: confirmation,
        };
      }
      if (options.councilRequired !== false && preview.councilAuthorized !== true) {
        return {
          ok: false,
          guard: true,
          reason: `${action} confirmation requires a fresh validated council result after its preview`,
          requiredTool: 'council',
          councilReason: preview.councilReason || 'council has not authorized this preview',
        };
      }
      // Consume before browser work. If the click outcome is ambiguous, a replay must obtain a
      // new preview (and council authorization) instead of risking a duplicate build/scrap/etc.
      this.structuralPreview = null;
    }
    return null;
  }

  afterAction(action, params, result) {
    const chatTerms = chatMutationTerms(action, params);
    if (CHAT_PREVIEW_ACTIONS.has(action) && params?.confirm === false
        && (result?.preview === true || result?.dry === true)
        && chatPreviewEvidenceIsExact(action, result, chatTerms)) {
      this.chatPreview = {
        action,
        terms: chatTerms,
        version: this.mutationVersion,
      };
    }
    if (STRUCTURAL_ACTIONS.has(action) && params?.confirm === false &&
        result?.ok === true && (result.preview === true || result.dry === true)) {
      const evidence = buildStructuralPreviewEvidence(
        action,
        params,
        result,
        this.mutationVersion,
      );
      this.structuralPreview = {
        action,
        terms: structuralTerms(action, params),
        version: this.mutationVersion,
        evidence,
        councilAuthorized: false,
        councilReason: null,
      };
      if (STRATEGY_DIRECTION_ACTIONS.has(action) && !this.strategyCouncilCompleted) {
        const candidate = buildStrategyCandidate(
          action,
          params,
          result,
          this.mutationVersion,
        );
        if (candidate) this.strategyCandidates.set(candidate.key, candidate);
      }
    }
    if (!actionRequiresRefresh(action, params, result)) return false;
    // Consume the one-use strategy direction only when the confirmed action IS that direction, so
    // an unrelated confirm cannot burn it: on 2026-08-01 wake 03:50 a rebuild confirm consumed the
    // council-selected Farm upgrade, every later upgrade attempt was refused as "direction was
    // consumed", and the wake exhausted its 40 rounds with the Farm left idle.
    if (STRATEGY_DIRECTION_ACTIONS.has(action) && params?.confirm === true &&
        this.strategyCouncilDecision &&
        strategyDecisionMatchesAction(this.strategyCouncilDecision, action, params) &&
        !structuralAttemptIsExplicitlyRetrySafe(action, params, result)) {
      this.strategyCouncilDecision.consumed = true;
    }
    this.mutationVersion += 1;
    this.dirty = true;
    this.lastMutation = action;
    this.lastEvidenceChange = action;
    return true;
  }

  noteCouncil(result, args = {}) {
    if (!this.structuralPreview || this.structuralPreview.version !== this.mutationVersion) return null;
    const argsMatch = councilArgsMatchPreview(this.structuralPreview, args);
    const authorization = argsMatch.ok
      ? validateCouncilAuthorization(result, {
          buildingInspectionRequired: ['upgrade', 'scrap', 'rebuild', 'robots'].includes(this.structuralPreview.action),
          portfolioInspectionRequired: true,
        })
      : argsMatch;
    this.structuralPreview.councilAuthorized = authorization.ok;
    this.structuralPreview.councilReason = authorization.reason || null;
    if (!authorization.ok && this.structuralPreview.action) {
      const key = strategyDirectionKey(this.structuralPreview.action, {
        buildingId: this.structuralPreview.terms?.buildingId ?? args?.buildingId ?? null,
        building: this.structuralPreview.terms?.building ?? null,
      });
      this.structuralAuthorizationFailures.set(
        key, (this.structuralAuthorizationFailures.get(key) || 0) + 1);
    }
    return authorization;
  }

  bindCouncilArgs(args = {}) {
    return bindStructuralPreviewToCouncilArgs(this.structuralPreview, args);
  }

  noteEvidenceChange(source) {
    this.mutationVersion += 1;
    this.lastEvidenceChange = String(source || 'evidence');
    this.structuralPreview = null;
    this.strategyCandidates.clear();
    this.chatPreview = null;
  }

  noteRefresh() {
    this.dirty = false;
    this.noteEvidenceChange('refresh_state');
  }

  beforeJournal() {
    if (this.dirty) {
      return { ok: false, guard: true, reason: 'refresh_state must succeed before journal', requiredTool: 'refresh_state' };
    }
    if (this.alarmVersion !== this.mutationVersion) {
      return { ok: false, guard: true, reason: 'set_alarm must succeed after the latest mutation before journal', requiredTool: 'set_alarm' };
    }
    if (this.strategyCouncilRequirement.required && !this.strategyCouncilCompleted) {
      const governance = this.strategyCouncilStatus();
      return {
        ok: false,
        guard: true,
        reason: governance.status === 'required_but_failed'
          ? 'the required strategy council attempt did not produce a validated decision'
          : 'this wake requires a strategy council decision before journal',
        requiredTool: 'strategy_council',
        strategyGovernance: governance,
      };
    }
    return null;
  }

  beforeMaster() {
    const journalBlock = this.beforeJournal();
    if (journalBlock) return journalBlock;
    if (this.journalVersion !== this.mutationVersion) {
      return { ok: false, guard: true, reason: 'journal must succeed after set_alarm and the latest mutation before master', requiredTool: 'journal' };
    }
    return null;
  }

  noteAlarm() {
    this.alarmVersion = this.mutationVersion;
  }

  noteJournal() {
    this.journalVersion = this.mutationVersion;
  }

  noteMaster() {
    this.masterVersion = this.mutationVersion;
  }

  finishCheck() {
    const missing = [];
    if (this.dirty) missing.push('refresh_state');
    if (this.alarmVersion !== this.mutationVersion) missing.push('set_alarm after the latest mutation');
    if (this.journalVersion !== this.mutationVersion) missing.push('journal after the latest mutation');
    if (this.masterVersion !== this.mutationVersion) missing.push('master after the latest mutation');
    if (this.strategyCouncilRequirement.required && !this.strategyCouncilCompleted) {
      missing.push('strategy_council decision');
    }
    if (!missing.length) return { ok: true };
    return {
      ok: false,
      guard: true,
      reason: `cannot finish this wake; required: ${missing.join(', ')}`,
      missing,
      lastMutation: this.lastMutation,
      lastEvidenceChange: this.lastEvidenceChange,
      mutationVersion: this.mutationVersion,
    };
  }
}

module.exports = {
  CHAT_PREVIEW_ACTIONS,
  MUTATING_ACTIONS,
  STRUCTURAL_ACTIONS,
  STRATEGY_DIRECTION_ACTIONS,
  WakeRuntimeGuard,
  actionChangedState,
  actionRequiresRefresh,
  bindStructuralPreviewToCouncilArgs,
  buildAutomaticFinishOnExhaustion,
  closingBudgetActive,
  closingBudgetDirective,
  buildSafetyRetryAlarm,
  buildStructuralPreviewEvidence,
  buildWakeAlarm,
  chatMutationTerms,
  chatPreviewEvidenceIsExact,
  councilArgsMatchPreview,
  councilRequiredForStructuralAction,
  isApprovedRollingMillUpgrade,
  sameStructuralTarget,
  sameChatMutationTerms,
  structuralTerms,
  structuralTermsAreNoRiskier,
  strategyDecisionMatchesAction,
  strategyDirectionKey,
  isNonBaselinePortfolioOption,
  strategyOptionKey,
  buildStrategyCandidate,
  validateCouncilAuthorization,
  validateStrategyCouncilCompletion,
  validateFinishSummary,
};
