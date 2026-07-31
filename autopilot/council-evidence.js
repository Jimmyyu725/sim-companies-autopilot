#!/usr/bin/env node
'use strict';

// Gather one shared, read-only evidence snapshot before CFO/COO/CMO deliberate. The three roles
// receive different projections of the same facts so they do not race the browser or invent data.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cdp = require(path.join(__dirname, '..', 'shared', 'cdp.js'));
const cfg = require(path.join(__dirname, '..', 'shared', 'config.json'));
const {
  compactStatement,
  normalizeMarketKinds,
  signedAgeSeconds,
  summarizeBondOfferForm,
  summarizeBookRows,
  summarizeCachedBook,
  summarizeStateAuthority,
} = require('./council-evidence-helpers.js');
const {
  buildCouncilDecisionModel,
  compactBuildingInspection,
  selectPortfolioBuildings,
} = require('./council-operating-model.js');

const FACTS_FILE = path.join(__dirname, '..', 'shared', 'facts', 'game-facts.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function freshRuntimePreview(value, nowMs = Date.now()) {
  const previewedAtMs = Date.parse(value?.previewedAt);
  const ageSeconds = Number.isFinite(previewedAtMs) ? (Number(nowMs) - previewedAtMs) / 1000 : NaN;
  return value?.source === 'runtime-verified-structural-preview' &&
    value?.preview?.ok === true &&
    (value.preview.preview === true || value.preview.dry === true) &&
    Number.isFinite(ageSeconds) && ageSeconds >= -30 && ageSeconds <= 600;
}

function parseArgs(raw) {
  const value = raw ? JSON.parse(raw) : {};
  const buildingId = value.buildingId == null ? null : Number(value.buildingId);
  if (buildingId != null && (!Number.isInteger(buildingId) || buildingId <= 0)) {
    throw new Error('buildingId must be a positive integer or null');
  }
  const reviewType = value.reviewType === 'strategy' ? 'strategy' : 'authorization';
  const strategyCandidates = Array.isArray(value.strategyCandidates)
    ? value.strategyCandidates.filter(candidate => freshRuntimePreview(candidate)).slice(0, 5)
    : [];
  const authorizationPreview = freshRuntimePreview(value.authorizationPreview)
    ? value.authorizationPreview
    : null;
  return {
    buildingId,
    marketKinds: normalizeMarketKinds(value.marketKinds),
    reviewType,
    strategyCandidates,
    authorizationPreview,
  };
}

function relevantStock(state, kinds) {
  const wanted = new Set(kinds.concat([1, 2, 66, 118, 119]));
  return (state.stock || []).filter(item => wanted.has(Number(item.kind)));
}

function namedRetail(state) {
  if (!Array.isArray(state.retail)) return 'UNKNOWN';
  const facts = readJson(FACTS_FILE, { resources: {} });
  const rows = [];
  for (const kind of [119, 7, 8, 5, 3, 4]) {
    const resource = facts.resources?.[kind];
    const match = (state.retail || []).find(row => row.dbLetter === resource?.dbLetter);
    if (match) rows.push({ kind, name: resource.name || `kind ${kind}`, ...match });
  }
  return rows;
}

function inspectBuilding(buildingId) {
  if (!buildingId) return null;
  try {
    const out = execFileSync('node', [path.join(__dirname, 'inspect-building.js'), JSON.stringify({
      buildingId, product: null, qty: null,
    })], { cwd: path.dirname(__dirname), timeout: 120000, encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 300) };
  }
}

function refreshCouncilState() {
  try {
    const out = execFileSync('node', [path.join(__dirname, 'state.js')], {
      cwd: path.dirname(__dirname),
      timeout: 160000,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const captured = JSON.parse(out.trim().split('\n').pop());
    const persisted = readJson(path.join(__dirname, '.state.json'), {});
    return {
      status: captured?.ok === true && persisted?.t ? 'OK' : 'UNKNOWN',
      asOf: persisted?.t || null,
      source: 'autopilot/state.js under the Council browser lock',
    };
  } catch (error) {
    return {
      status: 'ERROR',
      asOf: null,
      source: 'autopilot/state.js under the Council browser lock',
      error: String(error.message || error).slice(0, 240),
    };
  }
}

function inspectRetailCurve(state) {
  const store = (state.buildings || []).find(building =>
    String(building?.name || '').trim().toLowerCase() === 'grocery store');
  if (!store) return { ok: false, status: 'NO_GROCERY', best: null, tested: [] };
  if (store.busy && typeof store.busy === 'object') {
    return {
      ok: true,
      status: Number(store.busy.makingKind) === 119 && store.busy.type === 'sale'
        ? 'ACTIVE_ORDER_PRESENT'
        : 'STORE_BUSY',
      buildingId: Number(store.id),
      best: null,
      tested: [],
    };
  }
  const powder = (state.stock || []).find(item => Number(item?.kind) === 119);
  const available = Number(powder?.availableAmount ?? powder?.amount);
  const anchorPrice = Number(state.keyPrices?.['coffee ground'] ?? powder?.exchPrice);
  if (!Number.isFinite(available) || available < 1) {
    return { ok: true, status: 'NO_POWDER_STOCK', buildingId: Number(store.id), best: null, tested: [] };
  }
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    return { ok: true, status: 'NO_PRICE_ANCHOR', buildingId: Number(store.id), best: null, tested: [] };
  }
  try {
    const out = execFileSync('node', [path.join(__dirname, 'inspect-retail-curve.js'), JSON.stringify({
      buildingId: Number(store.id),
      name: 'COFFEE POWDER',
      qty: Math.min(100, Math.floor(available)),
      anchorPrice,
    })], { cwd: path.dirname(__dirname), timeout: 90000, encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    return { ok: false, status: 'ERROR', error: String(error.message || error).slice(0, 300), best: null, tested: [] };
  }
}

function collectPortfolioInspections(state, focusBuildingId) {
  const targets = selectPortfolioBuildings(state, focusBuildingId);
  const rawInspections = targets.map(target => {
    const stateBuilding = (state.buildings || []).find(building =>
      Number(building?.id) === Number(target.buildingId));
    return compactBuildingInspection(inspectBuilding(target.buildingId), stateBuilding);
  });
  const assessedAtMs = Date.now();
  const inspections = rawInspections.map(compact => {
    const ageSeconds = compact.inspectedAt
      ? signedAgeSeconds(compact.inspectedAt, assessedAtMs)
      : null;
    const fresh = compact.ok === true && ageSeconds != null && ageSeconds >= -30 && ageSeconds <= 180;
    return { ...compact, fresh, ageSeconds };
  });
  const portfolioTargets = targets;
  const freshPortfolioIds = new Set(inspections
    .filter(inspection => inspection.fresh === true)
    .map(inspection => Number(inspection.buildingId)));
  const missingPortfolioIds = portfolioTargets
    .map(target => Number(target.buildingId))
    .filter(buildingId => !freshPortfolioIds.has(buildingId));
  const focusInspection = focusBuildingId == null
    ? null
    : inspections.find(inspection => Number(inspection.buildingId) === Number(focusBuildingId));
  return {
    targets,
    inspections,
    freshInspections: inspections.filter(inspection => inspection.fresh === true),
    focusInspection,
    portfolioTargetCount: portfolioTargets.length,
    portfolioInspectedCount: freshPortfolioIds.size,
    missingPortfolioIds,
    portfolioStatus: portfolioTargets.length === 0
      ? 'UNKNOWN'
      : (missingPortfolioIds.length === 0 ? 'OK' : 'PARTIAL'),
  };
}

async function main() {
  const args = parseArgs(process.argv[2]);
  // A strategy prompt may spend minutes preparing candidates before Council starts. Refresh inside
  // the same browser lock so the richer portfolio scan cannot age an earlier snapshot past the
  // deterministic freshness boundary while advisors are being assembled.
  const councilStateRefresh = refreshCouncilState();
  const state = readJson(path.join(__dirname, '.state.json'), {});
  const facts = readJson(FACTS_FILE, { resources: {} });
  const portfolio = collectPortfolioInspections(state, args.buildingId);
  const retailCurve = inspectRetailCurve(state);

  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/finance/');
  const financePageRaw = await cdp.evaluate(String.raw`
    const text = document.body.innerText || '';
    const section = all('div').filter(div => /Adjust issued bonds/i.test(div.innerText || '') &&
      div.querySelectorAll('input').length >= 2).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    const inputs = section ? all('input', section).filter(input => input.type !== 'checkbox') : [];
    return {
      source: location.pathname,
      status: /Adjust issued bonds/i.test(text) ? 200 : 'UNKNOWN',
      rating: (text.match(/Rating\s*([A-Z][+-]?)/) || [])[1] || 'UNKNOWN',
      offerAmountField: inputs[0]?.value ?? 'UNKNOWN',
      offerInterestField: inputs[1]?.value ?? 'UNKNOWN',
    };
  `);
  const financePage = summarizeBondOfferForm(financePageRaw);

  const paths = {
    incomeStatement: '/api/v2/companies/me/income-statement/',
    balanceSheet: '/api/v2/companies/me/balance-sheet/',
    cashflowStatement: '/api/v2/companies/me/cashflow-statement/',
    cashflowRecent: '/api/v2/companies/me/cashflow/recent/',
    bondsSold: '/api/v2/companies/me/bonds/sold/',
    bondOffer: '/api/bonds/',
  };
  const live = await cdp.evaluate(String.raw`
    const paths = ${JSON.stringify(paths)};
    const marketKinds = ${JSON.stringify(args.marketKinds)};
    const finance = {};
    for (const [name, endpoint] of Object.entries(paths)) {
      try { const result = await api(endpoint); finance[name] = { status: result.status, json: result.json ?? null }; }
      catch (error) { finance[name] = { status: 'ERROR', error: String(error.message || error) }; }
    }
    const markets = {};
    for (const kind of marketKinds) {
      try {
        const result = await api('/api/v3/market/0/' + kind + '/');
        markets[kind] = { status: result.status, json: result.status === 200 ? result.json : null };
        if (result.status === 429) break;
      } catch (error) { markets[kind] = { status: 'ERROR', error: String(error.message || error) }; }
      await sleep(500);
    }
    return { finance, markets };
  `);
  cdp.close();

  const collectedAtMs = Date.now();
  const collectedAt = new Date(collectedAtMs).toISOString();
  const stateAuthority = summarizeStateAuthority(state, collectedAtMs);
  const inspectionAgeSeconds = portfolio.focusInspection?.ageSeconds ?? null;
  const inspectionFresh = args.buildingId != null && portfolio.focusInspection?.fresh === true;
  const bookState = readJson(path.join(__dirname, '..', 'shared', 'price-tracker', 'data', 'book-state.json'), { books: {} });
  const marketBooks = args.marketKinds.map(kind => {
    const direct = live.markets?.[kind];
    if (direct?.status === 200 && Array.isArray(direct.json)) {
      const summary = summarizeBookRows(kind, direct.json, collectedAt,
        `/api/v3/market/0/${kind}/`, 200);
      summary.ageSeconds = 0;
      summary.freshness = summary.status === 200 ? 'FRESH' : 'STALE';
      return summary;
    }
    const cached = summarizeCachedBook(kind, bookState.books?.[kind], collectedAtMs);
    cached.liveStatus = direct?.status ?? 'NOT_REQUESTED';
    return cached;
  });

  const statements = {
    incomeStatement: compactStatement(paths.incomeStatement, live.finance?.incomeStatement),
    balanceSheet: compactStatement(paths.balanceSheet, live.finance?.balanceSheet),
    cashflowStatement: compactStatement(paths.cashflowStatement, live.finance?.cashflowStatement),
    cashflowRecent: compactStatement(paths.cashflowRecent, live.finance?.cashflowRecent),
    bondOffer: {
      ...compactStatement(paths.bondOffer, live.finance?.bondOffer),
      representsOutstandingDebt: false,
      outstandingPrincipalSource: 'state.bonds.principalOutstanding',
      note: 'Offer configuration only; amount 0 is not an outstanding-debt balance.',
    },
  };
  const sold = live.finance?.bondsSold;
  statements.bondsSold = sold?.status === 200 && Array.isArray(sold.json)
    ? { source: paths.bondsSold, status: 200, count: sold.json.length, value: sold.json.map(record => ({
      units: record.amount, interestPctPerDay: record.interest, purchasedAt: record.purchased_at,
      missedPayments: record.missed_payments,
    })) }
    : { source: paths.bondsSold, status: sold?.status ?? 'UNKNOWN', value: 'UNKNOWN' };

  const candidates = args.reviewType === 'strategy'
    ? args.strategyCandidates
    : (args.authorizationPreview ? [args.authorizationPreview] : []);
  const decisionModel = buildCouncilDecisionModel({
    state,
    inspections: portfolio.freshInspections,
    facts,
    retailCurve,
    candidates,
  });

  const meta = {
    collectedAt,
    stateAsOf: state.t || null,
    stateAgeSeconds: stateAuthority.stateAgeSeconds,
    stateFreshness: stateAuthority.stateFreshness,
    coreSourcesFresh: stateAuthority.coreSourcesFresh,
    warehouseComplete: stateAuthority.warehouseComplete,
    buildingInspection: args.buildingId ? (inspectionFresh ? 'OK' : 'UNKNOWN') : 'NOT_REQUESTED',
    buildingInspectionAgeSeconds: args.buildingId ? inspectionAgeSeconds : null,
    portfolioInspection: portfolio.portfolioStatus,
    portfolioTargetCount: portfolio.portfolioTargetCount,
    portfolioInspectedCount: portfolio.portfolioInspectedCount,
    portfolioMissingBuildingIds: portfolio.missingPortfolioIds,
    retailEvidence: decisionModel.coffeeChain?.retailEvidence?.status || retailCurve.status || 'UNKNOWN',
    decisionModel: decisionModel.status,
    councilStateRefresh,
    financePage: financePage.status,
    marketKinds: args.marketKinds,
  };
  const shared = {
    meta,
    // Keep the automatic operating model ahead of larger role payloads so bounded transport
    // always preserves the same bottleneck and payback evidence for all three advisors.
    decisionModel,
    sourceStatus: state.sources || 'UNKNOWN',
    company: { cash: state.money ?? 'UNKNOWN', level: state.level ?? 'UNKNOWN', minCash: state.config?.minCash ?? 'UNKNOWN' },
  };
  const roles = {
    CFO: {
      ...shared,
      financePage,
      debt: state.bonds || 'UNKNOWN',
      statements,
    },
    COO: {
      ...shared,
      slots: { capacity: state.slotCapacity, used: state.usedSlots, free: state.freeSlots },
      buildings: state.buildings || 'UNKNOWN',
      warehouse: state.warehouse || 'UNKNOWN',
      stock: Array.isArray(state.stock) ? relevantStock(state, args.marketKinds) : 'UNKNOWN',
      modifiers: Array.isArray(state.modifiers) ? state.modifiers : 'UNKNOWN',
      printedRates: state.printedRates ?? 'UNKNOWN',
      buildingInspection: portfolio.focusInspection || 'NOT_REQUESTED',
      portfolioInspections: portfolio.inspections,
    },
    CMO: {
      ...shared,
      groceryRetailEvidence: decisionModel.coffeeChain?.retailEvidence || 'UNKNOWN',
      weather: state.weather || 'UNKNOWN',
      retail: namedRetail(state),
      keyPrices: state.keyPrices || 'UNKNOWN',
      volume1h: state.volume1h || 'UNKNOWN',
      volume1hMeta: state.volume1hMeta || 'UNKNOWN',
      marketBooks,
    },
  };
  console.log(JSON.stringify({ ok: true, meta, roles }));
}

main().then(() => process.exit(0)).catch(error => {
  try { cdp.close(); } catch (_) {}
  console.log(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 500) }));
  process.exit(0);
});
