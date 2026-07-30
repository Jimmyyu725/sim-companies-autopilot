'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  WakeRuntimeGuard,
  actionChangedState,
  actionRequiresRefresh,
  bindStructuralPreviewToCouncilArgs,
  buildSafetyRetryAlarm,
  buildWakeAlarm,
  councilRequiredForStructuralAction,
  isApprovedRollingMillUpgrade,
  isOwnerAuthorizedProspectorRebuild,
  validateCouncilAuthorization,
  validateFinishSummary,
  buildAutomaticFinishOnExhaustion,
} = require('../runtime-guard.js');

for (const filename of ['build.js', 'scrap.js', 'rebuild.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', filename), 'utf8');
  assert.match(
    source,
    /ok:\s*true,[\s\S]{0,100}dry:\s*true,[\s\S]{0,100}preview:\s*true/,
    `${filename} must return the preview contract required by WakeRuntimeGuard`,
  );
}

function validCouncilResult(verdict = 'APPROVE', buildingInspection = 'NOT_REQUESTED') {
  return {
    evidence: {
      stateFreshness: 'FRESH',
      financePage: 200,
      buildingInspection,
    },
    council: ['CFO', 'COO', 'CMO'].map(role => ({
      role,
      status: 'VALIDATED',
      verdict,
    })),
  };
}

assert.equal(actionChangedState('collect', {}, { collected: false }), false);
assert.equal(actionChangedState('collect', {}, { collected: true }), true);
assert.equal(actionChangedState('produce', {}, { ok: true, started: true }), true);
assert.equal(actionChangedState('upgrade', { confirm: false }, { ok: true, dry: true }), false);
assert.equal(actionChangedState('upgrade', { confirm: true }, { ok: true }), true);
assert.equal(actionChangedState('rebuild', { confirm: true }, { ok: true, verified: true }), true);
assert.equal(actionChangedState('bonds', { confirm: true }, { ok: true, clicked: true }), true);
assert.equal(actionChangedState('exchange_sell', { confirm: true }, { ok: true, armed: true, submitted: 'SELL' }), true);
assert.equal(actionRequiresRefresh('produce', {}, { ok: false, reason: 'start could not be verified' }), true);
assert.equal(actionRequiresRefresh('pa_read', {}, { ok: false, reason: 'message pane did not load' }), true);
assert.equal(actionRequiresRefresh('upgrade', { confirm: false }, { ok: false, reason: 'preview failed' }), false);
assert.equal(actionRequiresRefresh('rebuild', { confirm: true }, {
  ok: false,
  mutationAttempted: true,
  doNotRetry: true,
}), true);

const paRead = new WakeRuntimeGuard();
assert.equal(paRead.afterAction('pa_read', {}, { ok: true, offer: {} }), true);
assert.equal(paRead.beforeAction('pa_reply').requiredTool, 'refresh_state');

const ambiguousAttempt = new WakeRuntimeGuard();
assert.equal(ambiguousAttempt.afterAction('buy', {}, {
  ok: false,
  mutationAttempted: true,
  reason: 'cash delta could not be verified',
}), true);
assert.equal(ambiguousAttempt.beforeAction('produce').requiredTool, 'refresh_state');

const retryNow = Date.parse('2026-07-26T21:00:00.000Z');
const retryAlarm = buildSafetyRetryAlarm('no function call', retryNow, [2, 1, 2, -1]);
assert.equal(retryAlarm.at, retryNow + 5 * 60e3);
assert.equal(retryAlarm.set, '2026-07-26T21:00:00.000Z');
assert.deepEqual(retryAlarm.utilityRetryKinds, [1, 2]);
assert.equal(retryAlarm.safetyRetry, true);

assert.equal(buildWakeAlarm({ atIso: 'not-a-time', reason: 'retry' }, retryNow).ok, false);
assert.equal(buildWakeAlarm({ atIso: new Date(retryNow + 60e3).toISOString(), reason: '' }, retryNow).ok, false);
const requestedAlarm = buildWakeAlarm({
  atIso: new Date(retryNow + 60e3).toISOString(),
  reason: '  earliest completion  ',
}, retryNow, [2, 1, 2, null]);
assert.equal(requestedAlarm.ok, true);
assert.equal(requestedAlarm.alarm.at, retryNow + 2 * 60e3);
assert.equal(requestedAlarm.alarm.reason, 'earliest completion');
assert.deepEqual(requestedAlarm.alarm.utilityRetryKinds, [1, 2]);
assert.equal(validateFinishSummary(null).ok, false);
assert.equal(validateFinishSummary('   ').ok, false);
assert.deepEqual(validateFinishSummary('  wake complete  '), { ok: true, summary: 'wake complete' });

{
  const guard = new WakeRuntimeGuard();
  const incomplete = buildAutomaticFinishOnExhaustion(guard);
  assert.equal(incomplete.ok, false);
  assert(incomplete.finishCheck.missing.includes('master after the latest mutation'));

  guard.noteRefresh();
  guard.noteAlarm();
  guard.noteJournal();
  guard.noteMaster();
  const complete = buildAutomaticFinishOnExhaustion(guard);
  assert.equal(complete.ok, true);
  assert.equal(validateFinishSummary(complete.summary).ok, true);
}

const boundCouncilArgs = bindStructuralPreviewToCouncilArgs({
  action: 'bonds',
  terms: { amount: 15000, interest: 0.5 },
  version: 2,
}, {
  proposal: 'Review the financing change.',
  context: 'Fresh finance evidence is attached.',
});
assert.match(boundCouncilArgs.proposal, /RUNTIME-BOUND PREVIEW TERMS/);
assert.match(boundCouncilArgs.proposal, /"amount":15000/);
assert.match(boundCouncilArgs.proposal, /"interest":0\.5/);
assert.equal(boundCouncilArgs.context, 'Fresh finance evidence is attached.');

const guard = new WakeRuntimeGuard();
assert.equal(guard.beforeAction('produce'), null);
guard.afterAction('produce', {}, { ok: true, started: true });
assert.equal(guard.beforeAction('sell').requiredTool, 'refresh_state');
assert.equal(guard.beforeAction('inspect_building'), null);
assert(guard.finishCheck().missing.includes('refresh_state'));
assert.equal(guard.beforeJournal().requiredTool, 'refresh_state');

guard.noteRefresh();
assert.equal(guard.beforeJournal().requiredTool, 'set_alarm');
guard.noteAlarm();
assert.equal(guard.beforeJournal(), null);
assert.equal(guard.beforeMaster().requiredTool, 'journal');
guard.noteJournal();
assert.equal(guard.beforeMaster(), null);
guard.noteMaster();
assert.deepEqual(guard.finishCheck(), { ok: true });

guard.noteRefresh();
assert.equal(guard.dirty, false);
assert(guard.finishCheck().missing.includes('set_alarm after the latest mutation'));
assert(guard.finishCheck().missing.includes('journal after the latest mutation'));
assert(guard.finishCheck().missing.includes('master after the latest mutation'));
guard.noteAlarm();
guard.noteJournal();
guard.noteMaster();
assert.deepEqual(guard.finishCheck(), { ok: true });

guard.noteEvidenceChange('inspect_building');
assert(guard.finishCheck().missing.includes('set_alarm after the latest mutation'));
assert(guard.finishCheck().missing.includes('journal after the latest mutation'));
assert(guard.finishCheck().missing.includes('master after the latest mutation'));
guard.noteAlarm();
guard.noteJournal();
guard.noteMaster();
assert.deepEqual(guard.finishCheck(), { ok: true });

guard.afterAction('collect', {}, { collected: true });
guard.noteRefresh();
assert(guard.finishCheck().missing.includes('set_alarm after the latest mutation'));
assert(guard.finishCheck().missing.includes('journal after the latest mutation'));
assert(guard.finishCheck().missing.includes('master after the latest mutation'));

const structural = new WakeRuntimeGuard();
const buildPreview = { building: 'Quarry', maxCost: 30000, minCashAfter: 5000, confirm: false };
const buildConfirm = { building: 'Quarry', maxCost: 29000, minCashAfter: 6000, confirm: true };
assert.match(structural.beforeAction('build', buildConfirm, { councilRequired: true }).reason,
  /requires a successful same-wake preview/);
structural.afterAction('build', buildPreview, { ok: true, dry: true, preview: true });
assert.match(structural.beforeAction('build', buildConfirm, { councilRequired: true }).reason,
  /requires a fresh validated council/);
assert.equal(structural.noteCouncil(validCouncilResult(), {
  proposal: 'Build one Quarry within the previewed limits.',
  buildingId: null,
}).ok, true);
assert.equal(structural.beforeAction('build', buildConfirm, { councilRequired: true }), null);
assert.match(structural.beforeAction('build', buildConfirm, { councilRequired: true }).reason,
  /requires a successful same-wake preview/);

const changedTerms = new WakeRuntimeGuard();
changedTerms.afterAction('bonds', { amount: 5000, interest: 0.5, confirm: false },
  { ok: true, dry: true });
changedTerms.noteCouncil(validCouncilResult('AMEND'), {
  proposal: 'Adjust the bond offer using the previewed terms.',
  buildingId: null,
});
assert.match(changedTerms.beforeAction('bonds', { amount: 10000, interest: 0.5, confirm: true },
  { councilRequired: true }).reason, /differ from its preview/);

const changedRobotSpend = new WakeRuntimeGuard();
const robotPreview = {
  buildingId: 55,
  specialization: 'Power',
  buyMissing: true,
  maxCost: 1000,
  minCashAfter: 500,
  confirm: false,
};
changedRobotSpend.afterAction('robots', robotPreview, { ok: true, dry: true, preview: true });
changedRobotSpend.noteCouncil(validCouncilResult('APPROVE', 'OK'), {
  proposal: 'Install robots on building 55 using the previewed spend limits.',
  buildingId: 55,
});
assert.match(changedRobotSpend.beforeAction('robots', {
  ...robotPreview,
  maxCost: 1001,
  confirm: true,
}, { councilRequired: true }).reason, /differ from its preview/);

const invalidCouncil = validCouncilResult('APPROVE', 'OK');
invalidCouncil.council[1].verdict = 'REJECT';
assert.equal(validateCouncilAuthorization(invalidCouncil).ok, false);
const invalidCouncilGuard = new WakeRuntimeGuard();
invalidCouncilGuard.afterAction('scrap', { buildingId: 123, confirm: false },
  { ok: true, preview: true });
assert.equal(invalidCouncilGuard.noteCouncil(invalidCouncil, {
  proposal: 'Scrap building 123 after its preview.',
  buildingId: 123,
}).ok, false);
assert.match(invalidCouncilGuard.beforeAction('scrap', { buildingId: 123, confirm: true },
  { councilRequired: true }).reason, /requires a fresh validated council/);

const refreshed = new WakeRuntimeGuard();
refreshed.afterAction('scrap', { buildingId: 123, confirm: false },
  { ok: true, preview: true });
refreshed.noteCouncil(validCouncilResult('APPROVE', 'OK'), {
  proposal: 'Scrap building 123 after its preview.',
  buildingId: 123,
});
refreshed.noteRefresh();
assert.match(refreshed.beforeAction('scrap', { buildingId: 123, confirm: true },
  { councilRequired: true }).reason, /requires a successful same-wake preview/);

const rollingState = {
  buildings: [
    { id: 1, name: 'Mill', size: 1 },
    { id: 2, name: 'Mill', size: 2 },
    { id: 3, name: 'Mill', size: 3 },
    { id: 4, name: 'Farm', size: 3 },
  ],
};
assert.equal(isApprovedRollingMillUpgrade(rollingState, { buildingId: 2 }), true);
assert.equal(councilRequiredForStructuralAction('upgrade', { buildingId: 2 }, rollingState), false);
assert.equal(councilRequiredForStructuralAction('build', {}, rollingState), true);
assert.equal(councilRequiredForStructuralAction('rebuild', { buildingId: 5 }, rollingState), true);
assert.equal(isApprovedRollingMillUpgrade({ buildings: rollingState.buildings.concat(
  { id: 5, name: 'Mill', size: 1 }) }, { buildingId: 2 }), false);

const prospectorNow = Date.parse('2026-07-27T15:23:30.000Z');
const prospectorState = {
  t: new Date(prospectorNow - 1000).toISOString(),
  sources: {
    buildings: {
      status: 'ok',
      asOf: new Date(prospectorNow - 1000).toISOString(),
    },
  },
  buildings: [{
    id: 55258164,
    name: 'Quarry',
    size: 1,
    busy: null,
    activity: { status: 'unknown', busy: null },
  }],
};
const prospectorDirective = {
  schemaVersion: 1,
  status: 'pending',
  priority: 'owner',
  program: { status: 'completed' },
  prospectorExperiment: {
    status: 'baseline-verified',
    building: 'Quarry',
    buildingId: 55258164,
    level: 1,
    expectedBaseline: 1,
    expectedTarget: 10,
    expectedIncrement: 1,
    completesAt: new Date(prospectorNow - 60e3).toISOString(),
    baselineProgress: {
      path: '/api/v2/companies/me/achievements/', status: 200, current: 1, target: 10,
    },
    lastProgressEvidence: {
      path: '/api/v2/companies/me/achievements/', status: 200, current: 1, target: 10,
    },
  },
};
const clone = value => JSON.parse(JSON.stringify(value));
assert.equal(isOwnerAuthorizedProspectorRebuild(
  prospectorState, { buildingId: 55258164 }, prospectorDirective, prospectorNow), true);
assert.equal(councilRequiredForStructuralAction(
  'rebuild', { buildingId: 55258164 }, prospectorState, prospectorDirective, prospectorNow), false);
assert.equal(councilRequiredForStructuralAction(
  'rebuild', { buildingId: 55258164 }, prospectorState, null, prospectorNow), true);
const compactCampaignDirective = clone(prospectorDirective);
delete compactCampaignDirective.program;
compactCampaignDirective.action = 'complete-owner-subtasks';
compactCampaignDirective.prospectorExperiment.campaign = {
  mode: 'repeat-until-achievement-complete',
  status: 'active',
};
for (const evidence of [
  compactCampaignDirective.prospectorExperiment.baselineProgress,
  compactCampaignDirective.prospectorExperiment.lastProgressEvidence,
]) {
  evidence.stars = 1;
  evidence.starsMax = 7;
}
assert.equal(isOwnerAuthorizedProspectorRebuild(
  prospectorState, { buildingId: 55258164 }, compactCampaignDirective, prospectorNow), true);
assert.equal(councilRequiredForStructuralAction(
  'rebuild', { buildingId: 55258164 }, prospectorState, compactCampaignDirective, prospectorNow), false);
assert.equal(isOwnerAuthorizedProspectorRebuild(
  prospectorState, { buildingId: 99 }, prospectorDirective, prospectorNow), false);

for (const status of ['claimed', 'awaiting-counter']) {
  const active = clone(prospectorDirective);
  active.prospectorExperiment.rebuildAttempt = { status };
  assert.equal(isOwnerAuthorizedProspectorRebuild(
    prospectorState, { buildingId: 55258164 }, active, prospectorNow), false);
}
const advanced = clone(prospectorDirective);
advanced.prospectorExperiment.status = 'verified';
advanced.prospectorExperiment.lastProgressEvidence.current = 2;
assert.equal(isOwnerAuthorizedProspectorRebuild(
  prospectorState, { buildingId: 55258164 }, advanced, prospectorNow), false);
const busyProspectorState = clone(prospectorState);
busyProspectorState.buildings[0].busy = { type: 'production' };
assert.equal(isOwnerAuthorizedProspectorRebuild(
  busyProspectorState, { buildingId: 55258164 }, prospectorDirective, prospectorNow), false);
const staleProspectorState = clone(prospectorState);
staleProspectorState.t = new Date(prospectorNow - 6 * 60e3).toISOString();
staleProspectorState.sources.buildings.asOf = staleProspectorState.t;
assert.equal(isOwnerAuthorizedProspectorRebuild(
  staleProspectorState, { buildingId: 55258164 }, prospectorDirective, prospectorNow), false);

const campaignState = clone(prospectorState);
campaignState.buildings[0].id = 55282591;
const campaignDirective = clone(prospectorDirective);
campaignDirective.prospectorExperiment = {
  ...campaignDirective.prospectorExperiment,
  status: 'waiting-construction',
  buildingId: 55282591,
  expectedBaseline: 2,
  expectedTarget: 10,
  completesAt: new Date(prospectorNow - 60e3).toISOString(),
  campaign: {
    mode: 'repeat-until-achievement-complete',
    status: 'active',
    currentStars: 0,
    starsMax: 7,
  },
  baselineProgress: {
    path: '/api/v2/companies/me/achievements/', status: 200,
    current: 2, target: 10, stars: 0, starsMax: 7,
  },
  lastProgressEvidence: {
    path: '/api/v2/companies/me/achievements/', status: 200,
    current: 2, target: 10, stars: 0, starsMax: 7,
  },
  rebuildAttempt: { status: 'verified' },
};
assert.equal(isOwnerAuthorizedProspectorRebuild(
  campaignState, { buildingId: 55282591 }, campaignDirective, prospectorNow), true);
const unfinishedCampaignState = clone(campaignState);
unfinishedCampaignState.buildings[0].busy = {
  type: 'construction',
  endsAt: new Date(prospectorNow + 60e3).toISOString(),
};
assert.equal(isOwnerAuthorizedProspectorRebuild(
  unfinishedCampaignState, { buildingId: 55282591 }, campaignDirective, prospectorNow), false);
const completedCampaignDirective = clone(campaignDirective);
completedCampaignDirective.prospectorExperiment.campaign.status = 'completed';
assert.equal(isOwnerAuthorizedProspectorRebuild(
  campaignState, { buildingId: 55282591 }, completedCampaignDirective, prospectorNow), false);

const recoveredCampaignState = clone(prospectorState);
recoveredCampaignState.buildings[0] = {
  id: 55389445,
  name: 'Quarry',
  size: 1,
  activity: { status: 'unknown', busy: null },
  freeAndLocked: false,
};
const recoveredCampaignDirective = clone(campaignDirective);
recoveredCampaignDirective.prospectorExperiment = {
  ...recoveredCampaignDirective.prospectorExperiment,
  status: 'counter-mismatch',
  buildingId: 55282591,
  expectedBaseline: 3,
  expectedTarget: 10,
  baselineProgress: {
    path: '/api/v2/companies/me/achievements/', status: 200,
    current: 3, target: 10, stars: 0, starsMax: 7,
  },
  lastProgressEvidence: {
    path: '/api/v2/companies/me/achievements/', status: 200,
    current: 12, target: 50, stars: 1, starsMax: 7,
  },
  rebuildAttempt: { status: 'verified' },
};
assert.equal(isOwnerAuthorizedProspectorRebuild(
  recoveredCampaignState,
  { buildingId: 55389445 },
  recoveredCampaignDirective,
  prospectorNow,
), true);
assert.equal(councilRequiredForStructuralAction(
  'rebuild',
  { buildingId: 55389445 },
  recoveredCampaignState,
  recoveredCampaignDirective,
  prospectorNow,
), false);
for (const unsafeState of [
  {
    ...clone(recoveredCampaignState),
    buildings: recoveredCampaignState.buildings.concat({
      id: 55389446, name: 'Quarry', size: 1, busy: null, freeAndLocked: false,
    }),
  },
  {
    ...clone(recoveredCampaignState),
    buildings: recoveredCampaignState.buildings.concat({
      id: 55282591, name: 'Quarry', size: 1, busy: null, freeAndLocked: false,
    }),
  },
]) {
  assert.equal(isOwnerAuthorizedProspectorRebuild(
    unsafeState,
    { buildingId: 55389445 },
    recoveredCampaignDirective,
    prospectorNow,
  ), false);
}
const activeRecoveryDirective = clone(recoveredCampaignDirective);
activeRecoveryDirective.prospectorExperiment.rebuildAttempt = { status: 'awaiting-counter' };
assert.equal(isOwnerAuthorizedProspectorRebuild(
  recoveredCampaignState,
  { buildingId: 55389445 },
  activeRecoveryDirective,
  prospectorNow,
), false);

const ownerProspectorGuard = new WakeRuntimeGuard();
ownerProspectorGuard.afterAction('rebuild', { buildingId: 55258164, confirm: false },
  { ok: true, preview: true });
assert.equal(ownerProspectorGuard.beforeAction(
  'rebuild', { buildingId: 55258164, confirm: true }, { councilRequired: false }), null);
assert.match(ownerProspectorGuard.beforeAction(
  'rebuild', { buildingId: 55258164, confirm: true }, { councilRequired: false }).reason,
  /requires a successful same-wake preview/);

console.log('runtime-guard tests passed');
