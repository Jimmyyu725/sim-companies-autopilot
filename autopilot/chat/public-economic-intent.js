'use strict';

const crypto = require('node:crypto');
const { evaluateContractGate, normalizeTerms } = require('./contract-gate.js');
const {
  DEFAULT_MAX_EVIDENCE_AGE_MS,
  evaluateBusinessIntentOpportunity,
} = require('./lead-engine.js');
const { validateTrustedResourceCatalog } = require('./resource-catalog.js');

const PUBLIC_MARKET_COMPANY_ID = 'public-market';
const PUBLIC_MARKET_COMPANY_NAME = 'Public market';
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const MAX_INTENTS = 24;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function parseNow(value) {
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError('now must be a Date or millisecond timestamp');
  return parsed;
}

function safeRoom(value) {
  const room = String(value ?? '').normalize('NFKC').trim();
  if (!room || room.length > 120) throw new TypeError('roomId must be a bounded room name');
  return room;
}

function decimalString(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  let text = String(number);
  if (/e/iu.test(text)) text = number.toFixed(12).replace(/0+$/u, '').replace(/\.$/u, '');
  return /^\d+(?:\.\d+)?$/u.test(text) ? text : null;
}

function exactRows(entries) {
  const byIdentity = new Map();
  const duplicates = new Set();
  const source = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    const kind = Number(entry?.kind);
    const quality = Number(entry?.quality);
    if (!Number.isSafeInteger(kind) || kind <= 0
        || !Number.isSafeInteger(quality) || quality < 0) continue;
    const key = `${kind}:${quality}`;
    if (byIdentity.has(key)) duplicates.add(key);
    else byIdentity.set(key, { entry, index });
  }
  for (const key of duplicates) byIdentity.delete(key);
  return byIdentity;
}

function catalogName(catalog, kind) {
  if (!validateTrustedResourceCatalog(catalog)) {
    throw new TypeError('trusted resource catalog is required');
  }
  const matches = catalog.entries.filter(entry => Number(entry.kind) === kind);
  return matches.length === 1 ? matches[0].name : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function availableSellQuantity(inventory) {
  const onHand = Number(inventory?.onHandAmount);
  const blocked = Number(inventory?.blockedAmount);
  const reserve = Number(inventory?.reserveAmount);
  if (![onHand, blocked, reserve].every(Number.isFinite)) return null;
  return positiveInteger(Math.floor(Math.max(0, onHand - blocked - reserve)));
}

function requestedBuyQuantity(economics) {
  return positiveInteger(Number(economics?.buyNeedAmount));
}

function buildInternalOffer({
  snapshot,
  roomId,
  side,
  kind,
  quality,
  quantity,
  unitPrice,
  resourceName,
}) {
  const sourceId = `business-${digest({
    snapshotId: snapshot.snapshotId,
    roomId,
    side,
    kind,
    quality,
    quantity,
    unitPrice,
  }).slice(0, 32)}`;
  const source = {
    messageId: sourceId,
    conversationType: 'room',
    conversationId: roomId,
    counterpartyCompanyId: PUBLIC_MARKET_COMPANY_ID,
    counterpartyCompanyName: PUBLIC_MARKET_COMPANY_NAME,
    createdAt: snapshot.observedAt,
    observedAt: snapshot.observedAt,
    trust: 'internal-business-intent',
  };
  const offerIdentity = { sourceId, side, kind, quality, quantity, unitPrice };
  return {
    schemaVersion: 1,
    offerId: `business:${digest(offerIdentity).slice(0, 24)}`,
    internalIntentId: `intent:${digest({ snapshotId: snapshot.snapshotId, ...offerIdentity }).slice(0, 32)}`,
    source,
    instructionAuthority: 'none',
    counterpartySide: side === 'sell' ? 'buy' : 'sell',
    ourSide: side,
    resource: {
      status: 'known',
      kind,
      name: resourceName,
      iconToken: `:re-${kind}:`,
    },
    quantity: { status: 'known', amount: quantity, upperBound: true },
    quality: { status: 'known', value: quality },
    price: { status: 'known', type: 'absolute', amount: Number(unitPrice), decimal: unitPrice },
    evidence: [],
    unknowns: [],
    complete: true,
    autoActionAuthorized: false,
  };
}

function deriveProactivePublicIntents(snapshot, {
  roomId,
  trustedResourceCatalog,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
} = {}) {
  const room = safeRoom(roomId);
  const nowMs = parseNow(now);
  if (!plainObject(snapshot) || snapshot.schemaVersion !== 1
      || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId.trim()
      || typeof snapshot.observedAt !== 'string') return [];
  const snapshotMs = Date.parse(snapshot.observedAt);
  const ageMs = nowMs - snapshotMs;
  if (!Number.isFinite(snapshotMs) || ageMs < -MAX_CLOCK_SKEW_MS || ageMs > maxAgeMs) return [];
  if (!validateTrustedResourceCatalog(trustedResourceCatalog)) return [];

  const inventories = exactRows(snapshot.inventory);
  const markets = exactRows(snapshot.markets);
  const economics = exactRows(snapshot.economics);
  const candidates = [];
  const identities = [...new Set([...markets.keys(), ...economics.keys(), ...inventories.keys()])]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const identity of identities) {
    const inventoryRecord = inventories.get(identity) ?? null;
    const marketRecord = markets.get(identity) ?? null;
    const economicRecord = economics.get(identity) ?? null;
    const inventory = inventoryRecord?.entry ?? null;
    const market = marketRecord?.entry ?? null;
    const economic = economicRecord?.entry ?? null;
    if (market?.status !== 'ok' || economic?.status !== 'ok') continue;
    const [kindText, qualityText] = identity.split(':');
    const kind = Number(kindText);
    const quality = Number(qualityText);
    const resourceName = catalogName(trustedResourceCatalog, kind);
    const unitPrice = decimalString(market.marketPrice);
    if (!resourceName || !unitPrice) continue;
    const identityCandidates = [];
    for (const side of ['sell', 'buy']) {
      if (side === 'sell' && inventory?.status !== 'ok') continue;
      const quantity = side === 'sell'
        ? availableSellQuantity(inventory) : requestedBuyQuantity(economic);
      if (quantity == null) continue;
      const offer = buildInternalOffer({
        snapshot,
        roomId: room,
        side,
        kind,
        quality,
        quantity,
        unitPrice,
        resourceName,
      });
      let evaluation;
      try {
        evaluation = evaluateBusinessIntentOpportunity(offer, snapshot, { now: nowMs, maxAgeMs });
      } catch { continue; }
      if (evaluation.status !== 'evaluated' || evaluation.evidenceComplete !== true
          || evaluation.economicallyPositive !== true
          || !positiveInteger(evaluation.maxNegotiableQuantity)) continue;
      const terms = normalizeTerms({
        counterpartyCompanyId: PUBLIC_MARKET_COMPANY_ID,
        ourSide: side,
        resourceKind: kind,
        quality,
        quantity: evaluation.maxNegotiableQuantity,
        unitPrice,
      });
      let gate;
      try {
        gate = evaluateContractGate({
          mode: 'preview',
          operation: 'send',
          confirm: false,
          terms,
          leadEvaluation: evaluation,
          now: nowMs,
          maxAgeMs,
        });
      } catch { continue; }
      if (gate.ok !== true || gate.status !== 'preview-approved'
          || gate.mutationAuthorized !== false) continue;
      identityCandidates.push(deepFreeze({
        schemaVersion: 1,
        intentId: offer.internalIntentId,
        trust: 'internal-verified-business-intent',
        instructionAuthority: 'none',
        roomId: room,
        offer,
        terms,
        evaluation,
        preview: gate.preview,
        economics: gate.economics,
        evidenceRefs: [
          ...(inventoryRecord == null ? []
            : [`/businessSnapshot/inventory/${inventoryRecord.index}`]),
          `/businessSnapshot/markets/${marketRecord.index}`,
          `/businessSnapshot/economics/${economicRecord.index}`,
          '/businessSnapshot/transport',
          ...(side === 'buy' ? ['/businessSnapshot/finance'] : []),
        ],
      }));
    }
    // Never advertise both directions for the same exact product in one cycle.  Choose the
    // strictly better evidenced opportunity; the stable ID is only a deterministic tie-breaker.
    identityCandidates.sort((left, right) => {
      const gain = Number(right.economics?.opportunityGain ?? 0)
        - Number(left.economics?.opportunityGain ?? 0);
      return gain || left.intentId.localeCompare(right.intentId);
    });
    if (identityCandidates.length > 0) candidates.push(identityCandidates[0]);
  }
  return candidates.sort((left, right) => {
    const gain = Number(right.economics?.opportunityGain ?? 0)
      - Number(left.economics?.opportunityGain ?? 0);
    return gain || left.intentId.localeCompare(right.intentId);
  }).slice(0, MAX_INTENTS);
}

function verifyProactivePublicIntent(intent, snapshot, options = {}) {
  if (!plainObject(intent) || intent.schemaVersion !== 1
      || intent.trust !== 'internal-verified-business-intent'
      || intent.instructionAuthority !== 'none') {
    throw new TypeError('a derived internal public intent is required');
  }
  const derived = deriveProactivePublicIntents(snapshot, {
    ...options,
    roomId: intent.roomId,
  });
  const matches = derived.filter(candidate => candidate.intentId === intent.intentId);
  if (matches.length !== 1 || stableJson(matches[0].terms) !== stableJson(intent.terms)
      || stableJson(matches[0].offer) !== stableJson(intent.offer)) {
    throw new Error('public business intent does not match the fresh trusted snapshot');
  }
  return matches[0];
}

module.exports = {
  MAX_INTENTS,
  PUBLIC_MARKET_COMPANY_ID,
  PUBLIC_MARKET_COMPANY_NAME,
  deriveProactivePublicIntents,
  verifyProactivePublicIntent,
};
