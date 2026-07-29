#!/usr/bin/env node
'use strict';

// Read one owned building page without starting production or confirming an upgrade. This is the
// P1 source for the game's printed level/rates/wages and an optional quantity quote.
const fs = require('fs');
const path = require('path');
const cdp = require(path.join(__dirname, '..', 'shared', 'cdp.js'));
const { parseInspectArgs, parseProductionQuote } = require('./inspection-helpers.js');
const {
  bindProductModifiers,
  readInspectionRateCache,
  summarizeProductModifiers,
  upsertInspectionRate,
  writeInspectionRateCache,
} = require('./inspection-rate-cache.js');
const { calculateCoffeeReservePolicy } = require('./coffee-reserve-policy.js');
const {
  attachPageActivityInspection,
  buildPageActivityInspection,
  classifyPageActivity,
  readBuildingPageActivity,
} = require('./building-page-activity.js');

function cachedStateFreshness(value, nowMs = Date.now()) {
  const stateMs = Date.parse(value);
  if (!Number.isFinite(stateMs) || !Number.isFinite(Number(nowMs))) {
    return { ok: false, reason: 'captured state timestamp is invalid', ageSeconds: null };
  }
  const exactAgeSeconds = (Number(nowMs) - stateMs) / 1000;
  const ageSeconds = Math.round(exactAgeSeconds);
  if (exactAgeSeconds < -30) {
    return { ok: false, reason: 'captured state timestamp is more than 30 seconds in the future', ageSeconds };
  }
  if (exactAgeSeconds > 5 * 60) {
    return { ok: false, reason: 'captured state is older than five minutes', ageSeconds };
  }
  return { ok: true, reason: null, ageSeconds };
}

function resolveBuildingActivity(state, buildingId, pageEvidence = {}, nowMs = Date.now()) {
  const fallback = () => {
    const classified = classifyPageActivity(pageEvidence);
    return { ...classified, endsAt: null };
  };
  if (!state || typeof state !== 'object') return fallback();
  const freshness = cachedStateFreshness(state.t, nowMs);
  if (!freshness.ok) return { ...fallback(), stateReason: freshness.reason, stateAgeSeconds: freshness.ageSeconds };
  const building = Array.isArray(state.buildings)
    ? state.buildings.find(row => Number(row?.id) === Number(buildingId))
    : null;
  if (!building || !Object.prototype.hasOwnProperty.call(building, 'busy') || building.busy === undefined) {
    return { ...fallback(), stateReason: 'building activity is absent from fresh state', stateAgeSeconds: freshness.ageSeconds };
  }
  if (building.busy === null) {
    return {
      status: 'authoritative-state',
      busy: false,
      type: 'idle',
      endsAt: null,
      stateAsOf: state.t,
      stateAgeSeconds: freshness.ageSeconds,
    };
  }
  if (!building.busy || typeof building.busy !== 'object' || Array.isArray(building.busy)) {
    return { ...fallback(), stateReason: 'building activity shape is unknown', stateAgeSeconds: freshness.ageSeconds };
  }
  const type = ['production', 'sale', 'construction'].includes(building.busy.type)
    ? building.busy.type
    : 'unknown';
  return {
    status: 'authoritative-state',
    busy: true,
    type,
    makingKind: building.busy.makingKind ?? null,
    makingName: building.busy.makingName ?? null,
    expanding: building.busy.expanding ?? null,
    startedAt: building.busy.startedAt ?? null,
    endsAt: building.busy.endsAt ?? null,
    stateAsOf: state.t,
    stateAgeSeconds: freshness.ageSeconds,
  };
}

function persistPageActivityInspection(stateFile, inspection) {
  if (!inspection) return { updated: false, reason: 'no exact page activity evidence' };
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!attachPageActivityInspection(state.buildings, inspection)) {
      return { updated: false, reason: 'fresh authoritative state wins or exact building binding failed' };
    }
    const temporary = `${stateFile}.${process.pid}.activity.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 1)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, stateFile);
    return { updated: true, buildingId: inspection.buildingId, status: inspection.type };
  } catch (error) {
    return { updated: false, reason: String(error.message || error).slice(0, 180) };
  }
}

function refreshCachedSurplusPlan() {
  const stateFile = path.join(__dirname, '.state.json');
  const cacheFile = path.join(__dirname, '.inspection-rates.json');
  const factsFile = path.join(__dirname, '..', 'shared', 'facts', 'game-facts.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const freshness = cachedStateFreshness(state.t);
    if (!freshness.ok) {
      return { updated: false, reason: freshness.reason, stateAgeSeconds: freshness.ageSeconds };
    }
    const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
    state.surplusPlan = calculateCoffeeReservePolicy({
      state,
      inspectionCache: readInspectionRateCache(cacheFile),
      facts,
      horizonHours: 24,
      bufferPct: 0.10,
      nowMs: Date.now(),
    });
    state.sources = state.sources || {};
    state.sources.surplusPlan = {
      status: state.surplusPlan.status,
      asOf: state.surplusPlan.asOf,
      source: 'autopilot/coffee-reserve-policy.js + .inspection-rates.json',
    };
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 1)}\n`);
    fs.renameSync(temporary, stateFile);
    return {
      updated: true,
      complete: state.surplusPlan.complete,
      status: state.surplusPlan.status,
      stateAsOf: state.t,
      powderPerHour: state.surplusPlan.millCapacity?.powderPerHour ?? null,
      missingBuildingIds: state.surplusPlan.millCapacity?.missingBuildingIds || [],
    };
  } catch (error) {
    return { updated: false, reason: String(error.message || error).slice(0, 180) };
  }
}

function imageKindMap() {
  const defs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'facts', 'defs.json'), 'utf8'));
  const out = {};
  for (const [kind, resource] of Object.entries(defs.resources || {})) {
    const slug = String(resource.image || '').split('/').pop().split('.')[0].toLowerCase();
    if (slug) out[slug] = Number(kind);
  }
  return out;
}

async function main() {
  const args = parseInspectArgs(process.argv[2] || '{}');
  const expectedPath = `/b/${args.buildingId}/`;
  const byImage = imageKindMap();
  let cachedState = null;
  try { cachedState = JSON.parse(fs.readFileSync(path.join(__dirname, '.state.json'), 'utf8')); }
  catch (_) {}
  await cdp.connect();
  await cdp.goto(`https://www.simcompanies.com/b/${args.buildingId}/`);

  const page = await cdp.evaluate(String.raw`
    const readBuildingPageActivity = ${readBuildingPageActivity.toString()};
    const text = norm(document.body.innerText);
    const knownResourceSlugs = new Set(${JSON.stringify(Object.keys(byImage))});
    const levelMatch = text.match(/LEVEL\s+(\d+)/i);
    const wageMatch = text.match(/Wages:\s*\$([\d,.]+)\/h/i);
    const production = /Production:\s*([\d,.]+)\/h/i;
    const withProduction = all('*').filter(element => production.test(element.innerText || ''));
    const leaves = withProduction.filter(element =>
      !withProduction.some(other => other !== element && element.contains(other)));
    const products = [];
    for (const leaf of leaves) {
      const rateMatch = String(leaf.innerText || '').match(production);
      const rate = rateMatch ? Number(rateMatch[1].replace(/,/g, '')) : null;
      let region = null;
      let slug = null;
      let name = null;
      for (let node = leaf, depth = 0; node && depth < 10; node = node.parentElement, depth++) {
        const containedRateLeaves = leaves.filter(candidate => node.contains(candidate));
        if (containedRateLeaves.length > 1) break;
        const imageSlugs = [...new Set(all('img', node)
          .map(image => String(image.src || '').split('/').pop().split('.')[0].toLowerCase())
          .filter(candidate => knownResourceSlugs.has(candidate)))];
        if (imageSlugs.length > 1) break;
        if (containedRateLeaves.length === 1 && imageSlugs.length === 1) {
          region = node;
          slug = imageSlugs[0];
          name = (norm(node.innerText).match(/^([A-Z][A-Z0-9 .'\-]{2,}?)\s*(?:Production|Wages|$)/i) || [])[1] || slug;
        }
      }
      products.push({
        name: (name || '?').trim(),
        slug,
        productionPerHour: rate,
        modifierScopeStatus: region ? 'scoped' : 'unknown',
        modifierScopeText: region ? norm(region.innerText) : '',
      });
    }
    return {
      path: location.pathname,
      text,
      level: levelMatch ? Number(levelMatch[1]) : null,
      wagesPerHour: wageMatch ? Number(wageMatch[1].replace(/,/g, '')) : null,
      pageActivity: readBuildingPageActivity({ expectedPath: ${JSON.stringify(expectedPath)} }),
      products,
    };
  `);

  const activity = resolveBuildingActivity(cachedState, args.buildingId, page.pageActivity);

  page.products = bindProductModifiers(page.products.map(product => ({
    ...product,
    kind: product.slug ? (byImage[product.slug.toLowerCase()] ?? null) : null,
  })), page.text);
  page.modifier = summarizeProductModifiers(page.products);
  delete page.text;

  let quote = null;
  if (args.product && args.qty) {
    const quoteText = activity.busy === true
      ? { ok: false, reason: `building is ${activity.type}; quantity quote is not executable` }
      : await cdp.evaluate(String.raw`
      const product = ${JSON.stringify(args.product)};
      const qty = ${JSON.stringify(args.qty)};
      if (/currently busy/i.test(document.body.innerText)) {
        return { ok: false, reason: 'building busy — quantity quote unavailable' };
      }
      const cards = all('div').filter(div =>
        norm(div.innerText).toUpperCase().startsWith(product.toUpperCase() + ' PRODUCTION') &&
        div.querySelectorAll('input').length);
      const card = cards.sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!card) return { ok: false, reason: 'product card not found' };
      setInput(all('input', card)[0], qty);
      await sleep(1800);
      return { ok: true, text: norm(card.innerText) };
    `);
    quote = quoteText.ok
      ? { ok: true, product: args.product, qty: args.qty, ...parseProductionQuote(quoteText.text) }
      : quoteText;
  }

  const inspectedAt = new Date().toISOString();
  const activityInspection = buildPageActivityInspection({
    buildingId: args.buildingId,
    level: page.level,
    observedAt: inspectedAt,
    pageEvidence: page.pageActivity,
  });
  const result = {
    ok: page.path === expectedPath && (quote == null || quote.ok === true),
    pageOk: page.path === expectedPath,
    requestedQuoteOk: quote == null ? null : quote.ok === true,
    inspectedAt,
    buildingId: args.buildingId,
    source: page.path,
    level: page.level,
    wagesPerHour: page.wagesPerHour,
    busy: activity.busy,
    busyType: activity.type,
    activity,
    pageActivity: page.pageActivity,
    retailProducts: page.pageActivity.retailCards,
    activityInspection,
    products: page.products,
    modifier: page.modifier,
    quote,
  };
  const cacheFile = path.join(__dirname, '.inspection-rates.json');
  const cached = upsertInspectionRate(readInspectionRateCache(cacheFile), result);
  if (cached.ok) writeInspectionRateCache(cacheFile, cached.cache);
  result.rateEvidenceCached = cached.ok;
  result.rateEvidenceAuthorizingProductKinds = cached.authorizingProductKinds || [];
  if (!cached.ok) result.rateEvidenceCacheReason = cached.reason;
  result.surplusPlanRefresh = cached.ok ? refreshCachedSurplusPlan() : { updated: false, reason: cached.reason };
  result.activityEvidencePersistence = persistPageActivityInspection(
    path.join(__dirname, '.state.json'),
    activityInspection,
  );

  console.log(JSON.stringify(result));
  cdp.close();
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    try { cdp.close(); } catch (_) {}
    console.log(JSON.stringify({ ok: false, error: String(error.message || error) }));
    process.exit(0);
  });
}

module.exports = {
  cachedStateFreshness,
  persistPageActivityInspection,
  resolveBuildingActivity,
};
