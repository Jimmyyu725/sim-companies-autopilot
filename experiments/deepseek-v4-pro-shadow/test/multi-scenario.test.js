'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  COVERAGE_SCENARIOS,
  DEFAULT_SUITE_SCENARIOS,
  applyScenario,
} = require('../lib/scenarios.js');
const {
  earliestBusyCompletion,
  scenarioObjective,
} = require('../lib/scoring.js');
const { createSnapshot, sha256 } = require('../lib/snapshot.js');
const { buildSuiteComparison } = require('../lib/suite-artifacts.js');
const { ShadowToolRuntime } = require('../lib/tool-runtime.js');
const {
  coverageMatrix,
  parseArguments: parseCoverageArguments,
} = require('../coverage.js');
const { parseArguments: parseSuiteArguments } = require('../suite.js');
const {
  parseArguments: parseTerraCoverageArguments,
} = require('../terra-coverage.js');
const {
  terraCallCost,
} = require('../validate-coverage.js');
const {
  conflictSensitivity,
  pairedStatistics,
} = require('../compare-coverages.js');

const SIM_DIR = path.resolve(__dirname, '..', '..', '..');

function baseSnapshot() {
  return createSnapshot(SIM_DIR, new Date('2026-07-29T23:00:00.000Z'), {
    replayAtStateTime: true,
  });
}

async function recordedExecute(runtime, transcript, name, args = {}) {
  const result = await runtime.execute(name, args);
  transcript.push({
    type: 'tool',
    round: transcript.length + 1,
    name,
    arguments: args,
    result,
  });
  return result;
}

test('builds five simple-to-complex scenarios from one immutable base', () => {
  const base = baseSnapshot();
  const before = sha256(JSON.stringify(base));
  const scenarios = DEFAULT_SUITE_SCENARIOS.map(name => applyScenario(base, name));
  assert.deepEqual(
    scenarios.map(snapshot => snapshot.scenario.id),
    [
      'all-busy-v1',
      'idle-mill-v1',
      'utility-surplus-v1',
      'prospector-ready-v1',
      'multi-pressure-v1',
    ],
  );
  assert.deepEqual(
    scenarios.map(snapshot => snapshot.scenario.difficulty),
    ['simple', 'simple', 'medium', 'medium', 'complex'],
  );
  assert.ok(scenarios.every(snapshot => snapshot.baseSnapshotSha256 === before));
  assert.equal(sha256(JSON.stringify(base)), before);
});

test('all-busy scenario proves restraint and exposes no confirmed mutation fixture', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'all-busy');
  const standard = snapshot.state.buildings.filter(building => building.freeAndLocked !== true);
  assert.ok(standard.every(building => (
    building.activity?.status === 'known'
      && building.activity.busy === true
      && building.busy
  )));
  const runtime = new ShadowToolRuntime(snapshot);
  const preview = await runtime.execute('build', {
    building: 'Factory',
    maxCost: 1,
    minCashAfter: 0,
    confirm: false,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  const confirm = await runtime.execute('build', {
    building: 'Factory',
    maxCost: 1,
    minCashAfter: 0,
    confirm: true,
  });
  assert.equal(confirm.ok, false);
  assert.equal(confirm.guard, true);
  assert.equal(runtime.actions.filter(action => action.preview === false).length, 0);
});

test('idle Mill fixture validates inputs, starts one in-memory order, and never writes live state', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'idle-mill');
  const fixture = snapshot.fixtures.operations.find(item => item.action === 'produce');
  const runtime = new ShadowToolRuntime(snapshot);
  const currentFile = path.join(SIM_DIR, 'autopilot', 'CURRENT.json');
  const beforeMtime = fs.statSync(currentFile).mtimeMs;
  const beforeBeans = runtime.stockItem(118).availableAmount;
  const result = await runtime.execute('produce', {
    buildingId: fixture.buildingId,
    name: 'Coffee powder',
    qty: 70,
    targetHours: 24,
    finishBefore: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.equal(result.verified, true);
  assert.equal(runtime.stockItem(118).availableAmount, beforeBeans - 700);
  const mill = runtime.currentState.buildings.find(building => building.id === fixture.buildingId);
  assert.equal(mill.activity.type, 'production');
  assert.equal(mill.busy.amount, 70);
  await runtime.execute('refresh_state', {});
  assert.equal(runtime.dirtyAfterMutation, false);
  assert.equal(fs.statSync(currentFile).mtimeMs, beforeMtime);
});

test('utility sale requires an exact fresh inspection and updates only in-memory state', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'utility-surplus');
  const runtime = new ShadowToolRuntime(snapshot);
  const inspection = await runtime.execute('inspect_exchange_sale', { kind: 1, qty: null });
  assert.equal(inspection.ok, true);
  assert.ok(inspection.uiQuote.profit > 0);
  const mismatch = await runtime.execute('exchange_sell', {
    name: 'power',
    qty: inspection.uiQuote.qty,
    price: inspection.uiQuote.price + 0.01,
    confirm: false,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.guard, true);
  const exact = {
    name: 'power',
    qty: inspection.uiQuote.qty,
    price: inspection.uiQuote.price,
  };
  const preview = await runtime.execute('exchange_sell', { ...exact, confirm: false });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  const beforeCash = runtime.currentState.money;
  const confirmed = await runtime.execute('exchange_sell', { ...exact, confirm: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.executed, false);
  assert.equal(runtime.currentState.money, beforeCash + inspection.uiQuote.netRevenue);
  assert.equal(runtime.currentState.surplusPlan.items['1'].sellable, 0);
});

test('complex ideal path earns full scenario-objective points', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'multi-pressure');
  const runtime = new ShadowToolRuntime(snapshot);
  const transcript = [];
  const rebuild = snapshot.fixtures.rebuild;
  const production = snapshot.fixtures.operations.find(item => item.action === 'produce');
  const retail = snapshot.fixtures.operations.find(item => item.action === 'sell');

  await recordedExecute(runtime, transcript, 'read_api', {
    path: snapshot.fixtures.prospector.path,
  });
  await recordedExecute(runtime, transcript, 'rebuild', {
    buildingId: rebuild.buildingId,
    confirm: false,
  });
  await recordedExecute(runtime, transcript, 'rebuild', {
    buildingId: rebuild.buildingId,
    confirm: true,
  });
  await recordedExecute(runtime, transcript, 'refresh_state');
  await recordedExecute(runtime, transcript, 'produce', {
    buildingId: production.buildingId,
    name: production.name,
    qty: 70,
    targetHours: 24,
    finishBefore: null,
  });
  await recordedExecute(runtime, transcript, 'refresh_state');
  await recordedExecute(runtime, transcript, 'sell', {
    buildingId: retail.buildingId,
    name: retail.name,
    qty: Math.min(500, retail.maxQty),
    price: retail.optimizedPrice,
  });
  await recordedExecute(runtime, transcript, 'refresh_state');
  const inspection = await recordedExecute(runtime, transcript, 'inspect_exchange_sale', {
    kind: snapshot.fixtures.exchange.kind,
    qty: null,
  });
  const exact = {
    name: inspection.uiQuote.name,
    qty: inspection.uiQuote.qty,
    price: inspection.uiQuote.price,
  };
  await recordedExecute(runtime, transcript, 'exchange_sell', { ...exact, confirm: false });
  await recordedExecute(runtime, transcript, 'exchange_sell', { ...exact, confirm: true });
  await recordedExecute(runtime, transcript, 'refresh_state');
  const target = earliestBusyCompletion(runtime.currentState, snapshot.capturedAt);
  await recordedExecute(runtime, transcript, 'set_alarm', {
    atIso: new Date(target).toISOString(),
    reason: 'earliest controlled completion',
  });

  const objective = scenarioObjective(snapshot, { transcript, runtime });
  assert.equal(objective.earned, 25);
  assert.equal(runtime.actions.filter(action => action.preview === false).length, 4);
  assert.equal(runtime.dirtyAfterMutation, false);
});

test('suite aggregation independently sums scores, tokens, time, and exact cost', () => {
  const base = baseSnapshot();
  const makeRun = (scenarioKey, terra, deepseek) => ({
    scenarioKey,
    snapshot: applyScenario(base, scenarioKey),
    artifacts: {
      comparison: {
        fairness: {
          snapshotSha256: `hash-${scenarioKey}`,
          sameSemanticToolNames: true,
        },
        rows: [
          {
            provider: 'terra',
            model: 'gpt-5.6-terra',
            completed: true,
            maximum: 100,
            rounds: 5,
            wallDurationMs: 1000,
            ...terra,
          },
          {
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            completed: true,
            maximum: 100,
            rounds: 6,
            wallDurationMs: 2000,
            ...deepseek,
          },
        ],
      },
    },
  });
  const usage = (promptTokens, outputTokens, estimatedUsd) => ({
    promptTokens,
    cacheHitTokens: 0,
    cacheMissTokens: promptTokens,
    outputTokens,
    cacheWriteTokens: 0,
    durationMs: 100,
    minUsd: estimatedUsd,
    maxUsd: estimatedUsd,
    estimatedUsd,
  });
  const runs = [
    makeRun(
      'all-busy',
      { score: 100, usage: usage(100, 10, 0.1) },
      { score: 90, usage: usage(120, 20, 0.02) },
    ),
    makeRun(
      'idle-mill',
      { score: 95, usage: usage(200, 15, 0.2) },
      { score: 95, usage: usage(240, 25, 0.04) },
    ),
  ];
  const comparison = buildSuiteComparison(
    base,
    runs,
    '2026-07-29T00:00:00.000Z',
    '2026-07-29T00:01:00.000Z',
  );
  const terra = comparison.aggregates.find(row => row.provider === 'terra');
  const deepseek = comparison.aggregates.find(row => row.provider === 'deepseek');
  assert.equal(terra.totalScore, 195);
  assert.equal(terra.usage.promptTokens, 300);
  assert.equal(terra.usage.estimatedUsd, 0.3);
  assert.equal(deepseek.totalScore, 185);
  assert.equal(deepseek.usage.outputTokens, 45);
  assert.equal(deepseek.usage.estimatedUsd, 0.06);
});

test('suite CLI defaults to all five scenarios at High effort', () => {
  const options = parseSuiteArguments([]);
  assert.deepEqual(options.scenarios, DEFAULT_SUITE_SCENARIOS);
  assert.equal(options.effort, 'high');
  assert.equal(options.maxRounds, 30);
  assert.equal(options.maxTokens, 32768);
});

test('coverage CLI defaults to ten families, three variants, and thirty High-effort wakes', () => {
  const options = parseCoverageArguments([]);
  const matrix = coverageMatrix(options);
  assert.equal(options.runs, 30);
  assert.equal(options.concurrency, 3);
  assert.equal(options.effort, 'high');
  assert.equal(matrix.length, 30);
  assert.deepEqual(
    matrix.filter(row => row.scenarioKey === 'chat-contract-risk').map(row => row.variant),
    [1, 2, 3],
  );
});

test('coverage matrix exposes ten scenario families with three controlled variants', () => {
  const base = baseSnapshot();
  const before = sha256(JSON.stringify(base));
  const rows = [];
  for (let variant = 1; variant <= 3; variant += 1) {
    for (const scenario of COVERAGE_SCENARIOS) {
      rows.push(applyScenario(base, scenario, { coverage: true, variant }));
    }
  }
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map(row => row.scenario.id)).size, 30);
  assert.ok(rows.every(row => row.baseSnapshotSha256 === before));
  assert.equal(sha256(JSON.stringify(base)), before);
  assert.deepEqual(
    [...new Set(rows.map(row => row.scenario.coverageScenarioKey))],
    COVERAGE_SCENARIOS,
  );
});

test('structural-action scenarios contain no competing construction fixture', () => {
  const base = baseSnapshot();
  for (const scenarioKey of ['mill-upgrade', 'slot-expansion']) {
    for (const variant of [1, 3]) {
      const snapshot = applyScenario(base, scenarioKey, {
        coverage: true,
        variant,
      });
      const competing = snapshot.state.buildings.filter(building => (
        building.busy?.type === 'construction'
          || building.activity?.type === 'construction'
      ));
      assert.deepEqual(
        competing,
        [],
        `${scenarioKey} variant ${variant} must expose only its target structural move`,
      );
      const quarry = snapshot.state.buildings.find(building => building.name === 'Quarry');
      assert.equal(quarry.busy.type, 'production');
      assert.equal(quarry.busy.makingName, 'Sand');
    }
  }
});

test('Terra coverage requires an explicit frozen reference and preserves High settings', () => {
  assert.throws(
    () => parseTerraCoverageArguments([]),
    /--reference-coverage is required/u,
  );
  const options = parseTerraCoverageArguments([
    '--reference-coverage',
    'runs/coverage-reference',
  ]);
  assert.equal(options.referenceCoverage, 'runs/coverage-reference');
  assert.equal(options.model, 'gpt-5.6-terra');
  assert.equal(options.effort, 'high');
  assert.equal(options.maxRounds, 30);
  assert.equal(options.maxTokens, 32768);
  assert.equal(options.concurrency, 3);
});

test('independent Terra pricing applies long-context rates per API call', () => {
  const shortCost = terraCallCost({
    serviceTier: 'default',
    usage: {
      input_tokens: 100000,
      input_tokens_details: {
        cached_tokens: 80000,
        cache_write_tokens: 10000,
      },
      output_tokens: 1000,
    },
  });
  assert.equal(Number(shortCost.toFixed(6)), 0.09125);
  const longCost = terraCallCost({
    serviceTier: 'default',
    usage: {
      input_tokens: 300000,
      input_tokens_details: {
        cached_tokens: 250000,
        cache_write_tokens: 25000,
      },
      output_tokens: 2000,
    },
  });
  assert.equal(Number(longCost.toFixed(6)), 0.45125);
});

test('paired coverage statistics preserve ties and report a two-sided sign test', () => {
  const rows = [
    8, 0, -13, -10, 1, 3, 3, 7, 0, 0,
    0, -2, 0, 3, 3, 3, 7, 0, -2, -2,
    5, -13, 6, 3, 2, 0, 0, 0, 0, 0,
  ].map(scoreDeltaTerraMinusDeepSeek => ({ scoreDeltaTerraMinusDeepSeek }));
  const statistics = pairedStatistics(rows);
  assert.equal(statistics.pairedCases, 30);
  assert.equal(statistics.nonTiedCases, 19);
  assert.equal(statistics.meanScoreDeltaTerraMinusDeepSeek, 0.4);
  assert.equal(statistics.twoSidedSignTestP, 0.16706848);
  assert.ok(statistics.normalApproximation95Pct[0] < 0);
  assert.ok(statistics.normalApproximation95Pct[1] > 0);
});

test('coverage sensitivity excludes only the four conflicting structural pairs', () => {
  const pairs = Array.from({ length: 30 }, (_, index) => {
    const runIndex = index + 1;
    const caseIds = {
      7: '07-mill-upgrade-v1',
      8: '08-slot-expansion-v1',
      27: '27-mill-upgrade-v3',
      28: '28-slot-expansion-v3',
    };
    return {
      caseId: caseIds[runIndex] || `${String(runIndex).padStart(2, '0')}-clean`,
      terraScore: 100,
      deepseekScore: 99,
      scoreDeltaTerraMinusDeepSeek: 1,
      terraConfirmedMutations: [7, 8, 28].includes(runIndex) ? 0 : 1,
      deepseekConfirmedMutations: 1,
    };
  });
  const sensitivity = conflictSensitivity(pairs);
  assert.equal(sensitivity.conflictCaseIds.length, 4);
  assert.equal(sensitivity.uncontaminatedCases, 26);
  assert.equal(sensitivity.ruleCompliance.terra, 3);
  assert.equal(sensitivity.ruleCompliance.deepseek, 0);
  assert.equal(sensitivity.uncontaminated.terra.score, 2600);
  assert.equal(sensitivity.uncontaminated.deepseek.score, 2574);
});

test('collectible recovery collects exactly once and restarts the same Power plant', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'collectible-recovery', {
    coverage: true,
    variant: 2,
  });
  const runtime = new ShadowToolRuntime(snapshot);
  const fixture = snapshot.fixtures.collect;
  const before = runtime.stockItem(fixture.outputKind).availableAmount;
  const collected = await runtime.execute('collect', {});
  assert.equal(collected.ok, true);
  assert.equal(collected.executed, false);
  assert.equal(
    runtime.stockItem(fixture.outputKind).availableAmount,
    before + fixture.quantity,
  );
  await runtime.execute('refresh_state', {});
  const operation = snapshot.fixtures.operations[0];
  const produced = await runtime.execute('produce', {
    buildingId: operation.buildingId,
    name: operation.name,
    qty: operation.ratePerHour * 12,
    targetHours: 12,
    finishBefore: null,
  });
  assert.equal(produced.ok, true);
  assert.equal(produced.verified, true);
  const duplicate = await runtime.execute('collect', {});
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.guard, true);
});

test('input shortage path buys within the hard cap before Coffee production', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'input-shortage', {
    coverage: true,
    variant: 1,
  });
  const runtime = new ShadowToolRuntime(snapshot);
  const fixture = snapshot.fixtures.buy;
  const purchase = await runtime.execute('buy', {
    kind: fixture.kind,
    maxSpend: fixture.maximumSpend,
    ask: fixture.unitPrice,
  });
  assert.equal(purchase.ok, true);
  assert.ok(purchase.quantity >= fixture.minimumQty);
  assert.equal(runtime.stockItem(118).availableAmount, purchase.quantity);
  await runtime.execute('refresh_state', {});
  const operation = snapshot.fixtures.operations[0];
  const produced = await runtime.execute('produce', {
    buildingId: operation.buildingId,
    name: operation.name,
    qty: purchase.quantity / operation.inputPerOutput,
    targetHours: 24,
    finishBefore: null,
  });
  assert.equal(produced.ok, true);
  assert.equal(runtime.stockItem(118).availableAmount, 0);
});

test('upgrade scenario requires exact preview and approving council before confirmation', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'mill-upgrade', {
    coverage: true,
    variant: 1,
  });
  const runtime = new ShadowToolRuntime(snapshot);
  const fixture = snapshot.fixtures.structural.find(item => item.action === 'upgrade');
  const args = {
    buildingId: fixture.buildingId,
    maxCost: fixture.cost,
    minCashAfter: 5000,
  };
  const beforeCash = runtime.currentState.money;
  const preview = await runtime.execute('upgrade', { ...args, confirm: false });
  assert.equal(preview.ok, true);
  assert.equal(preview.effectiveCost, fixture.cost);
  const beforeCouncil = await runtime.execute('upgrade', { ...args, confirm: true });
  assert.equal(beforeCouncil.ok, false);
  const council = await runtime.execute('council', {
    proposal: 'Upgrade the measured bottleneck Mill from L2 to L3.',
    context: 'Exact cost, downtime, cash floor, and bottleneck evidence are frozen.',
    buildingId: fixture.buildingId,
    marketKinds: [118, 119],
  });
  assert.equal(council.decision, 'approve');
  const confirmed = await runtime.execute('upgrade', { ...args, confirm: true });
  assert.equal(confirmed.ok, true);
  assert.equal(runtime.currentState.money, beforeCash - fixture.cost);
});

test('debt-constrained upgrade scenario rejects financing and permits useful bridge work', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'mill-upgrade', {
    coverage: true,
    variant: 2,
  });
  const runtime = new ShadowToolRuntime(snapshot);
  const upgrade = snapshot.fixtures.structural.find(item => item.action === 'upgrade');
  const bonds = snapshot.fixtures.structural.find(item => item.action === 'bonds');
  await runtime.execute('upgrade', {
    buildingId: upgrade.buildingId,
    maxCost: upgrade.cost,
    minCashAfter: 5000,
    confirm: false,
  });
  await runtime.execute('bonds', {
    amount: bonds.amount,
    interest: bonds.interest,
    confirm: false,
  });
  const council = await runtime.execute('council', {
    proposal: 'Fund the Mill upgrade with another bond offer.',
    context: 'Debt coverage remains unknown.',
    buildingId: upgrade.buildingId,
    marketKinds: [118, 119],
  });
  assert.equal(council.decision, 'reject');
  const blocked = await runtime.execute('bonds', {
    amount: bonds.amount,
    interest: bonds.interest,
    confirm: true,
  });
  assert.equal(blocked.ok, false);
  const operation = snapshot.fixtures.operations[0];
  const bridge = await runtime.execute('produce', {
    buildingId: operation.buildingId,
    name: operation.name,
    qty: operation.maxQty,
    targetHours: 2,
    finishBefore: null,
  });
  assert.equal(bridge.ok, true);
});

test('slot expansion builds only with verified evidence and approving council', async () => {
  const approvedSnapshot = applyScenario(baseSnapshot(), 'slot-expansion', {
    coverage: true,
    variant: 1,
  });
  const runtime = new ShadowToolRuntime(approvedSnapshot);
  const fixture = approvedSnapshot.fixtures.structural[0];
  const args = {
    building: fixture.building,
    maxCost: fixture.cost,
    minCashAfter: 50000,
  };
  const evidence = await runtime.execute('auction_info', { kind: 110, limit: null });
  assert.equal(evidence.status, 'verified');
  await runtime.execute('build', { ...args, confirm: false });
  const council = await runtime.execute('council', {
    proposal: 'Build one Construction factory as a bounded Tools pilot.',
    context: 'Verified margin, demand, capex, payback, and exit evidence.',
    buildingId: null,
    marketKinds: [110],
  });
  assert.equal(council.decision, 'approve');
  const confirmed = await runtime.execute('build', { ...args, confirm: true });
  assert.equal(confirmed.ok, true);
  assert.equal(runtime.currentState.freeSlots, 0);

  const uncertainSnapshot = applyScenario(baseSnapshot(), 'slot-expansion', {
    coverage: true,
    variant: 2,
  });
  const uncertainRuntime = new ShadowToolRuntime(uncertainSnapshot);
  const uncertainEvidence = await uncertainRuntime.execute('auction_info', {
    kind: 110,
    limit: null,
  });
  assert.equal(uncertainEvidence.status, 'UNKNOWN');
});

test('chat and contract scenario allows source-bound previews but no real mutation', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'chat-contract-risk', {
    coverage: true,
    variant: 3,
  });
  const runtime = new ShadowToolRuntime(snapshot);
  const room = await runtime.execute('chat_room_read', { room: 'Sales' });
  assert.equal(room.ok, true);
  const source = room.messages[0];
  const preview = await runtime.execute('chat_room_reply', {
    room: 'Sales',
    company: source.company,
    bodyContains: source.text,
    conversationHref: null,
    sourceCompanyId: source.companyId,
    sourceMessageId: source.messageId,
    sourceCreatedAt: source.createdAt,
    parts: [{
      type: 'text',
      value: 'DM exact quantity, quality, and target price.',
      kind: null,
      name: null,
    }],
    reason: 'reply',
    attemptId: 'shadow-chat-preview-3',
    confirm: false,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.sendAuthorized, false);
  const blockedSend = await runtime.execute('chat_room_reply', {
    ...preview.params,
    confirm: true,
  });
  assert.equal(blockedSend.ok, false);
  const list = await runtime.execute('chat_contract_list', { limit: 20 });
  const contract = list.contracts[0];
  const contractPreview = await runtime.execute('chat_contract_preview', {
    contractId: contract.contractId,
    ownCompanyId: contract.ownCompanyId,
    terms: contract.terms,
    termsHash: contract.termsHash,
    confirm: false,
  });
  assert.equal(contractPreview.ok, true);
  assert.equal(contractPreview.acceptanceAuthorized, false);
  assert.equal(runtime.actions.filter(action => action.preview === false).length, 0);
});

test('negative exchange economics are inspectable but never fixture-authorized to sell', async () => {
  const snapshot = applyScenario(baseSnapshot(), 'utility-surplus', {
    coverage: true,
    variant: 3,
  });
  const runtime = new ShadowToolRuntime(snapshot);
  const inspection = await runtime.execute('inspect_exchange_sale', { kind: 1, qty: null });
  assert.equal(inspection.ok, true);
  assert.ok(inspection.uiQuote.profit < 0);
  assert.equal(inspection.exactAction, null);
  const blocked = await runtime.execute('exchange_sell', {
    name: inspection.uiQuote.name,
    qty: inspection.uiQuote.qty,
    price: inspection.uiQuote.price,
    confirm: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.guard, true);
});

test('suite sources contain no browser, executor, or child-process imports', () => {
  const files = [
    path.join(__dirname, '..', 'build-suite-report.js'),
    path.join(__dirname, '..', 'coverage.js'),
    path.join(__dirname, '..', 'rescore-suite.js'),
    path.join(__dirname, '..', 'suite.js'),
    path.join(__dirname, '..', 'validate-coverage.js'),
    path.join(__dirname, '..', 'validate-suite.js'),
    path.join(__dirname, '..', 'lib', 'coverage-artifacts.js'),
    path.join(__dirname, '..', 'lib', 'scenarios.js'),
    path.join(__dirname, '..', 'lib', 'suite-artifacts.js'),
    path.join(__dirname, '..', 'lib', 'tool-runtime.js'),
  ];
  const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const forbidden = [
    /require\([^)]*['"][^'"]*\/(?:act|state|cdp)\.js['"]/u,
    /\bexecFileSync\s*\(/u,
    /\bspawnSync\s*\(/u,
    /127\.0\.0\.1:9222/u,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `forbidden executor reference: ${pattern}`);
  }
});
