#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildComparison,
  buildReport,
  ensureInside,
  toolSurface,
  writeJson,
} = require('./lib/artifacts.js');
const { scoreShadowResult } = require('./lib/scoring.js');
const { buildDeepSeekTools, buildOpenAIResponsesTools } = require('./lib/tool-runtime.js');

const RUNS_DIR = path.join(__dirname, 'runs');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function lastRefreshedState(transcript, fallback) {
  const row = [...transcript].reverse().find(item => (
    item?.type === 'tool'
      && item.name === 'refresh_state'
      && typeof item.result?.t === 'string'
  ));
  if (!row) return fallback;
  const state = JSON.parse(JSON.stringify(row.result));
  delete state._shadow;
  return state;
}

function loadProvider(directory, provider, snapshot) {
  const providerDirectory = path.join(directory, provider);
  const stored = readJson(path.join(providerDirectory, 'result.json'));
  const usage = readJson(path.join(providerDirectory, 'usage.json'));
  const transcript = readJson(path.join(providerDirectory, 'transcript.json'));
  const runtime = {
    ...(stored.runtime || {}),
    currentState: lastRefreshedState(transcript, snapshot.state),
  };
  const result = {
    ok: stored.ok === true,
    reason: stored.reason || null,
    error: stored.error || null,
    rounds: stored.rounds || 0,
    transcript,
    usageCalls: usage.calls || [],
    usageTotal: usage.total || null,
    wallDurationMs: usage.wallDurationMs ?? null,
    runtime,
  };
  const tools = provider === 'terra'
    ? buildOpenAIResponsesTools(process.env)
    : buildDeepSeekTools(process.env);
  const model = {
    provider,
    model: usage.model,
    effort: usage.effort,
    maxTokens: usage.maxTokens,
    toolSurface: toolSurface(tools),
    result,
  };
  model.score = scoreShadowResult(snapshot, result);
  return model;
}

function rescore(directory) {
  const target = ensureInside(RUNS_DIR, directory);
  const snapshot = readJson(path.join(target, 'snapshot.json'));
  const prior = readJson(path.join(target, 'comparison.json'));
  const models = {
    terra: loadProvider(target, 'terra', snapshot),
    deepseek: loadProvider(target, 'deepseek', snapshot),
  };
  for (const model of Object.values(models)) {
    writeJson(path.join(target, model.provider, 'score.json'), model.score);
  }
  const comparison = buildComparison(
    snapshot,
    models,
    prior.startedAt,
    prior.finishedAt,
  );
  writeJson(path.join(target, 'comparison.json'), comparison);
  fs.writeFileSync(path.join(target, 'report.md'), buildReport(comparison, models), { mode: 0o600 });
  return { target, comparison };
}

function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: node rescore-run.js <runs/benchmark-directory>');
  const result = rescore(path.resolve(directory));
  console.log(`Rescored: ${result.target}`);
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
  lastRefreshedState,
  loadProvider,
  rescore,
};
