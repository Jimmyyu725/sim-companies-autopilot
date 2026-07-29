'use strict';

const crypto = require('node:crypto');
const { normalizeMessage, SCHEMA_VERSION } = require('./schemas.js');
const { detectPromptInjection, sanitizeExternalText } = require('./injection-guard.js');

const LEAD_SCHEMA_VERSION = 1;
const DEFAULT_MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) throw new TypeError('now must be a Date or millisecond timestamp');
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalDecimal(raw) {
  const cleaned = String(raw).trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/u.test(cleaned)) return null;
  const [wholeRaw, fractionRaw = ''] = cleaned.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/u, '') || '0';
  const fraction = fractionRaw.replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseScaledQuantity(rawNumber, rawSuffix = '') {
  const decimal = canonicalDecimal(rawNumber);
  if (decimal == null) return null;
  const base = Number(decimal);
  const suffix = String(rawSuffix || '').trim().toLowerCase();
  const multiplier = suffix === 'k'
    ? 1_000
    : ['m', 'mil', 'million'].includes(suffix) ? 1_000_000 : 1;
  const quantity = base * multiplier;
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function assertNormalizedExternalMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.direction !== 'inbound'
    || value.trust !== 'untrusted-external'
    || !['room', 'private'].includes(value.conversationType)) {
    throw new TypeError('a normalized inbound untrusted room/private message is required');
  }
  const normalized = normalizeMessage(value);
  if (normalized.direction !== 'inbound' || normalized.trust !== 'untrusted-external') {
    throw new TypeError('message trust boundary is invalid');
  }
  return normalized;
}

function extractSide(text) {
  const matches = [...text.matchAll(/\b(buy|buying|wtb|sell|selling|wts)\b/giu)].map(match => ({
    raw: match[0],
    side: /^(?:buy|buying|wtb)$/iu.test(match[1]) ? 'buy' : 'sell',
    index: match.index,
  }));
  const sides = [...new Set(matches.map(match => match.side))];
  if (sides.length === 0) {
    return { status: 'UNKNOWN', value: null, reason: 'missing explicit BUY/SELL word', evidence: [] };
  }
  if (sides.length > 1) {
    return { status: 'UNKNOWN', value: null, reason: 'both BUY and SELL appear', evidence: matches };
  }
  return { status: 'known', value: sides[0], reason: null, evidence: matches };
}

function relativePriceCandidates(text) {
  const candidates = [];
  const patterns = [
    /(?:@|\bat\b)?\s*mp\s*([+-])\s*(\d+(?:\.\d+)?)\s*%/giu,
    /(?:@|\bat\b)?\s*([+-])\s*(\d+(?:\.\d+)?)\s*%\s*mp\b/giu,
    /(?:@|\bat\b)\s*mp\b(?!\s*[+-])/giu,
  ];
  patterns.forEach((pattern, patternIndex) => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0].trim();
      const magnitude = patternIndex === 2 ? 0 : Number(match[2]);
      const deltaPercent = patternIndex === 2 ? 0 : (match[1] === '-' ? -magnitude : magnitude);
      if (!Number.isFinite(deltaPercent) || Math.abs(deltaPercent) > 100) continue;
      candidates.push({
        type: 'market-relative',
        deltaPercent,
        raw,
        index: match.index,
        end: match.index + match[0].length,
      });
    }
  });
  return candidates.filter((candidate, index, all) => !all.some((other, otherIndex) => (
    otherIndex < index && other.index === candidate.index && other.end === candidate.end
  )));
}

function absolutePriceCandidates(text) {
  const candidates = [];
  const patterns = [
    /(?:@|\bat\b)\s*\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)(?!\s*%)/giu,
    /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)(?!\s*%)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const decimal = canonicalDecimal(match[1]);
      const amount = decimal == null ? null : Number(decimal);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      candidates.push({
        type: 'absolute',
        amount,
        decimal,
        raw: match[0].trim(),
        index: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return candidates.filter((candidate, index, all) => !all.some((other, otherIndex) => (
    otherIndex < index && other.index === candidate.index && other.end === candidate.end
  )));
}

function extractPrice(text) {
  const relative = relativePriceCandidates(text);
  const absolute = absolutePriceCandidates(text).filter(candidate => !relative.some(relativeEntry => (
    candidate.index >= relativeEntry.index && candidate.end <= relativeEntry.end
  )));
  const candidates = [...relative, ...absolute].sort((left, right) => left.index - right.index);
  if (candidates.length === 0) {
    return { status: 'UNKNOWN', value: null, reason: 'missing explicit absolute or MP-relative price', evidence: [] };
  }
  if (candidates.length > 1) {
    return { status: 'UNKNOWN', value: null, reason: 'multiple prices cannot be bound safely', evidence: candidates };
  }
  const candidate = candidates[0];
  const value = candidate.type === 'absolute'
    ? { type: candidate.type, amount: candidate.amount, decimal: candidate.decimal }
    : { type: candidate.type, deltaPercent: candidate.deltaPercent };
  return { status: 'known', value, reason: null, evidence: [candidate] };
}

function maskPriceAndMetadata(text) {
  let masked = text;
  const ranges = [
    ...relativePriceCandidates(text),
    ...absolutePriceCandidates(text),
    ...[...text.matchAll(/\bq\s*\d+\b/giu)].map(match => ({
      index: match.index, end: match.index + match[0].length,
    })),
    ...[...text.matchAll(/:re-\d+:/giu)].map(match => ({
      index: match.index, end: match.index + match[0].length,
    })),
    ...[...text.matchAll(/[+-]?\d+(?:\.\d+)?\s*%/gu)].map(match => ({
      index: match.index, end: match.index + match[0].length,
    })),
  ].sort((left, right) => right.index - left.index);
  for (const range of ranges) {
    masked = `${masked.slice(0, range.index)}${' '.repeat(range.end - range.index)}${masked.slice(range.end)}`;
  }
  return masked;
}

function extractQuantity(text) {
  const masked = maskPriceAndMetadata(text);
  const pattern = /\b(?:(up\s*to|upto|max(?:imum)?)\s*)?(\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(million|mil|[km])?\b/giu;
  const candidates = [];
  for (const match of masked.matchAll(pattern)) {
    const value = parseScaledQuantity(match[2], match[3]);
    if (value == null) continue;
    candidates.push({
      value,
      upperBound: Boolean(match[1]),
      raw: text.slice(match.index, match.index + match[0].length).trim(),
      index: match.index,
    });
  }
  if (candidates.length === 0) {
    return { status: 'UNKNOWN', value: null, reason: 'missing explicit quantity', evidence: [] };
  }
  if (candidates.length > 1) {
    return { status: 'UNKNOWN', value: null, reason: 'multiple quantities cannot be bound safely', evidence: candidates };
  }
  const candidate = candidates[0];
  return {
    status: 'known',
    value: { amount: candidate.value, upperBound: candidate.upperBound },
    reason: null,
    evidence: [candidate],
  };
}

function extractQuality(text) {
  const candidates = [...text.matchAll(/\bq\s*(\d+)\b/giu)].map(match => ({
    value: Number(match[1]), raw: match[0], index: match.index,
  })).filter(candidate => nonNegativeInteger(candidate.value) != null);
  const unique = [...new Set(candidates.map(candidate => candidate.value))];
  if (unique.length === 0) {
    return { status: 'UNKNOWN', value: null, reason: 'missing explicit quality', evidence: [] };
  }
  if (unique.length > 1) {
    return { status: 'UNKNOWN', value: null, reason: 'multiple qualities cannot be bound safely', evidence: candidates };
  }
  return { status: 'known', value: unique[0], reason: null, evidence: candidates };
}

function extractResources(message, text) {
  const mentions = message.content.resourceMentions.map(mention => ({
    kind: mention.kind,
    name: mention.name,
    iconToken: `:re-${mention.kind}:`,
    source: 'content.resourceMentions',
  }));
  const byKind = new Map();
  const warnings = [];
  for (const mention of mentions) {
    const existing = byKind.get(mention.kind);
    if (existing && existing.name && mention.name && existing.name !== mention.name) {
      warnings.push(`resource kind ${mention.kind} has conflicting names`);
      continue;
    }
    if (!existing) byKind.set(mention.kind, mention);
  }
  const tokenKinds = [...text.matchAll(/:re-(\d+):/giu)].map(match => Number(match[1]));
  for (const kind of tokenKinds) {
    if (!byKind.has(kind)) warnings.push(`inline resource ${kind} is absent from normalized mentions`);
  }
  return { resources: [...byKind.values()], warnings };
}

function knownFieldEvidence(field, extracted) {
  return extracted.evidence.map(entry => ({
    field,
    raw: entry.raw,
    source: 'message.content.text',
  }));
}

function buildOffer({ message, side, quantity, quality, price, resource, ambiguousResources }) {
  const unknowns = [];
  const evidence = [];
  for (const [field, extracted] of Object.entries({ side, quantity, quality, price })) {
    const resourceBindingIsAmbiguous = ambiguousResources && field !== 'side';
    if (extracted.status !== 'known' || resourceBindingIsAmbiguous) {
      unknowns.push({
        field,
        status: 'UNKNOWN',
        reason: resourceBindingIsAmbiguous
          ? 'multiple resources prevent safe field binding'
          : extracted.reason,
      });
    } else {
      evidence.push(...knownFieldEvidence(field, extracted));
    }
  }
  if (!resource) {
    unknowns.push({ field: 'resource', status: 'UNKNOWN', reason: 'missing normalized resource mention' });
  } else {
    evidence.push({
      field: 'resource',
      raw: resource.iconToken,
      source: resource.source,
    });
  }
  const counterpartySide = side.status === 'known' ? side.value : null;
  const safeToBind = !ambiguousResources;
  const resourceValue = resource ? {
    status: 'known',
    kind: resource.kind,
    name: resource.name,
    iconToken: resource.iconToken,
  } : { status: 'UNKNOWN', kind: null, name: null, iconToken: null };
  const offerIdentity = {
    messageId: message.messageId,
    counterpartySide,
    resourceKind: resource?.kind ?? null,
    ordinal: resource?.kind ?? 'unknown',
  };
  return {
    schemaVersion: LEAD_SCHEMA_VERSION,
    offerId: stableHash(offerIdentity).slice(0, 24),
    source: {
      messageId: message.messageId,
      conversationType: message.conversationType,
      conversationId: message.conversationId,
      counterpartyCompanyId: message.author.companyId,
      counterpartyCompanyName: message.author.companyName,
      createdAt: message.createdAt,
      observedAt: message.observedAt,
      trust: 'untrusted-external',
    },
    instructionAuthority: 'none',
    counterpartySide: counterpartySide ?? 'UNKNOWN',
    ourSide: counterpartySide === 'buy' ? 'sell' : counterpartySide === 'sell' ? 'buy' : 'UNKNOWN',
    resource: resourceValue,
    quantity: safeToBind && quantity.status === 'known'
      ? { status: 'known', ...quantity.value }
      : { status: 'UNKNOWN', amount: null, upperBound: null },
    quality: safeToBind && quality.status === 'known'
      ? { status: 'known', value: quality.value }
      : { status: 'UNKNOWN', value: null },
    price: safeToBind && price.status === 'known'
      ? { status: 'known', ...price.value }
      : { status: 'UNKNOWN', type: null },
    evidence,
    unknowns,
    complete: unknowns.length === 0,
    autoActionAuthorized: false,
  };
}

function extractTradeLeads(input) {
  const message = assertNormalizedExternalMessage(input);
  const text = sanitizeExternalText(message.content.text);
  const injectionAssessment = detectPromptInjection(text);
  const side = extractSide(text);
  const quantity = extractQuantity(text);
  const quality = extractQuality(text);
  const price = extractPrice(text);
  const resourceResult = extractResources(message, text);
  const ambiguousResources = resourceResult.resources.length > 1;
  const resourceInputs = resourceResult.resources.length > 0 ? resourceResult.resources : [null];
  const offers = side.status === 'known'
    ? resourceInputs.map(resource => buildOffer({
      message, side, quantity, quality, price, resource, ambiguousResources,
    }))
    : [];
  const status = side.status !== 'known'
    ? 'not-a-verifiable-trade'
    : offers.length > 0 && offers.every(offer => offer.complete)
      ? 'complete'
      : ambiguousResources ? 'ambiguous' : 'partial';
  return {
    schemaVersion: LEAD_SCHEMA_VERSION,
    status,
    messageId: message.messageId,
    instructionAuthority: 'none',
    injectionAssessment,
    offers,
    warnings: resourceResult.warnings,
    autoActionAuthorized: false,
  };
}

function freshSource(value, snapshotMs, nowMs, maxAgeMs, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: `${field} evidence is missing` };
  }
  if (value.status !== 'ok') return { ok: false, reason: `${field} source status is not ok` };
  const observedMs = parseTimestamp(value.observedAt);
  if (observedMs == null) return { ok: false, reason: `${field} has no valid observedAt` };
  const ageMs = nowMs - observedMs;
  if (ageMs < -MAX_CLOCK_SKEW_MS || ageMs > maxAgeMs) {
    return { ok: false, reason: `${field} evidence is stale`, ageMs };
  }
  if (Math.abs(observedMs - snapshotMs) > maxAgeMs) {
    return { ok: false, reason: `${field} is not tied to the business snapshot`, ageMs };
  }
  return { ok: true, ageMs, observedAt: new Date(observedMs).toISOString() };
}

function exactEntry(entries, kind, quality) {
  if (!Array.isArray(entries)) return { entry: null, ambiguous: false };
  const matches = entries.filter(entry => entry && Number(entry.kind) === kind
    && Number(entry.quality) === quality);
  return { entry: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}

function snapshotEnvelope(snapshot, nowMs, maxAgeMs) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.schemaVersion !== 1
    || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId.trim()) {
    return { ok: false, reason: 'business snapshot identity is missing' };
  }
  const snapshotMs = parseTimestamp(snapshot.observedAt);
  if (snapshotMs == null) return { ok: false, reason: 'business snapshot observedAt is invalid' };
  const ageMs = nowMs - snapshotMs;
  if (ageMs < -MAX_CLOCK_SKEW_MS || ageMs > maxAgeMs) {
    return { ok: false, reason: 'business snapshot is stale', ageMs };
  }
  return { ok: true, snapshotMs, ageMs };
}

function resolveOfferPrice(offer, market) {
  if (offer.price?.status !== 'known') return null;
  if (offer.price.type === 'absolute') return finiteNonNegative(offer.price.amount);
  if (offer.price.type !== 'market-relative') return null;
  const marketPrice = finiteNonNegative(market?.marketPrice);
  const deltaPercent = Number(offer.price.deltaPercent);
  if (marketPrice == null || marketPrice <= 0 || !Number.isFinite(deltaPercent)) return null;
  const resolved = marketPrice * (1 + deltaPercent / 100);
  return resolved > 0 ? round(resolved) : null;
}

function blockedEvaluation(offer, snapshot, unknowns, extra = {}) {
  return {
    schemaVersion: LEAD_SCHEMA_VERSION,
    offerId: offer?.offerId ?? null,
    messageId: offer?.source?.messageId ?? null,
    counterpartyCompanyId: offer?.source?.counterpartyCompanyId ?? null,
    snapshotId: snapshot?.snapshotId ?? null,
    snapshotObservedAt: snapshot?.observedAt ?? null,
    status: 'UNKNOWN',
    evidenceComplete: false,
    economicallyPositive: false,
    autoCommitEligible: false,
    unknowns,
    ...extra,
  };
}

/**
 * Business snapshot schema used here is deliberately explicit. Every relevant entry must include
 * status:"ok" and observedAt. inventory entries use onHandAmount, blockedAmount, reserveAmount,
 * and unitCost. transport uses availableAmount plus entries[kind, unitsPerItem,
 * opportunityCostPerUnit]; opportunityCostPerUnit may be absent only when unitsPerItem is exactly
 * zero. markets require marketPrice. economics require contractFeeRate,
 * fixedCost, alternativeSellNetPerUnit for our sales, and buyUseValuePerUnit plus buyNeedAmount and
 * warehouseFreeAmount for our purchases. finance requires cashAvailable and cashReserve.
 */
function evaluateOpportunityWithSourceTrust(offer, snapshot, options, expectedSourceTrust) {
  const nowMs = normalizedNow(options.now ?? Date.now());
  const maxAgeMs = positiveInteger(options.maxAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS);
  if (maxAgeMs == null) throw new TypeError('maxAgeMs must be a positive integer');
  if (!offer || typeof offer !== 'object' || offer.schemaVersion !== LEAD_SCHEMA_VERSION
    || offer.instructionAuthority !== 'none' || offer.source?.trust !== expectedSourceTrust) {
    throw new TypeError(`a structured ${expectedSourceTrust} trade opportunity is required`);
  }
  const unknowns = [];
  if (!offer.complete) unknowns.push(...offer.unknowns.map(entry => `${entry.field}: ${entry.reason}`));
  const resourceKind = positiveInteger(offer.resource?.kind);
  const quality = nonNegativeInteger(offer.quality?.value);
  const advertisedQuantity = positiveInteger(offer.quantity?.amount);
  if (resourceKind == null) unknowns.push('resource kind is UNKNOWN');
  if (quality == null) unknowns.push('quality is UNKNOWN');
  if (advertisedQuantity == null) unknowns.push('quantity is UNKNOWN');
  if (!['buy', 'sell'].includes(offer.ourSide)) unknowns.push('our trade side is UNKNOWN');

  const envelope = snapshotEnvelope(snapshot, nowMs, maxAgeMs);
  if (!envelope.ok) unknowns.push(envelope.reason);
  if (unknowns.length > 0) return blockedEvaluation(offer, snapshot, [...new Set(unknowns)]);
  const { snapshotMs } = envelope;

  const inventoryMatch = exactEntry(snapshot.inventory, resourceKind, quality);
  const marketMatch = exactEntry(snapshot.markets, resourceKind, quality);
  const economicsMatch = exactEntry(snapshot.economics, resourceKind, quality);
  const transportMatches = Array.isArray(snapshot.transport?.entries)
    ? snapshot.transport.entries.filter(entry => Number(entry?.kind) === resourceKind)
    : [];
  const inventory = inventoryMatch.entry;
  const market = marketMatch.entry;
  const economics = economicsMatch.entry;
  const transportEntry = transportMatches.length === 1 ? transportMatches[0] : null;
  if (inventoryMatch.ambiguous) unknowns.push('inventory evidence has duplicate exact rows');
  if (marketMatch.ambiguous) unknowns.push('market evidence has duplicate exact rows');
  if (economicsMatch.ambiguous) unknowns.push('economics evidence has duplicate exact rows');
  if (transportMatches.length > 1) unknowns.push('transport evidence has duplicate resource rows');
  const requiredSources = offer.ourSide === 'sell'
    ? { inventory, market, economics, transport: snapshot.transport }
    : { market, economics, transport: snapshot.transport };
  for (const [field, value] of Object.entries(requiredSources)) {
    const freshness = freshSource(value, snapshotMs, nowMs, maxAgeMs, field);
    if (!freshness.ok) unknowns.push(freshness.reason);
  }
  if (!transportEntry) unknowns.push('transport coefficient is missing or ambiguous');
  const resolvedUnitPrice = resolveOfferPrice(offer, market);
  if (resolvedUnitPrice == null || resolvedUnitPrice <= 0) unknowns.push('offer price cannot be resolved');

  const onHandAmount = finiteNonNegative(inventory?.onHandAmount);
  const blockedAmount = finiteNonNegative(inventory?.blockedAmount);
  const reserveAmount = finiteNonNegative(inventory?.reserveAmount);
  const unitCost = finiteNonNegative(inventory?.unitCost);
  const transportAvailable = finiteNonNegative(snapshot.transport?.availableAmount);
  const transportPerItem = finiteNonNegative(transportEntry?.unitsPerItem);
  const capturedTransportOpportunityCost = finiteNonNegative(
    transportEntry?.opportunityCostPerUnit,
  );
  const transportOpportunityCostPerUnit = transportPerItem === 0
    ? 0
    : capturedTransportOpportunityCost;
  const marketPrice = finiteNonNegative(market?.marketPrice);
  const contractFeeRate = finiteNonNegative(economics?.contractFeeRate);
  const fixedCost = finiteNonNegative(economics?.fixedCost);
  const numericFields = {
    'transport.availableAmount': transportAvailable,
    'transport.unitsPerItem': transportPerItem,
    'transport.opportunityCostPerUnit': transportOpportunityCostPerUnit,
    'market.marketPrice': marketPrice,
    'economics.contractFeeRate': contractFeeRate,
    'economics.fixedCost': fixedCost,
  };
  if (offer.ourSide === 'sell') {
    Object.assign(numericFields, {
      'inventory.onHandAmount': onHandAmount,
      'inventory.blockedAmount': blockedAmount,
      'inventory.reserveAmount': reserveAmount,
      'inventory.unitCost': unitCost,
    });
  }
  for (const [field, value] of Object.entries(numericFields)) {
    if (value == null) unknowns.push(`${field} is UNKNOWN`);
  }
  if (marketPrice != null && marketPrice <= 0) unknowns.push('market.marketPrice must be positive');
  if (contractFeeRate != null && contractFeeRate > 1) unknowns.push('contract fee rate is outside 0..1');

  let alternativeSellNetPerUnit = null;
  let buyUseValuePerUnit = null;
  let buyNeedAmount = null;
  let warehouseFreeAmount = null;
  let finance = null;
  if (offer.ourSide === 'sell') {
    alternativeSellNetPerUnit = finiteNonNegative(economics?.alternativeSellNetPerUnit);
    if (alternativeSellNetPerUnit == null) unknowns.push('sell opportunity cost is UNKNOWN');
  } else {
    buyUseValuePerUnit = finiteNonNegative(economics?.buyUseValuePerUnit);
    buyNeedAmount = nonNegativeInteger(economics?.buyNeedAmount);
    warehouseFreeAmount = nonNegativeInteger(economics?.warehouseFreeAmount);
    finance = freshSource(snapshot.finance, snapshotMs, nowMs, maxAgeMs, 'finance');
    if (!finance.ok) unknowns.push(finance.reason);
    if (buyUseValuePerUnit == null) unknowns.push('buy use value is UNKNOWN');
    if (buyNeedAmount == null) unknowns.push('buy need amount is UNKNOWN');
    if (warehouseFreeAmount == null) unknowns.push('warehouse free amount is UNKNOWN');
    if (finiteNonNegative(snapshot.finance?.cashAvailable) == null) unknowns.push('cash available is UNKNOWN');
    if (finiteNonNegative(snapshot.finance?.cashReserve) == null) unknowns.push('cash reserve is UNKNOWN');
  }
  if (unknowns.length > 0) {
    return blockedEvaluation(offer, snapshot, [...new Set(unknowns)], {
      resourceKind,
      quality,
      advertisedQuantity,
      resolvedUnitPrice,
    });
  }

  const usableStock = Math.max(0, Math.floor(onHandAmount - blockedAmount));
  const sellableAmount = Math.max(0, Math.floor(usableStock - reserveAmount));
  const maxByTransport = transportPerItem === 0
    ? Number.MAX_SAFE_INTEGER
    : Math.floor(transportAvailable / transportPerItem);
  const transportOpportunityPerItem = transportPerItem * transportOpportunityCostPerUnit;
  let maxNegotiableQuantity;
  let economicsResult;
  if (offer.ourSide === 'sell') {
    maxNegotiableQuantity = Math.min(advertisedQuantity, sellableAmount, maxByTransport);
    const quantity = maxNegotiableQuantity;
    const gross = resolvedUnitPrice * quantity;
    const fee = gross * contractFeeRate;
    const transportOpportunityCost = transportOpportunityPerItem * quantity;
    const netCashProceeds = gross - fee - fixedCost;
    economicsResult = {
      quantity,
      gross: round(gross),
      fee: round(fee),
      fixedCost,
      transportOpportunityCost: round(transportOpportunityCost),
      netCashProceeds: round(netCashProceeds),
      accountingProfit: round(netCashProceeds - unitCost * quantity - transportOpportunityCost),
      opportunityGain: round(netCashProceeds - alternativeSellNetPerUnit * quantity
        - transportOpportunityCost),
      accountingMargin: gross > 0
        ? round((netCashProceeds - unitCost * quantity - transportOpportunityCost) / gross) : null,
    };
  } else {
    const cashAvailable = snapshot.finance.cashAvailable;
    const cashReserve = snapshot.finance.cashReserve;
    const spendableCash = Math.max(0, cashAvailable - cashReserve);
    const unitCashCost = resolvedUnitPrice * (1 + contractFeeRate);
    const maxByCash = unitCashCost <= 0
      ? 0
      : Math.max(0, Math.floor((spendableCash - fixedCost) / unitCashCost));
    maxNegotiableQuantity = Math.min(
      advertisedQuantity,
      buyNeedAmount,
      warehouseFreeAmount,
      maxByTransport,
      maxByCash,
    );
    const quantity = maxNegotiableQuantity;
    const gross = resolvedUnitPrice * quantity;
    const fee = gross * contractFeeRate;
    const transportOpportunityCost = transportOpportunityPerItem * quantity;
    const landedCost = gross + fee + fixedCost + transportOpportunityCost;
    economicsResult = {
      quantity,
      gross: round(gross),
      fee: round(fee),
      fixedCost,
      transportOpportunityCost: round(transportOpportunityCost),
      landedCost: round(landedCost),
      opportunityGain: round(buyUseValuePerUnit * quantity - landedCost),
      spendableCash: round(spendableCash),
      maxByCash,
    };
  }
  const economicallyPositive = maxNegotiableQuantity > 0 && economicsResult.opportunityGain > 0;
  const canFillAdvertisedQuantity = maxNegotiableQuantity >= advertisedQuantity;
  return {
    schemaVersion: LEAD_SCHEMA_VERSION,
    offerId: offer.offerId,
    messageId: offer.source.messageId,
    counterpartyCompanyId: offer.source.counterpartyCompanyId,
    ourSide: offer.ourSide,
    resourceKind,
    resourceName: offer.resource.name,
    quality,
    advertisedQuantity,
    quantityIsUpperBound: offer.quantity.upperBound,
    resolvedUnitPrice,
    priceEvidence: { ...offer.price },
    snapshotId: snapshot.snapshotId,
    snapshotObservedAt: snapshot.observedAt,
    evaluatedAt: new Date(nowMs).toISOString(),
    maxAgeMs,
    status: 'evaluated',
    evidenceComplete: true,
    economicallyPositive,
    autoCommitEligible: false,
    sellableAmount,
    maxByTransport: maxByTransport === Number.MAX_SAFE_INTEGER ? null : maxByTransport,
    maxNegotiableQuantity,
    canFillAdvertisedQuantity,
    market: {
      marketPrice,
      bestBid: finiteNonNegative(market.bestBid),
      bestAsk: finiteNonNegative(market.bestAsk),
      observedAt: market.observedAt,
    },
    economics: economicsResult,
    economicsInputs: {
      onHandAmount,
      blockedAmount,
      reserveAmount,
      unitCost,
      transportAvailable,
      transportPerItem,
      transportOpportunityCostPerUnit,
      contractFeeRate,
      fixedCost,
      alternativeSellNetPerUnit,
      buyUseValuePerUnit,
      buyNeedAmount,
      warehouseFreeAmount,
      cashAvailable: offer.ourSide === 'buy' ? snapshot.finance.cashAvailable : null,
      cashReserve: offer.ourSide === 'buy' ? snapshot.finance.cashReserve : null,
    },
    unknowns: [],
  };
}

function evaluateLeadOpportunity(offer, snapshot, options = {}) {
  return evaluateOpportunityWithSourceTrust(offer, snapshot, options, 'untrusted-external');
}

// Internal business intents use the same fail-closed economic evaluator but a distinct provenance
// label.  Callers must still derive and re-verify the intent from the exact trusted snapshot; this
// function deliberately does not turn an arbitrary internal-looking object into authorization.
function evaluateBusinessIntentOpportunity(offer, snapshot, options = {}) {
  return evaluateOpportunityWithSourceTrust(offer, snapshot, options, 'internal-business-intent');
}

function rankLeadOpportunities(input, snapshot, options = {}) {
  const offers = Array.isArray(input) ? input : input?.offers;
  if (!Array.isArray(offers)) throw new TypeError('offers or an extraction result is required');
  const evaluations = offers.map(offer => evaluateLeadOpportunity(offer, snapshot, options));
  return evaluations.sort((left, right) => {
    if (left.evidenceComplete !== right.evidenceComplete) return left.evidenceComplete ? -1 : 1;
    if (left.economicallyPositive !== right.economicallyPositive) return left.economicallyPositive ? -1 : 1;
    const leftGain = Number(left.economics?.opportunityGain ?? Number.NEGATIVE_INFINITY);
    const rightGain = Number(right.economics?.opportunityGain ?? Number.NEGATIVE_INFINITY);
    if (leftGain !== rightGain) return rightGain - leftGain;
    return String(left.offerId ?? '').localeCompare(String(right.offerId ?? ''));
  }).map((evaluation, index) => ({ ...evaluation, rank: index + 1 }));
}

module.exports = {
  DEFAULT_MAX_EVIDENCE_AGE_MS,
  LEAD_SCHEMA_VERSION,
  assertNormalizedExternalMessage,
  canonicalDecimal,
  evaluateBusinessIntentOpportunity,
  evaluateLeadOpportunity,
  extractPrice,
  extractQuality,
  extractQuantity,
  extractSide,
  extractTradeLeads,
  parseScaledQuantity,
  rankLeadOpportunities,
};
