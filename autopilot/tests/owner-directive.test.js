'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OWNER_SUBTASK_ACTION,
  PROSPECTOR_OVERVIEW_PATH,
  authorizeOwnerProspectorRebuild,
  claimOwnerProspectorRebuildAttempt,
  markOwnerBridgeStarted,
  parseProspectorOverview,
  readPendingOwnerDirective,
  recordOwnerProspectorRebuildOutcome,
  recordOwnerProspectorOverview,
  refreshAndClaimOwnerProspectorRebuildAttempt,
} = require('../owner-directive.js');

function fixture({ level = 1, busy = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-owner-directive-'));
  const directiveFile = path.join(directory, 'OWNER-DIRECTIVE.json');
  const stateFile = path.join(directory, '.state.json');
  fs.writeFileSync(directiveFile, JSON.stringify({
    schemaVersion: 1,
    id: 'upgrade-one-mill',
    status: 'pending',
    priority: 'owner',
    action: 'fund-and-upgrade-building',
    buildingId: 42,
    targetLevel: 2,
  }));
  fs.writeFileSync(stateFile, JSON.stringify({
    t: '2026-07-26T22:45:00.000Z',
    sources: {
      buildings: { status: 'ok', asOf: '2026-07-26T22:45:00.000Z' },
    },
    buildings: [{ id: 42, name: 'Mill', size: level, busy }],
  }));
  return { directory, directiveFile, stateFile };
}

function prospectorOverview(current, target = 10, { stars = 0, starsMax = 7 } = {}) {
  return [{
    label: 'Prospector',
    action: 'Scrap 10 mines, quarries or rigs',
    stars,
    starsMax,
    progress: {
      percent: current / target * 100,
      label: `${current} out of ${target}`,
    },
  }];
}

function completedProspectorOverview(starsMax = 7) {
  return [{
    label: 'Prospector',
    type: 'Prospector',
    action: null,
    stars: starsMax,
    starsMax,
    progress: null,
  }];
}

test('pending upgrade directive remains visible before the target level is reached', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  assert.equal(readPendingOwnerDirective(files.directiveFile, files.stateFile)?.id, 'upgrade-one-mill');
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).status, 'pending');
});

test('construction does not prematurely complete the owner directive', t => {
  const files = fixture({ level: 2, busy: { type: 'construction' } });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const pending = readPendingOwnerDirective(files.directiveFile, files.stateFile);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.action, 'fund-and-upgrade-building');
  assert.equal(pending.program?.completionEvidence, undefined);
});

test('fresh idle target-level evidence completes the directive atomically', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  ), null);
  const completed = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completionEvidence.level, 2);
  assert.equal(completed.completedAt, '2026-07-26T22:46:00.000Z');
});

test('stale idle state cannot complete an owner directive', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T23:00:01.000Z'),
  )?.status, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).status, 'pending');
});

test('non-authoritative building state cannot complete an owner directive', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const state = JSON.parse(fs.readFileSync(files.stateFile, 'utf8'));
  state.sources = { buildings: { status: 'fallback', asOf: state.t } };
  fs.writeFileSync(files.stateFile, JSON.stringify(state));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  )?.status, 'pending');
});

test('missing or unbound building source evidence cannot complete an owner directive', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const state = JSON.parse(fs.readFileSync(files.stateFile, 'utf8'));
  delete state.sources;
  fs.writeFileSync(files.stateFile, JSON.stringify(state));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  )?.status, 'pending');

  state.sources = { buildings: { status: 'ok' } };
  fs.writeFileSync(files.stateFile, JSON.stringify(state));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  )?.status, 'pending');

  state.sources.buildings.asOf = '2026-07-26T22:44:59.000Z';
  fs.writeFileSync(files.stateFile, JSON.stringify(state));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  )?.status, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).status, 'pending');
});

test('a multi-Mill program completes when every target-level Mill is idle or in normal work', t => {
  const files = fixture({ level: 3, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.targetLevel = 3;
  directive.program = { buildingIds: [42, 43], targetLevel: 3 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  fs.writeFileSync(files.stateFile, JSON.stringify({
    t: '2026-07-26T23:00:00.000Z',
    sources: {
      buildings: { status: 'ok', asOf: '2026-07-26T23:00:00.000Z' },
    },
    buildings: [
      { id: 42, name: 'Mill', size: 3, busy: null },
      { id: 43, name: 'Mill', size: 2, busy: null },
    ],
  }));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T23:01:00.000Z'),
  )?.status, 'pending');
  fs.writeFileSync(files.stateFile, JSON.stringify({
    t: '2026-07-27T05:00:00.000Z',
    sources: {
      buildings: { status: 'ok', asOf: '2026-07-27T05:00:00.000Z' },
    },
    buildings: [
      { id: 42, name: 'Mill', size: 3, busy: { type: 'production' } },
      { id: 43, name: 'Mill', size: 3, busy: { type: 'sale' } },
    ],
  }));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-27T05:01:00.000Z'),
  ), null);
  const completed = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(completed.completionEvidence.programBuildings.length, 2);
  assert.deepEqual(
    completed.completionEvidence.programBuildings.map(building => building.activity),
    ['production', 'sale'],
  );
  assert.equal(completed.completionEvidence.idle, false);
});

test('a completed Mill program remains a pending root only for Prospector', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = { status: 'building', buildingId: 99 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const pending = readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  );
  assert.equal(pending.status, 'pending');
  assert.equal(pending.action, OWNER_SUBTASK_ACTION);
  assert.equal(pending.completedAction, 'fund-and-upgrade-building');
  assert.match(pending.activeInstruction, /Do not preview or start another upgrade/i);
  assert.equal(pending.program.status, 'completed');
  assert.equal(pending.program.completionEvidence.status, 'verified');
  assert.equal(pending.program.completionEvidence.buildings[0].activity, 'idle');
  assert.deepEqual(pending.pendingOwnerSubtasks.map(subtask => subtask.key), ['prospectorExperiment']);
  assert.equal(pending.prospectorExperiment.progressEvidenceContract.path, PROSPECTOR_OVERVIEW_PATH);
  const persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(persisted.status, 'pending');
  assert.equal(persisted.action, 'fund-and-upgrade-building');
  assert.equal(persisted.program.status, 'completed');
  assert.equal(persisted.program.completionEvidence.status, 'verified');
});

test('Prospector overview parser uses the exact total-progress response shape', () => {
  assert.deepEqual(parseProspectorOverview(prospectorOverview(1)), {
    label: 'Prospector',
    action: 'Scrap 10 mines, quarries or rigs',
    current: 1,
    target: 10,
    percent: 10,
    stars: 0,
    starsMax: 7,
    complete: false,
  });
  assert.equal(parseProspectorOverview([{ label: 'Prospector', action: 'Scrap 10 mines', progress: { label: '1/10', percent: 10 } }]), null);
  assert.equal(parseProspectorOverview([...prospectorOverview(1), ...prospectorOverview(1)]), null);
  const unknownPercent = prospectorOverview(0);
  unknownPercent[0].progress.percent = null;
  assert.equal(parseProspectorOverview(unknownPercent), null);
  const missingStars = prospectorOverview(1);
  missingStars[0].stars = null;
  missingStars[0].starsMax = '';
  assert.equal(parseProspectorOverview(missingStars).stars, null);
  assert.equal(parseProspectorOverview(missingStars).starsMax, null);
  assert.deepEqual(parseProspectorOverview(completedProspectorOverview()), {
    label: 'Prospector', action: null, current: null, target: null, percent: null,
    stars: 7, starsMax: 7, complete: true,
  });
});

test('two authoritative overview reads record Prospector 0/10 to 1/10 and unblock root completion', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = { status: 'building', buildingId: 99 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const baselineAt = '2026-07-26T22:46:00.000Z';
  assert.deepEqual(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: baselineAt,
    data: prospectorOverview(0),
  }, Date.parse(baselineAt)), {
    recorded: true,
    experimentStatus: 'baseline-verified',
    current: 0,
    target: 10,
    stars: 0,
    starsMax: 7,
    path: PROSPECTOR_OVERVIEW_PATH,
  });
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:30.000Z'),
  )?.action, OWNER_SUBTASK_ACTION);
  const persistedProgram = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).program;
  assert.equal(persistedProgram.status, 'completed');

  // Program completion is durable evidence. Prospector may be verified in a later wake even when
  // the building snapshot that originally proved the Mill target is no longer fresh.
  const staleState = JSON.parse(fs.readFileSync(files.stateFile, 'utf8'));
  staleState.t = '2026-07-26T20:00:00.000Z';
  staleState.sources.buildings.asOf = staleState.t;
  fs.writeFileSync(files.stateFile, JSON.stringify(staleState));
  const verifiedAt = '2026-07-26T22:47:00.000Z';
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: verifiedAt,
    data: prospectorOverview(1),
  }, Date.parse(verifiedAt)).experimentStatus, 'verified');
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:47:00.000Z'),
  ), null);
  const completed = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(completed.status, 'completed');
  assert.equal(completed.prospectorExperiment.verificationEvidence.current, 1);
});

test('a later bounded experiment uses its configured Prospector 1/10 to 2/10 stage', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = {
    status: 'building',
    buildingId: 99,
    expectedBaseline: 1,
    expectedTarget: 10,
    expectedIncrement: 1,
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const pending = readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  );
  assert.match(pending.prospectorExperiment.progressEvidenceContract.progressField, /1 out of 10.*2 out of 10/);
  const baselineAt = '2026-07-26T22:46:00.000Z';
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: baselineAt,
    data: prospectorOverview(1),
  }, Date.parse(baselineAt)).experimentStatus, 'baseline-verified');
  const verifiedAt = '2026-07-26T22:47:00.000Z';
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: verifiedAt,
    data: prospectorOverview(2),
  }, Date.parse(verifiedAt)).experimentStatus, 'verified');
});

test('continuous Prospector campaign binds the replacement and rearms after one verified increment', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const now = Date.parse('2026-07-27T15:35:25.000Z');
  const observedAt = new Date(now - 30e3).toISOString();
  const completesAt = new Date(now + 3 * 60 * 60e3).toISOString();
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = {
    status: 'baseline-verified',
    building: 'Quarry',
    buildingId: 99,
    level: 1,
    completesAt: new Date(now - 60e3).toISOString(),
    expectedBaseline: 2,
    expectedTarget: 10,
    expectedIncrement: 1,
    campaign: {
      mode: 'repeat-until-achievement-complete',
      status: 'active',
      currentStars: 0,
      starsMax: 7,
      verifiedRebuilds: 0,
    },
    baselineProgress: {
      path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt,
      current: 2, target: 10, stars: 0, starsMax: 7,
    },
    lastProgressEvidence: {
      path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt,
      current: 2, target: 10, stars: 0, starsMax: 7,
    },
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));

  const claim = claimOwnerProspectorRebuildAttempt(files.directiveFile, 99, now);
  assert.equal(claim.ok, true);
  assert.equal(recordOwnerProspectorRebuildOutcome(files.directiveFile, claim.attemptId, {
    commitClicked: true,
    verified: true,
    rebuiltBuildingId: 100,
    rebuildCompletesAt: completesAt,
  }, now + 1000), true);
  let persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(persisted.prospectorExperiment.status, 'awaiting-counter');
  assert.equal(persisted.prospectorExperiment.buildingId, 100);
  assert.equal(persisted.prospectorExperiment.completesAt, completesAt);

  const verifiedAt = now + 60e3;
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: new Date(verifiedAt).toISOString(),
    data: prospectorOverview(3),
  }, verifiedAt).experimentStatus, 'waiting-construction');
  persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(persisted.prospectorExperiment.expectedBaseline, 3);
  assert.equal(persisted.prospectorExperiment.expectedTarget, 10);
  assert.equal(persisted.prospectorExperiment.baselineProgress.current, 3);
  assert.equal(persisted.prospectorExperiment.rebuildAttempt.status, 'verified');
  assert.equal(persisted.prospectorExperiment.campaign.verifiedRebuilds, 1);
  const freshState = JSON.parse(fs.readFileSync(files.stateFile, 'utf8'));
  freshState.t = new Date(verifiedAt).toISOString();
  freshState.sources.buildings.asOf = freshState.t;
  fs.writeFileSync(files.stateFile, JSON.stringify(freshState));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    verifiedAt,
  ).action, OWNER_SUBTASK_ACTION);
});

test('continuous Prospector campaign never duplicates while its counter is unchanged', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const now = Date.parse('2026-07-27T15:35:25.000Z');
  const baselineAt = new Date(now - 30e3).toISOString();
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = {
    status: 'awaiting-counter', building: 'Quarry', buildingId: 100, level: 1,
    completesAt: new Date(now + 3 * 60 * 60e3).toISOString(),
    expectedBaseline: 2, expectedTarget: 10, expectedIncrement: 1,
    campaign: { mode: 'repeat-until-achievement-complete', status: 'active', currentStars: 0, starsMax: 7 },
    baselineProgress: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt: baselineAt,
      current: 2, target: 10, stars: 0, starsMax: 7 },
    lastProgressEvidence: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt: baselineAt,
      current: 2, target: 10, stars: 0, starsMax: 7 },
    rebuildAttempt: { attemptId: 'active', status: 'awaiting-counter', buildingId: 99 },
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const observed = recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: new Date(now).toISOString(),
    data: prospectorOverview(2),
  }, now);
  assert.equal(observed.experimentStatus, 'awaiting-counter');
  const persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(persisted.prospectorExperiment.rebuildAttempt.status, 'awaiting-counter');
  assert.equal(claimOwnerProspectorRebuildAttempt(files.directiveFile, 100, now).ok, false);
});

test('continuous Prospector campaign accepts one exact tier transition and rejects a jump', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const now = Date.parse('2026-07-27T18:40:00.000Z');
  const baselineAt = new Date(now - 60e3).toISOString();
  const base = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  base.prospectorExperiment = {
    status: 'awaiting-counter', building: 'Quarry', buildingId: 100, level: 1,
    completesAt: new Date(now + 3 * 60 * 60e3).toISOString(),
    expectedBaseline: 9, expectedTarget: 10, expectedIncrement: 1,
    campaign: { mode: 'repeat-until-achievement-complete', status: 'active', currentStars: 0, starsMax: 7 },
    baselineProgress: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt: baselineAt,
      current: 9, target: 10, stars: 0, starsMax: 7 },
    lastProgressEvidence: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt: baselineAt,
      current: 9, target: 10, stars: 0, starsMax: 7 },
    rebuildAttempt: { attemptId: 'tier', status: 'awaiting-counter', buildingId: 99 },
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(base));
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: new Date(now).toISOString(),
    data: prospectorOverview(10, 50, { stars: 1 }),
  }, now).experimentStatus, 'waiting-construction');
  let persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(persisted.prospectorExperiment.expectedBaseline, 10);
  assert.equal(persisted.prospectorExperiment.expectedTarget, 50);
  assert.equal(persisted.prospectorExperiment.campaign.currentStars, 1);

  base.prospectorExperiment.expectedBaseline = 2;
  base.prospectorExperiment.expectedTarget = 10;
  base.prospectorExperiment.baselineProgress.current = 2;
  base.prospectorExperiment.lastProgressEvidence.current = 2;
  base.prospectorExperiment.rebuildAttempt = { attemptId: 'jump', status: 'awaiting-counter' };
  fs.writeFileSync(files.directiveFile, JSON.stringify(base));
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: new Date(now).toISOString(),
    data: prospectorOverview(4),
  }, now).experimentStatus, 'counter-mismatch');
});

test('continuous Prospector campaign stops only when the authenticated achievement is fully complete', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const now = Date.parse('2026-07-27T18:40:00.000Z');
  const baselineAt = new Date(now - 60e3).toISOString();
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = {
    status: 'awaiting-counter', building: 'Quarry', buildingId: 100, level: 1,
    completesAt: new Date(now + 3 * 60 * 60e3).toISOString(),
    expectedBaseline: 9, expectedTarget: 10, expectedIncrement: 1,
    campaign: { mode: 'repeat-until-achievement-complete', status: 'active', currentStars: 6, starsMax: 7 },
    baselineProgress: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt: baselineAt,
      current: 9, target: 10, stars: 6, starsMax: 7 },
    lastProgressEvidence: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt: baselineAt,
      current: 9, target: 10, stars: 6, starsMax: 7 },
    rebuildAttempt: { attemptId: 'final', status: 'awaiting-counter' },
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: new Date(now).toISOString(),
    data: completedProspectorOverview(),
  }, now).experimentStatus, 'completed');
  const persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(persisted.prospectorExperiment.campaign.status, 'completed');
  const freshState = JSON.parse(fs.readFileSync(files.stateFile, 'utf8'));
  freshState.t = new Date(now).toISOString();
  freshState.sources.buildings.asOf = freshState.t;
  fs.writeFileSync(files.stateFile, JSON.stringify(freshState));
  assert.equal(readPendingOwnerDirective(files.directiveFile, files.stateFile, now), null);
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).status, 'completed');
});

test('Prospector REBUILD claim is exact, fresh, and one-use while a click may be pending', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const now = Date.parse('2026-07-27T09:30:00.000Z');
  const observedAt = new Date(now - 30e3).toISOString();
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = {
    status: 'baseline-verified', buildingId: 99, completesAt: new Date(now - 60e3).toISOString(),
    expectedBaseline: 1, expectedTarget: 10, expectedIncrement: 1,
    baselineProgress: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt, current: 1, target: 10 },
    lastProgressEvidence: { path: PROSPECTOR_OVERVIEW_PATH, status: 200, observedAt, current: 1, target: 10 },
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));

  assert.equal(authorizeOwnerProspectorRebuild(directive, 99, now).ok, true);
  assert.equal(authorizeOwnerProspectorRebuild(directive, 100, now).ok, false);
  const claim = claimOwnerProspectorRebuildAttempt(files.directiveFile, 99, now);
  assert.equal(claim.ok, true);
  assert.equal(claimOwnerProspectorRebuildAttempt(files.directiveFile, 99, now).ok, false);
  assert.equal(recordOwnerProspectorRebuildOutcome(
    files.directiveFile, claim.attemptId, { mutationAttempted: true }, now + 1000), true);
  const attempted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(attempted.prospectorExperiment.rebuildAttempt.status, 'awaiting-counter');
  assert.equal(authorizeOwnerProspectorRebuild(attempted, 99, now + 2000).ok, false);
  assert.equal(authorizeOwnerProspectorRebuild({
    ...directive,
    prospectorExperiment: {
      ...directive.prospectorExperiment,
      lastProgressEvidence: { ...directive.prospectorExperiment.lastProgressEvidence,
        observedAt: new Date(now - 6 * 60e3).toISOString() },
    },
  }, 99, now).ok, false);
});

test('confirmed Prospector REBUILD refreshes the authenticated baseline before one-use claim', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const now = Date.parse('2026-07-27T13:29:28.000Z');
  const staleObservedAt = new Date(now - 23 * 60e3).toISOString();
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = {
    status: 'baseline-verified',
    buildingId: 99,
    completesAt: new Date(now - 60e3).toISOString(),
    expectedBaseline: 1,
    expectedTarget: 10,
    expectedIncrement: 1,
    baselineProgress: {
      path: PROSPECTOR_OVERVIEW_PATH,
      status: 200,
      observedAt: staleObservedAt,
      current: 1,
      target: 10,
    },
    lastProgressEvidence: {
      path: PROSPECTOR_OVERVIEW_PATH,
      status: 200,
      observedAt: staleObservedAt,
      current: 1,
      target: 10,
    },
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));

  assert.equal(authorizeOwnerProspectorRebuild(directive, 99, now).ok, false);
  const observation = {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: new Date(now - 1000).toISOString(),
    data: prospectorOverview(1),
  };
  const claimed = refreshAndClaimOwnerProspectorRebuildAttempt(
    files.directiveFile,
    99,
    observation,
    now,
  );
  assert.equal(claimed.ok, true);
  assert.equal(claimed.ownerDirectiveEvidence.current, 1);
  assert.equal(claimed.ownerDirectiveEvidence.target, 10);
  const persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(persisted.prospectorExperiment.lastProgressEvidence.observedAt,
    observation.fetchedAt);
  assert.equal(persisted.prospectorExperiment.rebuildAttempt.status, 'claimed');
  assert.equal(refreshAndClaimOwnerProspectorRebuildAttempt(
    files.directiveFile,
    99,
    { ...observation, fetchedAt: new Date(now).toISOString() },
    now,
  ).ok, false);
});

test('Prospector refresh-and-claim fails closed on malformed, wrong, or advanced progress', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const now = Date.parse('2026-07-27T13:29:28.000Z');
  const observedAt = new Date(now - 1000).toISOString();
  const baseDirective = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  baseDirective.prospectorExperiment = {
    status: 'baseline-verified',
    buildingId: 99,
    completesAt: new Date(now - 60e3).toISOString(),
    expectedBaseline: 1,
    expectedTarget: 10,
    expectedIncrement: 1,
    baselineProgress: {
      path: PROSPECTOR_OVERVIEW_PATH,
      status: 200,
      observedAt,
      current: 1,
      target: 10,
    },
    lastProgressEvidence: {
      path: PROSPECTOR_OVERVIEW_PATH,
      status: 200,
      observedAt,
      current: 1,
      target: 10,
    },
  };

  for (const [label, observation] of [
    ['non-200', { path: PROSPECTOR_OVERVIEW_PATH, status: 503, fetchedAt: observedAt,
      data: prospectorOverview(1) }],
    ['wrong endpoint', { path: '/api/v2/no-cache/companies/me/achievements/', status: 200,
      fetchedAt: observedAt, data: prospectorOverview(1) }],
    ['stale', { path: PROSPECTOR_OVERVIEW_PATH, status: 200,
      fetchedAt: new Date(now - 6 * 60e3).toISOString(), data: prospectorOverview(1) }],
    ['malformed', { path: PROSPECTOR_OVERVIEW_PATH, status: 200, fetchedAt: observedAt,
      data: [] }],
    ['wrong baseline', { path: PROSPECTOR_OVERVIEW_PATH, status: 200, fetchedAt: observedAt,
      data: prospectorOverview(0) }],
    ['already advanced', { path: PROSPECTOR_OVERVIEW_PATH, status: 200, fetchedAt: observedAt,
      data: prospectorOverview(2) }],
  ]) {
    fs.writeFileSync(files.directiveFile, JSON.stringify(baseDirective));
    const result = refreshAndClaimOwnerProspectorRebuildAttempt(
      files.directiveFile,
      99,
      observation,
      now,
    );
    assert.equal(result.ok, false, label);
    const persisted = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
    assert.equal(persisted.prospectorExperiment.rebuildAttempt, undefined, label);
  }

  fs.writeFileSync(files.directiveFile, JSON.stringify(baseDirective));
  const wrongBuilding = refreshAndClaimOwnerProspectorRebuildAttempt(
    files.directiveFile,
    100,
    { path: PROSPECTOR_OVERVIEW_PATH, status: 200, fetchedAt: observedAt,
      data: prospectorOverview(1) },
    now,
  );
  assert.equal(wrongBuilding.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'))
    .prospectorExperiment.rebuildAttempt, undefined);
});

test('wrong endpoint, stale evidence, and a counter jump cannot verify Prospector', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = { status: 'building' };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const now = Date.parse('2026-07-26T22:46:00.000Z');
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: '/api/v2/no-cache/companies/me/achievements/', status: 200,
    fetchedAt: new Date(now).toISOString(), data: prospectorOverview(0),
  }, now), null);
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH, status: 200,
    fetchedAt: new Date(now - 10 * 60e3).toISOString(), data: prospectorOverview(0),
  }, now), null);
  recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH, status: 200,
    fetchedAt: new Date(now).toISOString(), data: prospectorOverview(0),
  }, now);
  const jumpedAt = now + 60e3;
  const jumped = recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH, status: 200,
    fetchedAt: new Date(jumpedAt).toISOString(), data: prospectorOverview(2),
  }, jumpedAt);
  assert.equal(jumped.experimentStatus, 'counter-mismatch');
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).status, 'pending');
});

test('explicitly unknown Prospector expectations cannot inherit numeric defaults', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = {
    status: 'building',
    expectedBaseline: null,
    expectedTarget: 10,
    expectedIncrement: 1,
  };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const now = Date.parse('2026-07-26T22:46:00.000Z');
  assert.equal(recordOwnerProspectorOverview(files.directiveFile, {
    path: PROSPECTOR_OVERVIEW_PATH,
    status: 200,
    fetchedAt: new Date(now).toISOString(),
    data: prospectorOverview(0),
  }, now), null);
});

test('a program cannot omit the root target building and complete on unrelated buildings', t => {
  const files = fixture({ level: 1, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.program = { buildingIds: [43], targetLevel: 2 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  fs.writeFileSync(files.stateFile, JSON.stringify({
    t: '2026-07-26T22:45:00.000Z',
    sources: {
      buildings: { status: 'ok', asOf: '2026-07-26T22:45:00.000Z' },
    },
    buildings: [
      { id: 42, name: 'Mill', size: 1, busy: null },
      { id: 43, name: 'Mill', size: 2, busy: null },
    ],
  }));
  assert.equal(readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  )?.status, 'pending');
});

test('missing busy evidence cannot be interpreted as an idle completed target', t => {
  const files = fixture({ level: 2, busy: null });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  fs.writeFileSync(files.stateFile, JSON.stringify({
    t: '2026-07-26T22:45:00.000Z',
    sources: {
      buildings: { status: 'ok', asOf: '2026-07-26T22:45:00.000Z' },
    },
    buildings: [{ id: 42, name: 'Mill', size: 2 }],
  }));
  const pending = readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  );
  assert.equal(pending.status, 'pending');
  assert.equal(pending.action, 'fund-and-upgrade-building');
  assert.equal(pending.program?.completionEvidence, undefined);
});

test('unknown busy work cannot be persisted as completed normal production or sale', t => {
  const files = fixture({ level: 2, busy: { type: 'unknown' } });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.prospectorExperiment = { status: 'building', buildingId: 99 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const pending = readPendingOwnerDirective(
    files.directiveFile,
    files.stateFile,
    Date.parse('2026-07-26T22:46:00.000Z'),
  );
  assert.equal(pending.action, 'fund-and-upgrade-building');
  assert.equal(pending.program?.completionEvidence, undefined);
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).program, undefined);
});

test('authorized bridge production is recorded once with an expected end', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.bridgeProduction = { status: 'authorized', maximumQuantity: 10 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  assert.equal(markOwnerBridgeStarted(files.directiveFile, 'upgrade-one-mill', {
    quantity: 9,
    durationSeconds: 1800,
    startedAtMs: Date.parse('2026-07-26T22:50:00.000Z'),
    finishBefore: '2026-07-26T23:21:00.000Z',
  }), true);
  const updated = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(updated.bridgeProduction.status, 'started');
  assert.equal(updated.bridgeProduction.expectedEndAt, '2026-07-26T23:20:00.000Z');
  assert.equal(updated.bridgeProduction.runs.length, 1);
  assert.equal(markOwnerBridgeStarted(files.directiveFile, 'upgrade-one-mill', {
    quantity: 9, durationSeconds: 1800, startedAtMs: Date.now(),
  }), false);
});

test('bridge evidence needs a checkpoint and cannot overrun it', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.bridgeProduction = { status: 'authorized', maximumQuantity: 10 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  const evidence = {
    quantity: 9,
    durationSeconds: 1800,
    startedAtMs: Date.parse('2026-07-26T22:50:00.000Z'),
  };
  assert.equal(markOwnerBridgeStarted(files.directiveFile, 'upgrade-one-mill', evidence), false);
  assert.equal(markOwnerBridgeStarted(files.directiveFile, 'upgrade-one-mill', {
    ...evidence,
    finishBefore: '2026-07-26T23:10:00.000Z',
  }), false);
  assert.equal(JSON.parse(fs.readFileSync(files.directiveFile, 'utf8')).bridgeProduction.status, 'authorized');
});

test('a pending upgrade can record another deadline-bound bridge instead of idling', t => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const directive = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  directive.bridgeProduction = { status: 'authorized', product: 'COFFEE POWDER', maximumQuantity: 10 };
  fs.writeFileSync(files.directiveFile, JSON.stringify(directive));
  assert.equal(markOwnerBridgeStarted(files.directiveFile, 'upgrade-one-mill', {
    quantity: 9,
    durationSeconds: 1800,
    startedAtMs: Date.parse('2026-07-26T22:50:00.000Z'),
    finishBefore: '2026-07-26T23:21:00.000Z',
  }), true);
  assert.equal(markOwnerBridgeStarted(files.directiveFile, 'upgrade-one-mill', {
    quantity: 18,
    durationSeconds: 3600,
    startedAtMs: Date.parse('2026-07-26T23:22:00.000Z'),
    finishBefore: '2026-07-27T00:23:00.000Z',
  }), true);
  const updated = JSON.parse(fs.readFileSync(files.directiveFile, 'utf8'));
  assert.equal(updated.executeNotBefore, '2026-07-27T00:23:00.000Z');
  assert.equal(updated.bridgeProduction.quantity, 18);
  assert.equal(updated.bridgeProduction.runs.length, 2);
});
