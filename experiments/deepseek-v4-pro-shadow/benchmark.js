#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DeepSeekClient,
  DEFAULT_MODEL: DEFAULT_DEEPSEEK_MODEL,
  redactSecrets: redactDeepSeekSecrets,
} = require('./lib/client.js');
const {
  DEFAULT_MODEL: DEFAULT_OPENAI_MODEL,
  OpenAIResponsesClient,
  redactSecrets: redactOpenAISecrets,
} = require('./lib/openai-client.js');
const { writeBenchmarkArtifacts, toolSurface } = require('./lib/artifacts.js');
const { runOpenAIShadowWake, runShadowWake } = require('./lib/runner.js');
const { scoreShadowResult } = require('./lib/scoring.js');
const { applyScenario, SCENARIO_BUILDERS } = require('./lib/scenarios.js');
const { createSnapshot, sha256 } = require('./lib/snapshot.js');
const { buildDeepSeekTools, buildOpenAIResponsesTools } = require('./lib/tool-runtime.js');

const EXPERIMENT_DIR = __dirname;
const SIM_DIR = path.resolve(EXPERIMENT_DIR, '..', '..');
const RUNS_DIR = path.join(EXPERIMENT_DIR, 'runs');
const OPENAI_ENV_FILE = '/srv/appdata/ledgerwall/.env';

function parseArguments(argv) {
  const options = {
    mode: 'check',
    effort: 'high',
    maxRounds: 30,
    maxTokens: 32768,
    openaiModel: DEFAULT_OPENAI_MODEL,
    deepseekModel: DEFAULT_DEEPSEEK_MODEL,
    scenario: 'prospector-ready',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check') options.mode = 'check';
    else if (value === '--run') options.mode = 'run';
    else if (value === '--max-rounds') options.maxRounds = Number(argv[++index]);
    else if (value === '--max-tokens') options.maxTokens = Number(argv[++index]);
    else if (value === '--openai-model') options.openaiModel = argv[++index];
    else if (value === '--deepseek-model') options.deepseekModel = argv[++index];
    else if (value === '--scenario') options.scenario = argv[++index];
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 60) {
    throw new Error('--max-rounds must be an integer from 1 to 60');
  }
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1024 || options.maxTokens > 32768) {
    throw new Error('--max-tokens must be an integer from 1024 to 32768');
  }
  if (!['current', ...Object.keys(SCENARIO_BUILDERS)].includes(options.scenario)) {
    throw new Error(`--scenario must be one of current, ${Object.keys(SCENARIO_BUILDERS).join(', ')}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node benchmark.js --check',
    `  node benchmark.js --run [--scenario current|${Object.keys(SCENARIO_BUILDERS).join('|')}] [--max-rounds 30] [--max-tokens 32768]`,
    '',
    '--check performs an offline parity and isolation check.',
    '--run compares gpt-5.6-terra high and deepseek-v4-pro high concurrently.',
    'Both models receive one immutable snapshot and the same semantic tool names.',
  ].join('\n');
}

function readEnvValue(file, name) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
  const prefix = `${name}=`;
  const line = source.split(/\r?\n/u).find(candidate => candidate.startsWith(prefix));
  if (!line) return '';
  const raw = line.slice(prefix.length).trim();
  if ((raw.startsWith('"') && raw.endsWith('"'))
      || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function runId(now = new Date()) {
  return `benchmark-${now.toISOString().replace(/[-:.]/gu, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function redact(value) {
  return redactOpenAISecrets(redactDeepSeekSecrets(value));
}

function emptyRuntime() {
  return {
    actions: [],
    alarm: null,
    journal: null,
    journalEntry: null,
    master: null,
    finished: false,
    finishSummary: null,
    refreshCount: 0,
  };
}

async function timedRun(work) {
  const started = Date.now();
  try {
    const result = await work();
    return { ...result, wallDurationMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      rounds: 0,
      reason: 'provider request failed',
      error: redact(error?.message || error),
      transcript: [],
      usageCalls: [],
      usageTotal: null,
      runtime: emptyRuntime(),
      wallDurationMs: Date.now() - started,
    };
  }
}

function eventLogger(provider) {
  return event => {
    if (event.type === 'assistant') {
      console.log(
        `[${provider}] round ${event.round}: tools=${event.toolNames.join(',') || 'none'} reasoningChars=${event.reasoningCharacters}`,
      );
    } else {
      console.log(`[${provider}] round ${event.round}: ${event.name} -> ${event.ok ? 'shadow-ok' : 'guard/unknown'}`);
    }
  };
}

function parity(snapshot, environment = process.env) {
  const deepseek = toolSurface(buildDeepSeekTools(environment));
  const terra = toolSurface(buildOpenAIResponsesTools(environment));
  return {
    ok: deepseek.sha256 === terra.sha256,
    snapshotSha256: sha256(JSON.stringify(snapshot)),
    snapshotMode: snapshot.mode,
    stateAsOf: snapshot.stateAsOf,
    stalenessSeconds: snapshot.stalenessSeconds,
    deepseek,
    terra,
    sameSemanticToolNames: deepseek.sha256 === terra.sha256,
    networkCalled: false,
    browserOpened: false,
    gameMutations: 0,
    productionModelChanged: false,
  };
}

async function runBenchmark(options, overrides = {}) {
  const baseSnapshot = overrides.baseSnapshot
    || createSnapshot(SIM_DIR, new Date(), { replayAtStateTime: true });
  const snapshot = applyScenario(baseSnapshot, options.scenario);
  const environment = { ...process.env };
  const toolParity = parity(snapshot, environment);
  if (!toolParity.ok) throw new Error('provider tool-name surfaces are not identical');
  const openaiApiKey = environment.OPENAI_API_KEY
    || readEnvValue(OPENAI_ENV_FILE, 'OPENAI_API_KEY');
  if (!openaiApiKey) throw new Error(`OPENAI_API_KEY is unavailable at ${OPENAI_ENV_FILE}`);
  if (!environment.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required through the process environment');
  }

  const openaiClient = new OpenAIResponsesClient({
    apiKey: openaiApiKey,
    model: options.openaiModel,
    effort: options.effort,
    verbosity: 'low',
    maxTokens: options.maxTokens,
  });
  const deepseekClient = new DeepSeekClient({
    apiKey: environment.DEEPSEEK_API_KEY,
    baseUrl: environment.DEEPSEEK_BASE_URL,
    model: options.deepseekModel,
    effort: options.effort,
    maxTokens: options.maxTokens,
  });
  const startedAt = new Date().toISOString();
  console.log(`Benchmark started from frozen snapshot ${toolParity.snapshotSha256}.`);
  const [terraResult, deepseekResult] = await Promise.all([
    timedRun(() => runOpenAIShadowWake({
      snapshot,
      client: openaiClient,
      environment,
      maxRounds: options.maxRounds,
      onEvent: eventLogger('terra'),
    })),
    timedRun(() => runShadowWake({
      snapshot,
      environment,
      maxRounds: options.maxRounds,
      complete: (messages, tools) => deepseekClient.complete(messages, tools),
      onEvent: eventLogger('deepseek'),
    })),
  ]);
  const finishedAt = new Date().toISOString();
  const models = {
    terra: {
      provider: 'terra',
      model: options.openaiModel,
      effort: options.effort,
      maxTokens: options.maxTokens,
      toolSurface: toolParity.terra,
      result: terraResult,
      score: scoreShadowResult(snapshot, terraResult),
    },
    deepseek: {
      provider: 'deepseek',
      model: options.deepseekModel,
      effort: options.effort,
      maxTokens: options.maxTokens,
      toolSurface: toolParity.deepseek,
      result: deepseekResult,
      score: scoreShadowResult(snapshot, deepseekResult),
    },
  };
  const artifacts = writeBenchmarkArtifacts(
    overrides.runsDirectory || RUNS_DIR,
    overrides.runId || runId(new Date(startedAt)),
    snapshot,
    models,
    startedAt,
    finishedAt,
  );
  return { snapshot, models, artifacts };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.mode === 'check') {
    const baseSnapshot = createSnapshot(SIM_DIR, new Date(), { replayAtStateTime: true });
    const snapshot = applyScenario(baseSnapshot, options.scenario);
    const result = parity(snapshot);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  const benchmark = await runBenchmark(options);
  console.log(`Artifacts: ${benchmark.artifacts.directory}`);
  for (const row of benchmark.artifacts.comparison.rows) {
    const cost = row.usage?.estimatedUsd == null
      ? `${row.usage?.minUsd ?? 'UNKNOWN'}..${row.usage?.maxUsd ?? 'UNKNOWN'}`
      : row.usage.estimatedUsd;
    console.log(
      `${row.provider}: completed=${row.completed} score=${row.score}/${row.maximum} rounds=${row.rounds} wallMs=${row.wallDurationMs} costUsd=${cost}`,
    );
    if (row.error) console.log(`${row.provider}: ${row.error}`);
  }
  if (benchmark.artifacts.comparison.rows.some(row => !row.completed)) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    console.error(redact(error?.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  OPENAI_ENV_FILE,
  RUNS_DIR,
  SIM_DIR,
  emptyRuntime,
  eventLogger,
  parity,
  parseArguments,
  readEnvValue,
  redact,
  runBenchmark,
  runId,
  timedRun,
  usage,
};
