#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { RUNS_DIR, SIM_DIR } = require('./benchmark.js');
const { writeJson } = require('./lib/artifacts.js');
const {
  buildCoverageSummary,
} = require('./lib/coverage-artifacts.js');
const {
  COVERAGE_SCENARIOS,
} = require('./lib/scenarios.js');
const { scoreShadowResult } = require('./lib/scoring.js');
const { sha256 } = require('./lib/snapshot.js');

const DEEPSEEK_PRICING_PER_MILLION = Object.freeze({
  cacheHitInput: 0.003625,
  cacheMissInput: 0.435,
  output: 0.87,
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveCoverage(input) {
  const resolved = path.resolve(input);
  const root = `${path.resolve(RUNS_DIR)}${path.sep}`;
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error('coverage directory must remain inside the ignored runs directory');
  }
  return resolved;
}

function almostEqual(left, right, tolerance = 1e-8) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function deepseekCallCost(call) {
  const cost = call?.cost || {};
  const hit = Number(cost.cacheHitTokens);
  const miss = Number(cost.cacheMissTokens);
  const output = Number(cost.outputTokens);
  if (![hit, miss, output].every(Number.isFinite)) {
    throw new Error('invalid DeepSeek token allocation');
  }
  return (
    hit * DEEPSEEK_PRICING_PER_MILLION.cacheHitInput
      + miss * DEEPSEEK_PRICING_PER_MILLION.cacheMissInput
      + output * DEEPSEEK_PRICING_PER_MILLION.output
  ) / 1_000_000;
}

function persistedResult(result, transcript, usage) {
  return {
    ok: result.ok === true,
    reason: result.reason,
    error: result.error,
    rounds: result.rounds,
    runtime: result.runtime,
    transcript,
    usageCalls: usage.calls,
    usageTotal: usage.total,
    wallDurationMs: usage.wallDurationMs,
  };
}

function validateCoverage(input) {
  const directory = resolveCoverage(input);
  const summary = readJson(path.join(directory, 'coverage-summary.json'));
  const plan = readJson(path.join(directory, 'coverage-plan.json'));
  const baseSnapshot = readJson(path.join(directory, 'base-snapshot.json'));
  const checks = [];
  const failures = [];
  const assertCheck = (name, condition, evidence) => {
    const passed = condition === true;
    checks.push({ name, passed, evidence });
    if (!passed) failures.push(name);
  };
  assertCheck(
    'base snapshot hash',
    summary.baseSnapshotSha256 === sha256(JSON.stringify(baseSnapshot)),
    summary.baseSnapshotSha256,
  );
  assertCheck('exactly 30 planned cases', plan.cases?.length === 30, plan.cases?.length);
  assertCheck('exactly 30 result rows', summary.rows?.length === 30, summary.rows?.length);
  assertCheck(
    'ten scenario families',
    summary.scenarioFamilyCount === 10,
    summary.scenarioFamilyCount,
  );
  assertCheck(
    'coverage family set',
    JSON.stringify([...new Set(summary.rows.map(row => row.scenarioKey))])
      === JSON.stringify(COVERAGE_SCENARIOS),
    [...new Set(summary.rows.map(row => row.scenarioKey))],
  );
  assertCheck(
    'three variants per family',
    COVERAGE_SCENARIOS.every(scenarioKey => {
      const variants = summary.rows
        .filter(row => row.scenarioKey === scenarioKey)
        .map(row => row.variant)
        .sort();
      return JSON.stringify(variants) === JSON.stringify([1, 2, 3]);
    }),
    summary.scenarioSummaries,
  );
  assertCheck(
    'semantic tool parity',
    summary.fairness?.semanticToolParityWithTerra === true,
    summary.fairness,
  );
  assertCheck(
    'zero declared live mutations',
    summary.fairness?.liveGameMutations === 0,
    summary.fairness,
  );
  assertCheck(
    'browser remained closed',
    summary.fairness?.liveBrowserOpened === false,
    summary.fairness,
  );
  assertCheck(
    'production model unchanged',
    summary.fairness?.productionModelChanged === false,
    summary.fairness,
  );

  const recomputedRuns = [];
  for (const row of summary.rows) {
    const root = path.join(directory, row.artifactPath);
    const snapshot = readJson(path.join(root, 'snapshot.json'));
    const caseMeta = readJson(path.join(root, 'case.json'));
    const providerRoot = path.join(root, 'deepseek');
    const resultJson = readJson(path.join(providerRoot, 'result.json'));
    const scoreJson = readJson(path.join(providerRoot, 'score.json'));
    const usage = readJson(path.join(providerRoot, 'usage.json'));
    const transcript = readJson(path.join(providerRoot, 'transcript.json'));
    const result = persistedResult(resultJson, transcript, usage);
    const score = scoreShadowResult(snapshot, result);
    const callCosts = usage.calls.map(call => Number(deepseekCallCost(call).toFixed(8)));
    const independentlyPriced = Number(
      callCosts.reduce((sum, value) => sum + value, 0).toFixed(8),
    );
    const anyExecuted = transcript.some(entry => entry?.result?.executed === true)
      || (result.runtime?.actions || []).some(action => action?.executed === true);
    assertCheck(
      `${row.caseId}: base snapshot binding`,
      snapshot.baseSnapshotSha256 === summary.baseSnapshotSha256,
      snapshot.baseSnapshotSha256,
    );
    assertCheck(
      `${row.caseId}: case identity`,
      caseMeta.caseId === row.caseId
        && snapshot.scenario?.coverageScenarioKey === row.scenarioKey
        && snapshot.scenario?.coverageVariant === row.variant,
      { caseMeta, scenario: snapshot.scenario },
    );
    assertCheck(
      `${row.caseId}: independently recomputed score`,
      score.total === scoreJson.total && score.maximum === scoreJson.maximum,
      { recomputed: score.total, stored: scoreJson.total },
    );
    assertCheck(
      `${row.caseId}: summary score`,
      row.score === score.total && row.maximum === score.maximum,
      { row: row.score, recomputed: score.total },
    );
    assertCheck(
      `${row.caseId}: exact official-list cost`,
      almostEqual(independentlyPriced, usage.total.estimatedUsd),
      { independentlyPriced, stored: usage.total.estimatedUsd },
    );
    assertCheck(
      `${row.caseId}: no executed mutation`,
      anyExecuted === false,
      anyExecuted,
    );
    recomputedRuns.push({
      ...caseMeta,
      snapshot,
      result,
      score,
      model: usage.model,
      effort: usage.effort,
      maxTokens: usage.maxTokens,
    });
  }

  const recomputed = buildCoverageSummary(
    baseSnapshot,
    recomputedRuns,
    summary.startedAt,
    summary.finishedAt,
    {
      sameSemanticToolNames: summary.fairness.semanticToolParityWithTerra,
      deepseek: { sha256: summary.fairness.toolSurfaceSha256 },
    },
  );
  const aggregateFields = [
    'runs',
    'completed',
    'score',
    'maximum',
    'averageScore',
    'totalRounds',
    'totalWallDurationMs',
    'guardFailures',
    'unknownToolCalls',
    'confirmedMutations',
    'forbiddenConfirmedMutations',
    'duplicateConfirmedMutations',
  ];
  for (const field of aggregateFields) {
    assertCheck(
      `aggregate ${field}`,
      recomputed.aggregate[field] === summary.aggregate[field],
      { recomputed: recomputed.aggregate[field], stored: summary.aggregate[field] },
    );
  }
  for (const field of ['promptTokens', 'outputTokens', 'estimatedUsd']) {
    assertCheck(
      `aggregate usage ${field}`,
      almostEqual(recomputed.aggregate.usage[field], summary.aggregate.usage[field]),
      {
        recomputed: recomputed.aggregate.usage[field],
        stored: summary.aggregate.usage[field],
      },
    );
  }
  assertCheck(
    'readiness recomputation',
    JSON.stringify(recomputed.readiness) === JSON.stringify(summary.readiness),
    { recomputed: recomputed.readiness, stored: summary.readiness },
  );

  const productionLauncher = fs.readFileSync(
    path.join(SIM_DIR, 'autopilot', 'run-brain.sh'),
    'utf8',
  );
  assertCheck(
    'production launcher still selects Terra',
    /BRAIN_MODEL=gpt-5\.6-terra/u.test(productionLauncher),
    'autopilot/run-brain.sh',
  );
  const isolatedSources = [
    'coverage.js',
    'lib/coverage-artifacts.js',
    'lib/scenarios.js',
    'lib/tool-runtime.js',
  ].map(relative => fs.readFileSync(path.join(__dirname, relative), 'utf8')).join('\n');
  assertCheck(
    'coverage sources have no Chrome endpoint or executor import',
    !/127\.0\.0\.1:9222|require\([^)]*['"][^'"]*\/(?:act|state|cdp)\.js['"]/u
      .test(isolatedSources),
    'coverage source scan',
  );

  const validation = {
    schemaVersion: 1,
    status: failures.length ? 'failed' : 'passed',
    validatedAt: new Date().toISOString(),
    coverageDirectory: path.basename(directory),
    checks,
    failures,
    officialPricingPerMillion: DEEPSEEK_PRICING_PER_MILLION,
    pricingSource: 'DeepSeek API Models & Pricing: deepseek-v4-pro cache-hit, cache-miss, and output rates.',
  };
  writeJson(path.join(directory, 'validation.json'), validation);
  return validation;
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node validate-coverage.js <runs/coverage-* directory>');
  const result = validateCoverage(input);
  console.log(
    `Validation: ${result.status}; checks=${result.checks.length}; failures=${result.failures.length}`,
  );
  if (result.failures.length) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  DEEPSEEK_PRICING_PER_MILLION,
  almostEqual,
  deepseekCallCost,
  persistedResult,
  resolveCoverage,
  validateCoverage,
};
