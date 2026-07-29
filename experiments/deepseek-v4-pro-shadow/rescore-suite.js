#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { RUNS_DIR } = require('./benchmark.js');
const {
  buildComparison,
  buildReport,
  writeJson,
} = require('./lib/artifacts.js');
const { applyScenario } = require('./lib/scenarios.js');
const { scoreShadowResult } = require('./lib/scoring.js');
const {
  buildSuiteComparison,
  buildSuiteReport,
} = require('./lib/suite-artifacts.js');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeSuiteDirectory(input) {
  const resolved = path.resolve(input);
  const root = `${path.resolve(RUNS_DIR)}${path.sep}`;
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error('suite directory must remain inside the ignored benchmark runs directory');
  }
  if (!/^suite-[A-Za-z0-9-]+$/u.test(path.basename(resolved))) {
    throw new Error('suite directory name is invalid');
  }
  return resolved;
}

function currentStateFromTranscript(snapshot, transcript) {
  const refresh = [...transcript].reverse().find(row => (
    row?.type === 'tool'
      && row?.name === 'refresh_state'
      && row?.result
      && typeof row.result.t === 'string'
  ));
  if (!refresh) return snapshot.state;
  const state = JSON.parse(JSON.stringify(refresh.result));
  delete state._shadow;
  return state;
}

function reconstructResult(snapshot, providerDirectory) {
  const stored = readJson(path.join(providerDirectory, 'result.json'));
  const transcript = readJson(path.join(providerDirectory, 'transcript.json'));
  const usage = readJson(path.join(providerDirectory, 'usage.json'));
  return {
    ok: stored.ok === true,
    reason: stored.reason || null,
    error: stored.error || null,
    rounds: stored.rounds || 0,
    transcript,
    usageCalls: usage.calls || [],
    usageTotal: usage.total || null,
    wallDurationMs: usage.wallDurationMs ?? null,
    runtime: {
      ...(stored.runtime || {}),
      currentState: currentStateFromTranscript(snapshot, transcript),
    },
  };
}

function rescoreScenario(directory, scoringExpectations = null) {
  const snapshot = readJson(path.join(directory, 'snapshot.json'));
  const scoringSnapshot = JSON.parse(JSON.stringify(snapshot));
  if (scoringExpectations) {
    scoringSnapshot.scenario.expectations = JSON.parse(JSON.stringify(scoringExpectations));
  }
  const previous = readJson(path.join(directory, 'comparison.json'));
  const models = {};
  for (const provider of ['terra', 'deepseek']) {
    const providerDirectory = path.join(directory, provider);
    const usage = readJson(path.join(providerDirectory, 'usage.json'));
    const result = reconstructResult(snapshot, providerDirectory);
    const score = scoreShadowResult(scoringSnapshot, result);
    writeJson(path.join(providerDirectory, 'score.json'), score);
    models[provider] = {
      provider,
      model: usage.model,
      effort: usage.effort,
      maxTokens: usage.maxTokens,
      toolSurface: { sha256: 'provider-neutral-identical-surface' },
      result,
      score,
    };
  }
  const comparison = buildComparison(
    snapshot,
    models,
    previous.startedAt,
    previous.finishedAt,
  );
  writeJson(path.join(directory, 'comparison.json'), comparison);
  fs.writeFileSync(
    path.join(directory, 'report.md'),
    buildReport(comparison, models),
    { mode: 0o600 },
  );
  return { snapshot, comparison };
}

function rescoreSuite(input) {
  const directory = safeSuiteDirectory(input);
  const previous = readJson(path.join(directory, 'suite-comparison.json'));
  const baseSnapshot = readJson(path.join(directory, 'base-snapshot.json'));
  const scenariosDirectory = path.join(directory, 'scenarios');
  const scenarioKeys = fs.readdirSync(scenariosDirectory)
    .filter(name => fs.statSync(path.join(scenariosDirectory, name)).isDirectory())
    .sort((left, right) => {
      const order = ['all-busy', 'idle-mill', 'utility-surplus', 'prospector-ready', 'multi-pressure'];
      return order.indexOf(left) - order.indexOf(right);
    });
  const scenarioRuns = scenarioKeys.map(scenarioKey => {
    const scoringScenario = applyScenario(baseSnapshot, scenarioKey);
    const artifacts = rescoreScenario(
      path.join(scenariosDirectory, scenarioKey),
      scoringScenario.scenario.expectations,
    );
    return {
      scenarioKey,
      snapshot: artifacts.snapshot,
      artifacts: { comparison: artifacts.comparison },
    };
  });
  const comparison = buildSuiteComparison(
    baseSnapshot,
    scenarioRuns,
    previous.startedAt,
    previous.finishedAt,
  );
  writeJson(path.join(directory, 'suite-comparison.json'), comparison);
  fs.writeFileSync(
    path.join(directory, 'suite-report.md'),
    buildSuiteReport(comparison),
    { mode: 0o600 },
  );
  return { directory, comparison };
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node rescore-suite.js <runs/suite-* directory>');
  const result = rescoreSuite(input);
  console.log(`Rescored: ${result.directory}`);
  for (const row of result.comparison.aggregates) {
    console.log(`${row.provider}: ${row.totalScore}/${row.maximum}`);
  }
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
  currentStateFromTranscript,
  reconstructResult,
  rescoreScenario,
  rescoreSuite,
  safeSuiteDirectory,
};
