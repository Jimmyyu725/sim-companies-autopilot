'use strict';

const crypto = require('node:crypto');
const { executionBindingHash } = require('./execution-claim.js');
const {
  contractTermsHash,
  evaluateContractGate,
} = require('./contract-gate.js');
const { evaluateLeadOpportunity } = require('./lead-engine.js');

const DEFAULT_OPERATION_TIMEOUT_MS = 30 * 1000;
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CONTRACTS_PER_CYCLE = 20;
const ACTIVE_STATES = new Set(['ARMED', 'CONFIRMING', 'VERIFIED', 'AMBIGUOUS']);

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalDecimal(value) {
  const text = String(value ?? '').trim().replace(/,/gu, '');
  if (!/^\d+(?:\.\d+)?$/u.test(text) || !(Number(text) > 0)) return null;
  const [wholeRaw, fractionRaw = ''] = text.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/u, '') || '0';
  const fraction = fractionRaw.replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function positiveId(value) {
  const text = String(value ?? '').trim();
  return /^[1-9][0-9]{0,24}$/u.test(text) ? text : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeIncomingRow(row, listObservedAt) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const contractId = positiveId(row.contractId);
  const resourceKind = positiveInteger(row.resourceKind);
  const sellerCompanyId = positiveId(row.sellerCompanyId);
  const buyerCompanyId = positiveId(row.buyerCompanyId);
  const quality = Number(row.quality);
  const quantity = positiveInteger(row.quantity);
  const unitPrice = canonicalDecimal(row.unitPrice);
  const resourceName = String(row.resourceName ?? '').normalize('NFKC').trim();
  const sellerCompany = String(row.sellerCompany ?? '').normalize('NFKC').trim();
  const observedAt = String(row.observedAt || listObservedAt || '');
  if (!contractId || !resourceKind || !sellerCompanyId || !buyerCompanyId
      || row.contractIdStatus !== 'VERIFIED_REACT_RENDER_BINDING'
      || row.resourceKindStatus !== 'VERIFIED_REACT_RENDER_BINDING'
      || row.sellerCompanyIdStatus !== 'VERIFIED_REACT_RENDER_BINDING'
      || row.needsConfirmationStatus !== 'VERIFIED_REACT_RENDER_BINDING'
      || !Number.isSafeInteger(quality) || quality < 0 || !quantity || !unitPrice
      || !resourceName || resourceName.length > 160 || !sellerCompany || sellerCompany.length > 200
      || row.groupedCount !== 1 || row.acceptControlCount !== 1
      || row.acceptControlAriaLabel !== 'Sign contract'
      || typeof row.needsConfirmation !== 'boolean' || !Number.isFinite(Date.parse(observedAt))) {
    return null;
  }
  return Object.freeze({
    contractId,
    resourceKind,
    resourceName,
    quality,
    quantity,
    unitPrice,
    sellerCompanyId,
    sellerCompany,
    buyerCompanyId,
    needsConfirmation: row.needsConfirmation,
    observedAt: new Date(Date.parse(observedAt)).toISOString(),
  });
}

function buildIncomingOffer(row) {
  const messageId = `incoming-contract:${row.contractId}`;
  const offerId = hash({ messageId, contractId: row.contractId }).slice(0, 24);
  return Object.freeze({
    schemaVersion: 1,
    offerId,
    source: {
      messageId,
      conversationType: 'private',
      conversationId: 'incoming-contracts',
      counterpartyCompanyId: row.sellerCompanyId,
      counterpartyCompanyName: row.sellerCompany,
      createdAt: row.observedAt,
      observedAt: row.observedAt,
      trust: 'untrusted-external',
    },
    instructionAuthority: 'none',
    counterpartySide: 'sell',
    ourSide: 'buy',
    resource: {
      status: 'known',
      kind: row.resourceKind,
      name: row.resourceName,
      iconToken: `:re-${row.resourceKind}:`,
    },
    quantity: { status: 'known', amount: row.quantity, upperBound: false },
    quality: { status: 'known', value: row.quality },
    price: { status: 'known', type: 'absolute', amount: Number(row.unitPrice), decimal: row.unitPrice },
    evidence: [{ field: 'contract', raw: row.contractId, source: 'rendered-incoming-contract-row' }],
    unknowns: [],
    complete: true,
    autoActionAuthorized: false,
  });
}

function buildEconomicDecision(row, businessSnapshot, nowMs) {
  const terms = Object.freeze({
    counterpartyCompanyId: row.sellerCompanyId,
    ourSide: 'buy',
    quality: row.quality,
    quantity: row.quantity,
    resourceKind: row.resourceKind,
    unitPrice: row.unitPrice,
  });
  const offer = buildIncomingOffer(row);
  const leadEvaluation = evaluateLeadOpportunity(offer, businessSnapshot, { now: nowMs });
  const agreementEvidence = Object.freeze({
    schemaVersion: 1,
    status: 'explicit',
    observedAt: row.observedAt,
    counterpartyCompanyId: row.sellerCompanyId,
    termsHash: contractTermsHash(terms),
    sourceMessageId: offer.source.messageId,
  });
  const gatePreview = evaluateContractGate({
    mode: 'preview',
    operation: 'accept',
    confirm: false,
    terms,
    leadEvaluation,
    agreementEvidence,
    idempotencyRecords: [],
    now: nowMs,
  });
  return { terms, offer, leadEvaluation, agreementEvidence, gatePreview };
}

function classificationFor(result, row) {
  const expectedClicks = row.needsConfirmation ? 2 : 1;
  if (result?.ok === true && result.accepted === true && result.status === 'VERIFIED'
      && result.contractId === row.contractId && result.termsHash === contractTermsHash({
        counterpartyCompanyId: row.sellerCompanyId,
        ourSide: 'buy',
        quality: row.quality,
        quantity: row.quantity,
        resourceKind: row.resourceKind,
        unitPrice: row.unitPrice,
      })
      && result.exactRowAbsent === true && result.clickCount === expectedClicks) {
    return { state: 'VERIFIED', outcomeCode: 'exact-contract-ui-postcondition', verified: true };
  }
  if (result?.clickCount === 0 && result?.mutationAttempted !== true
      && result?.ambiguous !== true) {
    return { state: 'FAILED_PRE_CLICK', outcomeCode: 'contract-pre-click-failed', verified: false };
  }
  return { state: 'AMBIGUOUS', outcomeCode: 'contract-acceptance-unproven', verified: false };
}

async function runIncomingContractCycle(options = {}) {
  const {
    actionRunner,
    businessSnapshot,
    store,
    permissionGuard,
  } = options;
  if (typeof actionRunner !== 'function' || !businessSnapshot || !store
      || typeof permissionGuard !== 'function') {
    throw new TypeError('incoming contract cycle requires runner, snapshot, store, and permission guard');
  }
  const mode = String(options.mode || 'shadow');
  const clock = options.clock || Date.now;
  const deadlineAtMs = Number(options.deadlineAtMs ?? (Number(clock()) + 4 * 60 * 1000));
  const operationTimeoutMs = Number(options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
  const rateWindowMs = Number(options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS);
  const maxAttemptsPerWindow = Number(options.maxAttemptsPerWindow ?? 1);
  const control = async (label, mutation) => {
    const permission = await permissionGuard({ label, mode, mutation });
    const remaining = deadlineAtMs - Number(clock());
    if (permission?.ok !== true || permission.brainLockHeld !== true
        || permission.tickLockHeld !== true || (mutation && permission.mutationAllowed !== true)
        || !Number.isFinite(remaining) || remaining <= 0) return null;
    return Object.freeze({ timeoutMs: Math.max(1, Math.floor(Math.min(operationTimeoutMs, remaining))) });
  };
  const result = {
    ok: true,
    mode,
    listed: 0,
    eligible: 0,
    previews: 0,
    confirmAttempts: 0,
    outcomes: [],
    errors: [],
  };
  const listControl = await control('incoming-contract-list', false);
  if (!listControl) return { ...result, ok: false, reason: 'permission-or-deadline' };
  let listed;
  try {
    listed = await actionRunner('chat_contract_list', { limit: MAX_CONTRACTS_PER_CYCLE }, listControl);
  } catch {
    return { ...result, ok: false, errors: ['contract-list-failed'] };
  }
  if (listed?.ok !== true || !Array.isArray(listed.rows) || listed.complete !== true) {
    return { ...result, ok: false, errors: ['contract-list-incomplete'] };
  }
  result.listed = listed.rows.length;
  if (mode === 'read-only' || mode === 'off' || listed.rows.length === 0) return result;

  for (const rawRow of listed.rows) {
    const row = normalizeIncomingRow(rawRow, listed.observedAt);
    if (!row) {
      result.errors.push('contract-row-identity-incomplete');
      continue;
    }
    const sourceKey = `contract:${row.contractId}`;
    let sourceState;
    try { sourceState = await store.getSourceState(sourceKey); }
    catch {
      result.errors.push('contract-source-state-unavailable');
      continue;
    }
    if (ACTIVE_STATES.has(sourceState)) continue;
    const nowMs = Number(clock());
    let decision;
    try { decision = buildEconomicDecision(row, businessSnapshot, nowMs); }
    catch {
      result.errors.push('contract-economics-evaluation-failed');
      continue;
    }
    if (decision.gatePreview?.ok !== true) {
      result.errors.push('contract-economics-refused');
      continue;
    }
    result.eligible += 1;
    const termsHash = contractTermsHash(decision.terms);
    const previewControl = await control('incoming-contract-preview', false);
    if (!previewControl) return { ...result, ok: false, reason: 'permission-or-deadline' };
    let uiPreviewResult;
    try {
      uiPreviewResult = await actionRunner('chat_contract_preview', {
        contractId: row.contractId,
        ownCompanyId: row.buyerCompanyId,
        terms: decision.terms,
        termsHash,
        confirm: false,
      }, previewControl);
    } catch {
      result.errors.push('contract-ui-preview-failed');
      continue;
    }
    if (uiPreviewResult?.ok !== true || uiPreviewResult?.preview?.contractId !== row.contractId
        || uiPreviewResult.preview.termsHash !== termsHash
        || !/^[0-9a-f]{64}$/u.test(String(uiPreviewResult.preview.previewId || ''))
        || !/^[0-9a-f]{64}$/u.test(String(uiPreviewResult.preview.evidenceFingerprint || ''))) {
      result.errors.push('contract-ui-preview-mismatch');
      continue;
    }
    result.previews += 1;
    if (mode !== 'full') continue;
    let rateCount;
    try { rateCount = await store.countConfirmAttemptsSince(nowMs - rateWindowMs); }
    catch {
      result.errors.push('contract-rate-state-unavailable');
      continue;
    }
    if (!Number.isSafeInteger(rateCount) || rateCount >= maxAttemptsPerWindow) {
      result.errors.push('contract-confirm-rate-limit');
      continue;
    }
    const gateConfirmation = evaluateContractGate({
      mode: 'confirm',
      operation: 'accept',
      confirm: true,
      terms: decision.terms,
      leadEvaluation: decision.leadEvaluation,
      preview: decision.gatePreview.preview,
      agreementEvidence: decision.agreementEvidence,
      idempotencyRecords: [],
      now: Number(clock()),
    });
    if (gateConfirmation?.ok !== true || gateConfirmation.mutationAuthorized !== true) {
      result.errors.push('contract-confirm-gate-refused');
      continue;
    }
    const attemptId = `contract-accept:${hash({
      contractId: row.contractId,
      termsHash,
      economicPreviewId: decision.gatePreview.preview.previewId,
      uiPreviewId: uiPreviewResult.preview.previewId,
    }).slice(0, 40)}`;
    const authorization = Object.freeze({
      schemaVersion: 1,
      attemptId,
      economicPreviewId: decision.gatePreview.preview.previewId,
      uiPreviewId: uiPreviewResult.preview.previewId,
      idempotencyKey: gateConfirmation.authorization.idempotencyKey,
      termsHash,
      maxClicks: row.needsConfirmation ? 2 : 1,
      retryAfterAmbiguous: false,
      authorizedAt: gateConfirmation.authorization.authorizedAt,
      expiresAt: gateConfirmation.authorization.expiresAt,
    });
    const actionParams = Object.freeze({
      contractId: row.contractId,
      termsHash,
      evidenceFingerprint: uiPreviewResult.preview.evidenceFingerprint,
      previewId: uiPreviewResult.preview.previewId,
      economicPreviewId: decision.gatePreview.preview.previewId,
      attemptId,
      preview: uiPreviewResult.preview,
      authorization,
      confirm: true,
    });
    const claimControl = await control('incoming-contract-claim', true);
    if (!claimControl) return { ...result, ok: false, reason: 'permission-or-deadline' };
    let claim;
    try {
      claim = await store.claimAttempt({
        schemaVersion: 1,
        attemptId,
        sourceKey,
        state: 'ARMED',
        actionName: 'contract_accept',
        contentFingerprint: termsHash,
        executionBindingHash: executionBindingHash('contract_accept', actionParams),
        snapshotId: businessSnapshot.snapshotId,
        economicAuthorization: true,
        rateLimit: {
          windowStartedAtMs: Number(clock()) - rateWindowMs,
          maxAttempts: maxAttemptsPerWindow,
        },
        armedAt: new Date(Number(clock())).toISOString(),
      }, claimControl);
    } catch {
      result.errors.push('contract-durable-claim-failed');
      continue;
    }
    if (claim?.ok !== true || claim.durable !== true
        || !/^[0-9a-f]{64}$/u.test(String(claim.executionClaimToken || ''))) {
      result.errors.push('contract-durable-claim-refused');
      continue;
    }
    const confirmControl = await control('incoming-contract-confirm', true);
    if (!confirmControl) return { ...result, ok: false, reason: 'permission-lost-after-claim' };
    result.confirmAttempts += 1;
    let confirmedResult;
    let classification;
    try {
      confirmedResult = await actionRunner('contract_accept', actionParams, {
        ...confirmControl,
        executionClaimToken: claim.executionClaimToken,
      });
      classification = classificationFor(confirmedResult, row);
      const durableState = await store.getAttemptState(attemptId);
      if (classification.state === 'VERIFIED' && durableState !== 'CONFIRMING') {
        classification = {
          state: 'AMBIGUOUS',
          outcomeCode: 'contract-execution-claim-consumption-unproven',
          verified: false,
        };
      }
    } catch {
      classification = {
        state: 'AMBIGUOUS',
        outcomeCode: 'contract-confirm-runner-failed',
        verified: false,
      };
    }
    let persisted = false;
    const completionControl = await control('incoming-contract-complete', true);
    if (completionControl) {
      try {
        const completion = await store.completeAttempt({
          attemptId,
          sourceKey,
          state: classification.state,
          outcomeCode: classification.outcomeCode,
          postconditionVerified: classification.verified,
          completedAt: new Date(Number(clock())).toISOString(),
        }, completionControl);
        persisted = completion?.ok === true && completion.durable === true;
      } catch {}
    }
    result.outcomes.push({
      contractId: row.contractId,
      attemptId,
      state: persisted ? classification.state : 'AMBIGUOUS',
      outcomeCode: persisted ? classification.outcomeCode : 'contract-outcome-persistence-unproven',
      postconditionVerified: persisted && classification.verified,
    });
    if (!persisted || classification.state === 'AMBIGUOUS') {
      result.ok = false;
      result.reason = 'ambiguous-contract-outcome';
    }
    break;
  }
  return result;
}

module.exports = {
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_RATE_WINDOW_MS,
  MAX_CONTRACTS_PER_CYCLE,
  buildEconomicDecision,
  buildIncomingOffer,
  normalizeIncomingRow,
  runIncomingContractCycle,
};
