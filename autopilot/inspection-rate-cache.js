'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 3;

const TEMPORARY_MODIFIER_MARKER = /Production speed temporarily/gi;
const TEMPORARY_MODIFIER_PATTERN = /Production speed temporarily\s+(increased|decreased)\s+by\s+([\d.]+)%\s+until\s+(\d{1,2}:\d{2}\s*(?:AM|PM)\s+\d{1,2}\/\d{1,2}\/\d{4})/gi;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseLocalModifierExpiry(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (/PM/i.test(match[3]) && hour !== 12) hour += 12;
  if (/AM/i.test(match[3]) && hour === 12) hour = 0;
  const year = Number(match[6]);
  const month = Number(match[4]);
  const day = Number(match[5]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || month < 1 || month > 12 ||
      day < 1 || day > 31) return null;
  const expiresAt = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (expiresAt.getFullYear() !== year || expiresAt.getMonth() !== month - 1 ||
      expiresAt.getDate() !== day || expiresAt.getHours() !== hour ||
      expiresAt.getMinutes() !== minute) return null;
  const expiresAtMs = expiresAt.getTime();
  return Number.isFinite(expiresAtMs) ? expiresAt.toISOString() : null;
}

function extractTemporaryProductionModifiers(text) {
  const source = String(text || '');
  const markers = source.match(TEMPORARY_MODIFIER_MARKER) || [];
  const modifiers = [];
  for (const match of source.matchAll(TEMPORARY_MODIFIER_PATTERN)) {
    const percent = Number(match[2]);
    const expiresAt = parseLocalModifierExpiry(match[3]);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100 || !expiresAt) continue;
    modifiers.push({
      status: 'active',
      direction: match[1].toLowerCase(),
      percent,
      expiresAt,
      text: match[0],
    });
  }
  return {
    markerCount: markers.length,
    modifiers,
    fullyParsed: markers.length === modifiers.length,
  };
}

function unknownModifier(reason) {
  return { status: 'unknown', reason: String(reason || 'modifier evidence is not product-bound').slice(0, 240) };
}

function parseProductModifierScope(text, scopeStatus = 'scoped') {
  if (scopeStatus !== 'scoped') return unknownModifier('product card could not be isolated');
  const parsed = extractTemporaryProductionModifiers(text);
  if (!parsed.markerCount) return { status: 'none' };
  if (!parsed.fullyParsed) return unknownModifier('product card contains an unparseable temporary modifier');
  if (parsed.modifiers.length !== 1) return unknownModifier('product card contains conflicting temporary modifiers');
  return parsed.modifiers[0];
}

function modifierFingerprint(modifier) {
  return modifier?.status === 'active'
    ? [modifier.direction, Number(modifier.percent), modifier.expiresAt].join('|')
    : null;
}

function countModifierFingerprints(modifiers) {
  const counts = new Map();
  for (const modifier of modifiers || []) {
    const key = modifierFingerprint(modifier);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function summarizeProductModifiers(products) {
  const modifiers = (products || []).map(product => normalizeModifier(product?.modifier));
  if (!modifiers.length || modifiers.some(modifier => modifier.status === 'unknown')) {
    return unknownModifier('one or more product modifiers are unknown');
  }
  const signatures = new Set(modifiers.map(modifier => modifier.status === 'none'
    ? 'none'
    : modifierFingerprint(modifier)));
  return signatures.size === 1
    ? modifiers[0]
    : unknownModifier('product modifiers differ; no building-wide modifier exists');
}

function bindProductModifiers(products, pageText = '') {
  const pageEvidence = extractTemporaryProductionModifiers(pageText);
  const bound = (products || []).map(product => {
    const { modifierScopeText, modifierScopeStatus, ...safeProduct } = product || {};
    return {
      ...safeProduct,
      modifier: parseProductModifierScope(modifierScopeText, modifierScopeStatus),
    };
  });

  const pageCounts = countModifierFingerprints(pageEvidence.modifiers);
  const localCounts = countModifierFingerprints(bound.map(product => product.modifier));
  const locallyOverclaimed = new Set();
  for (const [key, count] of localCounts) {
    if (count > (pageCounts.get(key) || 0)) locallyOverclaimed.add(key);
  }
  for (const product of bound) {
    if (locallyOverclaimed.has(modifierFingerprint(product.modifier))) {
      product.modifier = unknownModifier('product-card modifier was not found exactly on the page');
    }
  }

  const remainingLocalCounts = countModifierFingerprints(bound.map(product => product.modifier));
  const hasUnboundPageModifier = [...pageCounts].some(([key, count]) =>
    count > (remainingLocalCounts.get(key) || 0));
  const pageHasUnparseableModifier = !pageEvidence.fullyParsed;
  if (hasUnboundPageModifier || pageHasUnparseableModifier) {
    for (const product of bound) {
      if (product.modifier.status === 'none') {
        product.modifier = unknownModifier(pageHasUnparseableModifier
          ? 'page contains an unparseable modifier outside this product card'
          : 'page contains an unbound modifier that may apply to this product');
      }
    }
  }
  return bound;
}

function normalizeProduct(product) {
  const kind = Number(product?.kind);
  const productionPerHour = finitePositive(product?.productionPerHour);
  if (!Number.isSafeInteger(kind) || kind <= 0 || productionPerHour == null) return null;
  return {
    kind,
    name: String(product?.name || product?.slug || `kind-${kind}`).trim(),
    slug: product?.slug ? String(product.slug) : null,
    productionPerHour,
    modifier: normalizeModifier(product?.modifier),
  };
}

function normalizeModifier(modifier) {
  if (modifier?.status === 'none') return { status: 'none' };
  if (modifier?.status !== 'active') return unknownModifier(modifier?.reason);
  const direction = modifier.direction === 'increased' || modifier.direction === 'decreased'
    ? modifier.direction
    : null;
  const percent = Number(modifier.percent);
  const expiresAtMs = Date.parse(modifier.expiresAt);
  if (!direction || !Number.isFinite(percent) || percent <= 0 || percent >= 100 ||
      !Number.isFinite(expiresAtMs)) return unknownModifier('temporary modifier fields are invalid');
  return {
    status: 'active',
    direction,
    percent,
    expiresAt: new Date(expiresAtMs).toISOString(),
    text: modifier.text ? String(modifier.text).slice(0, 240) : null,
  };
}

function normalizeEntry(result, { stored = false } = {}) {
  const buildingId = Number(result?.buildingId);
  const level = Number(result?.level);
  const inspectedAtMs = Date.parse(result?.inspectedAt);
  const rawProducts = Array.isArray(result?.products) ? result.products : [];
  const rawProductKinds = rawProducts
    .map(product => Number(product?.kind))
    .filter(kind => Number.isSafeInteger(kind) && kind > 0);
  const products = rawProducts.length
    ? rawProducts.map(normalizeProduct).filter(Boolean)
    : [];
  const duplicateProductKind = new Set(rawProductKinds).size !== rawProductKinds.length;
  const expectedSource = Number.isSafeInteger(buildingId) && buildingId > 0 ? `/b/${buildingId}/` : null;
  const pageEvidenceValid = stored ? result?.ok === true : result?.pageOk === true;
  if (!pageEvidenceValid || !Number.isSafeInteger(buildingId) || buildingId <= 0 ||
      !Number.isInteger(level) || level <= 0 || !Number.isFinite(inspectedAtMs) || !products.length ||
      duplicateProductKind || result?.source !== expectedSource) {
    return null;
  }
  for (const product of products) {
    if (product.modifier.status === 'active' && Date.parse(product.modifier.expiresAt) <= inspectedAtMs) {
      product.modifier = unknownModifier('temporary modifier had already expired at inspection time');
    }
  }
  return {
    ok: true,
    buildingId,
    level,
    inspectedAt: new Date(inspectedAtMs).toISOString(),
    source: expectedSource,
    products,
    modifier: summarizeProductModifiers(products),
  };
}

function emptyCache() {
  return { version: CACHE_VERSION, updatedAt: null, buildings: {} };
}

function productRatesMatch(left, right, tolerance = 0.02) {
  const previous = Number(left?.productionPerHour);
  const current = Number(right?.productionPerHour);
  return Number.isFinite(previous) && Number.isFinite(current) &&
    Math.abs(current - previous) <= Math.max(previous, current) * tolerance;
}

function readInspectionRateCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== CACHE_VERSION ||
        !parsed.buildings || typeof parsed.buildings !== 'object' || Array.isArray(parsed.buildings)) {
      return emptyCache();
    }
    const buildings = {};
    for (const raw of Object.values(parsed.buildings)) {
      const entry = normalizeEntry(raw, { stored: true });
      if (entry) buildings[String(entry.buildingId)] = entry;
    }
    const updatedAtMs = Date.parse(parsed.updatedAt);
    return {
      version: CACHE_VERSION,
      updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : null,
      buildings,
    };
  } catch (_) {
    return emptyCache();
  }
}

function upsertInspectionRate(cache, result) {
  const entry = normalizeEntry(result);
  if (!entry) return { ok: false, cache, reason: 'inspection has no valid live production-rate evidence' };
  const previous = cache?.buildings?.[String(entry.buildingId)];
  const inspectedAtMs = Date.parse(entry.inspectedAt);
  const previousInspectedAtMs = Date.parse(previous?.inspectedAt);
  if (Number.isFinite(previousInspectedAtMs) && inspectedAtMs < previousInspectedAtMs) {
    return {
      ok: false,
      cache,
      reason: 'inspection is older than the cached evidence for this building',
    };
  }
  if (Number(previous?.level) === Number(entry.level)) {
    const previousProducts = new Map((previous?.products || []).map(product => [Number(product.kind), product]));
    for (const product of entry.products) {
      const previousProduct = previousProducts.get(Number(product.kind));
      const previousModifierExpiry = Date.parse(previousProduct?.modifier?.expiresAt);
      if (product.modifier.status !== 'none' || previousProduct?.modifier?.status !== 'active' ||
          !Number.isFinite(previousModifierExpiry) || previousModifierExpiry <= inspectedAtMs) continue;
      if (!productRatesMatch(previousProduct, product)) {
        product.modifier = unknownModifier(
          'product modifier disappeared before its verified expiry while its printed rate changed',
        );
        continue;
      }
      product.modifier = {
        ...previousProduct.modifier,
        carriedForward: true,
        carriedFromInspection: previous.inspectedAt || null,
      };
    }
  }
  entry.modifier = summarizeProductModifiers(entry.products);
  const authorizingProductKinds = entry.products
    .filter(product => product.modifier.status === 'none' || product.modifier.status === 'active')
    .map(product => product.kind);
  return {
    ok: true,
    cache: {
      version: CACHE_VERSION,
      updatedAt: entry.inspectedAt,
      buildings: { ...(cache?.buildings || {}), [String(entry.buildingId)]: entry },
    },
    entry,
    authorizingProductKinds,
  };
}

function writeInspectionRateCache(file, cache) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function freshBuildingRateEvidence(cache, building, kind, now = Date.now(), maxAgeSeconds = 30 * 60) {
  const entry = cache?.buildings?.[String(building?.id)];
  const inspectedAtMs = Date.parse(entry?.inspectedAt);
  const ageSeconds = Number.isFinite(inspectedAtMs)
    ? Math.round((Number(now) - inspectedAtMs) / 1000)
    : null;
  const product = Array.isArray(entry?.products)
    ? entry.products.find(candidate => Number(candidate?.kind) === Number(kind))
    : null;
  const rate = finitePositive(product?.productionPerHour);
  const modifier = normalizeModifier(product?.modifier);
  const levelMatches = Number(entry?.level) === Number(building?.size);
  const future = ageSeconds != null && ageSeconds < -30;
  const fresh = ageSeconds != null && !future && ageSeconds <= maxAgeSeconds;
  const modifierKnown = modifier.status === 'none' || modifier.status === 'active';
  const usable = rate != null && levelMatches && fresh && modifierKnown;
  let status = 'fresh';
  if (!entry) status = 'missing';
  else if (future) status = 'future';
  else if (!fresh) status = 'stale';
  else if (!levelMatches) status = 'mismatch';
  else if (rate == null) status = 'missing-product';
  else if (!modifierKnown) status = 'modifier-unknown';
  return {
    buildingId: Number(building?.id) || null,
    level: Number(building?.size) || null,
    inspectedLevel: Number(entry?.level) || null,
    kind: Number(kind),
    ratePerHour: usable ? rate : null,
    modifier,
    inspectedAt: entry?.inspectedAt || null,
    ageSeconds,
    levelMatches,
    fresh,
    status,
    source: entry?.source || null,
  };
}

module.exports = {
  bindProductModifiers,
  emptyCache,
  extractTemporaryProductionModifiers,
  freshBuildingRateEvidence,
  normalizeEntry,
  normalizeModifier,
  parseProductModifierScope,
  readInspectionRateCache,
  summarizeProductModifiers,
  upsertInspectionRate,
  writeInspectionRateCache,
};
