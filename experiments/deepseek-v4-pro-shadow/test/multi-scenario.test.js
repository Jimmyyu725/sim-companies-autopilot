'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
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
const { parseArguments } = require('../suite.js');

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
  const options = parseArguments([]);
  assert.deepEqual(options.scenarios, DEFAULT_SUITE_SCENARIOS);
  assert.equal(options.effort, 'high');
  assert.equal(options.maxRounds, 30);
  assert.equal(options.maxTokens, 32768);
});

test('suite sources contain no browser, executor, or child-process imports', () => {
  const files = [
    path.join(__dirname, '..', 'build-suite-report.js'),
    path.join(__dirname, '..', 'rescore-suite.js'),
    path.join(__dirname, '..', 'suite.js'),
    path.join(__dirname, '..', 'validate-suite.js'),
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
