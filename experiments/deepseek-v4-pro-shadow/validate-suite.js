#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { RUNS_DIR, SIM_DIR } = require('./benchmark.js');
const { writeJson } = require('./lib/artifacts.js');
const { buildWakeMessage, sha256 } = require('./lib/snapshot.js');

const OFFICIAL_PRICING_PER_MILLION = Object.freeze({
  terraShort: Object.freeze({
    input: 2.5,
    cached: 0.25,
    cacheWrite: 3.125,
    output: 15,
  }),
  deepseek: Object.freeze({
    cacheHitInput: 0.003625,
    cacheMissInput: 0.435,
    output: 0.87,
  }),
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveSuite(input) {
  const resolved = path.resolve(input);
  const root = `${path.resolve(RUNS_DIR)}${path.sep}`;
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error('suite directory must remain inside the ignored runs directory');
  }
  return resolved;
}

function almostEqual(left, right, tolerance = 1e-8) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function terraCost(call) {
  const cost = call.cost || {};
  const input = Number(cost.promptTokens);
  const hit = Number(cost.cacheHitTokens);
  const write = Number(cost.cacheWriteTokens);
  const output = Number(cost.outputTokens);
  const uncached = input - hit - write;
  if (![input, hit, write, output, uncached].every(Number.isFinite) || uncached < 0) {
    throw new Error('invalid Terra token allocation');
  }
  if (input > 272000) throw new Error('validator requires explicit long-context pricing');
  const prices = OFFICIAL_PRICING_PER_MILLION.terraShort;
  return (
    uncached * prices.input
      + hit * prices.cached
      + write * prices.cacheWrite
      + output * prices.output
  ) / 1_000_000;
}

function deepseekCost(call) {
  const cost = call.cost || {};
  const hit = Number(cost.cacheHitTokens);
  const miss = Number(cost.cacheMissTokens);
  const output = Number(cost.outputTokens);
  if (![hit, miss, output].every(Number.isFinite)) {
    throw new Error('invalid DeepSeek token allocation');
  }
  const prices = OFFICIAL_PRICING_PER_MILLION.deepseek;
  return (
    hit * prices.cacheHitInput
      + miss * prices.cacheMissInput
      + output * prices.output
  ) / 1_000_000;
}

function validateSuite(input) {
  const directory = resolveSuite(input);
  const suite = readJson(path.join(directory, 'suite-comparison.json'));
  const baseSnapshot = readJson(path.join(directory, 'base-snapshot.json'));
  const failures = [];
  const checks = [];
  const assertCheck = (name, condition, evidence) => {
    checks.push({ name, passed: condition === true, evidence });
    if (!condition) failures.push(name);
  };
  assertCheck(
    'base snapshot hash',
    suite.baseSnapshotSha256 === sha256(JSON.stringify(baseSnapshot)),
    suite.baseSnapshotSha256,
  );
  assertCheck('five scenarios', suite.scenarioCount === 5, suite.scenarioCount);
  assertCheck('zero live game mutations', suite.fairness?.liveGameMutations === 0, suite.fairness);
  assertCheck('browser remained closed', suite.fairness?.liveBrowserOpened === false, suite.fairness);
  assertCheck('production model unchanged', suite.fairness?.productionModelChanged === false, suite.fairness);

  const scenarioDirectory = path.join(directory, 'scenarios');
  const recomputed = { terra: [], deepseek: [] };
  for (const scenario of fs.readdirSync(scenarioDirectory).sort()) {
    const root = path.join(scenarioDirectory, scenario);
    if (!fs.statSync(root).isDirectory()) continue;
    const snapshot = readJson(path.join(root, 'snapshot.json'));
    const comparison = readJson(path.join(root, 'comparison.json'));
    assertCheck(
      `${scenario}: snapshot hash`,
      comparison.fairness.snapshotSha256 === sha256(JSON.stringify(snapshot)),
      comparison.fairness.snapshotSha256,
    );
    assertCheck(
      `${scenario}: wake message hash`,
      comparison.fairness.wakeMessageSha256 === sha256(buildWakeMessage(snapshot)),
      comparison.fairness.wakeMessageSha256,
    );
    assertCheck(
      `${scenario}: paired prompt and tools`,
      comparison.fairness.samePrompt === true
        && comparison.fairness.sameSemanticToolNames === true
        && comparison.fairness.sameHighReasoningEffort === true,
      comparison.fairness,
    );
    for (const provider of ['terra', 'deepseek']) {
      const providerRoot = path.join(root, provider);
      const result = readJson(path.join(providerRoot, 'result.json'));
      const score = readJson(path.join(providerRoot, 'score.json'));
      const usage = readJson(path.join(providerRoot, 'usage.json'));
      const transcript = readJson(path.join(providerRoot, 'transcript.json'));
      const categorySum = Number(
        score.categories.reduce((sum, category) => sum + Number(category.earned), 0).toFixed(4),
      );
      const callCosts = usage.calls.map(call => Number((
        provider === 'terra' ? terraCost(call) : deepseekCost(call)
      ).toFixed(8)));
      const independentlyPriced = Number(callCosts.reduce((sum, cost) => sum + cost, 0).toFixed(8));
      const row = comparison.rows.find(candidate => candidate.provider === provider);
      const anyExecuted = transcript.some(entry => entry?.result?.executed === true)
        || (result.runtime?.actions || []).some(action => action?.executed === true);
      assertCheck(`${scenario}/${provider}: completed`, result.ok === true, result.reason);
      assertCheck(`${scenario}/${provider}: category sum`, categorySum === score.total, {
        categorySum,
        total: score.total,
      });
      assertCheck(`${scenario}/${provider}: comparison score`, row?.score === score.total, row);
      assertCheck(`${scenario}/${provider}: exact cost`, almostEqual(
        independentlyPriced,
        usage.total.estimatedUsd,
      ), {
        independentlyPriced,
        stored: usage.total.estimatedUsd,
      });
      assertCheck(`${scenario}/${provider}: no executed mutation`, anyExecuted === false, anyExecuted);
      recomputed[provider].push({
        score: score.total,
        maximum: score.maximum,
        rounds: result.rounds,
        wallDurationMs: usage.wallDurationMs,
        usage: usage.total,
      });
    }
  }

  for (const provider of ['terra', 'deepseek']) {
    const aggregate = suite.aggregates.find(row => row.provider === provider);
    const rows = recomputed[provider];
    const sum = field => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
    const usageSum = field => Number(rows.reduce(
      (total, row) => total + Number(row.usage?.[field] || 0),
      0,
    ).toFixed(field.endsWith('Usd') ? 8 : 0));
    const expected = {
      totalScore: Number(sum('score').toFixed(4)),
      maximum: sum('maximum'),
      totalRounds: sum('rounds'),
      totalWallDurationMs: sum('wallDurationMs'),
      promptTokens: usageSum('promptTokens'),
      outputTokens: usageSum('outputTokens'),
      estimatedUsd: usageSum('estimatedUsd'),
    };
    assertCheck(`${provider}: aggregate score`, aggregate.totalScore === expected.totalScore, expected);
    assertCheck(`${provider}: aggregate maximum`, aggregate.maximum === expected.maximum, expected);
    assertCheck(`${provider}: aggregate rounds`, aggregate.totalRounds === expected.totalRounds, expected);
    assertCheck(`${provider}: aggregate wall time`, aggregate.totalWallDurationMs === expected.totalWallDurationMs, expected);
    assertCheck(`${provider}: aggregate input tokens`, aggregate.usage.promptTokens === expected.promptTokens, expected);
    assertCheck(`${provider}: aggregate output tokens`, aggregate.usage.outputTokens === expected.outputTokens, expected);
    assertCheck(`${provider}: aggregate cost`, almostEqual(
      aggregate.usage.estimatedUsd,
      expected.estimatedUsd,
    ), expected);
  }

  const productionLauncher = fs.readFileSync(path.join(SIM_DIR, 'autopilot', 'run-brain.sh'), 'utf8');
  assertCheck(
    'production launcher still selects Terra',
    /BRAIN_MODEL=gpt-5\.6-terra/u.test(productionLauncher),
    'autopilot/run-brain.sh',
  );
  const result = {
    schemaVersion: 1,
    status: failures.length ? 'failed' : 'passed',
    validatedAt: new Date().toISOString(),
    suiteDirectory: path.basename(directory),
    checks,
    failures,
    officialPricingPerMillion: OFFICIAL_PRICING_PER_MILLION,
    pricingSources: {
      terra: 'OpenAI GPT-5.6 pricing: standard short-context rates and 1.25x cache-write rate.',
      deepseek: 'DeepSeek API Models & Pricing: deepseek-v4-pro cache-hit, cache-miss, and output rates.',
    },
  };
  writeJson(path.join(directory, 'validation.json'), result);
  return result;
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node validate-suite.js <runs/suite-* directory>');
  const result = validateSuite(input);
  console.log(`Validation: ${result.status}; checks=${result.checks.length}; failures=${result.failures.length}`);
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
  OFFICIAL_PRICING_PER_MILLION,
  deepseekCost,
  terraCost,
  validateSuite,
};
