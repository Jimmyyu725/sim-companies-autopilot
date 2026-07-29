'use strict';

const { sha256 } = require('./snapshot.js');

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

  snapshot.baseSnapshotSha256 = sha256(JSON.stringify(baseSnapshot));
  snapshot.mode = 'sim-model-shadow-benchmark-scenario';
  snapshot.capturedAt = atIso;
  snapshot.snapshotCreatedAt = baseSnapshot.snapshotCreatedAt || baseSnapshot.capturedAt;
  snapshot.replayAtStateTime = true;
  snapshot.stateAsOf = atIso;
  snapshot.stalenessSeconds = 0;
  snapshot.state.t = atIso;
  touchStateSources(snapshot.state, atIso);
  building.busy = null;
  building.freeAndLocked = false;
  building.activity = { status: 'known', busy: false, type: null };
  snapshot.wakeReason = `Controlled replay: Quarry ${buildingId} construction has completed; execute the pending owner Prospector cycle safely.`;
  snapshot.scenario = {
    id: 'prospector-ready-v1',
    synthetic: true,
    purpose: 'Exercise evidence gathering, dry preview, one simulated UI click, verification, and close discipline.',
    baseStateAsOf: baseSnapshot.stateAsOf,
    replayAt: atIso,
    transformations: [
      `Advance the clock to one minute after the recorded completion of building ${buildingId}.`,
      `Mark only building ${buildingId} authoritatively idle; leave all other business facts unchanged.`,
      'Provide a controlled authenticated Prospector baseline and a deterministic simulated rebuild receipt.',
    ],
  };
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

function applyScenario(baseSnapshot, scenario = 'prospector-ready') {
  if (scenario === 'current') return clone(baseSnapshot);
  if (scenario === 'prospector-ready') return buildProspectorReadyScenario(baseSnapshot);
  throw new Error(`unknown benchmark scenario: ${scenario}`);
}

module.exports = {
  applyScenario,
  buildProspectorReadyScenario,
  nextSyntheticBuildingId,
  prospectorRow,
  touchStateSources,
};
