#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DeepSeekClient, DEFAULT_MODEL, redactSecrets } = require('./lib/client.js');
const { costText } = require('./lib/artifacts.js');
const { runShadowWake } = require('./lib/runner.js');
const { createSnapshot, sha256 } = require('./lib/snapshot.js');
const { buildDeepSeekTools } = require('./lib/tool-runtime.js');

const EXPERIMENT_DIR = __dirname;
const SIM_DIR = path.resolve(EXPERIMENT_DIR, '..', '..');
const RUNS_DIR = path.join(EXPERIMENT_DIR, 'runs');

function parseArguments(argv) {
  const options = {
    mode: 'check',
    effort: 'high',
    maxRounds: 30,
    maxTokens: 32768,
    model: DEFAULT_MODEL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check') options.mode = 'check';
    else if (value === '--live') options.mode = 'live';
    else if (value === '--effort') options.effort = argv[++index];
    else if (value === '--max-rounds') options.maxRounds = Number(argv[++index]);
    else if (value === '--max-tokens') options.maxTokens = Number(argv[++index]);
    else if (value === '--model') options.model = argv[++index];
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!['high', 'max'].includes(options.effort)) throw new Error('--effort must be high or max');
  if (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 60) {
    throw new Error('--max-rounds must be an integer from 1 to 60');
  }
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1024 || options.maxTokens > 384000) {
    throw new Error('--max-tokens must be an integer from 1024 to 384000');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node shadow-wake.js --check',
    '  DEEPSEEK_API_KEY=... node shadow-wake.js --live [--effort high|max]',
    '',
    '--check validates the current snapshot and tool surface without network access.',
    '--live calls DeepSeek but never opens Chrome or imports any game executor.',
  ].join('\n');
}

function runId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.]/gu, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function ensureInside(parent, target) {
  const root = `${path.resolve(parent)}${path.sep}`;
  const resolved = path.resolve(target);
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error(`artifact path escapes the shadow runs directory: ${resolved}`);
  }
  return resolved;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeArtifacts(runDir, snapshot, result, options) {
  const target = ensureInside(RUNS_DIR, runDir);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  writeJson(path.join(target, 'snapshot.json'), snapshot);
  writeJson(path.join(target, 'transcript.json'), result.transcript);
  writeJson(path.join(target, 'usage.json'), {
    model: options.model,
    effort: options.effort,
    calls: result.usageCalls,
    total: result.usageTotal,
  });
  writeJson(path.join(target, 'result.json'), {
    ok: result.ok,
    reason: result.reason || null,
    rounds: result.rounds,
    finishSummary: result.runtime.finishSummary,
    alarm: result.runtime.alarm,
    actions: result.runtime.actions,
    journal: result.runtime.journal,
    master: result.runtime.master,
    snapshotSha256: sha256(JSON.stringify(snapshot)),
  });
  const actionLines = result.runtime.actions.length
    ? result.runtime.actions.map(action => (
      `- ${action.sequence}. \`${action.action}\` — ${action.preview ? 'preview' : 'would click'} — \`${JSON.stringify(action.params)}\``
    ))
    : ['- No action tool was proposed.'];
  const summary = [
    '# DeepSeek V4 Pro shadow wake',
    '',
    `- Result: ${result.ok ? 'completed' : 'incomplete'}`,
    `- Model: ${options.model}`,
    `- Thinking effort: ${options.effort}`,
    `- Rounds: ${result.rounds}`,
    `- Snapshot captured: ${snapshot.capturedAt}`,
    `- Game state as of: ${snapshot.stateAsOf || 'UNKNOWN'}`,
    `- Snapshot staleness: ${snapshot.stalenessSeconds ?? 'UNKNOWN'} seconds`,
    `- Live browser/game mutations: 0`,
    `- Estimated API cost: ${costText(result.usageTotal)}`,
    '',
    '## Proposed UI actions',
    '',
    ...actionLines,
    '',
    '## Final summary',
    '',
    result.runtime.finishSummary || result.reason || 'No successful finish.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(target, 'summary.md'), summary, { mode: 0o600 });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const snapshot = createSnapshot(SIM_DIR);
  const tools = buildDeepSeekTools(process.env);
  if (options.mode === 'check') {
    console.log(JSON.stringify({
      ok: true,
      mode: 'check',
      modelUnchanged: true,
      browserOpened: false,
      networkCalled: false,
      stateAsOf: snapshot.stateAsOf,
      snapshotStalenessSeconds: snapshot.stalenessSeconds,
      actionToolCount: tools.length,
      sourceManifest: snapshot.sourceManifest,
    }, null, 2));
    return;
  }

  const client = new DeepSeekClient({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: options.model,
    effort: options.effort,
    maxTokens: options.maxTokens,
  });
  const directory = path.join(RUNS_DIR, runId());
  console.log(`Shadow wake started. Artifacts: ${directory}`);
  const result = await runShadowWake({
    snapshot,
    environment: process.env,
    maxRounds: options.maxRounds,
    complete: (messages, currentTools) => client.complete(messages, currentTools),
    onEvent(event) {
      if (event.type === 'assistant') {
        console.log(`round ${event.round}: tools=${event.toolNames.join(',') || 'none'} reasoningChars=${event.reasoningCharacters}`);
      } else {
        console.log(`round ${event.round}: ${event.name} -> ${event.ok ? 'simulated-ok' : 'guard/unknown'}`);
      }
    },
  });
  writeArtifacts(directory, snapshot, result, options);
  console.log(`Shadow wake ${result.ok ? 'completed' : 'incomplete'} in ${result.rounds} rounds.`);
  console.log(`Estimated API cost: ${costText(result.usageTotal)}`);
  console.log(`Live browser/game mutations: 0`);
  if (!result.ok) process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    console.error(redactSecrets(error.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  ensureInside,
  parseArguments,
  runId,
  usage,
  writeArtifacts,
};
