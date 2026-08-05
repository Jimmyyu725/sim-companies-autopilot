'use strict';

const {
  validatePageActivityInspection,
} = require('./building-page-activity.js');

const MAX_STATE_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_SKEW_SECONDS = 30;
const OPERATIONAL_CATEGORIES = new Set(['production', 'sales']);

function effectiveBuildingActivity(building, nowMs) {
  const category = String(building?.category || '').trim().toLowerCase();
  const inspection = validatePageActivityInspection(
    building,
    building?.activityInspection,
    nowMs,
  );
  if (Object.prototype.hasOwnProperty.call(building || {}, 'busy')
      && building.busy !== undefined) {
    if (building.busy === null) {
      return { status: 'known', busy: false, type: 'idle', source: 'authoritative-state' };
    }
    if (!building.busy || typeof building.busy !== 'object' || Array.isArray(building.busy)) {
      return { status: 'unknown', busy: null, type: 'unknown', source: 'authoritative-state' };
    }
    const type = String(building.busy.type || 'unknown').trim().toLowerCase();
    if (category !== 'sales' || type === 'sale' || type === 'construction') {
      return { status: 'known', busy: true, type, source: 'authoritative-state' };
    }
    // A generic busy object is not proof that a sales building is retailing. A newer exact page
    // observation may disambiguate it, but an idle page may not contradict authoritative busy.
    if (inspection?.busy === true && ['sale', 'construction'].includes(inspection.type)) {
      return { ...inspection, source: 'page-derived' };
    }
    return { status: 'unknown', busy: null, type: 'unknown', source: 'authoritative-state' };
  }
  if (inspection) {
    if (category === 'sales' && inspection.busy === true
        && !['sale', 'construction'].includes(inspection.type)) {
      return { status: 'unknown', busy: null, type: 'unknown', source: 'page-derived' };
    }
    return { ...inspection, source: 'page-derived' };
  }
  return { status: 'unknown', busy: null, type: 'unknown', source: null };
}

function inspectOperationalUtilization(state, nowMs = Date.now()) {
  if (state?.sources?.buildings?.status !== 'ok') {
    return {
      ok: false,
      reason: 'building source is not authoritative and current',
      requiredTool: 'refresh_state',
    };
  }
  if (!Array.isArray(state?.buildings)) {
    return {
      ok: false,
      reason: 'building list is unavailable',
      requiredTool: 'refresh_state',
    };
  }
  const now = Number(nowMs);
  const capturedMs = Date.parse(state?.t);
  const ageSeconds = Number.isFinite(capturedMs)
    && Number.isFinite(now)
    ? Math.round((now - capturedMs) / 1000)
    : null;
  if (ageSeconds == null || ageSeconds > MAX_STATE_AGE_SECONDS || ageSeconds < -MAX_FUTURE_SKEW_SECONDS) {
    return {
      ok: false,
      reason: 'building state is stale or has an invalid capture time',
      requiredTool: 'refresh_state',
      stateAsOf: state?.t || null,
      stateAgeSeconds: ageSeconds,
    };
  }

  const operationalBuildings = state.buildings.filter(building => {
      const category = String(building?.category || '').trim().toLowerCase();
      return OPERATIONAL_CATEGORIES.has(category)
        && category !== 'seasonal'
        && building?.freeAndLocked !== true;
    });
  const summarize = building => ({
    buildingId: Number(building.id),
    name: String(building.name || 'UNKNOWN'),
    level: Number.isFinite(Number(building.size)) ? Number(building.size) : null,
    category: String(building.category || '').trim().toLowerCase(),
  });
  const idleBuildings = operationalBuildings
    .filter(building => effectiveBuildingActivity(building, now).busy === false)
    .map(summarize)
    .filter(building => Number.isSafeInteger(building.buildingId) && building.buildingId > 0);
  const unknownBuildings = operationalBuildings
    .filter(building => String(building?.category || '').trim().toLowerCase() === 'sales'
      && effectiveBuildingActivity(building, now).status !== 'known'
      && effectiveBuildingActivity(building, now).status !== 'page-derived')
    .map(summarize)
    .filter(building => Number.isSafeInteger(building.buildingId) && building.buildingId > 0);
  const completedBuildings = operationalBuildings
    .filter(building => {
      const endsAtMs = Date.parse(building?.busy?.endsAt);
      // A deterministic job can finish after capture but before the journal gate runs. Comparing
      // with the gate clock prevents a just-completed job from being treated as still occupied.
      return building?.busy && Number.isFinite(endsAtMs) && endsAtMs <= Math.max(now, capturedMs);
    })
    .map(building => ({
      ...summarize(building),
      busyType: String(building.busy.type || 'unknown'),
      endsAt: building.busy.endsAt,
    }))
    .filter(building => Number.isSafeInteger(building.buildingId) && building.buildingId > 0);

  return {
    ok: true,
    stateAsOf: state.t,
    stateAgeSeconds: ageSeconds,
    idleBuildings,
    unknownBuildings,
    completedBuildings,
  };
}

function buildingUtilizationJournalGate(state, nowMs = Date.now(), options = {}) {
  const inspection = inspectOperationalUtilization(state, nowMs);
  if (!inspection.ok) {
    return {
      ok: false,
      guard: true,
      reason: `cannot verify that every standard operational building is occupied: ${inspection.reason}`,
      requiredTool: inspection.requiredTool,
      stateAsOf: inspection.stateAsOf || null,
      stateAgeSeconds: inspection.stateAgeSeconds ?? null,
    };
  }
  if (inspection.unknownBuildings.length) {
    return {
      ok: false,
      guard: true,
      reason: 'cannot close this wake while a standard sales building has UNKNOWN activity. A generic busy object is not proof of a retail sale. Inspect each exact building page and require one of: an active retail-sale marker, construction marker, or an enabled retail order form proving idle.',
      unknownBuildings: inspection.unknownBuildings,
      idleBuildings: inspection.idleBuildings,
      completedBuildings: inspection.completedBuildings,
      requiredTool: 'inspect_building',
      requiredActions: inspection.unknownBuildings.map(building => ({
        buildingId: building.buildingId,
        tool: 'inspect_building',
        product: null,
        qty: null,
      })),
    };
  }
  // Every operational building is ordinary capacity. Extraction sites carry no special standing:
  // nothing reserves an idle one, so an idle Quarry would be treated like any other idle building.
  const idleBuildings = inspection.idleBuildings;
  if (!idleBuildings.length && !inspection.completedBuildings.length) return null;

  // This gate exists to stop the wake declaring voluntary idle. An action the FailureBudget has
  // closed is the opposite of voluntary: the wake tried it, the game refused twice, and the budget
  // now refuses it before it is attempted. Demanding it anyway is an instruction no tool call can
  // carry out, and the wake's only remaining move is to fail the close over and over.
  //
  // That is what happened on 2026-08-05 02:47. Grocery 55692959 sat idle with 30 Coffee Powder, the
  // retail scan found no positive quote, sell:55692959 hit the budget, and this gate kept refusing
  // the close. The reason text below says to "leave the wake incomplete" in that case, which used to
  // mean "run out of rounds" — a bounded, if wasteful, ending. Rounds became unlimited that evening,
  // so it came to mean "spin until the 45-minute wall clock", and it did: 373 model requests,
  // 59.8M tokens, $15.85, rc=124.
  //
  // Only idle buildings get this treatment. An uncollected completed job still blocks the close,
  // because collect is a single supporter-button click that does not depend on a market price.
  const exhausted = options.exhaustedActions instanceof Set
    ? options.exhaustedActions
    : new Set(Array.isArray(options.exhaustedActions) ? options.exhaustedActions : []);
  const remedyFor = building => (building.category === 'sales' ? 'sell' : 'produce');
  const remedyIsClosed = building => exhausted.has(`${remedyFor(building)}:${building.buildingId}`);
  const actionableIdle = idleBuildings.filter(building => !remedyIsClosed(building));
  const blockedIdle = idleBuildings.filter(remedyIsClosed);
  if (!actionableIdle.length && !inspection.completedBuildings.length && blockedIdle.length) {
    return null;
  }

  return {
    ok: false,
    guard: true,
    reason: 'cannot close this wake while a standard operational building is confirmed idle or its completed job remains uncollected. Collect completed work first, then start the next job. Waiting for an upgrade, bond proceeds, evidence, cash, or a preferred batch is not an exception: start the structural action now or place useful bridge work ending before the next checkpoint. If the game truly makes every order impossible, leave the wake incomplete so the safety retry records the blocker instead of declaring voluntary idle.',
    idleBuildings: actionableIdle,
    blockedIdleBuildings: blockedIdle,
    completedBuildings: inspection.completedBuildings,
    requiredActions: [
      ...inspection.completedBuildings.map(building => ({
        buildingId: building.buildingId,
        tool: 'collect',
        checkpointField: null,
      })),
      ...actionableIdle.map(building => ({
        buildingId: building.buildingId,
        tool: remedyFor(building),
        checkpointField: building.category === 'production' ? 'finishBefore' : null,
      })),
    ],
  };
}

module.exports = {
  buildingUtilizationJournalGate,
  effectiveBuildingActivity,
  inspectOperationalUtilization,
};
