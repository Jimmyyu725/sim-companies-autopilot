'use strict';

const crypto = require('node:crypto');

const CONTRACT_UI_SCHEMA_VERSION = 1;
const INCOMING_CONTRACTS_PATH = '/headquarters/warehouse/incoming-contracts/';
const SUPPORTED_ROUTE_LOCALES = Object.freeze([
  'cs', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'tr', 'zh-cn', 'zh-tw',
]);
const ACCEPTANCE_DOM_STATUS = 'DISABLED_UNTIL_EXACT_CONTRACT_ID_IS_RENDERED_AND_LIVE_PROBED';
const ENGLISH_ACCEPT_ARIA_LABEL = 'Sign contract';
const HEX_64 = /^[0-9a-f]{64}$/u;
const CONTRACT_ID = /^[1-9][0-9]{0,24}$/u;

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u00a0\u202f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex');
}

function canonicalContractId(value) {
  const text = normalizeText(value);
  return CONTRACT_ID.test(text) ? text : null;
}

function canonicalPositiveDecimal(value) {
  const text = normalizeText(value).replace(/,/gu, '');
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text)) return null;
  const [integerRaw, fractionRaw = ''] = text.split('.');
  const integer = integerRaw.replace(/^0+(?=\d)/u, '') || '0';
  const fraction = fractionRaw.replace(/0+$/u, '');
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  return Number(canonical) > 0 ? canonical : null;
}

function safePositiveInteger(value) {
  if (typeof value === 'boolean' || value == null || value === '') return null;
  const number = Number(String(value).replace(/,/gu, ''));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function expectedBundleTotal(quantity, unitPrice) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
  const price = canonicalPositiveDecimal(unitPrice);
  if (!price) return null;
  const [whole, fraction = ''] = price.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const priceInteger = BigInt(`${whole}${fraction}`);
  const rawNumerator = BigInt(quantity) * priceInteger;
  const thousandths = (rawNumerator * 1000n) / scale;
  const displayed = (thousandths + 999n) / 1000n;
  return displayed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(displayed) : null;
}

function parseIncomingContractsRoute(value) {
  let url;
  try {
    url = new URL(String(value), 'https://www.simcompanies.com');
  } catch (_) {
    return null;
  }
  const path = url.pathname.replace(/\/{2,}/gu, '/');
  if (path === INCOMING_CONTRACTS_PATH) {
    return { locale: 'en', pathname: path, canonicalPath: INCOMING_CONTRACTS_PATH };
  }
  const match = path.match(/^\/([^/]+)(\/headquarters\/warehouse\/incoming-contracts\/)$/u);
  if (!match || !SUPPORTED_ROUTE_LOCALES.includes(match[1])) return null;
  return { locale: match[1], pathname: path, canonicalPath: match[2] };
}

/**
 * Parses the exact English aria-label emitted by the measured contract-row component.
 * Localized or structurally changed labels deliberately fail closed.
 */
function parseIncomingContractAriaLabel(value) {
  const ariaLabel = normalizeText(value);
  const number = '[0-9][0-9,]*(?:\\.[0-9]+)?';
  const expression = new RegExp(
    `^incoming contract, (${number}) (.+?) quality ([0-9]+), at \\$(${number}) per unit, `
      + `total price \\$(${number}), from (.+)$`,
    'iu',
  );
  const match = ariaLabel.match(expression);
  if (!match) return { ok: false, unsupported: true, reason: 'unsupported or localized incoming-contract aria-label' };
  const quantity = safePositiveInteger(match[1]);
  const resourceName = normalizeText(match[2]);
  const quality = Number(match[3]);
  const unitPrice = canonicalPositiveDecimal(match[4]);
  const totalPrice = safePositiveInteger(match[5]);
  const sellerCompany = normalizeText(match[6]);
  if (!quantity || !resourceName || !Number.isSafeInteger(quality) || quality < 0
    || !unitPrice || !totalPrice || !sellerCompany) {
    return { ok: false, unsupported: true, reason: 'incoming-contract aria-label contains incomplete terms' };
  }
  const expectedTotal = expectedBundleTotal(quantity, unitPrice);
  if (expectedTotal == null || expectedTotal !== totalPrice) {
    return {
      ok: false,
      unsupported: true,
      reason: 'rendered total does not match the measured bundle total formula',
      renderedTotal: totalPrice,
      expectedTotal,
    };
  }
  return {
    ok: true,
    ariaLabel,
    quantity,
    resourceName,
    quality,
    unitPrice,
    totalPrice,
    sellerCompany,
  };
}

function explicitPositiveInteger(value, status) {
  if (status !== 'EXPLICIT_DOM_ATTRIBUTE') return null;
  return safePositiveInteger(value);
}

function normalizeIncomingRowEvidence(record, { ownCompany = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'incoming contract row evidence must be an object' };
  }
  const parsed = parseIncomingContractAriaLabel(record.ariaLabel);
  if (!parsed.ok) return parsed;
  const groupedCount = safePositiveInteger(record.groupedCount ?? 1);
  const acceptControlCount = Number(record.acceptControlCount ?? 0);
  if (!groupedCount || !Number.isSafeInteger(acceptControlCount) || acceptControlCount < 0) {
    return { ok: false, reason: 'row grouping or accept-control evidence is malformed' };
  }
  const contractId = record.contractIdStatus === 'EXPLICIT_DOM_ATTRIBUTE'
    ? canonicalContractId(record.contractId)
    : null;
  const resourceKind = explicitPositiveInteger(record.resourceKind, record.resourceKindStatus);
  const counterpartyCompanyId = record.counterpartyCompanyIdStatus === 'EXPLICIT_DOM_ATTRIBUTE'
    ? canonicalContractId(record.counterpartyCompanyId)
    : null;
  const buyerCompany = normalizeText(ownCompany) || null;
  const row = {
    schemaVersion: CONTRACT_UI_SCHEMA_VERSION,
    direction: 'incoming',
    status: 'pending-rendered',
    contractId,
    contractIdStatus: contractId ? 'EXPLICIT_DOM_ATTRIBUTE' : 'UNAVAILABLE_IN_RENDERED_DOM',
    groupedCount,
    sellerCompany: parsed.sellerCompany,
    sellerCompanyId: counterpartyCompanyId,
    sellerCompanyIdStatus: counterpartyCompanyId ? 'EXPLICIT_DOM_ATTRIBUTE' : 'UNAVAILABLE_IN_RENDERED_DOM',
    buyerCompany,
    buyerCompanyStatus: buyerCompany ? 'CALLER_BOUND_CURRENT_COMPANY' : 'CURRENT_COMPANY_NOT_RENDERED_IN_ROW',
    ourSide: 'buy',
    resourceName: parsed.resourceName,
    resourceKind,
    resourceKindStatus: resourceKind ? 'EXPLICIT_DOM_ATTRIBUTE' : 'UNAVAILABLE_IN_RENDERED_DOM',
    quality: parsed.quality,
    quantity: parsed.quantity,
    unitPrice: parsed.unitPrice,
    totalPrice: parsed.totalPrice,
    totalFormulaStatus: 'VERIFIED_BUNDLE_FORMULA',
    acceptControlCount,
    acceptControlAriaLabel: normalizeText(record.acceptControlAriaLabel) || null,
    needsConfirmation: typeof record.needsConfirmation === 'boolean' ? record.needsConfirmation : null,
    needsConfirmationStatus: typeof record.needsConfirmation === 'boolean'
      ? 'EXPLICIT_DOM_EVIDENCE'
      : 'UNAVAILABLE_IN_RENDERED_DOM',
    ariaLabel: parsed.ariaLabel,
    resourceImageSrc: normalizeText(record.resourceImageSrc) || null,
    counterpartyHref: normalizeText(record.counterpartyHref) || null,
  };
  return { ok: true, row: { ...row, evidenceFingerprint: sha256(row) } };
}

function normalizeIncomingRows(records, options = {}) {
  if (!Array.isArray(records)) return { ok: false, reason: 'incoming rows must be an array' };
  const rows = [];
  const ids = new Set();
  for (const record of records) {
    const normalized = normalizeIncomingRowEvidence(record, options);
    if (!normalized.ok) return normalized;
    const { row } = normalized;
    if (row.contractId) {
      if (ids.has(row.contractId)) return { ok: false, reason: `duplicate rendered contract ID ${row.contractId}` };
      ids.add(row.contractId);
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

function previewBlocked(reason, extra = {}) {
  return {
    ok: false,
    status: 'unsupported',
    mutationAuthorized: false,
    doNotClick: true,
    reason,
    ...extra,
  };
}

function buildIncomingContractPreview({
  contractId: rawContractId,
  rows: rawRows,
  ownCompany,
  termsHash,
  observedAt = new Date().toISOString(),
} = {}) {
  const contractId = canonicalContractId(rawContractId);
  if (!contractId) return previewBlocked('an exact positive contract ID is required');
  if (!HEX_64.test(String(termsHash || ''))) return previewBlocked('a valid immutable termsHash is required');
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return previewBlocked('observedAt is invalid');
  const normalized = normalizeIncomingRows(rawRows, { ownCompany });
  if (!normalized.ok) return previewBlocked(normalized.reason);
  const identified = normalized.rows.filter(row => row.contractId === contractId);
  if (identified.length !== 1) {
    const idsUnavailable = normalized.rows.length > 0
      && normalized.rows.every(row => row.contractIdStatus === 'UNAVAILABLE_IN_RENDERED_DOM');
    return previewBlocked(idsUnavailable
      ? 'rendered incoming-contract rows do not expose contract IDs; exact preview is unsupported'
      : 'exact rendered contract ID count is not one', {
      contractId,
      exactMatchCount: identified.length,
      contractIdStatus: idsUnavailable ? 'UNAVAILABLE_IN_RENDERED_DOM' : 'AMBIGUOUS_OR_MISSING',
    });
  }
  const row = identified[0];
  if (row.groupedCount !== 1) return previewBlocked('the UI grouped multiple contracts into one row');
  if (!row.buyerCompany) return previewBlocked('the current company is not proven for the buyer side');
  if (!row.sellerCompanyId) return previewBlocked('counterparty company ID is not explicit in rendered DOM');
  if (!row.resourceKind) return previewBlocked('resource kind ID is not explicit in rendered DOM');
  if (row.acceptControlCount !== 1 || row.acceptControlAriaLabel !== ENGLISH_ACCEPT_ARIA_LABEL) {
    return previewBlocked('one exact Sign contract control was not proven');
  }
  if (row.needsConfirmation == null) {
    return previewBlocked('the UI does not expose whether accepting requires a second confirmation dialog');
  }
  const renderedTerms = {
    counterpartyCompanyId: row.sellerCompanyId,
    ourSide: 'buy',
    quality: row.quality,
    quantity: row.quantity,
    resourceKind: row.resourceKind,
    unitPrice: row.unitPrice,
  };
  if (sha256(renderedTerms) !== termsHash) {
    return previewBlocked('termsHash is not bound to the exact rendered contract terms');
  }
  const base = {
    schemaVersion: CONTRACT_UI_SCHEMA_VERSION,
    operation: 'accept',
    confirm: false,
    contractId,
    terms: renderedTerms,
    termsHash,
    evidenceFingerprint: row.evidenceFingerprint,
    observedAt: new Date(observedMs).toISOString(),
    row,
  };
  return {
    ok: true,
    status: 'preview-only',
    mutationAuthorized: false,
    doNotClick: true,
    preview: Object.freeze({ ...base, previewId: sha256(base) }),
  };
}

function validateAcceptanceBinding({
  confirm,
  contractId: rawContractId,
  termsHash,
  evidenceFingerprint,
  preview,
  authorization,
  currentRow,
  now = Date.now(),
} = {}) {
  if (confirm !== true) return previewBlocked('acceptance requires literal confirm:true');
  const contractId = canonicalContractId(rawContractId);
  if (!contractId) return previewBlocked('an exact contract ID is required');
  if (!HEX_64.test(String(termsHash || '')) || !HEX_64.test(String(evidenceFingerprint || ''))) {
    return previewBlocked('valid terms and evidence fingerprints are required');
  }
  if (!preview || preview.schemaVersion !== CONTRACT_UI_SCHEMA_VERSION || preview.confirm !== false
    || preview.operation !== 'accept') {
    return previewBlocked('a valid confirm:false UI preview is required');
  }
  const { previewId, ...previewBase } = preview;
  if (previewId !== sha256(previewBase)) return previewBlocked('UI preview artifact integrity failed');
  if (preview.contractId !== contractId || preview.termsHash !== termsHash
    || preview.evidenceFingerprint !== evidenceFingerprint) {
    return previewBlocked('contract ID, terms, or UI evidence changed after preview');
  }
  if (!authorization || authorization.previewId !== preview.previewId
    || authorization.termsHash !== termsHash || authorization.maxClicks !== 1
    || authorization.retryAfterAmbiguous !== false || !HEX_64.test(String(authorization.idempotencyKey || ''))) {
    return previewBlocked('contract-gate authorization is missing or not bound to this preview');
  }
  const expiryMs = Date.parse(authorization.expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs) || nowMs > expiryMs) {
    return previewBlocked('acceptance authorization is expired or invalid');
  }
  const normalized = normalizeIncomingRowEvidence(currentRow, { ownCompany: preview.row.buyerCompany });
  if (!normalized.ok) return previewBlocked(normalized.reason);
  if (normalized.row.contractId !== contractId
    || normalized.row.evidenceFingerprint !== evidenceFingerprint) {
    return previewBlocked('current rendered contract evidence differs from preview');
  }
  return previewBlocked(
    'acceptance remains disabled: the current bundle does not render an exact contract ID or a proven one-click confirmation path',
    { acceptanceDomStatus: ACCEPTANCE_DOM_STATUS },
  );
}

function assessAcceptClickOutcome({
  contractId: rawContractId,
  clickCount,
  beforeFingerprint,
  afterContractIds,
  successAcknowledgementCount,
} = {}) {
  const contractId = canonicalContractId(rawContractId);
  if (!contractId || !HEX_64.test(String(beforeFingerprint || ''))) {
    throw new TypeError('exact contract ID and evidence fingerprint are required');
  }
  if (!Number.isSafeInteger(clickCount) || clickCount < 0
    || !Number.isSafeInteger(successAcknowledgementCount) || successAcknowledgementCount < 0
    || !Array.isArray(afterContractIds)) {
    throw new TypeError('accept outcome evidence is malformed');
  }
  if (clickCount === 0) return { ok: false, clicked: false, doNotRetry: false, status: 'not-clicked' };
  const normalizedAfter = afterContractIds.map(canonicalContractId);
  const exactAbsent = normalizedAfter.every(id => id && id !== contractId);
  if (clickCount === 1 && exactAbsent && successAcknowledgementCount === 1) {
    return { ok: true, clicked: true, doNotRetry: true, status: 'accepted-verified' };
  }
  return {
    ok: false,
    clicked: true,
    doNotRetry: true,
    status: clickCount > 1 ? 'protocol-violation' : 'ambiguous',
    reason: clickCount > 1
      ? 'more than one acceptance click was attempted'
      : 'the exact accepted-contract transition was not proven; never replay',
  };
}

module.exports = {
  ACCEPTANCE_DOM_STATUS,
  CONTRACT_UI_SCHEMA_VERSION,
  ENGLISH_ACCEPT_ARIA_LABEL,
  INCOMING_CONTRACTS_PATH,
  assessAcceptClickOutcome,
  buildIncomingContractPreview,
  canonicalContractId,
  expectedBundleTotal,
  normalizeIncomingRowEvidence,
  normalizeIncomingRows,
  normalizeText,
  parseIncomingContractAriaLabel,
  parseIncomingContractsRoute,
  sha256,
  validateAcceptanceBinding,
};
