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
const TERRA_SHORT_CONTEXT_LIMIT = 272000;
const TERRA_PRICING_PER_MILLION = Object.freeze({
  short: Object.freeze({
    input: 2.5,
    cached: 0.25,
    cacheWrite: 3.125,
    output: 15,
  }),
  long: Object.freeze({
    input: 5,
    cached: 0.5,
    cacheWrite: 6.25,
    output: 22.5,
  }),
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

function terraCallCost(call) {
  const usage = call?.usage || {};
  const details = usage.input_tokens_details || {};
  const input = Number(usage.input_tokens);
  const cached = Number(details.cached_tokens);
  const cacheWrite = Number(details.cache_write_tokens);
  const output = Number(usage.output_tokens);
  if (![input, cached, cacheWrite, output].every(Number.isFinite)
      || [input, cached, cacheWrite, output].some(value => value < 0)
      || cached + cacheWrite > input) {
    throw new Error('invalid Terra token allocation');
  }
  if (!['default', 'standard'].includes(String(call?.serviceTier || 'default'))) {
    throw new Error('unsupported Terra service tier for independent pricing');
  }
  const prices = input > TERRA_SHORT_CONTEXT_LIMIT
    ? TERRA_PRICING_PER_MILLION.long
    : TERRA_PRICING_PER_MILLION.short;
  return (
    (input - cached - cacheWrite) * prices.input
      + cached * prices.cached
      + cacheWrite * prices.cacheWrite
      + output * prices.output
  ) / 1_000_000;
}

function providerCallCost(provider, call) {
  if (provider === 'terra') return terraCallCost(call);
  if (provider === 'deepseek') return deepseekCallCost(call);
  throw new Error(`unsupported coverage provider: ${provider}`);
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
  const provider = summary.provider || plan.provider || 'deepseek';
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
  assertCheck(
    'known provider',
    ['deepseek', 'terra'].includes(provider),
    provider,
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
  let referenceDirectory = null;
  let referenceSummary = null;
  if (provider === 'terra') {
    const referenceId = summary.fairness?.referenceCoverageId
      || plan.referenceCoverageId;
    if (referenceId) {
      referenceDirectory = resolveCoverage(path.join(RUNS_DIR, referenceId));
      referenceSummary = readJson(path.join(referenceDirectory, 'coverage-summary.json'));
      const referenceValidation = readJson(path.join(referenceDirectory, 'validation.json'));
      assertCheck(
        'reference coverage independently passed',
        referenceValidation.status === 'passed',
        referenceValidation.status,
      );
      assertCheck(
        'same immutable base as reference',
        referenceSummary.baseSnapshotSha256 === summary.baseSnapshotSha256,
        {
          reference: referenceSummary.baseSnapshotSha256,
          terra: summary.baseSnapshotSha256,
        },
      );
      assertCheck(
        'exact reference snapshots declared',
        summary.fairness?.exactReferenceCaseSnapshots === true,
        summary.fairness?.exactReferenceCaseSnapshots,
      );
    } else {
      assertCheck('reference coverage identified', false, referenceId || null);
    }
  }
  for (const row of summary.rows) {
    const root = path.join(directory, row.artifactPath);
    const snapshot = readJson(path.join(root, 'snapshot.json'));
    const caseMeta = readJson(path.join(root, 'case.json'));
    const providerRoot = path.join(root, provider);
    const resultJson = readJson(path.join(providerRoot, 'result.json'));
    const scoreJson = readJson(path.join(providerRoot, 'score.json'));
    const usage = readJson(path.join(providerRoot, 'usage.json'));
    const transcript = readJson(path.join(providerRoot, 'transcript.json'));
    const result = persistedResult(resultJson, transcript, usage);
    const score = scoreShadowResult(snapshot, result);
    const callCosts = usage.calls.map(call => Number(providerCallCost(provider, call).toFixed(8)));
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
    if (referenceDirectory) {
      const referenceSnapshot = readJson(
        path.join(referenceDirectory, 'cases', row.caseId, 'snapshot.json'),
      );
      assertCheck(
        `${row.caseId}: exact reference snapshot`,
        sha256(JSON.stringify(snapshot)) === sha256(JSON.stringify(referenceSnapshot)),
        {
          reference: sha256(JSON.stringify(referenceSnapshot)),
          terra: sha256(JSON.stringify(snapshot)),
        },
      );
    }
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
      provider,
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
      terra: { sha256: summary.fairness.toolSurfaceSha256 },
    },
    {
      provider,
      referenceCoverageId: summary.fairness?.referenceCoverageId || null,
      referenceCoverageSha256: summary.fairness?.referenceCoverageSha256 || null,
      exactReferenceCaseSnapshots: summary.fairness?.exactReferenceCaseSnapshots === true,
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
    'terra-coverage.js',
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
    provider,
    checks,
    failures,
    officialPricingPerMillion: provider === 'terra'
      ? TERRA_PRICING_PER_MILLION
      : DEEPSEEK_PRICING_PER_MILLION,
    pricingSource: provider === 'terra'
      ? 'OpenAI API pricing: gpt-5.6-terra Standard short- and long-context rates.'
      : 'DeepSeek API Models & Pricing: deepseek-v4-pro cache-hit, cache-miss, and output rates.',
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
  TERRA_PRICING_PER_MILLION,
  TERRA_SHORT_CONTEXT_LIMIT,
  almostEqual,
  deepseekCallCost,
  persistedResult,
  providerCallCost,
  resolveCoverage,
  terraCallCost,
  validateCoverage,
};
