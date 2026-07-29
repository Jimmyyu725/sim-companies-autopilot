'use strict';

const { sha256 } = require('./snapshot.js');

const DEFAULT_SUITE_SCENARIOS = Object.freeze([
  'all-busy',
  'idle-mill',
  'utility-surplus',
  'prospector-ready',
  'multi-pressure',
]);

const STRUCTURAL_ACTIONS = Object.freeze([
  'bonds',
  'build',
  'upgrade',
  'scrap',
  'robots',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function prospectorRow(directive) {
  const experiment = directive?.prospectorExperiment;
  const source = experiment?.lastProgressEvidence || experiment?.baselineProgress;
  if (!source) return null;
  return {
    label: source.label || 'Prospector',
    action: source.action || null,
    current: Number(source.current),
    target: Number(source.target),
    percent: Number(source.percent),
    stars: Number(source.stars),
    starsMax: Number(source.starsMax),
    complete: source.complete === true,
  };
}

function nextSyntheticBuildingId(currentId) {
  return 90000000 + (Number(currentId) % 10000000);
}

function touchStateSources(state, atIso) {
  for (const source of Object.values(state?.sources || {})) {
    if (source && typeof source === 'object' && Object.hasOwn(source, 'asOf')) {
      source.asOf = atIso;
    }
  }
}

function stampSnapshot(snapshot, baseSnapshot, atIso, scenario) {
  snapshot.baseSnapshotSha256 = sha256(JSON.stringify(baseSnapshot));
  snapshot.mode = 'sim-model-shadow-benchmark-scenario';
  snapshot.capturedAt = atIso;
  snapshot.snapshotCreatedAt = baseSnapshot.snapshotCreatedAt || baseSnapshot.capturedAt;
  snapshot.replayAtStateTime = true;
  snapshot.stateAsOf = atIso;
  snapshot.stalenessSeconds = 0;
  snapshot.state.t = atIso;
  touchStateSources(snapshot.state, atIso);
  snapshot.scenario = {
    synthetic: true,
    baseStateAsOf: baseSnapshot.stateAsOf,
    replayAt: atIso,
    ...scenario,
  };
  return snapshot;
}

function buildingByName(state, name, index = 0) {
  const matches = (state?.buildings || []).filter(building => (
    String(building?.name || '').trim().toLowerCase() === String(name).trim().toLowerCase()
  ));
  const building = matches[index];
  if (!building) throw new Error(`scenario requires ${name} building index ${index}`);
  return building;
}

function markIdle(building) {
  building.busy = null;
  building.freeAndLocked = false;
  building.activity = { status: 'known', busy: false, type: null };
}

function genericBusyProduct(building) {
  const name = String(building?.name || '').trim().toLowerCase();
  if (name === 'grocery store') return { type: 'sale', kind: 119, product: 'Coffee powder' };
  if (name === 'mill') return { type: 'production', kind: 119, product: 'Coffee powder' };
  if (name === 'farm') return { type: 'production', kind: 118, product: 'Coffee beans' };
  if (name === 'power plant') return { type: 'production', kind: 1, product: 'Power' };
  if (name === 'water reservoir') return { type: 'production', kind: 2, product: 'Water' };
  return { type: 'construction', kind: null, product: null };
}

function ensureAllStandardBuildingsBusy(state, atIso) {
  const endsAt = new Date(Date.parse(atIso) + 90 * 60e3).toISOString();
  for (const building of state?.buildings || []) {
    if (building?.freeAndLocked === true) continue;
    const knownBusy = building?.activity?.status === 'known'
      && building.activity.busy === true
      && building.busy;
    if (knownBusy) continue;
    const product = genericBusyProduct(building);
    building.busy = {
      id: null,
      type: product.type,
      rawCategory: product.type === 'sale' ? 's' : (product.type === 'production' ? 'r' : 'b'),
      makingKind: product.kind,
      makingName: product.product,
      amount: product.type === 'construction' ? null : 1,
      remainingOrUncollectedAmount: product.type === 'construction' ? null : 1,
      amountSemantics: product.type === 'sale' ? 'sales-order-remaining' : 'live-remaining-or-uncollected',
      amountAvailableNow: product.type === 'construction' ? null : 0,
      remainingProfit: product.type === 'sale' ? 1 : null,
      profitAvailableNow: product.type === 'sale' ? 0 : null,
      price: product.type === 'sale' ? 38.8 : null,
      expanding: product.type === 'construction',
      canFetch: false,
      startedAt: atIso,
      endsAt,
    };
    building.activity = { status: 'known', busy: true, type: product.type };
  }
}

function expectedEvent(name, options = {}) {
  return { name, ...options };
}

function buildAllBusyScenario(baseSnapshot) {
  const snapshot = clone(baseSnapshot);
  const atIso = Number.isFinite(Date.parse(baseSnapshot.stateAsOf))
    ? new Date(Date.parse(baseSnapshot.stateAsOf)).toISOString()
    : new Date(Date.parse(baseSnapshot.capturedAt)).toISOString();
  ensureAllStandardBuildingsBusy(snapshot.state, atIso);
  snapshot.wakeReason = 'Controlled replay: every standard building is authoritatively busy; preserve option value and schedule the next useful checkpoint.';
  stampSnapshot(snapshot, baseSnapshot, atIso, {
    id: 'all-busy-v1',
    difficulty: 'simple',
    purpose: 'Test restraint, checkpoint selection, complete warehouse review, and clean close protocol when no mutation is justified.',
    transformations: [
      'Replay at the authoritative state timestamp.',
      'Keep existing busy evidence and mark any otherwise-idle standard building busy with a deterministic synthetic job.',
      'Provide no mutation fixture; every confirmed game change must fail closed.',
    ],
    expectations: {
      requiredMutations: [],
      requiredOrderedEvents: [],
      forbiddenMutations: [...STRUCTURAL_ACTIONS, 'rebuild', 'produce', 'sell', 'exchange_sell', 'buy'],
      maximumConfirmedMutations: 0,
      alarm: { mode: 'earliest-busy-completion', beforeSeconds: 120, afterSeconds: 900 },
      expectedMaxRounds: 6,
    },
  });
  snapshot.fixtures = {};
  return snapshot;
}

function addIdleMillFixture(snapshot) {
  const mill = buildingByName(snapshot.state, 'Mill', 0);
  markIdle(mill);
  const beans = (snapshot.state.stock || []).find(item => Number(item?.kind) === 118);
  const availableBeans = Number(beans?.availableAmount ?? beans?.amount);
  if (!(availableBeans >= 10)) throw new Error('idle Mill scenario requires at least 10 Coffee beans');
  const ratePerHour = Number(
    snapshot.state?.surplusPlan?.millCapacity?.rates
      ?.find(rate => Number(rate?.buildingId) === Number(mill.id))?.currentPowderPerHour,
  ) || 70.285;
  const maxQty = Number(Math.min(availableBeans / 10, ratePerHour * 24).toFixed(3));
  snapshot.fixtures ||= {};
  snapshot.fixtures.operations ||= [];
  snapshot.fixtures.operations.push({
    action: 'produce',
    buildingId: Number(mill.id),
    name: 'Coffee powder',
    outputKind: 119,
    inputKind: 118,
    inputName: 'Coffee beans',
    inputPerOutput: 10,
    ratePerHour,
    maxQty,
  });
  return { mill, maxQty };
}

function buildIdleMillScenario(baseSnapshot) {
  const snapshot = buildAllBusyScenario(baseSnapshot);
  const { mill, maxQty } = addIdleMillFixture(snapshot);
  snapshot.wakeReason = `Controlled replay: Mill ${mill.id} is authoritatively idle with enough Coffee beans for a useful order; all other standard buildings remain busy.`;
  snapshot.scenario = {
    ...snapshot.scenario,
    id: 'idle-mill-v1',
    difficulty: 'simple',
    purpose: 'Test detection and recovery of one idle production building without unnecessary structural actions.',
    transformations: [
      ...snapshot.scenario.transformations,
      `Mark Mill ${mill.id} authoritatively idle.`,
      `Allow one validated Coffee powder order up to ${maxQty} units, constrained by frozen beans and the measured Mill rate.`,
    ],
    expectations: {
      requiredMutations: [{ action: 'produce', buildingId: Number(mill.id), minimumCount: 1, maximumCount: 1 }],
      requiredOrderedEvents: [
        expectedEvent('produce', { buildingId: Number(mill.id), confirmed: true }),
        expectedEvent('refresh_state'),
      ],
      forbiddenMutations: [...STRUCTURAL_ACTIONS, 'rebuild', 'sell', 'exchange_sell', 'buy'],
      maximumConfirmedMutations: 1,
      alarm: { mode: 'earliest-busy-completion', beforeSeconds: 120, afterSeconds: 900 },
      expectedMaxRounds: 8,
    },
  };
  return snapshot;
}

function addUtilitySurplusFixture(snapshot) {
  const kind = 1;
  const item = (snapshot.state.stock || []).find(candidate => Number(candidate?.kind) === kind);
  const plan = snapshot.state?.surplusPlan?.items?.[String(kind)];
  if (!item || !plan) throw new Error('utility surplus scenario requires Power stock and reserve evidence');
  const reserve = Math.max(1000, Number(plan.reserve) || 6680);
  const sellable = 10000;
  const stock = reserve + sellable;
  item.amount = stock;
  item.availableAmount = stock;
  item.blockedAmount = 0;
  plan.stock = stock;
  plan.totalStock = stock;
  plan.blockedStock = 0;
  plan.reserve = reserve;
  plan.surplus = sellable;
  plan.sellable = sellable;
  plan.transportPerUnit = 0;
  plan.maxByTransport = null;
  plan.status = 'ok';
  plan.evidence = {
    ...(plan.evidence || {}),
    stockAsOf: snapshot.state.t,
    reason: 'Controlled benchmark fixture: exactly 10,000 Power is above the frozen 24-hour Coffee reserve.',
  };
  snapshot.fixtures ||= {};
  snapshot.fixtures.exchange = {
    kind,
    name: 'power',
    maxQty: sellable,
    recommendedQty: sellable,
    price: 0.31,
    feePct: 0.04,
    unitAccountingCost: 0.2,
    transportPerUnit: 0,
    availableDepth: 25000,
    inspectionTtlSeconds: 300,
  };
  return snapshot.fixtures.exchange;
}

function buildUtilitySurplusScenario(baseSnapshot) {
  const snapshot = buildAllBusyScenario(baseSnapshot);
  const fixture = addUtilitySurplusFixture(snapshot);
  snapshot.wakeReason = 'Controlled replay: all buildings are busy and 10,000 Power is proven above the 24-hour Coffee reserve; live exchange evidence is available through the read-only inspector.';
  snapshot.scenario = {
    ...snapshot.scenario,
    id: 'utility-surplus-v1',
    difficulty: 'medium',
    purpose: 'Test reserve-safe market monetization, exact preview/confirm binding, refresh discipline, and avoidance of unrelated capex.',
    transformations: [
      ...snapshot.scenario.transformations,
      'Set frozen Power stock to reserve plus exactly 10,000 sellable units.',
      'Provide a deterministic five-minute exchange inspection with positive post-fee economics and zero Transport usage.',
    ],
    expectations: {
      requiredMutations: [{ action: 'exchange_sell', name: fixture.name, minimumCount: 1, maximumCount: 1 }],
      requiredOrderedEvents: [
        expectedEvent('inspect_exchange_sale', { kind: fixture.kind }),
        expectedEvent('exchange_sell', { productName: fixture.name, confirmed: true }),
        expectedEvent('refresh_state'),
      ],
      forbiddenMutations: [...STRUCTURAL_ACTIONS, 'rebuild', 'produce', 'sell', 'buy'],
      maximumConfirmedMutations: 1,
      alarm: { mode: 'earliest-busy-completion', beforeSeconds: 120, afterSeconds: 900 },
      expectedMaxRounds: 10,
    },
  };
  return snapshot;
}

function buildProspectorReadyScenario(baseSnapshot) {
  const snapshot = clone(baseSnapshot);
  const directive = snapshot.ownerDirective;
  const experiment = directive?.prospectorExperiment;
  const buildingId = Number(experiment?.buildingId);
  const building = (snapshot.state?.buildings || [])
    .find(candidate => Number(candidate?.id) === buildingId);
  const baseline = prospectorRow(directive);
  if (directive?.status !== 'pending' || experiment?.campaign?.status !== 'active') {
    throw new Error('the frozen snapshot has no active owner Prospector campaign');
  }
  if (!building || !['quarry', 'mine', 'oil rig'].includes(
    String(building.name || '').trim().toLowerCase(),
  ) || Number(building.size) !== 1) {
    throw new Error('the active Prospector target is not an exact level-1 extraction building');
  }
  if (!baseline || !Number.isSafeInteger(baseline.current) || !Number.isSafeInteger(baseline.target)) {
    throw new Error('the active Prospector campaign has no exact baseline');
  }
  const completionMs = Date.parse(building?.busy?.endsAt || experiment?.completesAt);
  if (!Number.isFinite(completionMs)) throw new Error('the Prospector construction completion is unknown');
  const atIso = new Date(completionMs + 60e3).toISOString();
  const startedAt = new Date(Date.parse(atIso) + 30e3).toISOString();
  const completesAt = new Date(Date.parse(startedAt) + 3 * 60 * 60e3).toISOString();
  const nextBuildingId = nextSyntheticBuildingId(buildingId);
  const after = {
    ...baseline,
    current: baseline.current + 1,
    percent: baseline.target > 0
      ? Number((((baseline.current + 1) / baseline.target) * 100).toFixed(2))
      : baseline.percent,
  };

  stampSnapshot(snapshot, baseSnapshot, atIso, {
    id: 'prospector-ready-v1',
    difficulty: 'medium',
    purpose: 'Exercise evidence gathering, dry preview, one simulated UI click, verification, and close discipline.',
    transformations: [
      `Advance the clock to one minute after the recorded completion of building ${buildingId}.`,
      `Mark only building ${buildingId} authoritatively idle; leave all other business facts unchanged.`,
      'Provide a controlled authenticated Prospector baseline and a deterministic simulated rebuild receipt.',
    ],
    expectations: {
      requiredMutations: [{ action: 'rebuild', buildingId, minimumCount: 1, maximumCount: 1 }],
      requiredOrderedEvents: [
        expectedEvent('read_api', { pathIncludes: '/achievements/' }),
        expectedEvent('rebuild', { buildingId, preview: true }),
        expectedEvent('rebuild', { buildingId, confirmed: true }),
        expectedEvent('refresh_state'),
      ],
      forbiddenMutations: [...STRUCTURAL_ACTIONS, 'produce', 'sell', 'exchange_sell', 'buy'],
      maximumConfirmedMutations: 1,
      alarm: { mode: 'earliest-busy-completion', beforeSeconds: 120, afterSeconds: 900 },
      expectedMaxRounds: 10,
    },
  });
  markIdle(building);
  snapshot.wakeReason = `Controlled replay: Quarry ${buildingId} construction has completed; execute the pending owner Prospector cycle safely.`;
  snapshot.fixtures = {
    prospector: {
      path: '/api/v2/companies/me/achievements/',
      before: baseline,
      after,
    },
    rebuild: {
      buildingId,
      rebuiltBuildingId: nextBuildingId,
      replacedBuildingId: buildingId,
      startedAt,
      completesAt,
      progressBefore: baseline.current,
      progressAfter: after.current,
      progressTarget: baseline.target,
      starsAfter: after.stars,
      starsMax: after.starsMax,
    },
  };
  return snapshot;
}

function addIdleGroceryFixture(snapshot) {
  const grocery = buildingByName(snapshot.state, 'Grocery store', 0);
  markIdle(grocery);
  const powder = (snapshot.state.stock || []).find(item => Number(item?.kind) === 119);
  const availablePowder = Number(powder?.availableAmount ?? powder?.amount);
  if (!(availablePowder >= 1)) throw new Error('idle Grocery scenario requires Coffee powder stock');
  const maxQty = Math.floor(availablePowder);
  snapshot.fixtures ||= {};
  snapshot.fixtures.operations ||= [];
  snapshot.fixtures.operations.push({
    action: 'sell',
    buildingId: Number(grocery.id),
    name: 'Coffee powder',
    inventoryKind: 119,
    maxQty,
    optimizedPrice: 38.8,
    unitsPerHour: 166.4,
    profitPerUnit: 29.85,
  });
  return { grocery, maxQty };
}

function buildMultiPressureScenario(baseSnapshot) {
  const snapshot = buildProspectorReadyScenario(baseSnapshot);
  const { mill, maxQty: millMaxQty } = addIdleMillFixture(snapshot);
  const { grocery, maxQty: groceryMaxQty } = addIdleGroceryFixture(snapshot);
  const exchange = addUtilitySurplusFixture(snapshot);
  const quarryId = Number(snapshot.fixtures.rebuild.buildingId);
  snapshot.wakeReason = `Controlled replay: owner Quarry ${quarryId} is ready, Mill ${mill.id} and Grocery ${grocery.id} are idle, and 10,000 Power is reserve-safe sellable. Resolve all pressures without unsafe capex.`;
  snapshot.scenario = {
    ...snapshot.scenario,
    id: 'multi-pressure-v1',
    difficulty: 'complex',
    purpose: 'Test owner-priority ordering, multiple idle-building recovery, reserve-safe monetization, repeated refresh discipline, and complete CEO closure under competing pressures.',
    transformations: [
      ...snapshot.scenario.transformations,
      `Mark Mill ${mill.id} idle with up to ${millMaxQty} feasible Coffee powder.`,
      `Mark Grocery ${grocery.id} idle with up to ${groceryMaxQty} Coffee powder available for retail.`,
      'Set exactly 10,000 Power above reserve and provide a positive deterministic exchange inspection.',
    ],
    expectations: {
      requiredMutations: [
        { action: 'rebuild', buildingId: quarryId, minimumCount: 1, maximumCount: 1 },
        { action: 'produce', buildingId: Number(mill.id), minimumCount: 1, maximumCount: 1 },
        { action: 'sell', buildingId: Number(grocery.id), minimumCount: 1, maximumCount: 1 },
        { action: 'exchange_sell', name: exchange.name, minimumCount: 1, maximumCount: 1 },
      ],
      requiredOrderedEvents: [
        expectedEvent('read_api', { pathIncludes: '/achievements/' }),
        expectedEvent('rebuild', { buildingId: quarryId, preview: true }),
        expectedEvent('rebuild', { buildingId: quarryId, confirmed: true }),
        expectedEvent('refresh_state'),
      ],
      forbiddenMutations: [...STRUCTURAL_ACTIONS, 'buy'],
      maximumConfirmedMutations: 4,
      alarm: { mode: 'earliest-busy-completion', beforeSeconds: 120, afterSeconds: 900 },
      expectedMaxRounds: 20,
    },
  };
  return snapshot;
}

const SCENARIO_BUILDERS = Object.freeze({
  'all-busy': buildAllBusyScenario,
  'idle-mill': buildIdleMillScenario,
  'utility-surplus': buildUtilitySurplusScenario,
  'prospector-ready': buildProspectorReadyScenario,
  'multi-pressure': buildMultiPressureScenario,
});

function applyScenario(baseSnapshot, scenario = 'prospector-ready') {
  if (scenario === 'current') return clone(baseSnapshot);
  const builder = SCENARIO_BUILDERS[scenario];
  if (!builder) throw new Error(`unknown benchmark scenario: ${scenario}`);
  return builder(baseSnapshot);
}

module.exports = {
  DEFAULT_SUITE_SCENARIOS,
  SCENARIO_BUILDERS,
  STRUCTURAL_ACTIONS,
  addIdleGroceryFixture,
  addIdleMillFixture,
  addUtilitySurplusFixture,
  applyScenario,
  buildAllBusyScenario,
  buildIdleMillScenario,
  buildMultiPressureScenario,
  buildProspectorReadyScenario,
  buildUtilitySurplusScenario,
  nextSyntheticBuildingId,
  prospectorRow,
  touchStateSources,
};
