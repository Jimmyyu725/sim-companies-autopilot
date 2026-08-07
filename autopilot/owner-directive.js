'use strict';

// Owner directives: an out-of-band instruction the owner leaves for the brain, currently the
// funded upgrade program and its bridge production. The Prospector achievement campaign used to
// live here too and made up most of this file; the owner retired it on 2026-08-02 when the company
// went back to Coffee, so every quarry, mine and oil-rig code path is gone.

const fs = require('fs');
const { validatePageActivityInspection } = require('./building-page-activity.js');
const MAX_COMPLETION_STATE_AGE_MS = 5 * 60e3;
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

function completedProgramActivity(building, nowMs = Date.now()) {
  if (!building || typeof building !== 'object') return null;
  // Completion needs positive evidence that the upgrade has finished, and `size` cannot provide it:
  // it reports the TARGET level while construction runs (Farm 55693034, 2026-08-06: size 3 at actual
  // level 1). So the activity test is the only thing standing between a started upgrade and a
  // directive that retires before the work is done.
  //
  // An absent `busy` key is NOT that evidence. state-feed-validation.js:43 records the reason, with
  // an observation behind it: "The live buildings endpoint omits `busy` when some jobs finish
  // (verified on a Water reservoir at 2026-07-27T07:07Z). Absence is activity UNKNOWN ... never
  // proof of idle." state-helpers.js:82 says the same: only an explicit null means confirmed idle.
  //
  // PR #79 read absence as idle to unstick a directive that could never complete, on the reasoning
  // that absence cannot coexist with construction. That reasoning was wrong, and the consequence was
  // live: a confirmed upgrade reports the target size immediately, so a capture that happened to
  // omit `busy` would have retired the directive while the building was still being built.
  //
  // The way out of the original deadlock is a page read, not a weaker rule. inspect_building writes
  // an activityInspection that validatePageActivityInspection checks against this exact building and
  // level, and that is real evidence of idle. A directive may now wait a wake for one. That is the
  // correct trade: late is recoverable, wrong is not.
  if (building.busy === null) return 'idle';
  if (building.busy === undefined) {
    const inspection = validatePageActivityInspection(building, building.activityInspection, nowMs);
    // 'page-derived' is what validatePageActivityInspection returns (building-page-activity.js:165).
    // Demanding 'known' made this branch unreachable, so #83 replaced one deadlock with another: the
    // directive could never retire, and act.js:615 refuses every produce on a reserved building, so
    // the Farm could never be given work either — and work is the only other completion path.
    return inspection && inspection.busy === false
      && (inspection.status === 'page-derived' || inspection.status === 'known') ? 'idle' : null;
  }
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
    const activity = completedProgramActivity(building, nowMs);
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
    if (programEvidence && programCompletionEvidenceIsValid(directive) && nowIsRepresentable) {
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
        },
      });
      return null;
    }
  }
  return directive;
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
  completedProgramActivity,
  markOwnerBridgeStarted,
  programCompletionEvidenceIsValid,
  readPendingOwnerDirective,
};
