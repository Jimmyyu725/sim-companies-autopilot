#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  RUNS_DIR,
  emptyRuntime,
  parity,
  redact,
  timedRun,
} = require('./benchmark.js');
const {
  ensureInside,
  writeJson,
  writeProviderArtifacts,
} = require('./lib/artifacts.js');
const { writeCoverageArtifacts } = require('./lib/coverage-artifacts.js');
const {
  DEFAULT_MODEL,
  OpenAIResponsesClient,
} = require('./lib/openai-client.js');
const { runOpenAIShadowWake } = require('./lib/runner.js');
const { scoreShadowResult } = require('./lib/scoring.js');
const { sha256 } = require('./lib/snapshot.js');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function coverageId(now = new Date()) {
  return `terra-coverage-${now.toISOString().replace(/[-:.]/gu, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function resolveReference(input) {
  const resolved = path.resolve(input);
  const root = `${path.resolve(RUNS_DIR)}${path.sep}`;
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error('reference coverage must remain inside the ignored runs directory');
  }
  return resolved;
}

function parseArguments(argv) {
  const options = {
    concurrency: 3,
    effort: 'high',
    maxRounds: 30,
    maxTokens: 32768,
    model: DEFAULT_MODEL,
    referenceCoverage: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--reference-coverage') options.referenceCoverage = String(argv[++index] || '');
    else if (value === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (value === '--max-rounds') options.maxRounds = Number(argv[++index]);
    else if (value === '--max-tokens') options.maxTokens = Number(argv[++index]);
    else if (value === '--model') options.model = String(argv[++index]);
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.help && !options.referenceCoverage) {
    throw new Error('--reference-coverage is required');
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
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node terra-coverage.js --reference-coverage runs/coverage-*',
    '                         [--concurrency 3] [--max-rounds 30]',
    '                         [--max-tokens 32768]',
    '',
    'Runs Terra High against the exact thirty persisted snapshots from a validated',
    'DeepSeek coverage run. It never opens Chrome or mutates the live game.',
  ].join('\n');
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

function loadReference(input) {
  const directory = resolveReference(input);
  const validation = readJson(path.join(directory, 'validation.json'));
  const plan = readJson(path.join(directory, 'coverage-plan.json'));
  const summary = readJson(path.join(directory, 'coverage-summary.json'));
  const baseSnapshot = readJson(path.join(directory, 'base-snapshot.json'));
  if (validation.status !== 'passed') {
    throw new Error('reference coverage has not passed independent validation');
  }
  if (summary.provider && summary.provider !== 'deepseek') {
    throw new Error('reference coverage provider must be DeepSeek');
  }
  if (plan.cases?.length !== 30 || summary.rows?.length !== 30) {
    throw new Error('reference coverage must contain exactly thirty cases');
  }
  const baseHash = sha256(JSON.stringify(baseSnapshot));
  if (baseHash !== summary.baseSnapshotSha256) {
    throw new Error('reference base snapshot hash does not match its summary');
  }
  const cases = plan.cases.map(row => {
    const snapshotFile = path.join(directory, 'cases', row.caseId, 'snapshot.json');
    const snapshot = readJson(snapshotFile);
    const snapshotSha256 = sha256(JSON.stringify(snapshot));
    const summaryRow = summary.rows.find(candidate => candidate.caseId === row.caseId);
    if (!summaryRow
        || summaryRow.runIndex !== row.runIndex
        || summaryRow.scenarioKey !== row.scenarioKey
        || summaryRow.variant !== row.variant) {
      throw new Error(`reference case identity mismatch: ${row.caseId}`);
    }
    if (snapshot.baseSnapshotSha256 !== baseHash
        || snapshot.scenario?.coverageScenarioKey !== row.scenarioKey
        || snapshot.scenario?.coverageVariant !== row.variant) {
      throw new Error(`reference case snapshot binding mismatch: ${row.caseId}`);
    }
    return { ...row, snapshot, snapshotSha256 };
  });
  return {
    directory,
    validation,
    plan,
    summary,
    baseSnapshot,
    baseHash,
    cases,
    manifestHash: sha256(JSON.stringify({
      baseHash,
      cases: cases.map(row => ({
        caseId: row.caseId,
        snapshotSha256: row.snapshotSha256,
      })),
    })),
  };
}

async function runTerraCoverage(options) {
  const environment = {
    ...process.env,
    SIM_CHAT_MODE: 'shadow',
  };
  if (!environment.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required through the process environment');
  }
  const reference = loadReference(options.referenceCoverage);
  if (options.effort !== reference.plan.effort
      || options.maxRounds !== reference.plan.maxRounds
      || options.maxTokens !== reference.plan.maxTokens) {
    throw new Error('Terra effort, round limit, and output-token limit must match the reference');
  }
  const toolParity = parity(reference.cases[0].snapshot, environment);
  if (!toolParity.ok) throw new Error('DeepSeek and Terra semantic tool surfaces differ');
  if (toolParity.deepseek.sha256 !== reference.summary.fairness.toolSurfaceSha256) {
    throw new Error('current semantic tool surface differs from the frozen reference');
  }
  const client = new OpenAIResponsesClient({
    apiKey: environment.OPENAI_API_KEY,
    model: options.model,
    effort: options.effort,
    verbosity: 'low',
    maxTokens: options.maxTokens,
  });
  const startedAt = new Date().toISOString();
  const id = coverageId(new Date(startedAt));
  const directory = ensureInside(RUNS_DIR, path.join(RUNS_DIR, id));
  const casesDirectory = path.join(directory, 'cases');
  fs.mkdirSync(casesDirectory, { recursive: true, mode: 0o700 });
  writeJson(path.join(directory, 'coverage-plan.json'), {
    schemaVersion: 2,
    provider: 'terra',
    startedAt,
    model: options.model,
    effort: options.effort,
    maxRounds: options.maxRounds,
    maxTokens: options.maxTokens,
    concurrency: options.concurrency,
    referenceCoverageId: path.basename(reference.directory),
    referenceCoverageManifestSha256: reference.manifestHash,
    baseSnapshotSha256: reference.baseHash,
    cases: reference.cases.map(({ snapshot, ...row }) => row),
    isolation: {
      liveBrowserOpened: false,
      liveGameMutations: 0,
      productionModelChanged: false,
    },
  });
  console.log(
    `Coverage ${id}: ${reference.cases.length} Terra wakes from exact reference snapshots, concurrency ${options.concurrency}.`,
  );
  const runs = await runPool(reference.cases, options.concurrency, async row => {
    const currentHash = sha256(JSON.stringify(row.snapshot));
    if (currentHash !== row.snapshotSha256) {
      throw new Error(`reference snapshot changed before execution: ${row.caseId}`);
    }
    console.log(
      `[${String(row.runIndex).padStart(2, '0')}] START ${row.scenarioKey}/v${row.variant} snapshot=${row.snapshotSha256.slice(0, 12)}`,
    );
    const result = await timedRun(() => runOpenAIShadowWake({
      snapshot: row.snapshot,
      client,
      environment,
      maxRounds: options.maxRounds,
      onEvent: caseLogger(row),
    }));
    if (!result.runtime) result.runtime = emptyRuntime();
    const score = scoreShadowResult(row.snapshot, result);
    const caseDirectory = ensureInside(casesDirectory, path.join(casesDirectory, row.caseId));
    fs.mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
    writeJson(path.join(caseDirectory, 'snapshot.json'), row.snapshot);
    writeJson(path.join(caseDirectory, 'case.json'), {
      runIndex: row.runIndex,
      scenarioKey: row.scenarioKey,
      variant: row.variant,
      caseId: row.caseId,
      snapshotSha256: row.snapshotSha256,
      referenceCoverageId: path.basename(reference.directory),
    });
    writeProviderArtifacts(
      path.join(caseDirectory, 'terra'),
      'terra',
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
      runIndex: row.runIndex,
      scenarioKey: row.scenarioKey,
      variant: row.variant,
      caseId: row.caseId,
      provider: 'terra',
      snapshot: row.snapshot,
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
    reference.baseSnapshot,
    runs,
    startedAt,
    finishedAt,
    toolParity,
    {
      provider: 'terra',
      referenceCoverageId: path.basename(reference.directory),
      referenceCoverageSha256: reference.manifestHash,
      exactReferenceCaseSnapshots: true,
    },
  );
  return { reference, runs, artifacts, toolParity };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runTerraCoverage(options);
  const aggregate = result.artifacts.summary.aggregate;
  console.log(`Coverage artifacts: ${result.artifacts.directory}`);
  console.log(
    `Terra: completed=${aggregate.completed}/${aggregate.runs} score=${aggregate.score}/${aggregate.maximum} guards=${aggregate.guardFailures} wallMs=${aggregate.totalWallDurationMs} costUsd=${aggregate.usage.estimatedUsd ?? 'UNKNOWN'}`,
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
  loadReference,
  parseArguments,
  resolveReference,
  runPool,
  runTerraCoverage,
  usage,
};
