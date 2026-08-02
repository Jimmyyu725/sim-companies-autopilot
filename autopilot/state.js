#!/usr/bin/env node
// autopilot/state.js — gather a compact game state for the LLM brain. Same battle-tested source as
// tick.js readState: one CDP capture of the store page yields auth-data (money/level), buildings
// (busy schedules), resources (stock), ticker and retail in a single navigation. Run under
// `timeout 150 flock -w 60 .tick.lock` (LESSONS B2). Writes autopilot/.state.json and prints it.
const fs = require('fs'), path = require('path');
const AUTOPILOT = __dirname;
const SIM = path.dirname(AUTOPILOT);
const SHARED = path.join(SIM, 'shared');
const FACTS = path.join(SHARED, 'facts', 'game-facts.json');
const DEFS = path.join(SHARED, 'facts', 'defs.json');
const cdp = require(path.join(SHARED, 'cdp.js'));
const CFG = require(path.join(SHARED, 'config.json'));
const { aggregateVolumeRecords } = require(path.join(SHARED, 'price-tracker', 'data-quality.js'));
const {
  calculateCompanyValue,
  collectInventoryLots,
  deriveQualityMarketPrices,
  derivePreviousDayReferencePrices,
  inventoryAmountsByQuality,
} = require(path.join(AUTOPILOT, 'company-value.js'));
const {
  ageSeconds,
  aggregateStock,
  calculateSlots,
  normalizeProductionModifiers,
  parseBuilding,
  summarizeBonds,
  summarizeVolumeRows,
  stockSourceIsComplete,
  withExplicitStockKinds,
} = require(path.join(AUTOPILOT, 'state-helpers.js'));
const { calculateCoffeeReservePolicy } = require(path.join(AUTOPILOT, 'coffee-reserve-policy.js'));
const { readInspectionRateCache } = require(path.join(AUTOPILOT, 'inspection-rate-cache.js'));
const {
  attachPageActivityInspection,
  buildPageActivityInspection,
  readBuildingPageActivity,
} = require(path.join(AUTOPILOT, 'building-page-activity.js'));
const {
  buildingRowsProblem,
  normalizePositiveRateMap,
  normalizeRetailRows,
  summarizeBuildingActivityEvidence,
  validAuthSnapshot,
  validBuildingRows,
  validTickerRows,
} = require(path.join(AUTOPILOT, 'state-feed-validation.js'));
const {
  PROSPECTOR_OVERVIEW_PATH,
  recordOwnerProspectorOverview,
  synchronizeOwnerProspectorConstruction,
} = require(path.join(AUTOPILOT, 'owner-directive.js'));
const {
  derivePaState,
  parsePaUnreadRows,
  readPaStatus,
  readPendingPa,
  writePaStatus,
} = require(path.join(AUTOPILOT, 'pa-state.js'));

const MISSION_KINDS = Object.freeze([1, 2, 13, 66, 118, 119]);
const PRICE_FALLBACK_MAX_AGE_SECONDS = 10 * 60;
const PRINTED_RATE_FRESH_SECONDS = 6 * 3600;
const PA_STATUS_FILE = path.join(AUTOPILOT, '.pa-status.json');
const PA_PENDING_FILE = path.join(AUTOPILOT, '.pa-pending.json');

(async () => {
  await cdp.connect();
  const cap = await cdp.capture(`https://www.simcompanies.com/b/${CFG.storeId}/`, 15);
  const capturedAt = new Date().toISOString();
  let capturedStorePageActivity = null;
  try {
    capturedStorePageActivity = await cdp.evaluate(`
      const readBuildingPageActivity = ${readBuildingPageActivity.toString()};
      return readBuildingPageActivity({ expectedPath: ${JSON.stringify(`/b/${CFG.storeId}/`)} });
    `);
  } catch (error) { /* Exact page activity remains UNKNOWN. */ }
  const auth = cap['/api/v3/companies/auth-data/'];
  const buildings = cap['/api/v2/companies/me/buildings/'];
  const resourcesRaw = cap['/api/v3/resources/' + CFG.companyId + '/'];
  const tickerRaw = cap['/api/v3/market-ticker/0/'];
  const resourcesKnown = stockSourceIsComplete(resourcesRaw);
  const tickerLiveKnown = validTickerRows(tickerRaw);
  if (!validAuthSnapshot(auth)) throw new Error('state capture auth payload is incomplete or malformed');
  const buildingProblem = buildingRowsProblem(buildings, [CFG.storeId, CFG.farmId]);
  if (buildingProblem) {
    throw new Error(`state capture building payload failed validation: ${buildingProblem}`);
  }

  const P = {}, N = {};
  for (const t of tickerLiveKnown ? tickerRaw : []) {
    P[t.kind] = Number(t.price);
    N[t.kind] = String(t.image || '').replace(/.*\//, '').replace('.png', '');
  }
  // Fallback (2026-07-25): the store-page capture regularly misses /market-ticker/ entirely —
  // measured live: every stock name 'k<kind>', every keyPrice null, and the brain then GUESSED
  // a product name and a $0 sell price. The price collector already dumps the full ticker every
  // 2 min; reuse its files so names/prices are never blank.
  let trackerPriceUsed = false;
  let trackerAsOf = null;
  let trackerAgeSeconds = null;
  try {
    const PT = path.join(SHARED, 'price-tracker', 'data');
    const names = JSON.parse(fs.readFileSync(path.join(PT, 'names.json'), 'utf8'));
    for (const [k, n] of Object.entries(names)) if (!N[k]) N[k] = n;
    const rows = fs.readFileSync(path.join(PT, 'prices.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(rows[rows.length - 1]);
    trackerAsOf = new Date(Number(last.t) * 1000).toISOString();
    trackerAgeSeconds = ageSeconds(Number(last.t));
    if (trackerAgeSeconds != null && trackerAgeSeconds >= -30 &&
        trackerAgeSeconds <= PRICE_FALLBACK_MAX_AGE_SECONDS) {
      for (const [k, v] of Object.entries(last.p || {})) {
        const price = Number(v);
        if (P[k] == null && Number.isFinite(price) && price > 0) {
          P[k] = price;
          trackerPriceUsed = true;
        }
      }
    }
  } catch (e) { /* tracker absent -> old behavior */ }
  const tickerStatus = tickerLiveKnown
    ? (trackerPriceUsed ? 'mixed' : 'ok')
    : (trackerPriceUsed ? 'fallback' : 'unknown');
  const tickerAsOf = tickerLiveKnown ? capturedAt : (trackerPriceUsed ? trackerAsOf : null);
  const tickerAgeSeconds = tickerLiveKnown ? 0 : (trackerPriceUsed ? trackerAgeSeconds : null);

  const level = auth.levelInfo?.level ?? null;
  const levelingProgress = summarizeLevelingProgress(auth.levelInfo);
  const blds = buildings.map(parseBuilding);
  const storeBuilding = blds.find(building => Number(building?.id) === Number(CFG.storeId));
  const storeActivityInspection = buildPageActivityInspection({
    buildingId: CFG.storeId,
    level: storeBuilding?.size,
    observedAt: new Date().toISOString(),
    pageEvidence: capturedStorePageActivity,
  });
  const storeActivityAttached = attachPageActivityInspection(blds, storeActivityInspection);
  const buildingActivityEvidence = summarizeBuildingActivityEvidence(buildings);
  let slotSchedule;
  try {
    slotSchedule = JSON.parse(fs.readFileSync(FACTS, 'utf8'))
      .mechanics?.building_slots;
  } catch (e) { /* helper uses its measured fallback schedule */ }
  const baseSlotCapacity = auth.levelInfo?.maxBuildings ?? null;
  const extraBuildingSlots = auth.authCompany?.extraBuildingSlots ?? null;
  const slots = calculateSlots(buildings, level, slotSchedule, baseSlotCapacity, extraBuildingSlots);
  const aggregatedStock = aggregateStock(resourcesKnown ? resourcesRaw : [], N, P);
  const stock = withExplicitStockKinds(aggregatedStock, MISSION_KINDS, N, P, resourcesKnown);

  // RECIPE TABLE (owner request): the full tech tree, one compact line per product, so the brain
  // always knows what makes what. From game-facts (MEASURED nightly).
  // Trimmed to the kinds we actually touch (~16) — the full 151-line tech tree cost ~2.5k tokens
  // EVERY wake for lines never used. Full table: game-facts.json (read_api or ask the runner).
  const RELEVANT = new Set([1, 2, 13, 66, 118, 119, 5, 3, 4, 7, 8, 115, 116]);
  let recipes = [];
  try {
    const gf = JSON.parse(fs.readFileSync(FACTS, 'utf8')).resources;
    recipes = Object.entries(gf).filter(([k, r]) => r.producedAt && RELEVANT.has(Number(k))).map(([k, r]) =>
      `${k} ${(N[k] || 'k' + k)} @${r.producedAt} rawRate${r.ratePerHourRaw ?? 'UNKNOWN'}/h = ` +
      (Object.entries(r.recipe || {}).map(([ik, m]) => `${m}×${N[ik] || 'k' + ik}`).join(' + ') || '(raw)'));
    recipes.push('(full tech tree is a local historical reference; absent rates are UNKNOWN—use a live building inspection before acting)');
  } catch (e) {}

  // Retail saturation/averages for goods we can sell (demand-side truth).
  // Our sellables + the 10 lowest-saturation opportunities (full feed was ~100 entries of noise).
  const retailRaw = cap['/api/v4/0/resources-retail-info/'];
  let retail = Array.isArray(retailRaw) ? [] : null;
  try {
    const normalizedRetail = normalizeRetailRows(retailRaw);
    if (!normalizedRetail) throw new Error('retail source missing or invalid');
    const gf = JSON.parse(fs.readFileSync(FACTS, 'utf8')).resources;
    const ourDb = new Set([119, 7, 8, 5, 3, 4].map(k => gf[k]?.dbLetter).filter(x => x != null));
    const ri = normalizedRetail
      .map(e => ({ dbLetter: e.dbLetter, avgPrice: +e.averagePrice.toFixed(2), saturation: +e.saturation.toFixed(2) }));
    retail = [...ri.filter(e => ourDb.has(e.dbLetter)),
              ...ri.filter(e => !ourDb.has(e.dbLetter)).sort((a, b) => a.saturation - b.saturation).slice(0, 10)];
  } catch (e) { retail = null; }

  // Exchange trade volume, last hour, our key kinds (from the volume tracker).
  let volume1h = null, volume1hMeta = null;
  try {
    const rows = fs.readFileSync(path.join(SHARED, 'price-tracker', 'data', 'volume.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(JSON.parse);
    const summary = summarizeVolumeRows(rows, {
      names: N,
      includeKinds: [1, 2, 5, 7, 8, 66, 118, 119],
    });
    if (summary.sourceRows > 0) volume1h = summary.byName;
    volume1hMeta = summary.sourceRows > 0 ? {
      from: summary.from,
      to: summary.to,
      sourceRows: summary.sourceRows,
      prorated: summary.prorated,
      status: 'ok',
    } : { status: 'unknown', sourceRows: 0 };
  } catch (e) {}

  const flags = ['fastloop-stuck', 'chat-pending', 'price-alert', 'surplus-alert', 'slot-alert']
    .filter(f => fs.existsSync(path.join(SIM, f + '.flag')));

  // Weather multiplies retail selling speed (±40% — pricing experiments must normalize by it);
  // paUnread>0 means the personal assistant has an offer waiting (often free money — handle it).
  let weather = null;
  try { weather = await cdp.evaluate(`const r=await api('/api/v2/weather/0/'); return r.status===200?r.json:null;`); } catch (e) {}
  let bonds = summarizeBonds(null, null, null);
  let supplementalData = {
    sold: null,
    recent: null,
    balance: null,
    marketOrders: null,
    outgoingContracts: null,
    research: null,
    status: {},
  };
  try {
    const bondData = await cdp.evaluate(`
      const [sold, recent, balance, marketOrders, outgoingContracts, research] = await Promise.all([
        api('/api/v2/companies/me/bonds/sold/'),
        api('/api/v2/companies/me/cashflow/recent/'),
        api('/api/v2/companies/me/balance-sheet/'),
        api('/api/v2/companies/me/market-orders/'),
        api('/api/v3/contracts-outgoing/me/'),
        api('/api/v3/players/research/'),
      ]);
      return {
        sold: sold.status === 200 ? sold.json : null,
        recent: recent.status === 200 ? recent.json : null,
        balance: balance.status === 200 ? balance.json : null,
        marketOrders: marketOrders.status === 200 ? marketOrders.json : null,
        outgoingContracts: outgoingContracts.status === 200 ? outgoingContracts.json : null,
        research: research.status === 200 ? research.json : null,
        status: {
          sold: sold.status,
          recent: recent.status,
          balance: balance.status,
          marketOrders: marketOrders.status,
          outgoingContracts: outgoingContracts.status,
          research: research.status,
        },
      };
    `);
    supplementalData = bondData;
    bonds = summarizeBonds(bondData.sold, bondData.recent, bondData.balance);
  } catch (e) {
    bonds = summarizeBonds(null, null, null);
    bonds.error = 'live bond read failed';
  }

  let modifiersRaw = cap['/api/v2/production-modifiers/0/'];
  let modifiersSource = '/api/v2/production-modifiers/0/ (captured response)';
  let modifierCapture = normalizeProductionModifiers(modifiersRaw, Date.parse(capturedAt));
  if (!modifierCapture.ok) {
    try {
      const result = await cdp.evaluate(`const r=await api('/api/v2/production-modifiers/0/'); return {status:r.status,json:r.json};`);
      const direct = result?.status === 200
        ? normalizeProductionModifiers(result.json, Date.parse(capturedAt))
        : { ok: false, modifiers: null };
      if (direct.ok) {
        modifiersRaw = result.json;
        modifierCapture = direct;
        modifiersSource = '/api/v2/production-modifiers/0/ (direct read)';
      }
    } catch (e) {}
  }
  const modifiers = modifierCapture.ok ? modifierCapture.modifiers : null;
  const configuredRates = CFG.printedRates && typeof CFG.printedRates === 'object' ? CFG.printedRates : {};
  const printedRateAsOf = configuredRates._asOf || null;
  const printedRateAgeSeconds = ageSeconds(printedRateAsOf);
  const printedRateValues = normalizePositiveRateMap(configuredRates);
  const printedRateStatus = !Object.keys(printedRateValues).length ? 'unknown'
    : (printedRateAgeSeconds != null && printedRateAgeSeconds >= -30 &&
      printedRateAgeSeconds <= PRINTED_RATE_FRESH_SECONDS ? 'fresh' : 'stale');
  const printedRates = {
    status: printedRateStatus,
    asOf: printedRateAsOf,
    ageSeconds: printedRateAgeSeconds,
    source: configuredRates._source || 'config.printedRates',
    scope: 'Mixed building IDs and levels; values are cache anchors, never proof for a different building or current modifier.',
    values: printedRateValues,
  };
  let companyValue;
  try {
    const volumeText = fs.readFileSync(
      path.join(SHARED, 'price-tracker', 'data', 'volume.jsonl'),
      'utf8',
    );
    const facts = JSON.parse(fs.readFileSync(FACTS, 'utf8'));
    const definitions = JSON.parse(fs.readFileSync(DEFS, 'utf8')).resources;
    const referencePrices = derivePreviousDayReferencePrices(
      volumeText,
      supplementalData.balance?.date,
      aggregateVolumeRecords,
    );
    const inventoryPreview = collectInventoryLots({
      warehouse: resourcesKnown ? resourcesRaw : null,
      marketOrders: supplementalData.marketOrders,
      outgoingContracts: supplementalData.outgoingContracts,
      buildings,
      resourceDefinitions: definitions,
    });
    const requiredQualityAmounts = inventoryAmountsByQuality(inventoryPreview.lots);
    const marketKinds = [...new Set(
      Object.keys(requiredQualityAmounts)
        .map(key => Number(key.split(':')[0]))
        .filter(kind => Number.isSafeInteger(kind) && kind > 0),
    )];
    let marketSummaries = [];
    if (marketKinds.length) {
      try {
        marketSummaries = await cdp.evaluate(`
          const kinds = ${JSON.stringify(marketKinds)};
          const summaries = [];
          for (let offset = 0; offset < kinds.length; offset += 6) {
            const batch = kinds.slice(offset, offset + 6);
            const rows = await Promise.all(batch.map(async kind => {
              const response = await api('/api/v3/market/0/' + kind + '/');
              const qualities = {};
              for (const order of Array.isArray(response.json) ? response.json : []) {
                const quality = Number(order?.quality);
                const bestAsk = Number(order?.price);
                const quantity = Number(order?.quantity);
                if (!Number.isSafeInteger(quality) || quality < 0
                    || !Number.isFinite(bestAsk) || bestAsk <= 0
                    || !Number.isFinite(quantity) || quantity <= 0) continue;
                if (!qualities[quality]) {
                  qualities[quality] = {
                    quality,
                    bestAsk,
                    listedUnits: 0,
                    orderCount: 0,
                  };
                }
                qualities[quality].bestAsk = Math.min(qualities[quality].bestAsk, bestAsk);
                qualities[quality].listedUnits += quantity;
                qualities[quality].orderCount += 1;
              }
              return {
                kind,
                status: response.status,
                qualities: Object.values(qualities).sort((a, b) => a.quality - b.quality),
              };
            }));
            summaries.push(...rows);
          }
          return summaries;
        `);
      } catch (error) { /* Explicit local VWAP and sourcing-cost fallbacks remain available. */ }
    }
    const qualityMarketPrices = deriveQualityMarketPrices(
      marketSummaries,
      requiredQualityAmounts,
      { capturedAt },
    );
    companyValue = calculateCompanyValue({
      capturedAt,
      balanceSheet: supplementalData.balance,
      liveCash: auth.money ?? auth.authCompany?.money,
      liveBondsPayable: bonds.principalOutstanding,
      buildings,
      warehouse: resourcesKnown ? resourcesRaw : null,
      marketOrders: supplementalData.marketOrders,
      outgoingContracts: supplementalData.outgoingContracts,
      resourceDefinitions: definitions,
      researchProgress: supplementalData.research,
      patentRequirements: facts.mechanics?.patents_needed_per_quality,
      patentValuesByResearchKind: facts.mechanics?.patent_value_by_research_kind,
      referencePriceResult: referencePrices,
      qualityMarketPriceResult: qualityMarketPrices,
      tickerPrices: P,
    });
  } catch (error) {
    companyValue = {
      methodVersion: 3,
      capturedAt,
      official: {
        status: 'unavailable',
        asOf: supplementalData.balance?.date || null,
        total: null,
      },
      realtimeEstimate: {
        status: 'unavailable',
        total: null,
        reason: `company value calculation failed: ${String(error.message || error).slice(0, 180)}`,
      },
    };
  }
  let paUiStatus = readPaStatus(PA_STATUS_FILE);
  if (process.env.SIM_PA_SCAN === '1') {
    const paObservedAt = new Date().toISOString();
    try {
      await cdp.goto('https://www.simcompanies.com/messages/');
      const rows = await cdp.evaluate(`
        return all('a')
          .filter(anchor => (anchor.href || '').includes('/messages/') && anchor.offsetParent !== null)
          .map(anchor => ({ text: norm(anchor.innerText), href: anchor.href }));
      `);
      const parsed = parsePaUnreadRows(rows);
      paUiStatus = writePaStatus(PA_STATUS_FILE, {
        ...parsed,
        source: 'rendered-messages-ui',
      }, paObservedAt);
    } catch (error) {
      paUiStatus = writePaStatus(PA_STATUS_FILE, {
        status: 'unknown',
        unread: null,
        source: 'rendered-messages-ui',
        reason: `PA row scan failed: ${String(error.message || error).slice(0, 180)}`,
      }, paObservedAt);
    }
  }
  const pendingPa = readPendingPa(PA_PENDING_FILE);
  const authPaUnread = Number.isSafeInteger(auth.paUnread) && auth.paUnread >= 0
    ? auth.paUnread
    : null;
  const pa = derivePaState({
    uiStatus: paUiStatus,
    authUnread: authPaUnread,
    pending: pendingPa,
  });
  const sources = {
    auth: { status: 'ok', asOf: capturedAt, source: '/api/v3/companies/auth-data/' },
    buildings: {
      status: 'ok',
      asOf: capturedAt,
      source: '/api/v2/companies/me/buildings/',
      activityStatus: buildingActivityEvidence.status,
      activityKnownRows: buildingActivityEvidence.knownRows,
      activityUnknownRows: buildingActivityEvidence.unknownRows,
      activityUnknownBuildingIds: buildingActivityEvidence.unknownBuildingIds,
      pageActivityResolvedBuildingIds: storeActivityAttached ? [Number(CFG.storeId)] : [],
    },
    stock: { status: resourcesKnown ? 'ok' : 'unknown', asOf: resourcesKnown ? capturedAt : null, source: `/api/v3/resources/${CFG.companyId}/` },
    ticker: { status: tickerStatus, asOf: tickerAsOf, ageSeconds: tickerAgeSeconds, source: tickerLiveKnown ? '/api/v3/market-ticker/0/' : (trackerPriceUsed ? 'shared/price-tracker/data/prices.jsonl' : null) },
    retail: { status: retail ? 'ok' : 'unknown', asOf: retail ? capturedAt : null, source: '/api/v4/0/resources-retail-info/' },
    modifiers: { status: modifierCapture.ok ? 'ok' : 'unknown', asOf: modifierCapture.ok ? capturedAt : null, source: modifiersSource },
    volume1h: { status: volume1hMeta?.status || 'unknown', asOf: volume1hMeta?.to || null, source: 'shared/price-tracker/data/volume.jsonl' },
    weather: { status: weather ? 'ok' : 'unknown', asOf: weather ? capturedAt : null, source: '/api/v2/weather/0/' },
    pa: {
      status: pa.status,
      asOf: pa.observedAt,
      source: pa.source,
    },
    bonds: { status: bonds.status || 'unknown', asOf: capturedAt, source: 'sold bonds + balance sheet' },
    research: {
      status: Array.isArray(supplementalData.research) ? 'ok' : 'unknown',
      asOf: Array.isArray(supplementalData.research) ? capturedAt : null,
      source: '/api/v3/players/research/',
    },
    companyValue: {
      status: companyValue.realtimeEstimate?.status || 'unavailable',
      asOf: companyValue.realtimeEstimate?.asOf || null,
      source: 'live assets + live research + official balance baseline + quality-specific live market proxies',
      officialAsOf: companyValue.official?.asOf || null,
      supplementalStatus: supplementalData.status,
    },
    printedRates: { status: printedRateStatus, asOf: printedRateAsOf, ageSeconds: printedRateAgeSeconds, source: 'shared/config.json' },
  };

  const state = {
    t: capturedAt,
    sources,
    weather,
    pa,
    paUnread: pa.unread,
    money: auth.money ?? auth.authCompany?.money ?? null,
    level,
    levelingProgress,
    buildings: blds,
    baseSlotCapacity: baseSlotCapacity != null && Number.isSafeInteger(Number(baseSlotCapacity)) &&
      Number(baseSlotCapacity) >= 0
      ? Number(baseSlotCapacity)
      : null,
    extraBuildingSlots: extraBuildingSlots != null && Number.isSafeInteger(Number(extraBuildingSlots)) &&
      Number(extraBuildingSlots) >= 0
      ? Number(extraBuildingSlots)
      : null,
    slotCapacity: slots.capacity,
    usedSlots: slots.used,
    freeSlots: slots.free,
    warehouse: {
      complete: resourcesKnown,
      sourceRows: resourcesKnown ? resourcesRaw.length : null,
      positiveProductKinds: stock ? stock.filter(entry => Number(entry.amount) > 0).length : null,
      allPositiveProductsIncluded: resourcesKnown,
    },
    stock,
    bonds,
    companyValue,
    keyPrices: Object.fromEntries([1, 2, 13, 66, 115, 116, 118, 119, 5, 7, 8].map(k => [N[k] || k, P[k] ?? null])),
    printedRates,
    modifiers,
    recipes, retail, volume1h, volume1hMeta,
    flags,
    config: { minCash: CFG.minCash, farmInputFloor: CFG.farmInputFloor, factoryInputFloor: CFG.factoryInputFloor, storeId: CFG.storeId, farmId: CFG.farmId },
  };
  try {
    const facts = JSON.parse(fs.readFileSync(FACTS, 'utf8'));
    const inspectionCache = readInspectionRateCache(path.join(AUTOPILOT, '.inspection-rates.json'));
    state.surplusPlan = calculateCoffeeReservePolicy({
      state,
      inspectionCache,
      facts,
      horizonHours: 24,
      bufferPct: 0.10,
      nowMs: Date.parse(capturedAt),
    });
  } catch (error) {
    state.surplusPlan = {
      asOf: capturedAt,
      complete: false,
      status: 'unknown',
      horizonHours: 24,
      bufferPct: 0.10,
      millCapacity: { status: 'unknown', powderPerHour: null, rates: [], missingBuildingIds: [] },
      items: {},
      reason: `reserve calculation failed: ${String(error.message || error).slice(0, 180)}`,
    };
  }
  sources.surplusPlan = {
    status: state.surplusPlan.status,
    asOf: state.surplusPlan.asOf,
    source: 'autopilot/coffee-reserve-policy.js + .inspection-rates.json',
  };
  const stateFile = path.join(AUTOPILOT, '.state.json');
  const temporaryStateFile = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryStateFile, `${JSON.stringify(state, null, 1)}\n`);
  fs.renameSync(temporaryStateFile, stateFile);
  try {
    const directive = JSON.parse(
      fs.readFileSync(path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'), 'utf8'),
    );
    if (directive?.status === 'pending' &&
        directive?.prospectorExperiment?.campaign?.status === 'active') {
      const live = await cdp.evaluate(`const r=await api(${JSON.stringify(PROSPECTOR_OVERVIEW_PATH)}); return {status:r.status,json:r.json};`);
      recordOwnerProspectorOverview(
        path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'),
        {
          path: PROSPECTOR_OVERVIEW_PATH,
          status: live?.status ?? null,
          fetchedAt: capturedAt,
          data: live?.json ?? null,
        },
        Date.parse(capturedAt),
      );
    }
  } catch (_) {}
  synchronizeOwnerProspectorConstruction(
    path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'),
    state,
    Date.parse(capturedAt),
  );
  console.log(JSON.stringify({ ok: true, money: state.money, level: state.level, buildings: blds.length }));
  cdp.close(); process.exit(0);   // open ws keeps node alive -> timeout kills us -> false FAILED
})().catch(e => { console.error(JSON.stringify({ ok: false, err: e.message })); try { cdp.close(); } catch (x) {} process.exit(1); });
