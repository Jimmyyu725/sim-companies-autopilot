'use strict';

const crypto = require('node:crypto');
const { canonicalDecimal, DEFAULT_MAX_EVIDENCE_AGE_MS } = require('./lead-engine.js');

const CONTRACT_GATE_SCHEMA_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const TERM_KEYS = Object.freeze([
  'counterpartyCompanyId',
  'ourSide',
  'quality',
  'quantity',
  'resourceKind',
  'unitPrice',
]);

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex');
}

function normalizeTerms(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('contract terms must be an object');
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== TERM_KEYS.length || keys.some((key, index) => key !== [...TERM_KEYS].sort()[index])) {
    throw new TypeError(`contract terms must contain exactly: ${TERM_KEYS.join(', ')}`);
  }
  const counterpartyCompanyId = String(input.counterpartyCompanyId ?? '').trim();
  if (!counterpartyCompanyId || counterpartyCompanyId.length > 160) {
    throw new TypeError('counterpartyCompanyId is invalid');
  }
  if (!['buy', 'sell'].includes(input.ourSide)) throw new TypeError('ourSide must be buy or sell');
  const resourceKind = Number(input.resourceKind);
  const quality = Number(input.quality);
  const quantity = Number(input.quantity);
  if (!Number.isSafeInteger(resourceKind) || resourceKind <= 0) {
    throw new TypeError('resourceKind must be a positive integer');
  }
  if (!Number.isSafeInteger(quality) || quality < 0) {
    throw new TypeError('quality must be a non-negative integer');
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new TypeError('quantity must be a positive integer');
  }
  const rawPrice = typeof input.unitPrice === 'number' && Number.isFinite(input.unitPrice)
    ? String(input.unitPrice)
    : String(input.unitPrice ?? '').trim();
  const unitPrice = canonicalDecimal(rawPrice);
  if (unitPrice == null || Number(unitPrice) <= 0) throw new TypeError('unitPrice must be a positive decimal');
  return {
    counterpartyCompanyId,
    ourSide: input.ourSide,
    quality,
    quantity,
    resourceKind,
    unitPrice,
  };
}

function contractTermsHash(terms) {
  return digest(normalizeTerms(terms));
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) throw new TypeError('now must be a Date or millisecond timestamp');
  return value;
}

function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function validateEvaluationBinding(evaluation, terms, nowMs, maxAgeMs) {
  const reasons = [];
  if (!evaluation || typeof evaluation !== 'object' || evaluation.schemaVersion !== 1
    || evaluation.status !== 'evaluated' || evaluation.evidenceComplete !== true) {
    return { ok: false, reasons: ['complete evaluated economic evidence is required'] };
  }
  const snapshotMs = parseTime(evaluation.snapshotObservedAt);
  const evaluatedMs = parseTime(evaluation.evaluatedAt);
  if (snapshotMs == null || nowMs - snapshotMs > maxAgeMs || nowMs - snapshotMs < -MAX_CLOCK_SKEW_MS) {
    reasons.push('business snapshot is stale or invalid');
  }
  if (evaluatedMs == null || nowMs - evaluatedMs > maxAgeMs || nowMs - evaluatedMs < -MAX_CLOCK_SKEW_MS) {
    reasons.push('lead evaluation is stale or invalid');
  }
  if (!evaluation.snapshotId) reasons.push('evaluation snapshot identity is missing');
  if (evaluation.counterpartyCompanyId !== terms.counterpartyCompanyId) {
    reasons.push('counterparty differs from evaluated lead');
  }
  if (evaluation.ourSide !== terms.ourSide) reasons.push('trade side differs from evaluated lead');
  if (Number(evaluation.resourceKind) !== terms.resourceKind) reasons.push('resource differs from evaluated lead');
  if (Number(evaluation.quality) !== terms.quality) reasons.push('quality differs from evaluated lead');
  const maxQuantity = Number(evaluation.maxNegotiableQuantity);
  if (!Number.isSafeInteger(maxQuantity) || terms.quantity > maxQuantity) {
    reasons.push('quantity exceeds the evidence-backed negotiable maximum');
  }
  return { ok: reasons.length === 0, reasons, snapshotMs, evaluatedMs };
}

function evaluateCandidateEconomics(evaluation, terms) {
  const input = evaluation.economicsInputs;
  if (!input || typeof input !== 'object') {
    return { ok: false, reasons: ['economic inputs are missing'] };
  }
  const price = Number(terms.unitPrice);
  const quantity = terms.quantity;
  const feeRate = finiteNonNegative(input.contractFeeRate);
  const fixedCost = finiteNonNegative(input.fixedCost);
  const transportPerItem = finiteNonNegative(input.transportPerItem);
  const transportAvailable = finiteNonNegative(input.transportAvailable);
  const transportOpportunityCostPerUnit = finiteNonNegative(input.transportOpportunityCostPerUnit);
  const reasons = [];
  if (feeRate == null || feeRate > 1) reasons.push('contract fee rate is UNKNOWN');
  if (fixedCost == null) reasons.push('fixed cost is UNKNOWN');
  if (transportPerItem == null || transportAvailable == null || transportOpportunityCostPerUnit == null) {
    reasons.push('transport economics are UNKNOWN');
  }
  if (reasons.length > 0) return { ok: false, reasons };
  const transportRequired = quantity * transportPerItem;
  if (transportRequired > transportAvailable) reasons.push('Transport is insufficient');
  const gross = price * quantity;
  const fee = gross * feeRate;
  const transportOpportunityCost = transportRequired * transportOpportunityCostPerUnit;

  if (terms.ourSide === 'sell') {
    const onHand = finiteNonNegative(input.onHandAmount);
    const blocked = finiteNonNegative(input.blockedAmount);
    const reserve = finiteNonNegative(input.reserveAmount);
    const unitCost = finiteNonNegative(input.unitCost);
    const alternative = finiteNonNegative(input.alternativeSellNetPerUnit);
    if ([onHand, blocked, reserve, unitCost, alternative].some(value => value == null)) {
      reasons.push('inventory, reserve, unit cost, or opportunity cost is UNKNOWN');
      return { ok: false, reasons };
    }
    const sellable = Math.max(0, Math.floor(onHand - blocked - reserve));
    if (quantity > sellable) reasons.push('quantity exceeds verified sellable inventory');
    const netCashProceeds = gross - fee - fixedCost;
    const accountingProfit = netCashProceeds - unitCost * quantity - transportOpportunityCost;
    const opportunityGain = netCashProceeds - alternative * quantity - transportOpportunityCost;
    if (!(accountingProfit > 0)) reasons.push('accounting profit is not positive');
    if (!(opportunityGain > 0)) reasons.push('gain versus the best verified alternative is not positive');
    return {
      ok: reasons.length === 0,
      reasons,
      metrics: {
        gross: round(gross),
        fee: round(fee),
        fixedCost,
        transportRequired: round(transportRequired),
        transportOpportunityCost: round(transportOpportunityCost),
        netCashProceeds: round(netCashProceeds),
        accountingProfit: round(accountingProfit),
        opportunityGain: round(opportunityGain),
        sellable,
      },
    };
  }

  const valuePerUnit = finiteNonNegative(input.buyUseValuePerUnit);
  const buyNeedAmount = finiteNonNegative(input.buyNeedAmount);
  const warehouseFreeAmount = finiteNonNegative(input.warehouseFreeAmount);
  const cashAvailable = finiteNonNegative(input.cashAvailable);
  const cashReserve = finiteNonNegative(input.cashReserve);
  if ([valuePerUnit, buyNeedAmount, warehouseFreeAmount, cashAvailable, cashReserve]
    .some(value => value == null)) {
    reasons.push('buy value, need, warehouse, cash, or cash reserve is UNKNOWN');
    return { ok: false, reasons };
  }
  if (quantity > buyNeedAmount) reasons.push('quantity exceeds verified business need');
  if (quantity > warehouseFreeAmount) reasons.push('warehouse capacity is insufficient');
  const landedCost = gross + fee + fixedCost + transportOpportunityCost;
  const spendableCash = Math.max(0, cashAvailable - cashReserve);
  if (landedCost > spendableCash) reasons.push('spendable cash after reserve is insufficient');
  const opportunityGain = valuePerUnit * quantity - landedCost;
  if (!(opportunityGain > 0)) reasons.push('purchase value net of all costs is not positive');
  return {
    ok: reasons.length === 0,
    reasons,
    metrics: {
      gross: round(gross),
      fee: round(fee),
      fixedCost,
      transportRequired: round(transportRequired),
      transportOpportunityCost: round(transportOpportunityCost),
      landedCost: round(landedCost),
      spendableCash: round(spendableCash),
      opportunityGain: round(opportunityGain),
    },
  };
}

function validateExplicitAgreement(agreement, terms, nowMs, maxAgeMs) {
  if (!agreement || typeof agreement !== 'object' || Array.isArray(agreement)
    || agreement.schemaVersion !== 1 || agreement.status !== 'explicit') {
    return { ok: false, reason: 'accepting a contract requires explicit exact-term agreement evidence' };
  }
  const agreementMs = parseTime(agreement.observedAt);
  if (agreementMs == null || nowMs - agreementMs > maxAgeMs || nowMs - agreementMs < -MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'agreement evidence is stale or invalid' };
  }
  if (agreement.counterpartyCompanyId !== terms.counterpartyCompanyId
    || agreement.termsHash !== contractTermsHash(terms)
    || typeof agreement.sourceMessageId !== 'string' || !agreement.sourceMessageId) {
    return { ok: false, reason: 'agreement evidence does not match immutable terms and counterparty' };
  }
  return { ok: true, sourceMessageId: agreement.sourceMessageId, observedAt: agreement.observedAt };
}

function relevantIdempotencyRecord(records, key) {
  if (!Array.isArray(records)) throw new TypeError('idempotencyRecords must be an array');
  return records.find(record => record?.idempotencyKey === key
    && ['authorized', 'click-attempted', 'confirmed', 'ambiguous', 'succeeded'].includes(record.status)) || null;
}

function economicFingerprintPayload(evaluation, candidateEconomics) {
  return {
    snapshotId: evaluation.snapshotId,
    snapshotObservedAt: evaluation.snapshotObservedAt,
    market: evaluation.market,
    resolvedUnitPrice: evaluation.resolvedUnitPrice,
    maxNegotiableQuantity: evaluation.maxNegotiableQuantity,
    economicsInputs: evaluation.economicsInputs,
    candidateMetrics: candidateEconomics.metrics,
  };
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    status: 'blocked',
    mutationAuthorized: false,
    doNotClick: true,
    reason,
    ...extra,
  };
}

function buildPreview({ operation, terms, evaluation, candidateEconomics, nowMs, maxAgeMs, agreement }) {
  const termsHash = contractTermsHash(terms);
  const idempotencyKey = digest({
    operation,
    counterpartyCompanyId: terms.counterpartyCompanyId,
    sourceMessageId: evaluation.messageId,
    termsHash,
  });
  const expiresMs = Math.min(
    parseTime(evaluation.snapshotObservedAt) + maxAgeMs,
    parseTime(evaluation.evaluatedAt) + maxAgeMs,
  );
  const economicFingerprint = digest(economicFingerprintPayload(evaluation, candidateEconomics));
  const base = {
    schemaVersion: CONTRACT_GATE_SCHEMA_VERSION,
    operation,
    terms,
    termsHash,
    idempotencyKey,
    offerId: evaluation.offerId,
    sourceMessageId: evaluation.messageId,
    snapshotId: evaluation.snapshotId,
    snapshotObservedAt: evaluation.snapshotObservedAt,
    economicFingerprint,
    agreementSourceMessageId: agreement?.sourceMessageId ?? null,
    previewedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };
  return Object.freeze({
    ...base,
    previewId: digest(base),
  });
}

function validatePreviewArtifact(preview, operation, terms, evaluation, candidateEconomics, agreement, nowMs) {
  if (!preview || typeof preview !== 'object' || preview.schemaVersion !== CONTRACT_GATE_SCHEMA_VERSION) {
    return { ok: false, reason: 'a valid preview artifact is required' };
  }
  const { previewId, ...base } = preview;
  if (previewId !== digest(base)) return { ok: false, reason: 'preview artifact integrity failed' };
  if (preview.operation !== operation || preview.termsHash !== contractTermsHash(terms)
    || digest(preview.terms) !== digest(terms)) {
    return { ok: false, reason: 'contract terms changed after preview' };
  }
  if (preview.offerId !== evaluation.offerId || preview.sourceMessageId !== evaluation.messageId
    || preview.snapshotId !== evaluation.snapshotId
    || preview.snapshotObservedAt !== evaluation.snapshotObservedAt) {
    return { ok: false, reason: 'economic evidence changed after preview' };
  }
  if (preview.economicFingerprint !== digest(economicFingerprintPayload(evaluation, candidateEconomics))) {
    return { ok: false, reason: 'contract economics changed after preview' };
  }
  if (preview.agreementSourceMessageId !== (agreement?.sourceMessageId ?? null)) {
    return { ok: false, reason: 'agreement evidence changed after preview' };
  }
  const expiresMs = parseTime(preview.expiresAt);
  if (expiresMs == null || nowMs > expiresMs) return { ok: false, reason: 'contract preview expired' };
  return { ok: true };
}

/**
 * Pure preview/confirm guard. It never clicks, sends, accepts, or calls a browser/API.
 */
function evaluateContractGate({
  mode,
  operation,
  confirm,
  terms: rawTerms,
  leadEvaluation,
  preview = null,
  agreementEvidence = null,
  idempotencyRecords = [],
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
}) {
  if (!['preview', 'confirm'].includes(mode)) throw new TypeError('mode must be preview or confirm');
  if (!['send', 'accept'].includes(operation)) throw new TypeError('operation must be send or accept');
  if (mode === 'preview' && confirm !== false) return blocked('preview requires literal confirm:false');
  if (mode === 'confirm' && confirm !== true) return blocked('confirmation requires literal confirm:true');
  const terms = normalizeTerms(rawTerms);
  const nowMs = parseNow(now);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new TypeError('maxAgeMs must be positive');
  const binding = validateEvaluationBinding(leadEvaluation, terms, nowMs, maxAgeMs);
  if (!binding.ok) return blocked(binding.reasons.join('; '));
  const economics = evaluateCandidateEconomics(leadEvaluation, terms);
  if (!economics.ok) return blocked(economics.reasons.join('; '), { economics: economics.metrics ?? null });
  const agreement = operation === 'accept'
    ? validateExplicitAgreement(agreementEvidence, terms, nowMs, maxAgeMs)
    : { ok: true, sourceMessageId: null };
  if (!agreement.ok) return blocked(agreement.reason);

  const candidatePreview = buildPreview({
    operation,
    terms,
    evaluation: leadEvaluation,
    candidateEconomics: economics,
    nowMs,
    maxAgeMs,
    agreement,
  });
  const prior = relevantIdempotencyRecord(idempotencyRecords, candidatePreview.idempotencyKey);
  if (prior) {
    return blocked('idempotency key was already authorized or clicked; do not retry', {
      doNotRetry: true,
      priorStatus: prior.status,
      idempotencyKey: candidatePreview.idempotencyKey,
    });
  }
  if (mode === 'preview') {
    return {
      ok: true,
      status: 'preview-approved',
      mutationAuthorized: false,
      doNotClick: true,
      preview: candidatePreview,
      economics: economics.metrics,
    };
  }

  const preClickFailure = idempotencyRecords.find(record => (
    record?.idempotencyKey === candidatePreview.idempotencyKey
    && record.status === 'failed-before-click'
  ));
  if (preClickFailure && (!preClickFailure.previewId || preClickFailure.previewId === preview?.previewId)) {
    return blocked('a proven pre-click failure requires a new preview before retrying', {
      doNotRetry: false,
      idempotencyKey: candidatePreview.idempotencyKey,
    });
  }

  const previewValidation = validatePreviewArtifact(
    preview,
    operation,
    terms,
    leadEvaluation,
    economics,
    agreement,
    nowMs,
  );
  if (!previewValidation.ok) return blocked(previewValidation.reason);
  return {
    ok: true,
    status: 'confirm-authorized',
    mutationAuthorized: true,
    doNotClick: false,
    authorization: {
      schemaVersion: CONTRACT_GATE_SCHEMA_VERSION,
      previewId: preview.previewId,
      idempotencyKey: preview.idempotencyKey,
      termsHash: preview.termsHash,
      snapshotId: preview.snapshotId,
      maxClicks: 1,
      retryAfterAmbiguous: false,
      authorizedAt: new Date(nowMs).toISOString(),
      expiresAt: preview.expiresAt,
    },
    economics: economics.metrics,
  };
}

function assessContractClickOutcome({
  idempotencyKey,
  clickCount,
  exactTransitionCount = 0,
  exactTermsObserved = false,
  failureStage = null,
}) {
  if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{64}$/u.test(idempotencyKey)) {
    throw new TypeError('a valid idempotencyKey is required');
  }
  if (!Number.isSafeInteger(clickCount) || clickCount < 0
    || !Number.isSafeInteger(exactTransitionCount) || exactTransitionCount < 0) {
    throw new TypeError('click and transition counts must be non-negative integers');
  }
  if (clickCount === 0 && failureStage === 'pre-click') {
    return {
      idempotencyKey,
      status: 'failed-before-click',
      clicked: false,
      retryAllowedWithNewPreview: true,
      doNotRetry: false,
    };
  }
  if (clickCount === 0) {
    return {
      idempotencyKey,
      status: 'not-clicked',
      clicked: false,
      retryAllowedWithNewPreview: false,
      doNotRetry: false,
    };
  }
  if (clickCount === 1 && exactTransitionCount === 1 && exactTermsObserved === true) {
    return {
      idempotencyKey,
      status: 'confirmed',
      clicked: true,
      retryAllowedWithNewPreview: false,
      doNotRetry: true,
    };
  }
  return {
    idempotencyKey,
    status: clickCount > 1 ? 'protocol-violation' : 'ambiguous',
    clicked: true,
    retryAllowedWithNewPreview: false,
    doNotRetry: true,
    reason: clickCount > 1
      ? 'more than one click was attempted'
      : 'single-click outcome is not exactly proven; never replay it',
  };
}

module.exports = {
  CONTRACT_GATE_SCHEMA_VERSION,
  TERM_KEYS,
  assessContractClickOutcome,
  contractTermsHash,
  evaluateCandidateEconomics,
  evaluateContractGate,
  normalizeTerms,
};
