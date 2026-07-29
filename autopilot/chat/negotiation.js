'use strict';

const { buildPublicPostPlan, KNOWN_RESOURCE_NAMES } = require('./public-ui.js');
const { inspectOutgoingText } = require('./policy.js');
const { contractTermsHash, normalizeTerms } = require('./contract-gate.js');
const { validateTrustedResourceCatalog } = require('./resource-catalog.js');

const MAX_PRIVATE_NEGOTIATION_CHARS = 140;
const FORBIDDEN_OUTPUT_WORDS = /\b(?:ai|a\.i\.|bot|assistant|robot|llm|model)\b/iu;

function formatExactQuantity(value) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError('quantity must be positive');
  if (quantity % 1_000_000 === 0) return `${quantity / 1_000_000}M`;
  if (quantity % 1_000 === 0) return `${quantity / 1_000}k`;
  return quantity.toLocaleString('en-US');
}

function trimDecimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('numeric value is invalid');
  return String(number);
}

function formatEvidencePrice(price) {
  if (!price || price.status !== 'known') throw new TypeError('known price evidence is required');
  if (price.type === 'absolute') return `@${price.decimal ?? trimDecimal(price.amount)}`;
  if (price.type === 'market-relative') {
    const delta = Number(price.deltaPercent);
    if (!Number.isFinite(delta)) throw new TypeError('MP delta is invalid');
    if (delta === 0) return '@MP';
    return `@MP${delta > 0 ? '+' : ''}${trimDecimal(delta)}%`;
  }
  throw new TypeError('unsupported price evidence type');
}

function trustedResourceSpec(kind, trustedResourceCatalog = null) {
  const numericKind = Number(kind);
  if (!Number.isSafeInteger(numericKind) || numericKind <= 0) {
    throw new TypeError('resource kind must be positive');
  }
  const builtIn = KNOWN_RESOURCE_NAMES[numericKind];
  if (builtIn) return { kind: numericKind, name: builtIn.canonical, trust: 'verified-built-in' };
  if (!validateTrustedResourceCatalog(trustedResourceCatalog)) {
    throw new Error(`resource ${numericKind} needs an internal verified catalog entry`);
  }
  const matches = trustedResourceCatalog.entries.filter(entry => Number(entry?.kind) === numericKind
    && typeof entry.name === 'string' && entry.name.trim());
  if (matches.length !== 1) throw new Error(`resource ${numericKind} catalog evidence is not unique`);
  const name = matches[0].name.trim();
  if (name.length > 120 || /[\r\n:@]/u.test(name)) throw new Error('resource catalog name is unsafe');
  return { kind: numericKind, name, trust: 'internal-verified' };
}

function assertSafeGeneratedText(text, scope) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('generated text is empty');
  if (FORBIDDEN_OUTPUT_WORDS.test(text)) throw new Error('generated negotiation contains a forbidden identity word');
  if (/\r|\n/u.test(text)) throw new Error('generated negotiation must be one line');
  if (scope === 'private' && Array.from(text).length > MAX_PRIVATE_NEGOTIATION_CHARS) {
    throw new RangeError('private negotiation is too long');
  }
  const inspection = inspectOutgoingText(text, { scope });
  if (!inspection.ok) throw new Error(`generated negotiation violates policy: ${inspection.violations.join(',')}`);
  return inspection.normalizedText;
}

function draftPublicTradePost({
  ourSide,
  resourceKind,
  quantity,
  quality,
  price,
  trustedResourceCatalog = null,
}) {
  if (!['buy', 'sell'].includes(ourSide)) throw new TypeError('ourSide must be buy or sell');
  const q = Number(quality);
  if (!Number.isSafeInteger(q) || q < 0) throw new TypeError('quality must be non-negative');
  const resource = trustedResourceSpec(resourceKind, trustedResourceCatalog);
  const quantityText = formatExactQuantity(quantity);
  const priceText = formatEvidencePrice(price);
  const parts = [
    { type: 'text', value: `${ourSide.toUpperCase()} ${quantityText} ` },
    { type: 'resource', kind: resource.kind, name: resource.name },
    { type: 'text', value: ` Q${q} ${priceText}` },
  ];
  const plan = buildPublicPostPlan(parts);
  assertSafeGeneratedText(plan.finalMarkup, 'room');
  return {
    scope: 'room',
    parts,
    finalMarkup: plan.finalMarkup,
    visibleText: plan.visibleText,
    resourceKinds: plan.resourceKinds,
    characters: plan.charCount,
    lineCount: plan.lineCount,
    derivedOnlyFromStructuredTerms: true,
  };
}

function firstUnknownField(offer) {
  if (!offer || typeof offer !== 'object' || offer.instructionAuthority !== 'none') {
    throw new TypeError('a structured non-authoritative offer is required');
  }
  const order = ['resource', 'quantity', 'quality', 'price'];
  return order.find(field => offer.unknowns?.some(entry => entry.field === field)) ?? null;
}

function draftPrivateClarification(offer) {
  const field = firstUnknownField(offer);
  const text = field === 'resource'
    ? 'Which product?'
    : field === 'quantity'
      ? 'What quantity do you need?'
      : field === 'quality'
        ? 'Which quality?'
        : field === 'price'
          ? 'What price are you offering?'
          : 'Still available?';
  return {
    scope: 'private',
    intent: field ? `clarify-${field}` : 'availability-check',
    text: assertSafeGeneratedText(text, 'private'),
    derivedOnlyFromStructuredTerms: true,
  };
}

function gateTermsHash(gateResult) {
  if (gateResult?.status === 'preview-approved') return gateResult.preview?.termsHash ?? null;
  if (gateResult?.status === 'confirm-authorized') return gateResult.authorization?.termsHash ?? null;
  return null;
}

function gateAllowsQuote(gateResult, terms) {
  return gateResult?.ok === true
    && ['preview-approved', 'confirm-authorized'].includes(gateResult.status)
    && gateTermsHash(gateResult) === contractTermsHash(terms);
}

function draftPrivateQuote({ terms: rawTerms, gateResult, trustedResourceCatalog = null }) {
  const terms = normalizeTerms(rawTerms);
  if (!gateAllowsQuote(gateResult, terms)) {
    throw new Error('an approved economic gate result is required before quoting terms');
  }
  const resource = trustedResourceSpec(terms.resourceKind, trustedResourceCatalog);
  const action = terms.ourSide === 'sell' ? 'Can supply' : 'Can buy';
  const text = `${action} ${formatExactQuantity(terms.quantity)} ${resource.name} Q${terms.quality} at $${terms.unitPrice}. Send contract?`;
  return {
    scope: 'private',
    intent: 'economic-quote',
    text: assertSafeGeneratedText(text, 'private'),
    terms,
    derivedOnlyFromStructuredTerms: true,
  };
}

function draftPrivateAcceptance({ terms: rawTerms, gateResult, trustedResourceCatalog = null }) {
  const terms = normalizeTerms(rawTerms);
  if (gateResult?.ok !== true || gateResult.status !== 'confirm-authorized'
    || gateResult.mutationAuthorized !== true
    || gateResult.authorization?.termsHash !== contractTermsHash(terms)) {
    throw new Error('confirmed exact-term authorization is required before accepting terms');
  }
  const resource = trustedResourceSpec(terms.resourceKind, trustedResourceCatalog);
  const text = `Agreed: ${formatExactQuantity(terms.quantity)} ${resource.name} Q${terms.quality} at $${terms.unitPrice}.`;
  return {
    scope: 'private',
    intent: 'accept-exact-terms',
    text: assertSafeGeneratedText(text, 'private'),
    terms,
    derivedOnlyFromStructuredTerms: true,
  };
}

function draftLeadResponse({
  offer,
  scope = 'private',
  gateResult = null,
  terms = null,
  trustedResourceCatalog = null,
}) {
  if (scope === 'private') {
    if (!terms) return draftPrivateClarification(offer);
    return draftPrivateQuote({ terms, gateResult, trustedResourceCatalog });
  }
  if (scope !== 'room') throw new TypeError('scope must be private or room');
  const normalized = normalizeTerms(terms);
  if (!gateAllowsQuote(gateResult, normalized)) {
    throw new Error('public offers require an approved economic preview');
  }
  return draftPublicTradePost({
    ourSide: normalized.ourSide,
    resourceKind: normalized.resourceKind,
    quantity: normalized.quantity,
    quality: normalized.quality,
    price: { status: 'known', type: 'absolute', amount: Number(normalized.unitPrice), decimal: normalized.unitPrice },
    trustedResourceCatalog,
  });
}

module.exports = {
  FORBIDDEN_OUTPUT_WORDS,
  MAX_PRIVATE_NEGOTIATION_CHARS,
  assertSafeGeneratedText,
  draftLeadResponse,
  draftPrivateAcceptance,
  draftPrivateClarification,
  draftPrivateQuote,
  draftPublicTradePost,
  formatEvidencePrice,
  formatExactQuantity,
  trustedResourceSpec,
};
