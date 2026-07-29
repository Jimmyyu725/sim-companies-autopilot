#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  RUNS_DIR,
  SIM_DIR,
  runBenchmark,
} = require('./benchmark.js');
const {
  DEFAULT_MODEL: DEFAULT_DEEPSEEK_MODEL,
} = require('./lib/client.js');
const {
  DEFAULT_MODEL: DEFAULT_OPENAI_MODEL,
} = require('./lib/openai-client.js');
const {
  DEFAULT_SUITE_SCENARIOS,
  SCENARIO_BUILDERS,
} = require('./lib/scenarios.js');
const { createSnapshot } = require('./lib/snapshot.js');
const { writeSuiteArtifacts } = require('./lib/suite-artifacts.js');

function suiteId(now = new Date()) {
  return `suite-${now.toISOString().replace(/[-:.]/gu, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function parseArguments(argv) {
  const options = {
    effort: 'high',
    maxRounds: 30,
    maxTokens: 32768,
    openaiModel: DEFAULT_OPENAI_MODEL,
    deepseekModel: DEFAULT_DEEPSEEK_MODEL,
    scenarios: [...DEFAULT_SUITE_SCENARIOS],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--max-rounds') options.maxRounds = Number(argv[++index]);
    else if (value === '--max-tokens') options.maxTokens = Number(argv[++index]);
    else if (value === '--openai-model') options.openaiModel = argv[++index];
    else if (value === '--deepseek-model') options.deepseekModel = argv[++index];
    else if (value === '--scenarios') {
      options.scenarios = String(argv[++index] || '').split(',').map(item => item.trim()).filter(Boolean);
    } else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 60) {
    throw new Error('--max-rounds must be an integer from 1 to 60');
  }
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1024 || options.maxTokens > 32768) {
    throw new Error('--max-tokens must be an integer from 1024 to 32768');
  }
  if (!options.scenarios.length || options.scenarios.some(name => !SCENARIO_BUILDERS[name])) {
    throw new Error(`--scenarios must contain only: ${Object.keys(SCENARIO_BUILDERS).join(', ')}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node suite.js [--scenarios all-busy,idle-mill,utility-surplus,prospector-ready,multi-pressure]',
    '                [--max-rounds 30] [--max-tokens 32768]',
    '',
    'Runs paired Terra High and DeepSeek V4 Pro High shadow wakes sequentially across scenarios.',
    'Each provider pair runs concurrently from one identical controlled scenario snapshot.',
  ].join('\n');
}

async function runSuite(options) {
  const startedAt = new Date().toISOString();
  const id = suiteId(new Date(startedAt));
  const directory = path.join(RUNS_DIR, id);
  const scenarioDirectory = path.join(directory, 'scenarios');
  fs.mkdirSync(scenarioDirectory, { recursive: true, mode: 0o700 });
  const baseSnapshot = createSnapshot(SIM_DIR, new Date(), { replayAtStateTime: true });
  const scenarioRuns = [];
  for (const scenarioKey of options.scenarios) {
    console.log(`\n=== Scenario ${scenarioKey} ===`);
    const run = await runBenchmark({
      ...options,
      mode: 'run',
      scenario: scenarioKey,
    }, {
      baseSnapshot,
      runsDirectory: scenarioDirectory,
      runId: scenarioKey,
    });
    scenarioRuns.push({ ...run, scenarioKey });
    for (const row of run.artifacts.comparison.rows) {
      console.log(
        `${scenarioKey}/${row.provider}: completed=${row.completed} score=${row.score}/${row.maximum} rounds=${row.rounds} wallMs=${row.wallDurationMs}`,
      );
    }
  }
  const finishedAt = new Date().toISOString();
  const artifacts = writeSuiteArtifacts(
    RUNS_DIR,
    id,
    baseSnapshot,
    scenarioRuns,
    startedAt,
    finishedAt,
  );
  return { baseSnapshot, scenarioRuns, artifacts };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runSuite(options);
  console.log(`\nSuite artifacts: ${result.artifacts.directory}`);
  for (const row of result.artifacts.comparison.aggregates) {
    console.log(
      `${row.provider}: completed=${row.completedScenarios}/${row.totalScenarios} score=${row.totalScore}/${row.maximum} wallMs=${row.totalWallDurationMs} costUsd=${row.usage.estimatedUsd ?? 'UNKNOWN'}`,
    );
  }
  if (result.artifacts.comparison.scenarioRows.some(row => !row.completed)) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    console.error(String(error?.message || error).replace(/sk-[A-Za-z0-9_-]{16,}/gu, '[REDACTED]'));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  runSuite,
  suiteId,
  usage,
};
