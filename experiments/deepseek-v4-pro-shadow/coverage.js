#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  RUNS_DIR,
  SIM_DIR,
  emptyRuntime,
  parity,
  redact,
  timedRun,
} = require('./benchmark.js');
const {
  DeepSeekClient,
  DEFAULT_MODEL,
} = require('./lib/client.js');
const {
  ensureInside,
  writeJson,
  writeProviderArtifacts,
} = require('./lib/artifacts.js');
const {
  COVERAGE_SCENARIOS,
  SCENARIO_BUILDERS,
  applyScenario,
} = require('./lib/scenarios.js');
const { writeCoverageArtifacts } = require('./lib/coverage-artifacts.js');
const { runShadowWake } = require('./lib/runner.js');
const { scoreShadowResult } = require('./lib/scoring.js');
const { createSnapshot } = require('./lib/snapshot.js');

function coverageId(now = new Date()) {
  return `coverage-${now.toISOString().replace(/[-:.]/gu, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function parseArguments(argv) {
  const options = {
    runs: 30,
    concurrency: 3,
    effort: 'high',
    maxRounds: 30,
    maxTokens: 32768,
    model: DEFAULT_MODEL,
    scenarios: [...COVERAGE_SCENARIOS],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--runs') options.runs = Number(argv[++index]);
    else if (value === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (value === '--max-rounds') options.maxRounds = Number(argv[++index]);
    else if (value === '--max-tokens') options.maxTokens = Number(argv[++index]);
    else if (value === '--model') options.model = String(argv[++index]);
    else if (value === '--scenarios') {
      options.scenarios = String(argv[++index] || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    } else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 100) {
    throw new Error('--runs must be an integer from 1 to 100');
  }
  if (!Number.isSafeInteger(options.concurrency)
      || options.concurrency < 1
      || options.concurrency > 5) {
    throw new Error('--concurrency must be an integer from 1 to 5');
  }
  if (!Number.isSafeInteger(options.maxRounds)
      || options.maxRounds < 1
      || options.maxRounds > 60) {
    throw new Error('--max-rounds must be an integer from 1 to 60');
  }
  if (!Number.isSafeInteger(options.maxTokens)
      || options.maxTokens < 1024
      || options.maxTokens > 32768) {
    throw new Error('--max-tokens must be an integer from 1024 to 32768');
  }
  if (!options.scenarios.length || options.scenarios.some(name => !SCENARIO_BUILDERS[name])) {
    throw new Error(`--scenarios must contain only: ${Object.keys(SCENARIO_BUILDERS).join(', ')}`);
  }
  if (options.runs > options.scenarios.length * 3) {
    throw new Error('--runs cannot exceed three controlled variants per selected scenario');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node coverage.js [--runs 30] [--concurrency 3]',
    '                   [--max-rounds 30] [--max-tokens 32768]',
    '',
    'Runs DeepSeek V4 Pro High across ten controlled scenario families and three variants each.',
    'No OpenAI request, Chrome connection, or live game mutation is made.',
  ].join('\n');
}

function coverageMatrix(options) {
  const rows = [];
  for (let variant = 1; variant <= 3 && rows.length < options.runs; variant += 1) {
    for (const scenarioKey of options.scenarios) {
      if (rows.length >= options.runs) break;
      const runIndex = rows.length + 1;
      rows.push({
        runIndex,
        scenarioKey,
        variant,
        caseId: `${String(runIndex).padStart(2, '0')}-${scenarioKey}-v${variant}`,
      });
    }
  }
  return rows;
}

function caseLogger(row) {
  return event => {
    if (event.type !== 'assistant') return;
    const tools = event.toolNames.join(',') || 'none';
    console.log(
      `[${String(row.runIndex).padStart(2, '0')}] ${row.scenarioKey}/v${row.variant} round ${event.round}: ${tools}`,
    );
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => consume()),
  );
  return results;
}

async function runCoverage(options) {
  const environment = {
    ...process.env,
    SIM_CHAT_MODE: 'shadow',
  };
  if (!environment.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required through the process environment');
  }
  const startedAt = new Date().toISOString();
  const id = coverageId(new Date(startedAt));
  const directory = ensureInside(RUNS_DIR, path.join(RUNS_DIR, id));
  const casesDirectory = path.join(directory, 'cases');
  fs.mkdirSync(casesDirectory, { recursive: true, mode: 0o700 });
  const baseSnapshot = createSnapshot(SIM_DIR, new Date(), { replayAtStateTime: true });
  const toolParity = parity(
    applyScenario(baseSnapshot, options.scenarios[0], {
      coverage: true,
      variant: 1,
    }),
    environment,
  );
  if (!toolParity.ok) throw new Error('DeepSeek and Terra semantic tool surfaces differ');
  const client = new DeepSeekClient({
    apiKey: environment.DEEPSEEK_API_KEY,
    baseUrl: environment.DEEPSEEK_BASE_URL,
    model: options.model,
    effort: options.effort,
    maxTokens: options.maxTokens,
  });
  const matrix = coverageMatrix(options);
  writeJson(path.join(directory, 'coverage-plan.json'), {
    schemaVersion: 1,
    startedAt,
    model: options.model,
    effort: options.effort,
    maxRounds: options.maxRounds,
    maxTokens: options.maxTokens,
    concurrency: options.concurrency,
    cases: matrix,
    isolation: {
      liveBrowserOpened: false,
      liveGameMutations: 0,
      productionModelChanged: false,
    },
  });
  console.log(
    `Coverage ${id}: ${matrix.length} DeepSeek-only wakes, concurrency ${options.concurrency}.`,
  );
  const runs = await runPool(matrix, options.concurrency, async row => {
    const snapshot = applyScenario(baseSnapshot, row.scenarioKey, {
      coverage: true,
      variant: row.variant,
    });
    console.log(
      `[${String(row.runIndex).padStart(2, '0')}] START ${row.scenarioKey}/v${row.variant}`,
    );
    const result = await timedRun(() => runShadowWake({
      snapshot,
      environment,
      maxRounds: options.maxRounds,
      complete: (messages, tools) => client.complete(messages, tools),
      onEvent: caseLogger(row),
    }));
    if (!result.runtime) result.runtime = emptyRuntime();
    const score = scoreShadowResult(snapshot, result);
    const caseDirectory = ensureInside(casesDirectory, path.join(casesDirectory, row.caseId));
    fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
    writeJson(path.join(caseDirectory, 'snapshot.json'), snapshot);
    writeJson(path.join(caseDirectory, 'case.json'), row);
    writeProviderArtifacts(
      path.join(caseDirectory, 'deepseek'),
      'deepseek',
      result,
      score,
      {
        model: options.model,
        effort: options.effort,
        maxTokens: options.maxTokens,
      },
    );
    console.log(
      `[${String(row.runIndex).padStart(2, '0')}] DONE ${row.scenarioKey}/v${row.variant} completed=${result.ok === true} score=${score.total}/${score.maximum} rounds=${result.rounds} cost=${result.usageTotal?.estimatedUsd ?? 'UNKNOWN'}`,
    );
    return {
      ...row,
      snapshot,
      result,
      score,
      model: options.model,
      effort: options.effort,
      maxTokens: options.maxTokens,
    };
  });
  const finishedAt = new Date().toISOString();
  const artifacts = writeCoverageArtifacts(
    RUNS_DIR,
    id,
    baseSnapshot,
    runs,
    startedAt,
    finishedAt,
    toolParity,
  );
  return { baseSnapshot, runs, artifacts, toolParity };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runCoverage(options);
  const aggregate = result.artifacts.summary.aggregate;
  console.log(`Coverage artifacts: ${result.artifacts.directory}`);
  console.log(
    `DeepSeek: completed=${aggregate.completed}/${aggregate.runs} score=${aggregate.score}/${aggregate.maximum} guards=${aggregate.guardFailures} wallMs=${aggregate.totalWallDurationMs} costUsd=${aggregate.usage.estimatedUsd ?? 'UNKNOWN'}`,
  );
  if (aggregate.completed !== aggregate.runs) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    console.error(redact(error?.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  caseLogger,
  coverageId,
  coverageMatrix,
  parseArguments,
  runCoverage,
  runPool,
  usage,
};
