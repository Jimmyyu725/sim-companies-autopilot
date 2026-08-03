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
  validateCouncilAuthorization,
  validateStrategyCouncilCompletion,
  validateFinishSummary,
  buildAutomaticFinishOnExhaustion,
  closingBudgetActive,
  closingBudgetDirective,
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
      portfolioInspection: 'OK',
    },
    council: ['CFO', 'COO', 'CMO'].map(role => ({
      role,
      status: 'VALIDATED',
      verdict,
    })),
  };
}

function authorizeStrategy(guard, selectedOption, otherOption = {
  id: 'hold',
  label: 'Hold the current structure.',
  action: 'hold',
  buildingId: null,
  target: null,
}) {
  const options = [otherOption, selectedOption];
  const result = {
    evidence: {
      stateFreshness: 'FRESH',
      financePage: 200,
      buildingInspection: selectedOption.buildingId == null ? 'NOT_REQUESTED' : 'OK',
      portfolioInspection: 'OK',
    },
    council: ['CFO', 'COO', 'CMO'].map(role => ({
      role,
      status: 'VALIDATED',
      verdict: 'RECOMMEND',
      optionId: selectedOption.id,
    })),
    decision: {
      status: 'DECIDED',
      optionId: selectedOption.id,
      method: 'majority',
      tally: { [selectedOption.id]: 3 },
    },
  };
  const completion = guard.noteStrategyCouncil(result, {
    focusBuildingId: selectedOption.buildingId,
    options,
  });
  assert.equal(completion.ok, true);
  return result;
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
assert.equal(boundCouncilArgs.authorizationPreview, null);

const previewEvidenceGuard = new WakeRuntimeGuard();
previewEvidenceGuard.afterAction('build', {
  building: 'farm',
  maxCost: 20000,
  minCashAfter: 5000,
  confirm: false,
}, {
  ok: true,
  dry: true,
  preview: true,
  quoted: 7794,
  cashAfter: 84702,
});
const evidenceBoundCouncilArgs = previewEvidenceGuard.bindCouncilArgs({
  proposal: 'Build the previewed farm.',
  context: '',
});
assert.equal(evidenceBoundCouncilArgs.authorizationPreview.source,
  'runtime-verified-structural-preview');
assert.equal(evidenceBoundCouncilArgs.authorizationPreview.preview.quoted, 7794);
assert.equal(evidenceBoundCouncilArgs.authorizationPreview.preview.cashAfter, 84702);

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

const requiredStrategy = new WakeRuntimeGuard();
requiredStrategy.configureStrategyCouncil({
  required: true,
  reasons: ['wake-cadence'],
  currentWakeOrdinal: 20,
  wakeInterval: 20,
});
const narrowRequiredOptions = requiredStrategy.prepareStrategyCouncil({
  options: [
    { id: 'hold', action: 'hold', buildingId: null, target: null },
    { id: 'build_farm', action: 'build', buildingId: null, target: 'farm' },
    { id: 'robot_farm', action: 'robots', buildingId: 1, target: 'farm' },
  ],
});
assert.equal(narrowRequiredOptions.ok, false);
assert.match(narrowRequiredOptions.reason, /non-baseline expansion or pivot/u);
const broadRequiredOptions = requiredStrategy.prepareStrategyCouncil({
  options: [
    { id: 'hold', action: 'hold', buildingId: null, target: null },
    { id: 'tools_pilot', action: 'pivot', buildingId: null, target: 'tools' },
  ],
});
assert.equal(broadRequiredOptions.ok, true);
assert.deepEqual(broadRequiredOptions.strategyCandidates, []);
requiredStrategy.noteRefresh();
requiredStrategy.noteAlarm();
assert.equal(requiredStrategy.beforeJournal().requiredTool, 'strategy_council');
assert.equal(requiredStrategy.strategyCouncilStatus().status, 'required_but_skipped');
assert(requiredStrategy.finishCheck().missing.includes('strategy_council decision'));
const failedStrategy = {
  evidence: { stateFreshness: 'FRESH', financePage: 200, buildingInspection: 'NOT_REQUESTED' },
  council: [
    { role: 'CFO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'hold' },
    { role: 'COO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'hold' },
    { role: 'CMO', status: 'API_ERROR', verdict: 'UNKNOWN', optionId: null },
  ],
  decision: { status: 'INCOMPLETE', optionId: null, method: null, tally: {} },
};
assert.equal(requiredStrategy.noteStrategyCouncil(failedStrategy, {
  focusBuildingId: null,
  options: [{ id: 'hold', action: 'hold', buildingId: null, target: null }],
}).ok, false);
assert.equal(requiredStrategy.strategyCouncilStatus().status, 'required_but_failed');
assert.equal(requiredStrategy.beforeJournal().requiredTool, 'strategy_council');
authorizeStrategy(requiredStrategy, {
  id: 'hold',
  label: 'Hold the current structure.',
  action: 'hold',
  buildingId: null,
  target: null,
}, {
  id: 'continue',
  label: 'Continue routine operations.',
  action: 'other',
  buildingId: null,
  target: null,
});
assert.equal(requiredStrategy.strategyCouncilStatus().status, 'required_and_completed');
assert.equal(requiredStrategy.beforeJournal(), null);
assert.equal(requiredStrategy.beforeStrategyCouncil().ok, false);
assert.equal(validateStrategyCouncilCompletion(failedStrategy).ok, false);

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
authorizeStrategy(structural, {
  id: 'build_quarry',
  label: 'Build a Quarry.',
  action: 'build',
  buildingId: null,
  target: 'quarry',
});
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

const safeStructuralRetry = new WakeRuntimeGuard();
authorizeStrategy(safeStructuralRetry, {
  id: 'build_farm',
  label: 'Build a Farm.',
  action: 'build',
  buildingId: null,
  target: 'farm',
});
const farmPreview = { building: 'Farm', maxCost: 20000, minCashAfter: 5000, confirm: false };
const farmConfirm = { building: 'Farm', maxCost: 20000, minCashAfter: 5000, confirm: true };
safeStructuralRetry.afterAction('build', farmPreview, {
  ok: true, dry: true, preview: true, quoted: 7500,
});
assert.equal(safeStructuralRetry.noteCouncil(validCouncilResult(), {
  proposal: 'Build one Farm within the previewed limits.',
  buildingId: null,
}).ok, true);
assert.equal(safeStructuralRetry.beforeAction('build', farmConfirm, {
  councilRequired: true,
}), null);
assert.equal(safeStructuralRetry.afterAction('build', farmConfirm, {
  ok: false,
  reason: 'construction confirmation scope is not unique',
  safeToRetry: true,
  mutationAttempted: false,
}), true);
assert.equal(safeStructuralRetry.strategyCouncilStatus().decision.consumed, false);
assert.equal(safeStructuralRetry.beforeAction('build', farmConfirm, {
  councilRequired: true,
}).requiredTool, 'refresh_state');
safeStructuralRetry.noteRefresh();
safeStructuralRetry.afterAction('build', farmPreview, {
  ok: true, dry: true, preview: true, quoted: 7500,
});
assert.equal(safeStructuralRetry.noteCouncil(validCouncilResult(), {
  proposal: 'Build one Farm within the previewed limits.',
  buildingId: null,
}).ok, true);
assert.equal(safeStructuralRetry.beforeAction('build', farmConfirm, {
  councilRequired: true,
}), null);
safeStructuralRetry.afterAction('build', farmConfirm, {
  ok: false,
  reason: 'commit outcome is ambiguous',
  mutationAttempted: true,
  doNotRetry: true,
});
assert.equal(safeStructuralRetry.strategyCouncilStatus().decision.consumed, true);
safeStructuralRetry.noteRefresh();
assert.match(safeStructuralRetry.beforeAction('build', farmPreview, {
  councilRequired: true,
}).reason, /cannot be replayed this wake/);

const missingDirection = new WakeRuntimeGuard();
assert.equal(missingDirection.beforeAction('upgrade', {
  buildingId: 77,
  maxCost: 20000,
  minCashAfter: 5000,
  confirm: false,
}, { councilRequired: true }), null);
authorizeStrategy(missingDirection, {
  id: 'hold',
  label: 'Hold the current structure.',
  action: 'hold',
  buildingId: null,
  target: null,
}, {
  id: 'upgrade_mill',
  label: 'Upgrade the selected Mill.',
  action: 'upgrade',
  buildingId: 77,
  target: 'mill',
});
assert.match(missingDirection.beforeAction('upgrade', {
  buildingId: 77,
  maxCost: 20000,
  minCashAfter: 5000,
  confirm: false,
}, { councilRequired: true }).reason, /not the direction selected/);

const candidateStrategy = new WakeRuntimeGuard();
candidateStrategy.configureStrategyCouncil({
  required: true,
  reasons: ['wake-cadence'],
  currentWakeOrdinal: 20,
  wakeInterval: 20,
});
const candidateUpgrade = {
  buildingId: 77,
  maxCost: 20000,
  minCashAfter: 5000,
  confirm: false,
};
candidateStrategy.afterAction('upgrade', candidateUpgrade, {
  ok: true,
  dry: true,
  preview: true,
  cashCost: 12500,
  downtime: '04:00h',
});
const candidateOptions = [
  {
    id: 'hold',
    label: 'Hold the current structure.',
    action: 'hold',
    buildingId: null,
    target: null,
  },
  {
    id: 'upgrade_mill',
    label: 'Upgrade the selected Mill.',
    action: 'upgrade',
    buildingId: 77,
    target: 'mill',
  },
  {
    id: 'tools_pilot',
    label: 'Measure a bounded Tools expansion pilot.',
    action: 'pivot',
    buildingId: null,
    target: 'tools',
  },
];
const preparedCandidates = candidateStrategy.prepareStrategyCouncil({
  options: candidateOptions,
});
assert.equal(preparedCandidates.ok, true);
assert.equal(preparedCandidates.strategyCandidates.length, 1);
assert.equal(preparedCandidates.strategyCandidates[0].optionId, 'upgrade_mill');
assert.equal(preparedCandidates.strategyCandidates[0].preview.cashCost, 12500);
assert.equal(candidateStrategy.beforeAction('upgrade', {
  ...candidateUpgrade,
  confirm: true,
}, { councilRequired: true }).requiredTool, 'strategy_council');
authorizeStrategy(candidateStrategy, candidateOptions[1], candidateOptions[0]);
assert.match(candidateStrategy.beforeAction('upgrade', {
  ...candidateUpgrade,
  confirm: true,
}, { councilRequired: true }).reason, /requires a successful same-wake preview/);
candidateStrategy.afterAction('upgrade', candidateUpgrade, {
  ok: true,
  dry: true,
  preview: true,
  cashCost: 12500,
});
assert.match(candidateStrategy.beforeAction('upgrade', {
  ...candidateUpgrade,
  confirm: true,
}, { councilRequired: true }).reason, /requires a fresh validated council/);

const missingCandidate = new WakeRuntimeGuard();
missingCandidate.afterAction('upgrade', candidateUpgrade, {
  ok: false,
  reason: 'upgrade quote unavailable',
});
const missingCandidateResult = missingCandidate.prepareStrategyCouncil({
  options: candidateOptions,
});
assert.equal(missingCandidateResult.ok, false);
assert.equal(missingCandidateResult.missingCandidates[0].optionId, 'upgrade_mill');
missingCandidate.afterAction('upgrade', candidateUpgrade, {
  ok: true,
  dry: true,
  preview: true,
  cashCost: 12500,
});
assert.equal(missingCandidate.prepareStrategyCouncil({ options: candidateOptions }).ok, true);
missingCandidate.noteRefresh();
assert.equal(missingCandidate.prepareStrategyCouncil({ options: candidateOptions }).ok, false);

const farmReviewAt = Date.parse('2026-08-01T02:49:49.494Z');
const farmReviewState = {
  t: new Date(farmReviewAt).toISOString(),
  buildings: [{ id: 55518748, name: 'Farm', size: 1, busy: null }],
};
const farmUpgradePreview = {
  buildingId: 55518748,
  maxCost: 20000,
  minCashAfter: 5000,
  confirm: false,
};
const farmProduction = {
  buildingId: 55518748,
  name: 'COFFEE BEANS',
  qty: 3080,
  targetHours: 6,
  finishBefore: null,
};
const farmUpgradeOption = {
  id: 'upgrade-farm-l1',
  label: 'Upgrade Farm L1 to L2.',
  action: 'upgrade',
  buildingId: 55518748,
  target: 'farm',
};
const farmHoldOption = {
  id: 'hold-farm-l1',
  label: 'Hold Farm L1 and continue production.',
  action: 'hold',
  buildingId: null,
  target: null,
};
const farmReview = new WakeRuntimeGuard();
assert.equal(farmReview.beforeAction('produce', farmProduction, {
  state: farmReviewState,
}).requiredAction.action, 'upgrade');
farmReview.afterAction('upgrade', farmUpgradePreview, {
  ok: true, dry: true, preview: true, cashCost: 11000,
});
assert.equal(farmReview.beforeAction('produce', farmProduction, {
  state: farmReviewState,
}).requiredTool, 'strategy_council');
authorizeStrategy(farmReview, farmHoldOption, farmUpgradeOption);
assert.equal(farmReview.beforeAction('produce', farmProduction, {
  state: farmReviewState,
}), null);

const selectedFarmUpgrade = new WakeRuntimeGuard();
selectedFarmUpgrade.afterAction('upgrade', farmUpgradePreview, {
  ok: true, dry: true, preview: true, cashCost: 11000,
});
authorizeStrategy(selectedFarmUpgrade, farmUpgradeOption, farmHoldOption);
assert.match(selectedFarmUpgrade.beforeAction('produce', farmProduction, {
  state: farmReviewState,
}).reason, /selected this Farm upgrade/);

const failedFarmReview = new WakeRuntimeGuard();
failedFarmReview.afterAction('upgrade', farmUpgradePreview, {
  ok: true, dry: true, preview: true, cashCost: 11000,
});
failedFarmReview.noteStrategyCouncil({}, {
  focusBuildingId: 55518748,
  options: [farmHoldOption, farmUpgradeOption],
});
assert.match(failedFarmReview.beforeAction('produce', farmProduction, {
  state: farmReviewState,
}).reason, /bridge of at most one hour/);
assert.equal(failedFarmReview.beforeAction('produce', {
  ...farmProduction,
  finishBefore: new Date(farmReviewAt + 45 * 60e3).toISOString(),
}, { state: farmReviewState }), null);
assert.match(failedFarmReview.beforeAction('produce', {
  ...farmProduction,
  finishBefore: new Date(farmReviewAt + 2 * 60 * 60e3).toISOString(),
}, { state: farmReviewState }).reason, /bridge of at most one hour/);
const levelThreeFarmState = {
  ...farmReviewState,
  buildings: [{ id: 55518748, name: 'Farm', size: 3, busy: null }],
};
assert.equal(new WakeRuntimeGuard().beforeAction('produce', farmProduction, {
  state: levelThreeFarmState,
}), null);

const changedTerms = new WakeRuntimeGuard();
authorizeStrategy(changedTerms, {
  id: 'issue_bonds',
  label: 'Issue bounded debt.',
  action: 'bonds',
  buildingId: null,
  target: null,
});
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
authorizeStrategy(changedRobotSpend, {
  id: 'install_robots',
  label: 'Install robots on the selected building.',
  action: 'robots',
  buildingId: 55,
  target: null,
});
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
const partialPortfolioCouncil = validCouncilResult('APPROVE', 'OK');
partialPortfolioCouncil.evidence.portfolioInspection = 'PARTIAL';
assert.equal(validateCouncilAuthorization(partialPortfolioCouncil, {
  portfolioInspectionRequired: true,
}).ok, false);
const partialPortfolioStrategy = {
  evidence: {
    stateFreshness: 'FRESH',
    financePage: 200,
    buildingInspection: 'NOT_REQUESTED',
    portfolioInspection: 'PARTIAL',
  },
  council: ['CFO', 'COO', 'CMO'].map(role => ({
    role,
    status: 'VALIDATED',
    verdict: 'RECOMMEND',
    optionId: 'hold',
  })),
  decision: { status: 'DECIDED', optionId: 'hold', method: 'majority', tally: { hold: 3 } },
};
assert.equal(validateStrategyCouncilCompletion(partialPortfolioStrategy, {
  portfolioInspectionRequired: true,
}).ok, false);
const invalidCouncilGuard = new WakeRuntimeGuard();
authorizeStrategy(invalidCouncilGuard, {
  id: 'scrap_building',
  label: 'Scrap the selected building.',
  action: 'scrap',
  buildingId: 123,
  target: null,
});
invalidCouncilGuard.afterAction('scrap', { buildingId: 123, confirm: false },
  { ok: true, preview: true });
assert.equal(invalidCouncilGuard.noteCouncil(invalidCouncil, {
  proposal: 'Scrap building 123 after its preview.',
  buildingId: 123,
}).ok, false);
assert.match(invalidCouncilGuard.beforeAction('scrap', { buildingId: 123, confirm: true },
  { councilRequired: true }).reason, /requires a fresh validated council/);

const refreshed = new WakeRuntimeGuard();
authorizeStrategy(refreshed, {
  id: 'scrap_building',
  label: 'Scrap the selected building.',
  action: 'scrap',
  buildingId: 123,
  target: null,
});
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
assert.equal(councilRequiredForStructuralAction('upgrade'), true);
assert.equal(councilRequiredForStructuralAction('build'), true);
assert.equal(councilRequiredForStructuralAction('rebuild'), true);
assert.equal(councilRequiredForStructuralAction('produce'), false);
assert.equal(isApprovedRollingMillUpgrade({ buildings: rollingState.buildings.concat(
  { id: 5, name: 'Mill', size: 1 }) }, { buildingId: 2 }), false);
console.log('runtime-guard tests passed');

// Regression (2026-08-01 03:50 wake): a REBUILD confirm on a DIFFERENT building must not consume
// the council-selected Farm-upgrade direction. The old code consumed it, every later upgrade
// attempt was refused as "direction was consumed", and the wake exhausted 40 rounds with the Farm
// idle.
const crosstalk = new WakeRuntimeGuard();
authorizeStrategy(crosstalk, {
  id: 'upgrade_farm_55518748',
  label: 'Upgrade Farm 55518748 to level 2.',
  action: 'upgrade',
  buildingId: 55518748,
  target: 'farm',
});
// A rebuild of an unrelated Quarry executes without touching the selected upgrade.
assert.equal(crosstalk.afterAction('rebuild', { buildingId: 55538609, confirm: true }, {
  ok: true, clicked: true, newBuildingId: 55545964,
}), true);
assert.equal(crosstalk.strategyCouncilStatus().decision.consumed, false,
  'unrelated rebuild confirm must not consume the selected upgrade direction');
crosstalk.noteRefresh();
// The selected upgrade must still be executable: preview + council + confirm passes the
// consumed-direction gate (null = no guard objection from beforeAction).
crosstalk.afterAction('upgrade',
  { buildingId: 55518748, maxCost: 50000, minCashAfter: 5000, confirm: false },
  { ok: true, dry: true, preview: true, cashCost: 7652 });
assert.equal(crosstalk.noteCouncil(validCouncilResult('APPROVE', 'OK'), {
  proposal: 'Upgrade Farm 55518748 within the previewed limits.',
  buildingId: 55518748,
}).ok, true);
assert.equal(crosstalk.beforeAction('upgrade',
  { buildingId: 55518748, maxCost: 50000, minCashAfter: 5000, confirm: true },
  { councilRequired: true }), null);
// And a MATCHED confirm still consumes the direction (one-use preserved).
crosstalk.afterAction('upgrade',
  { buildingId: 55518748, maxCost: 50000, minCashAfter: 5000, confirm: true },
  { ok: false, reason: 'commit outcome is ambiguous', mutationAttempted: true, doNotRetry: true });
assert.equal(crosstalk.strategyCouncilStatus().decision.consumed, true,
  'a matched confirm attempt must still consume the one-use direction');

// Regression (2026-08-01 wake 04:23): a selected Farm upgrade whose EXECUTION council keeps
// refusing authorization must not also block bridge production. Live deadlock: strategy council
// chose the upgrade, the execution council returned COO VALIDATED/UNKNOWN five times, produce was
// refused as "do not hide the upgrade window", strategy_council could not be re-rolled in the same
// wake, and the no-voluntary-idle journal gate then blocked finishing — the Farm stayed idle.
const authDeadlockAt = Date.parse('2026-08-01T09:40:00.000Z');
const authDeadlockState = {
  t: new Date(authDeadlockAt).toISOString(),
  buildings: [{ id: 55518748, name: 'Farm', size: 1, busy: null }],
};
const authDeadlockUpgrade = {
  buildingId: 55518748, maxCost: 50000, minCashAfter: 5000, confirm: false,
};
const authDeadlockBridge = {
  buildingId: 55518748,
  name: 'SEEDS',
  qty: 917,
  targetHours: 1,
  finishBefore: new Date(authDeadlockAt + 30 * 60 * 1000).toISOString(),
};
const authDeadlock = new WakeRuntimeGuard();
authorizeStrategy(authDeadlock, {
  id: 'upgrade-farm-l1',
  label: 'Upgrade Farm L1 to L2.',
  action: 'upgrade',
  buildingId: 55518748,
  target: 'farm',
}, farmHoldOption);
// Before any authorization failure the selected upgrade still outranks production.
assert.match(authDeadlock.beforeAction('produce', authDeadlockBridge, {
  state: authDeadlockState,
}).reason, /do not hide the upgrade window/);
// Two execution-council refusals for that exact upgrade.
for (let attempt = 0; attempt < 2; attempt += 1) {
  authDeadlock.afterAction('upgrade', authDeadlockUpgrade,
    { ok: true, dry: true, preview: true, cashCost: 7663 });
  const refusal = authDeadlock.noteCouncil({
    structuralAuthorization: { ok: false, reason: 'COO did not provide a validated non-rejecting verdict' },
  }, { buildingId: 55518748, proposal: 'Upgrade Farm 55518748 within the previewed limits.' });
  assert.equal(refusal.ok, false);
  authDeadlock.noteRefresh();
}
// Now a checkpoint-bound bridge of at most one hour is allowed, so the Farm can work.
assert.equal(authDeadlock.beforeAction('produce', authDeadlockBridge, {
  state: authDeadlockState,
}), null, 'a repeatedly unauthorized upgrade must not also block a bounded bridge');
// A long order is still refused: the upgrade remains the pending direction.
assert.match(authDeadlock.beforeAction('produce', {
  ...authDeadlockBridge,
  targetHours: 6,
  finishBefore: new Date(authDeadlockAt + 6 * 60 * 60 * 1000).toISOString(),
}, { state: authDeadlockState }).reason, /failed council authorization/);

// Regression (2026-08-01 wake 05:16): the wake spent all 30 rounds on useful work, wrote the alarm
// and decision brief on the last round, and never reached `master` — CURRENT stayed stale, the
// automatic finish correctly refused, and the completed work was retried from scratch. The final
// rounds must be reserved for the closing sequence.
assert.equal(closingBudgetDirective(30, { ok: false, missing: ['master after the latest mutation'] }),
  null, 'no directive while plenty of rounds remain');
assert.equal(closingBudgetDirective(2, { ok: true }), null,
  'no directive when nothing is missing');
assert.equal(closingBudgetDirective(2, { ok: false, missing: [] }), null);
const closingNow = closingBudgetDirective(3, {
  ok: false,
  missing: ['journal after the latest mutation', 'master after the latest mutation'],
});
assert.equal(closingNow.roundsRemaining, 3);
assert.equal(closingNow.requiredTool, 'journal');
assert.match(closingNow.message, /CLOSING BUDGET: 3 tool rounds remain/);
assert.match(closingNow.message, /master after the latest mutation/);
assert.match(closingNow.message, /Start no new work/);
const closingMaster = closingBudgetDirective(1, {
  ok: false, missing: ['master after the latest mutation'],
});
assert.equal(closingMaster.requiredTool, 'master');
// An unexpected missing label must not be forced as a tool name.
assert.equal(closingBudgetDirective(1, {
  ok: false, missing: ['collect the completed job first'],
}).requiredTool, null);

// Regression (2026-08-01 wake 11:57): a safety hold that never considered this exact Farm blocked
// every exit. Production demanded an upgrade preview; the direction gate refused the preview
// because the wake's decision was `hold`; the council could not be re-rolled; and the
// no-voluntary-idle gate blocked finishing. The L2 Farm sat idle while the wake burned rounds.
const holdBlockedAt = Date.parse('2026-08-01T16:58:23.386Z');
const holdBlockedState = {
  t: new Date(holdBlockedAt).toISOString(),
  buildings: [{ id: 55345580, name: 'Farm', size: 2, busy: null }],
};
const holdBlocked = new WakeRuntimeGuard();
authorizeStrategy(holdBlocked, {
  id: 'hold',
  label: 'Hold the current structure.',
  action: 'hold',
  buildingId: null,
  target: null,
}, {
  id: 'build_mill',
  label: 'Build another Mill.',
  action: 'build',
  buildingId: null,
  target: 'mill',
});
// A long order is still refused, and the refusal states the exact latest checkpoint.
const longOrder = holdBlocked.beforeAction('produce', {
  buildingId: 55345580, name: 'SEEDS', qty: 14500, targetHours: 8, finishBefore: null,
}, { state: holdBlockedState });
assert.match(longOrder.reason, /cannot be previewed/);
assert.equal(longOrder.requiredParameter, 'finishBefore');
assert.equal(longOrder.latestAllowedFinishBefore,
  new Date(holdBlockedAt + 60 * 60 * 1000).toISOString());
// The bounded bridge is allowed, so the Farm can work while the upgrade waits for the next wake.
assert.equal(holdBlocked.beforeAction('produce', {
  buildingId: 55345580,
  name: 'SEEDS',
  qty: 1800,
  targetHours: 1,
  finishBefore: new Date(holdBlockedAt + 30 * 60 * 1000).toISOString(),
}, { state: holdBlockedState }), null,
'a hold that blocks the preview must not also block bounded bridge work');

// Regression (2026-08-01 wake 11:57): the utility surplus review — optional by its own message
// ("Selling is optional") — blocked the journal with two rounds left. The closing budget could not
// help because the mandatory closing sequence was gated behind optional work, and the whole wake
// was discarded. Optional gates must yield once the wake is inside its closing rounds.
assert.equal(closingBudgetActive(30), false, 'not closing while the budget is untouched');
assert.equal(closingBudgetActive(5), false);
assert.equal(closingBudgetActive(4), true, 'closing begins at the reserved rounds');
assert.equal(closingBudgetActive(1), true);
assert.equal(closingBudgetActive(0), true);
assert.equal(closingBudgetActive(-1), false, 'a negative count is not a closing signal');
assert.equal(closingBudgetActive(Number.POSITIVE_INFINITY), false,
  'an untracked wake must keep every gate');
assert.equal(closingBudgetActive(1.5), false);

// Owner directive 2026-08-02: the Prospector campaign is retired and the company is back on
// Coffee. Extraction sites carry no special standing any more — the guard that used to refuse
// production on an idle level-1 Quarry (so it stayed scrappable) must be gone, or a Quarry left
// standing after the pivot would be permanently unable to work.
const retiredCampaignState = {
  t: '2026-08-03T01:42:26.000Z',
  buildings: [
    { id: 55599317, name: 'Quarry', size: 1, busy: null },
    { id: 55042846, name: 'Mill', size: 3, busy: null },
  ],
};
const retiredCampaignRuntime = new WakeRuntimeGuard();
assert.equal(retiredCampaignRuntime.beforeAction('produce',
  { buildingId: 55599317, name: 'sand', qty: 5000 },
  { state: retiredCampaignState }), null,
'a level-1 Quarry produces like any other building once the campaign is retired');
// A stale directive carrying the old campaign block must not revive the reservation either.
assert.equal(retiredCampaignRuntime.beforeAction('produce',
  { buildingId: 55599317, name: 'sand', qty: 5000 },
  {
    state: retiredCampaignState,
    ownerDirective: { prospectorExperiment: { campaign: { status: 'active' } } },
  }), null,
'a leftover active-campaign directive cannot re-reserve an extraction site');
// REBUILD lost its campaign exemption: every structural action goes through council now.
assert.equal(councilRequiredForStructuralAction('rebuild'), true);
