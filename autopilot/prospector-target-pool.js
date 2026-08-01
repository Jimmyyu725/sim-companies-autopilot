'use strict';

const { randomUUID } = require('crypto');

const PROSPECTOR_CAMPAIGN_MODE = 'repeat-until-achievement-complete';
const PROSPECTOR_BUILDING_NAMES = new Set(['quarry', 'mine', 'oil rig']);

function canonicalBuildingName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function validIso(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function poolIsConfigured(experiment) {
  const campaign = experiment?.campaign;
  return campaign?.mode === PROSPECTOR_CAMPAIGN_MODE && (
    campaign?.slotPolicy?.parallelizeWhenSafe === true ||
    Array.isArray(campaign?.targets) ||
    positiveInteger(campaign?.targetCapacity) != null
  );
}

function normalizeTarget(target, index) {
  const buildingId = positiveInteger(target?.buildingId);
  const building = String(target?.building || '').trim();
  const level = positiveInteger(target?.level);
  if (!buildingId || !building || level !== 1 ||
      !PROSPECTOR_BUILDING_NAMES.has(canonicalBuildingName(building))) return null;
  return {
    ...target,
    targetId: String(target?.targetId || `target-${index + 1}`).trim(),
    building,
    buildingId,
    level: 1,
    status: String(target?.status || 'waiting-construction').trim(),
    completesAt: validIso(target?.completesAt),
  };
}

function normalizeProspectorExperiment(experiment) {
  if (!poolIsConfigured(experiment)) return experiment;
  const campaign = experiment.campaign;
  const targets = [];
  const seenTargetIds = new Set();
  const seenBuildingIds = new Set();
  for (const [index, rawTarget] of (Array.isArray(campaign.targets)
    ? campaign.targets : []).entries()) {
    const target = normalizeTarget(rawTarget, index);
    if (!target || !target.targetId || seenTargetIds.has(target.targetId) ||
        seenBuildingIds.has(target.buildingId)) continue;
    seenTargetIds.add(target.targetId);
    seenBuildingIds.add(target.buildingId);
    targets.push(target);
  }

  const primaryBuildingId = positiveInteger(experiment?.buildingId);
  const primaryBuilding = String(experiment?.building || '').trim();
  if (!targets.length && primaryBuildingId && Number(experiment?.level) === 1 &&
      PROSPECTOR_BUILDING_NAMES.has(canonicalBuildingName(primaryBuilding))) {
    targets.push({
      targetId: 'primary',
      building: primaryBuilding,
      buildingId: primaryBuildingId,
      level: 1,
      status: String(experiment.status || 'waiting-construction'),
      completesAt: validIso(experiment.completesAt),
    });
  }

  const reserved = Number(campaign?.slotPolicy?.reservedFreeSlots);
  const reservedFreeSlots = Number.isSafeInteger(reserved) && reserved >= 0 ? reserved : 0;
  const configuredCapacity = positiveInteger(campaign.targetCapacity);
  const targetCapacity = Math.max(
    targets.length,
    configuredCapacity || (targets.length + reservedFreeSlots),
  );
  const requestedActiveId = String(campaign.activeTargetId || '').trim();
  const activeTarget = targets.find(target => target.targetId === requestedActiveId) ||
    targets.find(target => target.buildingId === primaryBuildingId) || targets[0] || null;
  return {
    ...experiment,
    campaign: {
      ...campaign,
      targetCapacity,
      activeTargetId: activeTarget?.targetId || null,
      targets,
    },
  };
}

function prospectorCampaignTargetSummary(directiveOrExperiment) {
  const experiment = directiveOrExperiment?.prospectorExperiment || directiveOrExperiment;
  if (!poolIsConfigured(experiment)) {
    return {
      configured: false,
      activeTargetId: null,
      targetCount: 0,
      targetCapacity: null,
      openTargetSlots: 0,
      targets: [],
    };
  }
  const normalized = normalizeProspectorExperiment(experiment);
  const targets = normalized.campaign.targets;
  const targetCapacity = Number(normalized.campaign.targetCapacity);
  return {
    configured: true,
    activeTargetId: normalized.campaign.activeTargetId,
    targetCount: targets.length,
    targetCapacity,
    openTargetSlots: Math.max(0, targetCapacity - targets.length),
    targets: targets.map(target => ({ ...target })),
  };
}

function activeProspectorTarget(experiment) {
  const normalized = normalizeProspectorExperiment(experiment);
  if (!poolIsConfigured(normalized)) return null;
  return normalized.campaign.targets.find(
    target => target.targetId === normalized.campaign.activeTargetId,
  ) || null;
}

function isOwnerProspectorCampaignTarget(directive, buildingId) {
  const id = positiveInteger(buildingId);
  if (!id || directive?.status !== 'pending' ||
      directive?.prospectorExperiment?.campaign?.status !== 'active') return false;
  return prospectorCampaignTargetSummary(directive).targets.some(
    target => target.buildingId === id,
  );
}

function updateProspectorTarget(experiment, targetId, patch) {
  const normalized = normalizeProspectorExperiment(experiment);
  if (!poolIsConfigured(normalized) || !targetId) return normalized;
  let found = false;
  const targets = normalized.campaign.targets.map(target => {
    if (target.targetId !== targetId) return target;
    found = true;
    return normalizeTarget({ ...target, ...patch, targetId }, 0) || target;
  });
  if (!found) return normalized;
  return {
    ...normalized,
    campaign: { ...normalized.campaign, targets },
  };
}

function appendProspectorTarget(experiment, evidence, now = Date.now()) {
  if (!poolIsConfigured(experiment) ||
      experiment?.campaign?.status !== 'active' ||
      experiment?.campaign?.slotPolicy?.parallelizeWhenSafe !== true) {
    return { ok: false, applicable: false, reason: 'parallel Prospector pool is not active' };
  }
  const normalized = normalizeProspectorExperiment(experiment);
  const summary = prospectorCampaignTargetSummary(normalized);
  if (summary.openTargetSlots < 1) {
    return { ok: false, applicable: true, reason: 'Prospector target pool is already full' };
  }
  const buildingId = positiveInteger(evidence?.buildingId);
  const building = String(evidence?.building || '').trim();
  if (evidence?.verified !== true || !buildingId ||
      !PROSPECTOR_BUILDING_NAMES.has(canonicalBuildingName(building))) {
    return { ok: false, applicable: true, reason: 'verified eligible building evidence is unavailable' };
  }
  if (summary.targets.some(target => target.buildingId === buildingId)) {
    return { ok: false, applicable: true, reason: 'building is already registered in the Prospector pool' };
  }
  const target = {
    targetId: `target-${randomUUID()}`,
    building,
    buildingId,
    level: 1,
    status: validIso(evidence?.completesAt) ? 'waiting-construction' : 'construction-unverified',
    completesAt: validIso(evidence?.completesAt),
    enrolledAt: new Date(Number(now)).toISOString(),
  };
  const nextExperiment = {
    ...normalized,
    campaign: {
      ...normalized.campaign,
      targets: [...normalized.campaign.targets, target],
    },
  };
  return {
    ok: true,
    applicable: true,
    experiment: nextExperiment,
    target,
    targetCount: nextExperiment.campaign.targets.length,
    targetCapacity: nextExperiment.campaign.targetCapacity,
  };
}

function otherProspectorTargetBuildingIds(experiment, activeTargetId = null) {
  const summary = prospectorCampaignTargetSummary(experiment);
  const selectedId = activeTargetId || summary.activeTargetId;
  return summary.targets
    .filter(target => target.targetId !== selectedId)
    .map(target => target.buildingId);
}

function completeProspectorTargets(experiment) {
  const normalized = normalizeProspectorExperiment(experiment);
  if (!poolIsConfigured(normalized)) return normalized;
  return {
    ...normalized,
    campaign: {
      ...normalized.campaign,
      targets: normalized.campaign.targets.map(target => ({
        ...target,
        status: 'completed',
      })),
    },
  };
}

function synchronizeProspectorTargets(experiment, state, now = Date.now()) {
  const normalized = normalizeProspectorExperiment(experiment);
  if (!poolIsConfigured(normalized)) return { applicable: false, changed: false, experiment };
  const nowMs = Number(now);
  const rows = Array.isArray(state?.buildings) ? state.buildings : [];
  const targets = normalized.campaign.targets.map(target => {
    const matches = rows.filter(building => Number(building?.id) === target.buildingId);
    if (matches.length !== 1) return { ...target, status: 'missing' };
    const building = matches[0];
    if (canonicalBuildingName(building?.name) !== canonicalBuildingName(target.building) ||
        Number(building?.size) !== 1) return { ...target, status: 'mismatch' };
    const busyType = canonicalBuildingName(building?.busy?.type || building?.busy?.rawCategory);
    const endsAt = validIso(building?.busy?.endsAt);
    if (['construction', 'b'].includes(busyType) && building?.busy?.expanding !== false) {
      return {
        ...target,
        status: endsAt && Date.parse(endsAt) > nowMs
          ? 'waiting-construction' : 'waiting-completion',
        completesAt: endsAt || target.completesAt,
      };
    }
    const hasBusyField = Object.prototype.hasOwnProperty.call(building, 'busy');
    const activityStatus = String(building?.activity?.status || '').trim().toLowerCase();
    const activityBusy = building?.activity?.busy;
    const pageIdle = ['known', 'page-derived'].includes(activityStatus) &&
      activityBusy === false;
    const expectedCompletionMs = Date.parse(target.completesAt);
    const apiOmittedBusyAfterCompletion = !hasBusyField && activityBusy !== true &&
      Number.isFinite(expectedCompletionMs) && expectedCompletionMs <= nowMs;
    if (building?.busy === null || pageIdle || apiOmittedBusyAfterCompletion) {
      return {
        ...target,
        status: 'ready',
        completesAt: target.completesAt || validIso(state?.t),
      };
    }
    if (!hasBusyField && Number.isFinite(expectedCompletionMs) && expectedCompletionMs > nowMs) {
      return { ...target, status: 'waiting-construction' };
    }
    return { ...target, status: 'busy' };
  });

  const activeAttempt = ['claimed', 'awaiting-counter'].includes(
    normalized?.rebuildAttempt?.status,
  );
  const protectedStatus = ['counter-mismatch', 'awaiting-tier-transition'].includes(
    normalized.status,
  );
  let selected = targets.find(target =>
    target.targetId === (normalized.rebuildAttempt?.targetId ||
      normalized.campaign.activeTargetId));
  if (!activeAttempt && !protectedStatus) {
    const ready = targets.filter(target => target.status === 'ready')
      .sort((left, right) => (Date.parse(left.completesAt) || 0) -
        (Date.parse(right.completesAt) || 0));
    if (selected?.status !== 'ready' && ready.length) selected = ready[0];
    if (!selected) selected = ready[0] || targets[0] || null;
  }

  let next = {
    ...normalized,
    campaign: {
      ...normalized.campaign,
      activeTargetId: selected?.targetId || null,
      targets,
    },
  };
  if (selected) {
    next = {
      ...next,
      building: selected.building,
      buildingId: selected.buildingId,
      level: 1,
      completesAt: selected.completesAt,
    };
    if (!activeAttempt && !protectedStatus) {
      if (selected.status === 'ready') next.status = 'baseline-verified';
      else if (['waiting-construction', 'waiting-completion', 'construction-unverified']
        .includes(selected.status)) next.status = 'waiting-construction';
    }
    if (next.rebuildAttempt?.rebuiltBuildingId === selected.buildingId &&
        selected.completesAt) {
      next.rebuildAttempt = {
        ...next.rebuildAttempt,
        rebuildCompletesAt: selected.completesAt,
      };
    }
  }
  return {
    applicable: true,
    changed: JSON.stringify(next) !== JSON.stringify(experiment),
    experiment: next,
  };
}

module.exports = {
  activeProspectorTarget,
  appendProspectorTarget,
  completeProspectorTargets,
  isOwnerProspectorCampaignTarget,
  normalizeProspectorExperiment,
  otherProspectorTargetBuildingIds,
  poolIsConfigured,
  prospectorCampaignTargetSummary,
  synchronizeProspectorTargets,
  updateProspectorTarget,
};
