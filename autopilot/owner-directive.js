'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const MAX_COMPLETION_STATE_AGE_MS = 5 * 60e3;
const PROSPECTOR_OVERVIEW_PATH = '/api/v2/companies/me/achievements/';
const PROSPECTOR_CAMPAIGN_MODE = 'repeat-until-achievement-complete';
const PROSPECTOR_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'abandoned']);
const PROSPECTOR_BUILDING_NAMES = new Set(['quarry', 'mine', 'oil rig']);
const OWNER_SUBTASK_ACTION = 'complete-owner-subtasks';
const NORMAL_COMPLETED_PROGRAM_ACTIVITIES = new Set(['production', 'sale']);

function configuredNumber(value, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (resolved == null || resolved === '' || typeof resolved === 'boolean') return NaN;
  return Number(resolved);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function pickDefined(source, keys) {
  const picked = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function compactProspectorExperiment(experiment, { prompt = false } = {}) {
  if (!experiment || typeof experiment !== 'object') return experiment;
  const compact = pickDefined(experiment, [
    'status',
    'authorizedAt',
    'building',
    'buildingId',
    'level',
    'expectedBaseline',
    'expectedTarget',
    'expectedIncrement',
    'completesAt',
    'campaign',
    'instruction',
    'baselineProgress',
    'lastProgressEvidence',
    'verificationError',
  ]);
  const attemptStatus = String(experiment?.rebuildAttempt?.status || '');
  if ((!prompt && experiment.rebuildAttempt) ||
      ['claimed', 'awaiting-counter', 'not-clicked'].includes(attemptStatus)) {
    compact.rebuildAttempt = experiment.rebuildAttempt;
  }
  if (experiment.status === 'completed') {
    if (experiment.verificationEvidence !== undefined) {
      compact.verificationEvidence = experiment.verificationEvidence;
    }
    if (experiment.verifiedAt !== undefined) compact.verifiedAt = experiment.verifiedAt;
  }
  if (prompt) {
    if (experiment.progressEvidenceContract !== undefined) {
      compact.progressEvidenceContract = experiment.progressEvidenceContract;
    }
    if (experiment.recoveryCandidate !== undefined) {
      compact.recoveryCandidate = experiment.recoveryCandidate;
    }
  }
  return compact;
}

function compactOwnerDirectiveForStorage(value) {
  if (value?.action !== OWNER_SUBTASK_ACTION ||
      !isProspectorCampaign(value?.prospectorExperiment)) return value;
  return {
    ...pickDefined(value, [
      'schemaVersion',
      'id',
      'createdAt',
      'status',
      'priority',
      'action',
      'completedAt',
      'completionEvidence',
    ]),
    prospectorExperiment: compactProspectorExperiment(value.prospectorExperiment),
  };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(compactOwnerDirectiveForStorage(value), null, 2)}\n`,
  );
  fs.renameSync(temporary, file);
}

function parseProgressLabel(value) {
  const match = String(value || '').trim().match(/^([\d,]+)\s+out\s+of\s+([\d,]+)$/i);
  if (!match) return null;
  const current = Number(match[1].replace(/,/g, ''));
  const target = Number(match[2].replace(/,/g, ''));
  return Number.isSafeInteger(current) && current >= 0 && Number.isSafeInteger(target) &&
    target > 0 && current <= target ? { current, target } : null;
}

function parseProspectorOverview(data) {
  if (!Array.isArray(data)) return null;
  const matches = data.filter(row => String(row?.label || '').trim().toLowerCase() === 'prospector');
  if (matches.length !== 1) return null;
  const row = matches[0];
  const stars = row.stars != null && row.stars !== '' && typeof row.stars !== 'boolean' &&
    Number.isSafeInteger(Number(row.stars)) ? Number(row.stars) : null;
  const starsMax = row.starsMax != null && row.starsMax !== '' && typeof row.starsMax !== 'boolean' &&
    Number.isSafeInteger(Number(row.starsMax)) ? Number(row.starsMax) : null;
  const progress = parseProgressLabel(row?.progress?.label);
  const rawPercent = row?.progress?.percent;
  const percent = rawPercent == null || rawPercent === '' || typeof rawPercent === 'boolean'
    ? NaN
    : Number(rawPercent);
  const action = String(row?.action || '').trim();
  if (row?.progress == null && !action && Number.isSafeInteger(stars) &&
      Number.isSafeInteger(starsMax) && starsMax > 0 && stars === starsMax) {
    return {
      label: String(row.label).trim(),
      action: null,
      current: null,
      target: null,
      percent: null,
      stars,
      starsMax,
      complete: true,
    };
  }
  if (!progress || !Number.isFinite(percent) || !/\bscrap\b/i.test(action) ||
      !/\b(mines?|quarries|rigs?)\b/i.test(action)) return null;
  const expectedPercent = progress.target > 0 ? progress.current / progress.target * 100 : null;
  if (!Number.isFinite(expectedPercent) || Math.abs(percent - expectedPercent) > 1.5) return null;
  return {
    label: String(row.label).trim(),
    action,
    current: progress.current,
    target: progress.target,
    percent,
    stars,
    starsMax,
    complete: false,
  };
}

function isProspectorCampaign(experiment) {
  return experiment?.campaign?.mode === PROSPECTOR_CAMPAIGN_MODE;
}

function ownerProspectorRootIsAuthorized(directive) {
  return directive?.action === OWNER_SUBTASK_ACTION ||
    directive?.program?.status === 'completed';
}

function prospectorCampaignIsComplete(experiment) {
  return isProspectorCampaign(experiment) && experiment.campaign.status === 'completed';
}

function prospectorVerificationIsComplete(experiment) {
  if (!experiment || typeof experiment !== 'object') return true;
  if (PROSPECTOR_TERMINAL_STATUSES.has(experiment.status)) return true;
  if (isProspectorCampaign(experiment)) return prospectorCampaignIsComplete(experiment);
  const baseline = experiment.baselineProgress;
  const verified = experiment.verificationEvidence;
  const expectedBaseline = configuredNumber(experiment.expectedBaseline, 0);
  const expectedTarget = configuredNumber(experiment.expectedTarget, 10);
  const expectedIncrement = configuredNumber(experiment.expectedIncrement, 1);
  return experiment.status === 'verified' && verified?.path === PROSPECTOR_OVERVIEW_PATH &&
    verified.status === 200 && Number.isSafeInteger(baseline?.current) &&
    Number.isSafeInteger(baseline?.target) && Number.isSafeInteger(verified?.current) &&
    Number.isSafeInteger(verified?.target) && baseline.current === expectedBaseline &&
    baseline.target === expectedTarget && verified.current === baseline.current + expectedIncrement &&
    verified.target === baseline.target && Date.parse(verified.observedAt) > Date.parse(baseline.observedAt);
}

function pendingOwnerSubtasks(directive) {
  const pending = [];
  if (directive?.prospectorExperiment && !prospectorVerificationIsComplete(directive.prospectorExperiment)) {
    const experiment = directive.prospectorExperiment;
    const baseline = configuredNumber(experiment.expectedBaseline, 0);
    const target = configuredNumber(experiment.expectedTarget, 10);
    const increment = configuredNumber(experiment.expectedIncrement, 1);
    const campaign = isProspectorCampaign(experiment);
    pending.push({
      key: 'prospectorExperiment',
      status: experiment.status || 'unknown',
      requiredEvidence: campaign
        ? `GET ${PROSPECTOR_OVERVIEW_PATH}: verify exactly one Prospector increment from ${baseline}/${target}, then repeat after the replacement building finishes until stars equals starsMax`
        : `GET ${PROSPECTOR_OVERVIEW_PATH}: Prospector progress must move from ${baseline}/${target} to ${baseline + increment}/${target}`,
    });
  }
  return pending;
}

function ownerUpgradeProgramDefinition(directive) {
  const buildingId = Number(directive?.buildingId);
  const targetLevel = Number(directive?.targetLevel);
  const buildingIds = Array.isArray(directive?.program?.buildingIds)
    ? [...new Set(directive.program.buildingIds.map(Number))]
    : [buildingId];
  const programTargetLevel = configuredNumber(directive?.program?.targetLevel, targetLevel);
  const valid = Number.isSafeInteger(buildingId) && buildingId > 0 &&
    Number.isSafeInteger(targetLevel) && targetLevel > 0 &&
    Number.isSafeInteger(programTargetLevel) && programTargetLevel > 0 &&
    buildingIds.length > 0 && buildingIds.includes(buildingId) &&
    buildingIds.every(id => Number.isSafeInteger(id) && id > 0);
  return { valid, buildingId, targetLevel, buildingIds, programTargetLevel };
}

function completedProgramActivity(building) {
  if (!building || !Object.prototype.hasOwnProperty.call(building, 'busy')) return null;
  if (building.busy === null) return 'idle';
  if (!building.busy || typeof building.busy !== 'object' || Array.isArray(building.busy)) return null;
  const type = String(building.busy.type || '').trim().toLowerCase();
  return NORMAL_COMPLETED_PROGRAM_ACTIVITIES.has(type) ? type : null;
}

function programCompletionEvidenceIsValid(directive) {
  const definition = ownerUpgradeProgramDefinition(directive);
  const program = directive?.program;
  const evidence = program?.completionEvidence;
  const stateAsOfMs = Date.parse(evidence?.stateAsOf);
  const recordedAtMs = Date.parse(evidence?.recordedAt);
  const evidenceAgeAtRecordMs = recordedAtMs - stateAsOfMs;
  if (!definition.valid || program?.status !== 'completed' || evidence?.status !== 'verified' ||
      Number(evidence.targetLevel) !== definition.programTargetLevel ||
      !Number.isFinite(stateAsOfMs) || !Number.isFinite(recordedAtMs) ||
      evidenceAgeAtRecordMs < -60e3 || evidenceAgeAtRecordMs > MAX_COMPLETION_STATE_AGE_MS ||
      evidence?.source?.status !== 'ok' || evidence.source.asOf !== evidence.stateAsOf ||
      !Array.isArray(evidence.buildingIds) || !Array.isArray(evidence.buildings)) return false;

  const evidenceIds = evidence.buildingIds.map(Number);
  if (evidenceIds.length !== definition.buildingIds.length ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      definition.buildingIds.some(id => !evidenceIds.includes(id)) ||
      evidence.buildings.length !== definition.buildingIds.length) return false;

  return definition.buildingIds.every(id => {
    const matches = evidence.buildings.filter(row => Number(row?.buildingId) === id);
    if (matches.length !== 1) return false;
    const row = matches[0];
    const requiredLevel = id === definition.buildingId
      ? Math.max(definition.targetLevel, definition.programTargetLevel)
      : definition.programTargetLevel;
    return Number(row.level) >= requiredLevel &&
      ['idle', ...NORMAL_COMPLETED_PROGRAM_ACTIVITIES].includes(row.activity);
  });
}

function buildProgramCompletionEvidence(directive, state, nowMs) {
  const definition = ownerUpgradeProgramDefinition(directive);
  const stateAsOfMs = Date.parse(state?.t);
  const stateAgeMs = nowMs - stateAsOfMs;
  const nowIsRepresentable = Number.isFinite(new Date(nowMs).getTime());
  const buildingSource = state?.sources?.buildings;
  const stateIsFresh = Number.isFinite(nowMs) && nowIsRepresentable && Number.isFinite(stateAsOfMs) &&
    stateAgeMs >= -60e3 && stateAgeMs <= MAX_COMPLETION_STATE_AGE_MS &&
    buildingSource?.status === 'ok' && typeof buildingSource.asOf === 'string' &&
    buildingSource.asOf === state?.t;
  if (!definition.valid || !stateIsFresh || !Array.isArray(state?.buildings)) return null;

  const buildings = [];
  for (const id of definition.buildingIds) {
    const matches = state.buildings.filter(candidate => Number(candidate?.id) === id);
    if (matches.length !== 1) return null;
    const building = matches[0];
    const requiredLevel = id === definition.buildingId
      ? Math.max(definition.targetLevel, definition.programTargetLevel)
      : definition.programTargetLevel;
    const activity = completedProgramActivity(building);
    if (Number(building.size) < requiredLevel || !activity) return null;
    buildings.push({
      buildingId: Number(building.id),
      level: Number(building.size),
      activity,
    });
  }

  return {
    status: 'verified',
    recordedAt: new Date(nowMs).toISOString(),
    stateAsOf: state.t,
    stateAgeSeconds: Math.max(0, Math.round(stateAgeMs / 1000)),
    source: {
      status: buildingSource.status,
      asOf: buildingSource.asOf,
    },
    targetLevel: definition.programTargetLevel,
    buildingIds: definition.buildingIds,
    buildings,
  };
}

function decoratePendingDirective(directive) {
  let decorated = directive;
  if (directive?.prospectorExperiment) {
    const baseline = configuredNumber(directive.prospectorExperiment.expectedBaseline, 0);
    const target = configuredNumber(directive.prospectorExperiment.expectedTarget, 10);
    const increment = configuredNumber(directive.prospectorExperiment.expectedIncrement, 1);
    const campaign = isProspectorCampaign(directive.prospectorExperiment);
    decorated = {
      ...decorated,
      prospectorExperiment: {
        ...directive.prospectorExperiment,
        progressEvidenceContract: {
          method: 'GET',
          path: PROSPECTOR_OVERVIEW_PATH,
          requestParameters: null,
          rowSelector: 'exact label "Prospector" plus a scrap mines/quarries/rigs action',
          progressField: campaign
            ? `progress.label advances by exactly ${increment}; a tier boundary may also increment stars by exactly one and change the target`
            : `progress.label ("${baseline} out of ${target}" -> "${baseline + increment} out of ${target}")`,
        },
      },
    };
  }
  const pendingSubtasks = pendingOwnerSubtasks(decorated);
  const completedUpgradeProgram = programCompletionEvidenceIsValid(decorated);
  if ((completedUpgradeProgram || decorated?.action === OWNER_SUBTASK_ACTION) &&
      pendingSubtasks.length > 0) {
    decorated = {
      ...decorated,
      action: OWNER_SUBTASK_ACTION,
      ...(completedUpgradeProgram ? { completedAction: directive.action } : {}),
      activeInstruction: `${completedUpgradeProgram
        ? 'The funded upgrade program is authoritatively complete. Do not preview or start another upgrade or upgrade bridge; '
        : ''}Execute only the listed pending owner subtasks. The exact eligible owner-authorized Prospector REBUILD campaign is already strategically approved: after each replacement Quarry finishes, dry-preview it, confirm it without council re-review, verify exactly one counter increment, bind the replacement building ID, and repeat until stars equals starsMax. Do not start production on the campaign target once REBUILD is executable.`,
      pendingOwnerSubtasks: pendingSubtasks,
    };
  }
  return decorated;
}

function buildProspectorEvidence(progress, observedAtMs) {
  return {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    observedAt: new Date(observedAtMs).toISOString(),
    label: progress.label,
    action: progress.action,
    current: progress.current,
    target: progress.target,
    percent: progress.percent,
    stars: progress.stars,
    starsMax: progress.starsMax,
    complete: progress.complete === true,
  };
}

function validProspectorCampaignProgress(progress) {
  return Number.isSafeInteger(progress?.stars) && progress.stars >= 0 &&
    Number.isSafeInteger(progress?.starsMax) && progress.starsMax > 0 &&
    progress.stars <= progress.starsMax &&
    (progress.complete === true || (
      Number.isSafeInteger(progress?.current) && progress.current >= 0 &&
      Number.isSafeInteger(progress?.target) && progress.target >= progress.current && progress.target > 0
    ));
}

function canonicalProspectorBuildingName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validProspectorEvidenceRecord(evidence, nowMs = null, maxAgeMs = null) {
  const observedAtMs = Date.parse(evidence?.observedAt);
  const timeIsValid = nowMs == null || (
    Number.isFinite(Number(nowMs)) && Number.isFinite(observedAtMs) &&
    observedAtMs <= Number(nowMs) + 60e3 &&
    (maxAgeMs == null || Number(nowMs) - observedAtMs <= Number(maxAgeMs))
  );
  return evidence?.path === PROSPECTOR_OVERVIEW_PATH && Number(evidence?.status) === 200 &&
    evidence?.complete !== true &&
    Number.isSafeInteger(Number(evidence?.current)) && Number(evidence.current) >= 0 &&
    Number.isSafeInteger(Number(evidence?.target)) &&
    Number(evidence.target) > Number(evidence.current) &&
    Number.isSafeInteger(Number(evidence?.stars)) && Number(evidence.stars) >= 0 &&
    Number.isSafeInteger(Number(evidence?.starsMax)) &&
    Number(evidence.starsMax) > Number(evidence.stars) &&
    timeIsValid;
}

function ownerProspectorCampaignCanRecover(directive, nowMs = Date.now()) {
  const experiment = directive?.prospectorExperiment;
  const storedBuildingId = Number(experiment?.buildingId);
  const completionMs = Date.parse(experiment?.completesAt);
  const expectedName = canonicalProspectorBuildingName(experiment?.building);
  const activeAttempt = ['claimed', 'awaiting-counter'].includes(
    experiment?.rebuildAttempt?.status,
  );
  return directive?.schemaVersion === 1 && directive?.status === 'pending' &&
    directive?.priority === 'owner' && ownerProspectorRootIsAuthorized(directive) &&
    isProspectorCampaign(experiment) && experiment?.campaign?.status === 'active' &&
    experiment?.status === 'counter-mismatch' && !activeAttempt &&
    Number(experiment?.expectedIncrement) === 1 && Number(experiment?.level) === 1 &&
    Number.isSafeInteger(storedBuildingId) && storedBuildingId > 0 &&
    PROSPECTOR_BUILDING_NAMES.has(expectedName) &&
    Number.isFinite(Number(nowMs)) && Number.isFinite(completionMs) &&
    Number(nowMs) >= completionMs &&
    validProspectorEvidenceRecord(experiment?.lastProgressEvidence);
}

function findOwnerProspectorRecoveryCandidate(state, directive, now = Date.now()) {
  const nowMs = Number(now);
  if (!ownerProspectorCampaignCanRecover(directive, nowMs)) return null;
  const stateAtMs = Date.parse(state?.t);
  const buildingSource = state?.sources?.buildings;
  const sourceAtMs = Date.parse(buildingSource?.asOf);
  const stateIsFresh = Number.isFinite(stateAtMs) && Number.isFinite(sourceAtMs) &&
    stateAtMs <= nowMs + 60e3 && sourceAtMs <= nowMs + 60e3 &&
    nowMs - stateAtMs <= MAX_COMPLETION_STATE_AGE_MS &&
    nowMs - sourceAtMs <= MAX_COMPLETION_STATE_AGE_MS;
  if (buildingSource?.status !== 'ok' || !stateIsFresh || !Array.isArray(state?.buildings)) {
    return null;
  }

  const experiment = directive.prospectorExperiment;
  const storedBuildingId = Number(experiment.buildingId);
  const expectedName = canonicalProspectorBuildingName(experiment.building);
  if (state.buildings.some(building => Number(building?.id) === storedBuildingId)) return null;
  const matches = state.buildings.filter(building =>
    canonicalProspectorBuildingName(building?.name) === expectedName &&
    Number(building?.size) === 1 && building?.freeAndLocked !== true);
  if (matches.length !== 1) return null;
  const building = matches[0];
  const buildingId = Number(building?.id);
  if (!Number.isSafeInteger(buildingId) || buildingId <= 0 ||
      building?.busy != null ||
      (building?.activity?.status === 'known' && building?.activity?.busy === true)) {
    return null;
  }
  return {
    buildingId,
    building: building.name,
    level: 1,
    previousBuildingId: storedBuildingId,
    status: 'requires-fresh-page-and-achievement-validation',
  };
}

function classifyProspectorCampaignTransition(baseline, progress, expectedIncrement) {
  if (!validProspectorCampaignProgress(progress) ||
      !Number.isSafeInteger(Number(baseline?.current)) ||
      !Number.isSafeInteger(Number(baseline?.target)) ||
      !Number.isSafeInteger(Number(baseline?.stars)) ||
      !Number.isSafeInteger(Number(baseline?.starsMax)) ||
      Number(baseline.starsMax) !== progress.starsMax) return 'mismatch';

  const baselineCurrent = Number(baseline.current);
  const baselineTarget = Number(baseline.target);
  const baselineStars = Number(baseline.stars);
  if (progress.complete === true) {
    return progress.stars === progress.starsMax && progress.stars === baselineStars + 1 &&
      baselineCurrent + expectedIncrement === baselineTarget ? 'complete' : 'mismatch';
  }
  if (progress.stars === baselineStars && progress.target === baselineTarget) {
    if (progress.current === baselineCurrent) return 'unchanged';
    if (progress.current === baselineCurrent + expectedIncrement) {
      return progress.current === progress.target ? 'tier-pending' : 'advanced';
    }
    return 'mismatch';
  }
  const tierAdvanced = progress.stars === baselineStars + 1 &&
    baselineCurrent + expectedIncrement === baselineTarget &&
    ((progress.current === baselineCurrent + expectedIncrement && progress.target > progress.current) ||
      (progress.current === 0 && progress.target > 0));
  return tierAdvanced ? 'tier-advanced' : 'mismatch';
}

function appendVerifiedProspectorAttempt(experiment, evidence, nowMs) {
  const attempt = experiment.rebuildAttempt;
  if (!attempt || attempt.status !== 'awaiting-counter') {
    return {
      rebuildAttempt: attempt,
      verifiedRebuilds: Number(experiment.campaign?.verifiedRebuilds) || 0,
    };
  }
  const verifiedAttempt = {
    ...attempt,
    status: 'verified',
    counterVerifiedAt: new Date(nowMs).toISOString(),
    progressAfter: evidence.current,
    progressTargetAfter: evidence.target,
    starsAfter: evidence.stars,
  };
  return {
    rebuildAttempt: verifiedAttempt,
    verifiedRebuilds: (Number(experiment.campaign?.verifiedRebuilds) || 0) + 1,
  };
}

function recordOwnerProspectorOverview(directiveFile, observation, now = Date.now()) {
  const directive = readJson(directiveFile);
  if (directive?.schemaVersion !== 1 || directive?.status !== 'pending' ||
      directive?.priority !== 'owner' || !directive?.prospectorExperiment) return null;
  if (observation?.path !== PROSPECTOR_OVERVIEW_PATH || Number(observation?.status) !== 200) return null;
  const progress = parseProspectorOverview(observation.data);
  const observedAtMs = Date.parse(observation?.fetchedAt);
  const nowMs = Number(now);
  if (!progress || !Number.isFinite(observedAtMs) || !Number.isFinite(nowMs) ||
      observedAtMs > nowMs + 60e3 || nowMs - observedAtMs > MAX_COMPLETION_STATE_AGE_MS) return null;

  const experiment = directive.prospectorExperiment;
  const expectedBaseline = configuredNumber(experiment.expectedBaseline, 0);
  const expectedTarget = configuredNumber(experiment.expectedTarget, 10);
  const expectedIncrement = configuredNumber(experiment.expectedIncrement, 1);
  if (!Number.isSafeInteger(expectedBaseline) || expectedBaseline < 0 ||
      !Number.isSafeInteger(expectedTarget) || expectedTarget <= expectedBaseline ||
      !Number.isSafeInteger(expectedIncrement) || expectedIncrement <= 0) return null;
  const evidence = buildProspectorEvidence(progress, observedAtMs);
  let nextExperiment;
  let resultStatus;

  if (isProspectorCampaign(experiment)) {
    if (!validProspectorCampaignProgress(progress)) return null;
    if (progress.complete === true) {
      nextExperiment = {
        ...experiment,
        status: 'completed',
        lastProgressEvidence: evidence,
        verificationEvidence: evidence,
        verifiedAt: new Date(nowMs).toISOString(),
        campaign: {
          ...experiment.campaign,
          status: 'completed',
          currentStars: progress.stars,
          starsMax: progress.starsMax,
          completedAt: new Date(nowMs).toISOString(),
        },
      };
      delete nextExperiment.verificationError;
      resultStatus = 'completed';
    } else if (!experiment.baselineProgress) {
      const baselineMatches = progress.current === expectedBaseline &&
        progress.target === expectedTarget;
      nextExperiment = {
        ...experiment,
        status: baselineMatches ? 'baseline-verified' : 'counter-mismatch',
        baselineProgress: baselineMatches ? evidence : null,
        lastProgressEvidence: evidence,
        campaign: {
          ...experiment.campaign,
          status: 'active',
          currentStars: progress.stars,
          starsMax: progress.starsMax,
        },
        ...(baselineMatches ? {} : {
          verificationError: `expected campaign baseline ${expectedBaseline}/${expectedTarget}, observed ${progress.current}/${progress.target}`,
        }),
      };
      resultStatus = nextExperiment.status;
    } else {
      const baseline = experiment.baselineProgress;
      const transition = classifyProspectorCampaignTransition(baseline, progress, expectedIncrement);
      const activeAttempt = ['claimed', 'awaiting-counter'].includes(experiment.rebuildAttempt?.status);
      if (transition === 'advanced' || transition === 'tier-advanced') {
        const verifiedAttempt = appendVerifiedProspectorAttempt(experiment, evidence, nowMs);
        nextExperiment = {
          ...experiment,
          status: 'waiting-construction',
          expectedBaseline: progress.current,
          expectedTarget: progress.target,
          baselineProgress: evidence,
          lastProgressEvidence: evidence,
          verificationEvidence: evidence,
          verifiedAt: new Date(nowMs).toISOString(),
          rebuildAttempt: verifiedAttempt.rebuildAttempt,
          campaign: {
            ...experiment.campaign,
            status: 'active',
            currentStars: progress.stars,
            starsMax: progress.starsMax,
            verifiedRebuilds: verifiedAttempt.verifiedRebuilds,
            lastVerifiedAt: new Date(nowMs).toISOString(),
          },
        };
        delete nextExperiment.completedAttempts;
        delete nextExperiment.verificationError;
      } else if (transition === 'tier-pending') {
        nextExperiment = {
          ...experiment,
          status: 'awaiting-tier-transition',
          lastProgressEvidence: evidence,
          verificationError: 'Prospector reached the current tier threshold but stars and the next target have not advanced yet',
        };
      } else if (transition === 'unchanged') {
        const waitingForCounter = activeAttempt;
        nextExperiment = {
          ...experiment,
          status: waitingForCounter ? 'awaiting-counter' : 'baseline-verified',
          baselineProgress: waitingForCounter ? baseline : evidence,
          lastProgressEvidence: evidence,
          ...(waitingForCounter ? {
            verificationError: 'Prospector counter has not advanced yet',
          } : {}),
        };
        if (!waitingForCounter) delete nextExperiment.verificationError;
      } else {
        nextExperiment = {
          ...experiment,
          status: 'counter-mismatch',
          lastProgressEvidence: evidence,
          verificationError: `expected exactly one campaign increment from ${baseline.current}/${baseline.target} at ${baseline.stars}/${baseline.starsMax} stars, observed ${progress.current}/${progress.target} at ${progress.stars}/${progress.starsMax} stars`,
        };
      }
      resultStatus = nextExperiment.status;
    }
  } else if (!experiment.baselineProgress) {
    const baselineMatches = progress.current === expectedBaseline && progress.target === expectedTarget;
    nextExperiment = {
      ...experiment,
      status: baselineMatches ? 'baseline-verified' : 'counter-mismatch',
      baselineProgress: baselineMatches ? evidence : null,
      lastProgressEvidence: evidence,
      ...(baselineMatches ? {} : {
        verificationError: `expected baseline ${expectedBaseline}/${expectedTarget}, observed ${progress.current}/${progress.target}`,
      }),
    };
    resultStatus = nextExperiment.status;
  } else {
    const baseline = experiment.baselineProgress;
    const verified = progress.target === Number(baseline.target) &&
      progress.current === Number(baseline.current) + expectedIncrement &&
      observedAtMs > Date.parse(baseline.observedAt);
    const unchanged = progress.target === Number(baseline.target) &&
      progress.current === Number(baseline.current);
    nextExperiment = {
      ...experiment,
      status: verified ? 'verified' : (unchanged ? 'baseline-verified' : 'counter-mismatch'),
      lastProgressEvidence: evidence,
      ...(verified ? {
        verificationEvidence: evidence,
        verifiedAt: new Date(nowMs).toISOString(),
      } : {
        verificationError: unchanged
          ? 'Prospector counter has not advanced yet'
          : `expected ${Number(baseline.current) + expectedIncrement}/${baseline.target}, observed ${progress.current}/${progress.target}`,
      }),
    };
    if (verified) delete nextExperiment.verificationError;
    resultStatus = nextExperiment.status;
  }
  writeJsonAtomic(directiveFile, { ...directive, prospectorExperiment: nextExperiment });
  return {
    recorded: true,
    experimentStatus: resultStatus,
    current: progress.current,
    target: progress.target,
    stars: progress.stars,
    starsMax: progress.starsMax,
    path: PROSPECTOR_OVERVIEW_PATH,
  };
}

function authorizeOwnerProspectorRebuild(directive, buildingId, now = Date.now()) {
  const nowMs = Number(now);
  const experiment = directive?.prospectorExperiment;
  const baseline = experiment?.baselineProgress;
  const latest = experiment?.lastProgressEvidence;
  const expectedBaseline = configuredNumber(experiment?.expectedBaseline, 0);
  const expectedTarget = configuredNumber(experiment?.expectedTarget, 10);
  const completionMs = Date.parse(experiment?.completesAt);
  const latestMs = Date.parse(latest?.observedAt);
  const campaign = isProspectorCampaign(experiment);
  const campaignActive = campaign && experiment?.campaign?.status === 'active';
  const activeAttempt = ['claimed', 'awaiting-counter'].includes(experiment?.rebuildAttempt?.status);
  const campaignEvidenceValid = !campaign || (campaignActive &&
    Number.isSafeInteger(Number(baseline?.stars)) && Number(baseline.stars) >= 0 &&
    Number.isSafeInteger(Number(baseline?.starsMax)) && Number(baseline.starsMax) > Number(baseline.stars) &&
    Number(latest?.stars) === Number(baseline.stars) &&
    Number(latest?.starsMax) === Number(baseline.starsMax));
  const valid = directive?.schemaVersion === 1 && directive?.status === 'pending' &&
    directive?.priority === 'owner' && experiment?.status === 'baseline-verified' &&
    Number(experiment?.buildingId) === Number(buildingId) &&
    Number.isSafeInteger(Number(buildingId)) && Number(buildingId) > 0 &&
    Number.isFinite(nowMs) && Number.isFinite(completionMs) && nowMs >= completionMs &&
    Number.isSafeInteger(expectedBaseline) && expectedBaseline >= 0 &&
    Number.isSafeInteger(expectedTarget) && expectedTarget > expectedBaseline &&
    baseline?.path === PROSPECTOR_OVERVIEW_PATH && Number(baseline?.status) === 200 &&
    Number(baseline?.current) === expectedBaseline && Number(baseline?.target) === expectedTarget &&
    latest?.path === PROSPECTOR_OVERVIEW_PATH && Number(latest?.status) === 200 &&
    Number(latest?.current) === expectedBaseline && Number(latest?.target) === expectedTarget &&
    Number.isFinite(latestMs) && latestMs <= nowMs + 60e3 && nowMs - latestMs <= MAX_COMPLETION_STATE_AGE_MS &&
    campaignEvidenceValid && !activeAttempt;
  return valid
    ? { ok: true, baselineCurrent: expectedBaseline, baselineTarget: expectedTarget }
    : { ok: false, reason: 'fresh exact owner authorization for this Prospector REBUILD is unavailable' };
}

function validateProspectorRecoveryTarget(directive, buildingId, targetEvidence, now = Date.now()) {
  const nowMs = Number(now);
  if (!ownerProspectorCampaignCanRecover(directive, nowMs)) {
    return { ok: false, reason: 'owner Prospector campaign is not eligible for target recovery' };
  }
  const capturedAtMs = Date.parse(targetEvidence?.capturedAt);
  if (targetEvidence?.source !== 'authoritative-buildings-capture' ||
      !Number.isFinite(capturedAtMs) || capturedAtMs > nowMs + 10e3 ||
      nowMs - capturedAtMs > 60e3 || !Array.isArray(targetEvidence?.buildings)) {
    return { ok: false, reason: 'fresh authoritative building capture is unavailable' };
  }

  const experiment = directive.prospectorExperiment;
  const expectedName = canonicalProspectorBuildingName(experiment.building);
  const storedBuildingId = Number(experiment.buildingId);
  const id = Number(buildingId);
  if (!Number.isSafeInteger(id) || id <= 0 || id === storedBuildingId ||
      targetEvidence.buildings.some(building => Number(building?.id) === storedBuildingId)) {
    return { ok: false, reason: 'the stale campaign building is still present or the replacement ID is invalid' };
  }
  const matches = targetEvidence.buildings.filter(building =>
    canonicalProspectorBuildingName(building?.name) === expectedName &&
    Number(building?.size) === 1 && building?.freeAndLocked !== true);
  if (matches.length !== 1 || Number(matches[0]?.id) !== id) {
    return { ok: false, reason: 'the current level-1 campaign replacement is missing or ambiguous' };
  }
  const building = matches[0];
  if (building?.busy != null ||
      (building?.activity?.status === 'known' && building?.activity?.busy === true)) {
    return { ok: false, reason: 'the campaign replacement has a known active operation' };
  }

  const idle = targetEvidence?.idleEvidence;
  const idleAtMs = Date.parse(idle?.observedAt);
  if (idle?.status !== 'validated' || Number(idle?.buildingId) !== id ||
      canonicalProspectorBuildingName(idle?.buildingName) !== expectedName ||
      Number(idle?.level) !== 1 || !Number.isFinite(idleAtMs) ||
      idleAtMs > nowMs + 10e3 || nowMs - idleAtMs > 60e3) {
    return { ok: false, reason: 'fresh validated idle evidence is not bound to the replacement' };
  }
  if (idle.source === 'authoritative-api') {
    if (!Object.prototype.hasOwnProperty.call(building, 'busy') || building.busy !== null) {
      return { ok: false, reason: 'authoritative idle evidence disagrees with the building row' };
    }
  } else if (idle.source === 'page-derived') {
    if ((Object.prototype.hasOwnProperty.call(building, 'busy') && building.busy !== undefined) ||
        idle.path !== `/b/${id}/` || idle.construction !== false ||
        idle.orderBusy !== false || idle.collectible !== false ||
        idle.orderAvailable !== true || idle.rebuildOpenerCount !== 1 ||
        idle.rebuildOpenerEnabled !== true) {
      return { ok: false, reason: 'page-derived idle evidence is incomplete or contradictory' };
    }
  } else {
    return { ok: false, reason: 'replacement idle evidence does not use a trusted source' };
  }
  if (!validProspectorEvidenceRecord(
    experiment.lastProgressEvidence,
    nowMs,
    MAX_COMPLETION_STATE_AGE_MS,
  )) {
    return { ok: false, reason: 'fresh authenticated Prospector progress is unavailable' };
  }
  return { ok: true, building };
}

function reconcileOwnerProspectorRecoveryTarget(
  directiveFile,
  buildingId,
  targetEvidence,
  now = Date.now(),
) {
  const directive = readJson(directiveFile);
  const validation = validateProspectorRecoveryTarget(
    directive,
    buildingId,
    targetEvidence,
    now,
  );
  if (!validation.ok) return validation;
  const nowMs = Number(now);
  const experiment = directive.prospectorExperiment;
  const evidence = experiment.lastProgressEvidence;
  const previousBuildingId = Number(experiment.buildingId);
  const nextExperiment = {
    ...experiment,
    status: 'baseline-verified',
    buildingId: Number(buildingId),
    completesAt: new Date(nowMs).toISOString(),
    expectedBaseline: Number(evidence.current),
    expectedTarget: Number(evidence.target),
    baselineProgress: evidence,
    lastProgressEvidence: evidence,
    instruction: 'For the active owner Prospector campaign, rebuild the exact current replacement level-1 extraction building through the rendered UI whenever it is authoritatively idle. Refresh and verify the authenticated achievement immediately before every one-use claim, bind the verified replacement building ID after every click, and stop only when stars equals starsMax.',
    recoveryEvidence: {
      status: 'verified',
      recoveredAt: new Date(nowMs).toISOString(),
      previousBuildingId,
      buildingId: Number(buildingId),
      building: validation.building.name,
      level: 1,
      progress: {
        current: Number(evidence.current),
        target: Number(evidence.target),
        stars: Number(evidence.stars),
        starsMax: Number(evidence.starsMax),
        observedAt: evidence.observedAt,
      },
    },
    campaign: {
      ...experiment.campaign,
      status: 'active',
      currentStars: Number(evidence.stars),
      starsMax: Number(evidence.starsMax),
      lastRecoveredAt: new Date(nowMs).toISOString(),
    },
  };
  delete nextExperiment.verificationError;
  delete nextExperiment.verificationEvidence;
  delete nextExperiment.verifiedAt;
  writeJsonAtomic(directiveFile, {
    ...directive,
    prospectorExperiment: nextExperiment,
  });
  return {
    ok: true,
    previousBuildingId,
    buildingId: Number(buildingId),
    baselineCurrent: Number(evidence.current),
    baselineTarget: Number(evidence.target),
  };
}

function claimOwnerProspectorRebuildAttempt(directiveFile, buildingId, now = Date.now()) {
  const directive = readJson(directiveFile);
  const authorization = authorizeOwnerProspectorRebuild(directive, buildingId, now);
  if (!authorization.ok) return authorization;
  const attemptId = randomUUID();
  writeJsonAtomic(directiveFile, {
    ...directive,
    prospectorExperiment: {
      ...directive.prospectorExperiment,
      rebuildAttempt: {
        attemptId,
        status: 'claimed',
        buildingId: Number(buildingId),
        baselineCurrent: authorization.baselineCurrent,
        baselineTarget: authorization.baselineTarget,
        claimedAt: new Date(Number(now)).toISOString(),
      },
    },
  });
  return { ok: true, attemptId };
}

function refreshAndClaimOwnerProspectorRebuildAttempt(
  directiveFile,
  buildingId,
  observation,
  now = Date.now(),
  targetEvidence = null,
) {
  let evidence = recordOwnerProspectorOverview(directiveFile, observation, now);
  let recovery = null;
  if (evidence?.recorded && evidence.experimentStatus === 'counter-mismatch' &&
      targetEvidence) {
    recovery = reconcileOwnerProspectorRecoveryTarget(
      directiveFile,
      buildingId,
      targetEvidence,
      now,
    );
    if (recovery.ok) {
      evidence = {
        ...evidence,
        experimentStatus: 'baseline-verified',
        recoveredTarget: recovery,
      };
    }
  }
  if (!evidence?.recorded || evidence.experimentStatus !== 'baseline-verified') {
    return {
      ok: false,
      reason: recovery?.reason ||
        'fresh authenticated Prospector baseline is unavailable for this REBUILD',
      ownerDirectiveEvidence: evidence || null,
    };
  }
  const claim = claimOwnerProspectorRebuildAttempt(directiveFile, buildingId, now);
  return { ...claim, ownerDirectiveEvidence: evidence };
}

function recordOwnerProspectorRebuildOutcome(directiveFile, attemptId, result, now = Date.now()) {
  const directive = readJson(directiveFile);
  const experiment = directive?.prospectorExperiment;
  const attempt = experiment?.rebuildAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.status !== 'claimed') return false;
  const commitPossible = result?.commitClicked === true || result?.mutationAttempted === true;
  const rebuiltBuildingId = Number(result?.rebuiltBuildingId);
  const completesAtMs = Date.parse(result?.rebuildCompletesAt);
  const verifiedReplacement = result?.verified === true &&
    Number.isSafeInteger(rebuiltBuildingId) && rebuiltBuildingId > 0;
  const verifiedCompletion = verifiedReplacement &&
    Number.isFinite(completesAtMs) && completesAtMs > Number(now);
  const nextAttempt = {
    ...attempt,
    status: commitPossible ? 'awaiting-counter' : 'not-clicked',
    resultRecordedAt: new Date(Number(now)).toISOString(),
    commitPossible,
    verified: result?.verified === true,
    ...(verifiedReplacement ? {
      rebuiltBuildingId,
    } : {}),
    ...(verifiedCompletion ? {
      rebuildCompletesAt: new Date(completesAtMs).toISOString(),
    } : {}),
  };
  writeJsonAtomic(directiveFile, {
    ...directive,
    prospectorExperiment: {
      ...experiment,
      ...(commitPossible ? { status: 'awaiting-counter' } : {}),
      ...(isProspectorCampaign(experiment) && verifiedReplacement ? {
        buildingId: rebuiltBuildingId,
        builtAt: new Date(Number(now)).toISOString(),
        completesAt: verifiedCompletion ? new Date(completesAtMs).toISOString() : null,
      } : {}),
      rebuildAttempt: nextAttempt,
    },
  });
  return true;
}

function synchronizeOwnerProspectorConstruction(directiveFile, state, now = Date.now()) {
  const directive = readJson(directiveFile);
  const experiment = directive?.prospectorExperiment;
  const nowMs = Number(now);
  const stateAtMs = Date.parse(state?.t);
  const source = state?.sources?.buildings;
  const sourceAtMs = Date.parse(source?.asOf);
  const buildingId = Number(experiment?.buildingId);
  const expectedName = canonicalProspectorBuildingName(experiment?.building);
  const stateIsFresh = Number.isFinite(nowMs) && Number.isFinite(stateAtMs) &&
    Number.isFinite(sourceAtMs) && stateAtMs <= nowMs + 60e3 &&
    sourceAtMs <= nowMs + 60e3 && nowMs - stateAtMs <= MAX_COMPLETION_STATE_AGE_MS &&
    nowMs - sourceAtMs <= MAX_COMPLETION_STATE_AGE_MS;
  if (directive?.schemaVersion !== 1 || directive?.status !== 'pending' ||
      directive?.priority !== 'owner' || !ownerProspectorRootIsAuthorized(directive) ||
      !isProspectorCampaign(experiment) || experiment?.campaign?.status !== 'active' ||
      !Number.isSafeInteger(buildingId) || buildingId <= 0 ||
      !PROSPECTOR_BUILDING_NAMES.has(expectedName) ||
      source?.status !== 'ok' || !stateIsFresh || !Array.isArray(state?.buildings)) {
    return false;
  }
  const matches = state.buildings.filter(building => Number(building?.id) === buildingId);
  if (matches.length !== 1) return false;
  const building = matches[0];
  const busyType = canonicalProspectorBuildingName(
    building?.busy?.type || building?.busy?.rawCategory,
  );
  const endsAtMs = Date.parse(building?.busy?.endsAt);
  if (canonicalProspectorBuildingName(building?.name) !== expectedName ||
      Number(building?.size) !== 1 ||
      !['construction', 'b'].includes(busyType) ||
      building?.busy?.expanding !== true ||
      !Number.isFinite(endsAtMs) || endsAtMs <= nowMs) {
    return false;
  }
  const completesAt = new Date(endsAtMs).toISOString();
  if (experiment.completesAt === completesAt) return true;
  const nextAttempt = experiment.rebuildAttempt?.rebuiltBuildingId === buildingId
    ? {
        ...experiment.rebuildAttempt,
        rebuildCompletesAt: completesAt,
      }
    : experiment.rebuildAttempt;
  writeJsonAtomic(directiveFile, {
    ...directive,
    prospectorExperiment: {
      ...experiment,
      completesAt,
      constructionEvidence: {
        status: 'verified',
        buildingId,
        building: building.name,
        level: Number(building.size),
        stateAsOf: state.t,
        completesAt,
        recordedAt: new Date(nowMs).toISOString(),
      },
      rebuildAttempt: nextAttempt,
    },
  });
  return true;
}

function readPendingOwnerDirective(directiveFile, stateFile, now = Date.now()) {
  let directive = readJson(directiveFile);
  if (directive?.schemaVersion !== 1 || directive?.status !== 'pending' ||
      directive?.priority !== 'owner' || !directive.id || !directive.action) return null;
  const state = readJson(stateFile);

  if (directive.action === 'fund-and-upgrade-building') {
    const nowMs = Number(now);
    const nowIsRepresentable = Number.isFinite(new Date(nowMs).getTime());
    const definition = ownerUpgradeProgramDefinition(directive);
    let programEvidence = programCompletionEvidenceIsValid(directive)
      ? directive.program.completionEvidence
      : null;
    if (!programEvidence) {
      programEvidence = buildProgramCompletionEvidence(directive, state, nowMs);
      if (programEvidence) {
        directive = {
          ...directive,
          program: {
            ...(directive.program || {}),
            buildingIds: definition.buildingIds,
            targetLevel: definition.programTargetLevel,
            status: 'completed',
            completedAt: new Date(nowMs).toISOString(),
            completionEvidence: programEvidence,
          },
        };
        writeJsonAtomic(directiveFile, directive);
      }
    }
    const ownerSubtasks = pendingOwnerSubtasks(directive);
    if (programEvidence && programCompletionEvidenceIsValid(directive) &&
        ownerSubtasks.length === 0 && nowIsRepresentable) {
      const targetBuilding = programEvidence.buildings.find(
        building => Number(building.buildingId) === definition.buildingId,
      );
      writeJsonAtomic(directiveFile, {
        ...directive,
        status: 'completed',
        completedAt: new Date(nowMs).toISOString(),
        completionEvidence: {
          stateAsOf: programEvidence.stateAsOf,
          buildingId: definition.buildingId,
          level: Number(targetBuilding.level),
          idle: targetBuilding.activity === 'idle',
          activity: targetBuilding.activity,
          stateAgeSeconds: programEvidence.stateAgeSeconds,
          programCompletedAt: directive.program.completedAt,
          programBuildings: programEvidence.buildings.map(building => ({
            buildingId: Number(building.buildingId),
            level: Number(building.level),
            idle: building.activity === 'idle',
            activity: building.activity,
          })),
          ownerSubtasks: directive.prospectorExperiment ? [{
            key: 'prospectorExperiment',
            status: directive.prospectorExperiment.status,
            verificationEvidence: directive.prospectorExperiment.verificationEvidence || null,
          }] : [],
        },
      });
      return null;
    }
  }
  if (directive.action === OWNER_SUBTASK_ACTION && directive.prospectorExperiment &&
      pendingOwnerSubtasks(directive).length === 0 &&
      Number.isFinite(new Date(Number(now)).getTime())) {
    writeJsonAtomic(directiveFile, {
      ...directive,
      status: 'completed',
      completedAt: new Date(Number(now)).toISOString(),
      completionEvidence: {
        ownerSubtasks: [{
          key: 'prospectorExperiment',
          status: directive.prospectorExperiment.status,
          verificationEvidence: directive.prospectorExperiment.verificationEvidence || null,
        }],
      },
    });
    return null;
  }
  const recoveryCandidate = findOwnerProspectorRecoveryCandidate(state, directive, now);
  const decorated = decoratePendingDirective(directive);
  if (!recoveryCandidate || !decorated?.prospectorExperiment) return decorated;
  return {
    ...decorated,
    activeInstruction: `${decorated.activeInstruction || ''} The fresh authoritative building state contains exactly one safe Prospector recovery candidate: ${recoveryCandidate.building} ${recoveryCandidate.buildingId}, level 1. Preview and confirm that exact candidate; the action gate will require fresh page-derived idle evidence and authenticated achievement evidence before atomically rebinding it.`.trim(),
    prospectorExperiment: {
      ...decorated.prospectorExperiment,
      recoveryCandidate,
    },
  };
}

function readPendingOwnerDirectiveForPrompt(directiveFile, stateFile, now = Date.now()) {
  const directive = readPendingOwnerDirective(directiveFile, stateFile, now);
  if (!directive || directive.action !== OWNER_SUBTASK_ACTION ||
      !isProspectorCampaign(directive.prospectorExperiment)) return directive;
  return {
    ...pickDefined(directive, [
      'schemaVersion',
      'id',
      'status',
      'priority',
      'action',
      'activeInstruction',
      'pendingOwnerSubtasks',
    ]),
    prospectorExperiment: compactProspectorExperiment(
      directive.prospectorExperiment,
      { prompt: true },
    ),
  };
}

function markOwnerBridgeStarted(directiveFile, directiveId, evidence) {
  const directive = readJson(directiveFile);
  if (directive?.schemaVersion !== 1 || directive?.status !== 'pending' ||
      directive?.id !== directiveId || !['authorized', 'started'].includes(directive?.bridgeProduction?.status)) return false;
  const quantity = Number(evidence?.quantity);
  const durationSeconds = Number(evidence?.durationSeconds);
  const startedAtMs = Number(evidence?.startedAtMs);
  const finishBeforeMs = evidence?.finishBefore == null ? null : Date.parse(evidence.finishBefore);
  const expectedEndMs = startedAtMs + durationSeconds * 1000;
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 || !Number.isFinite(startedAtMs) ||
      !Number.isFinite(finishBeforeMs) || finishBeforeMs <= startedAtMs ||
      !Number.isFinite(new Date(startedAtMs).getTime()) ||
      !Number.isFinite(new Date(expectedEndMs).getTime()) || expectedEndMs > finishBeforeMs) return false;
  const run = {
    quantity,
    durationSeconds,
    startedAt: new Date(startedAtMs).toISOString(),
    expectedEndAt: new Date(expectedEndMs).toISOString(),
    checkpointAt: new Date(finishBeforeMs).toISOString(),
  };
  const priorRuns = Array.isArray(directive.bridgeProduction.runs)
    ? directive.bridgeProduction.runs
    : (directive.bridgeProduction.status === 'started' && directive.bridgeProduction.startedAt
      ? [{
          quantity: directive.bridgeProduction.quantity,
          durationSeconds: directive.bridgeProduction.durationSeconds,
          startedAt: directive.bridgeProduction.startedAt,
          expectedEndAt: directive.bridgeProduction.expectedEndAt,
          checkpointAt: directive.bridgeProduction.checkpointAt || directive.executeNotBefore || null,
        }]
      : []);
  writeJsonAtomic(directiveFile, {
    ...directive,
    executeNotBefore: new Date(finishBeforeMs).toISOString(),
    bridgeProduction: {
      ...directive.bridgeProduction,
      status: 'started',
      ...run,
      runs: [...priorRuns, run].slice(-10),
    },
  });
  return true;
}

module.exports = {
  OWNER_SUBTASK_ACTION,
  PROSPECTOR_OVERVIEW_PATH,
  completedProgramActivity,
  authorizeOwnerProspectorRebuild,
  claimOwnerProspectorRebuildAttempt,
  findOwnerProspectorRecoveryCandidate,
  markOwnerBridgeStarted,
  parseProspectorOverview,
  pendingOwnerSubtasks,
  programCompletionEvidenceIsValid,
  readPendingOwnerDirective,
  readPendingOwnerDirectiveForPrompt,
  recordOwnerProspectorRebuildOutcome,
  recordOwnerProspectorOverview,
  refreshAndClaimOwnerProspectorRebuildAttempt,
  synchronizeOwnerProspectorConstruction,
};
