'use strict';

const {
  findOwnerProspectorRecoveryCandidate,
} = require('./owner-directive.js');

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
const PROSPECTOR_OVERVIEW_PATH = '/api/v2/companies/me/achievements/';
const PROSPECTOR_CAMPAIGN_MODE = 'repeat-until-achievement-complete';
const OWNER_SUBTASK_ACTION = 'complete-owner-subtasks';

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

function isOwnerAuthorizedProspectorRebuild(state, params = {}, directive, now = Date.now()) {
  const nowMs = Number(now);
  const stateAtMs = Date.parse(state?.t);
  const buildingSource = state?.sources?.buildings;
  const buildingSourceAtMs = Date.parse(buildingSource?.asOf);
  const buildingId = Number(params?.buildingId);
  const recoveryCandidate = findOwnerProspectorRecoveryCandidate(
    state,
    directive,
    now,
  );
  if (Number(recoveryCandidate?.buildingId) === buildingId) return true;
  const experiment = directive?.prospectorExperiment;
  const baseline = experiment?.baselineProgress;
  const latest = experiment?.lastProgressEvidence;
  const completionMs = Date.parse(experiment?.completesAt);
  const activeAttempt = ['claimed', 'awaiting-counter'].includes(
    experiment?.rebuildAttempt?.status,
  );
  const matches = (Array.isArray(state?.buildings) ? state.buildings : [])
    .filter(building => Number(building?.id) === buildingId);
  const building = matches.length === 1 ? matches[0] : null;
  const buildingName = String(building?.name || '').trim().toLowerCase();
  const expectedName = String(experiment?.building || '').trim().toLowerCase();
  const expectedBaseline = Number(experiment?.expectedBaseline);
  const expectedTarget = Number(experiment?.expectedTarget);
  const expectedIncrement = Number(experiment?.expectedIncrement);
  const campaign = experiment?.campaign?.mode === PROSPECTOR_CAMPAIGN_MODE;
  const campaignProgressValid = campaign && experiment?.campaign?.status === 'active' &&
    ['waiting-construction', 'baseline-verified'].includes(experiment?.status) &&
    Number.isSafeInteger(expectedBaseline) && expectedBaseline >= 0 &&
    Number.isSafeInteger(expectedTarget) && expectedTarget > expectedBaseline &&
    expectedIncrement === 1 &&
    Number(baseline?.current) === expectedBaseline && Number(baseline?.target) === expectedTarget &&
    Number(latest?.current) === expectedBaseline && Number(latest?.target) === expectedTarget &&
    Number.isSafeInteger(Number(baseline?.stars)) && Number(baseline.stars) >= 0 &&
    Number.isSafeInteger(Number(baseline?.starsMax)) && Number(baseline.starsMax) > Number(baseline.stars) &&
    Number(latest?.stars) === Number(baseline.stars) &&
    Number(latest?.starsMax) === Number(baseline.starsMax);
  const boundedProgressValid = !campaign && experiment?.status === 'baseline-verified' &&
    expectedBaseline === 1 && expectedTarget === 10 && expectedIncrement === 1 &&
    Number(baseline?.current) === 1 && Number(baseline?.target) === 10 &&
    Number(latest?.current) === 1 && Number(latest?.target) === 10;
  const rootAuthorizationValid = directive?.program?.status === 'completed' ||
    (campaign && directive?.action === OWNER_SUBTASK_ACTION);
  const stateIsFresh = Number.isFinite(nowMs) && Number.isFinite(stateAtMs) &&
    Number.isFinite(buildingSourceAtMs) && stateAtMs <= nowMs + 60e3 &&
    buildingSourceAtMs <= nowMs + 60e3 && nowMs - stateAtMs <= OWNER_DIRECTIVE_MAX_STATE_AGE_MS &&
    nowMs - buildingSourceAtMs <= OWNER_DIRECTIVE_MAX_STATE_AGE_MS;
  return directive?.schemaVersion === 1 && directive?.status === 'pending' &&
    directive?.priority === 'owner' && rootAuthorizationValid &&
    (campaignProgressValid || boundedProgressValid) && !activeAttempt &&
    Number.isSafeInteger(buildingId) && buildingId > 0 &&
    Number(experiment?.buildingId) === buildingId && Number(experiment?.level) === 1 &&
    Number.isFinite(completionMs) && nowMs >= completionMs &&
    baseline?.path === PROSPECTOR_OVERVIEW_PATH && Number(baseline?.status) === 200 &&
    latest?.path === PROSPECTOR_OVERVIEW_PATH && Number(latest?.status) === 200 &&
    buildingSource?.status === 'ok' && stateIsFresh && Boolean(building) &&
    ['quarry', 'mine', 'oil rig'].includes(buildingName) &&
    (!expectedName || expectedName === buildingName) && Number(building?.size) === 1 &&
    building?.freeAndLocked !== true && building?.busy == null &&
    !(building?.activity?.status === 'known' && building?.activity?.busy === true);
}

function councilRequiredForStructuralAction(action, params, state, ownerDirective = null, now = Date.now()) {
  if (!STRUCTURAL_ACTIONS.has(action)) return false;
  if (action === 'upgrade' && isApprovedRollingMillUpgrade(state, params)) return false;
  if (action === 'rebuild' &&
      isOwnerAuthorizedProspectorRebuild(state, params, ownerDirective, now)) return false;
  return true;
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
    this.chatPreview = null;
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
      this.structuralPreview = {
        action,
        terms: structuralTerms(action, params),
        version: this.mutationVersion,
        councilAuthorized: false,
        councilReason: null,
      };
    }
    if (!actionRequiresRefresh(action, params, result)) return false;
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
        })
      : argsMatch;
    this.structuralPreview.councilAuthorized = authorization.ok;
    this.structuralPreview.councilReason = authorization.reason || null;
    return authorization;
  }

  bindCouncilArgs(args = {}) {
    return bindStructuralPreviewToCouncilArgs(this.structuralPreview, args);
  }

  noteEvidenceChange(source) {
    this.mutationVersion += 1;
    this.lastEvidenceChange = String(source || 'evidence');
    this.structuralPreview = null;
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
  WakeRuntimeGuard,
  actionChangedState,
  actionRequiresRefresh,
  bindStructuralPreviewToCouncilArgs,
  buildAutomaticFinishOnExhaustion,
  buildSafetyRetryAlarm,
  buildWakeAlarm,
  chatMutationTerms,
  chatPreviewEvidenceIsExact,
  councilArgsMatchPreview,
  councilRequiredForStructuralAction,
  isApprovedRollingMillUpgrade,
  isOwnerAuthorizedProspectorRebuild,
  sameStructuralTarget,
  sameChatMutationTerms,
  structuralTerms,
  structuralTermsAreNoRiskier,
  validateCouncilAuthorization,
  validateFinishSummary,
};
