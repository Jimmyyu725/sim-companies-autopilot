'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const MAX_COMPLETION_STATE_AGE_MS = 5 * 60e3;
const PROSPECTOR_OVERVIEW_PATH = '/api/v2/companies/me/achievements/';
const PROSPECTOR_CAMPAIGN_MODE = 'repeat-until-achievement-complete';
const PROSPECTOR_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'abandoned']);
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

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
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
  if (programCompletionEvidenceIsValid(decorated) && pendingSubtasks.length > 0) {
    decorated = {
      ...decorated,
      action: OWNER_SUBTASK_ACTION,
      completedAction: directive.action,
      activeInstruction: 'The funded upgrade program is authoritatively complete. Do not preview or start another upgrade or upgrade bridge; execute only the listed pending owner subtasks. The exact eligible owner-authorized Prospector REBUILD campaign is already strategically approved: after each replacement Quarry finishes, dry-preview it, confirm it without council re-review, verify exactly one counter increment, bind the replacement building ID, and repeat until stars equals starsMax. Do not start production on the campaign target once REBUILD is executable.',
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
      completedAttempts: experiment.completedAttempts,
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
  const priorAttempts = Array.isArray(experiment.completedAttempts)
    ? experiment.completedAttempts.filter(row => row?.attemptId !== attempt.attemptId)
    : [];
  return {
    rebuildAttempt: verifiedAttempt,
    completedAttempts: [...priorAttempts, verifiedAttempt].slice(-250),
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
          completedAttempts: verifiedAttempt.completedAttempts,
          campaign: {
            ...experiment.campaign,
            status: 'active',
            currentStars: progress.stars,
            starsMax: progress.starsMax,
            verifiedRebuilds: verifiedAttempt.verifiedRebuilds,
            lastVerifiedAt: new Date(nowMs).toISOString(),
          },
        };
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
) {
  const evidence = recordOwnerProspectorOverview(directiveFile, observation, now);
  if (!evidence?.recorded || evidence.experimentStatus !== 'baseline-verified') {
    return {
      ok: false,
      reason: 'fresh authenticated Prospector baseline is unavailable for this REBUILD',
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
    Number.isSafeInteger(rebuiltBuildingId) && rebuiltBuildingId > 0 &&
    Number.isFinite(completesAtMs) && completesAtMs > Number(now);
  const nextAttempt = {
    ...attempt,
    status: commitPossible ? 'awaiting-counter' : 'not-clicked',
    resultRecordedAt: new Date(Number(now)).toISOString(),
    commitPossible,
    verified: result?.verified === true,
    ...(verifiedReplacement ? {
      rebuiltBuildingId,
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
        completesAt: new Date(completesAtMs).toISOString(),
      } : {}),
      rebuildAttempt: nextAttempt,
    },
  });
  return true;
}

function readPendingOwnerDirective(directiveFile, stateFile, now = Date.now()) {
  let directive = readJson(directiveFile);
  if (directive?.schemaVersion !== 1 || directive?.status !== 'pending' ||
      directive?.priority !== 'owner' || !directive.id || !directive.action) return null;

  if (directive.action === 'fund-and-upgrade-building') {
    const state = readJson(stateFile);
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
  return decoratePendingDirective(directive);
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
  markOwnerBridgeStarted,
  parseProspectorOverview,
  pendingOwnerSubtasks,
  programCompletionEvidenceIsValid,
  readPendingOwnerDirective,
  recordOwnerProspectorRebuildOutcome,
  recordOwnerProspectorOverview,
  refreshAndClaimOwnerProspectorRebuildAttempt,
};
