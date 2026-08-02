'use strict';

// The abundance building types the Prospector achievement counts.
const EXTRACTION_BUILDING_NAMES = new Set(['quarry', 'mine', 'oil rig']);

function prospectorCampaignActive(ownerDirective) {
  return ownerDirective?.prospectorExperiment?.campaign?.status === 'active';
}

const {
  validatePageActivityInspection,
} = require('./building-page-activity.js');
const {
  prospectorCampaignTargetSummary,
} = require('./owner-directive.js');

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
  const targetIds = new Set(
    prospectorCampaignTargetSummary(options?.ownerDirective).targets.map(
      target => Number(target.buildingId),
    ),
  );
  // An idle level-1 extraction site is campaign capacity waiting its turn, not spare capacity: the
  // runtime refuses production on it precisely so it stays scrappable. Counting it as a
  // no-voluntary-idle failure would block the journal with no legal move left — produce is
  // refused, and enrolment is capped, so the wake could neither work it nor close.
  const campaignActive = prospectorCampaignActive(options?.ownerDirective);
  const campaignCapacity = building => campaignActive &&
    EXTRACTION_BUILDING_NAMES.has(String(building?.name || '').trim().toLowerCase()) &&
    Number(building?.level ?? building?.size) === 1;
  const reservedIdleBuildings = inspection.idleBuildings.filter(
    building => targetIds.has(building.buildingId) || campaignCapacity(building),
  );
  const idleBuildings = inspection.idleBuildings.filter(
    building => !targetIds.has(building.buildingId) && !campaignCapacity(building),
  );
  if (!idleBuildings.length && !inspection.completedBuildings.length) return null;

  return {
    ok: false,
    guard: true,
    reason: 'cannot close this wake while a standard operational building is confirmed idle or its completed job remains uncollected. Collect completed work first, then start the next job. Waiting for an upgrade, bond proceeds, evidence, cash, or a preferred batch is not an exception: start the structural action now or place useful bridge work ending before the next checkpoint. If the game truly makes every order impossible, leave the wake incomplete so the safety retry records the blocker instead of declaring voluntary idle.',
    idleBuildings,
    reservedIdleBuildings,
    completedBuildings: inspection.completedBuildings,
    requiredActions: [
      ...inspection.completedBuildings.map(building => ({
        buildingId: building.buildingId,
        tool: 'collect',
        checkpointField: null,
      })),
      ...idleBuildings.map(building => ({
        buildingId: building.buildingId,
        tool: building.category === 'sales' ? 'sell' : 'produce',
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
