'use strict';

const fs = require('fs');
const path = require('path');
const { buildWakeMessage, sha256 } = require('./snapshot.js');

function ensureInside(parent, target) {
  const root = `${path.resolve(parent)}${path.sep}`;
  const resolved = path.resolve(target);
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error(`artifact path escapes the benchmark runs directory: ${resolved}`);
  }
  return resolved;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function toolName(tool) {
  return tool?.function?.name || tool?.name || '';
}

function toolSurface(tools) {
  const names = (tools || []).map(toolName).filter(Boolean);
  return {
    count: names.length,
    names,
    sha256: sha256(JSON.stringify(names)),
  };
}

function costText(usage = {}) {
  if (!usage || typeof usage !== 'object') return 'UNKNOWN';
  if (usage.estimatedUsd != null) return `$${Number(usage.estimatedUsd).toFixed(6)}`;
  if (usage.minUsd != null && usage.maxUsd != null) {
    return `$${Number(usage.minUsd).toFixed(6)}–$${Number(usage.maxUsd).toFixed(6)}`;
  }
  return 'UNKNOWN';
}

function durationText(milliseconds) {
  if (!Number.isFinite(Number(milliseconds))) return 'UNKNOWN';
  return `${(Number(milliseconds) / 1000).toFixed(1)}s`;
}

function runtimeRecord(result) {
  return {
    finished: result?.runtime?.finished === true,
    finishSummary: result?.runtime?.finishSummary || null,
    alarm: result?.runtime?.alarm || null,
    actions: result?.runtime?.actions || [],
    journal: result?.runtime?.journal || null,
    journalEntry: result?.runtime?.journalEntry || null,
    master: result?.runtime?.master || null,
    refreshCount: result?.runtime?.refreshCount || 0,
  };
}

function writeProviderArtifacts(directory, provider, result, score, config) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJson(path.join(directory, 'transcript.json'), result?.transcript || []);
  writeJson(path.join(directory, 'usage.json'), {
    provider,
    model: config.model,
    effort: config.effort,
    maxTokens: config.maxTokens,
    calls: result?.usageCalls || [],
    total: result?.usageTotal || null,
    wallDurationMs: result?.wallDurationMs ?? null,
  });
  writeJson(path.join(directory, 'result.json'), {
    ok: result?.ok === true,
    reason: result?.reason || null,
    error: result?.error || null,
    rounds: result?.rounds || 0,
    runtime: runtimeRecord(result),
  });
  writeJson(path.join(directory, 'score.json'), score);
}

function leaderboardRows(models) {
  return Object.values(models).map(model => ({
    provider: model.provider,
    model: model.model,
    completed: model.result?.ok === true,
    score: model.score?.total ?? 0,
    maximum: model.score?.maximum ?? 100,
    rounds: model.result?.rounds || 0,
    wallDurationMs: model.result?.wallDurationMs ?? null,
    usage: model.result?.usageTotal || null,
    error: model.result?.error || null,
  }));
}

function leader(rows, selector, lowerWins = false) {
  const eligible = rows.filter(row => row.completed && Number.isFinite(selector(row)));
  if (!eligible.length) return null;
  return [...eligible].sort((left, right) => (
    lowerWins ? selector(left) - selector(right) : selector(right) - selector(left)
  ))[0].provider;
}

function buildComparison(snapshot, models, startedAt, finishedAt) {
  const rows = leaderboardRows(models);
  const exactCosts = rows.filter(row => row.usage?.estimatedUsd != null);
  return {
    schemaVersion: 1,
    benchmark: 'Sim Companies frozen-shadow wake',
    startedAt,
    finishedAt,
    wallDurationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    fairness: {
      snapshotSha256: sha256(JSON.stringify(snapshot)),
      systemPromptSha256: sha256(snapshot.systemPrompt),
      wakeMessageSha256: sha256(buildWakeMessage(snapshot)),
      snapshotCapturedAt: snapshot.capturedAt,
      snapshotCreatedAt: snapshot.snapshotCreatedAt,
      replayAtStateTime: snapshot.replayAtStateTime === true,
      scenario: snapshot.scenario || null,
      gameStateAsOf: snapshot.stateAsOf,
      sameSnapshot: true,
      samePrompt: true,
      sameHighReasoningEffort: true,
      sameMaxOutputTokens: true,
      sameSemanticToolNames: models.terra.toolSurface.sha256 === models.deepseek.toolSurface.sha256,
      productionModelChanged: false,
      liveBrowserOpened: false,
      liveGameMutations: 0,
      scorer: 'provider-neutral deterministic rubric v1',
    },
    rows,
    leaders: {
      observableCapabilityScore: leader(rows, row => row.score),
      latency: leader(rows, row => row.wallDurationMs, true),
      exactApiCost: exactCosts.length === rows.filter(row => row.completed).length
        ? leader(rows, row => row.usage.estimatedUsd, true)
        : null,
    },
    limitation: 'One paired frozen wake is a preliminary operational benchmark, not a statistically stable model ranking.',
  };
}

function reportTableRow(row) {
  return [
    row.provider,
    row.model,
    row.completed ? 'yes' : 'no',
    `${row.score}/${row.maximum}`,
    String(row.rounds),
    durationText(row.wallDurationMs),
    String(row.usage?.promptTokens ?? 'UNKNOWN'),
    String(row.usage?.outputTokens ?? 'UNKNOWN'),
    costText(row.usage),
  ].join(' | ');
}

function buildReport(comparison, models) {
  const lines = [
    '# Sim Companies model shadow benchmark',
    '',
    `- Started: ${comparison.startedAt}`,
    `- Finished: ${comparison.finishedAt}`,
    `- Frozen snapshot: \`${comparison.fairness.snapshotSha256}\``,
    `- Game state as of: ${comparison.fairness.gameStateAsOf || 'UNKNOWN'}`,
    '- Reasoning effort: high for both models',
    `- Scenario: ${comparison.fairness.scenario?.id || 'current frozen state'}`,
    '- Live browser opened: no',
    '- Live game mutations: 0',
    '- Production model changed: no',
    '',
    '## Observable results',
    '',
    'Provider | Model | Completed | Score | Rounds | Wall time | Input tokens | Output tokens | Estimated list price',
    '--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---:',
    ...comparison.rows.map(reportTableRow),
    '',
    '## Provider-neutral rubric',
    '',
  ];
  for (const row of comparison.rows) {
    const model = models[row.provider];
    lines.push(`### ${row.provider}: ${row.model}`, '');
    for (const category of model.score.categories) {
      lines.push(`- ${category.name}: ${category.earned}/${category.maximum}`);
    }
    if (row.error) lines.push(`- Error: ${row.error}`);
    lines.push('');
  }
  lines.push(
    '## Interpretation boundary',
    '',
    comparison.limitation,
    'The score covers observable tool selection, safety, owner-directive handling, structured CEO analysis, state fidelity, and action economy. It does not score hidden chain-of-thought and does not execute any proposed game mutation.',
    '',
  );
  return lines.join('\n');
}

function writeBenchmarkArtifacts(runsDirectory, runId, snapshot, models, startedAt, finishedAt) {
  const directory = ensureInside(runsDirectory, path.join(runsDirectory, runId));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJson(path.join(directory, 'snapshot.json'), snapshot);
  for (const model of Object.values(models)) {
    writeProviderArtifacts(
      path.join(directory, model.provider),
      model.provider,
      model.result,
      model.score,
      model,
    );
  }
  const comparison = buildComparison(snapshot, models, startedAt, finishedAt);
  writeJson(path.join(directory, 'comparison.json'), comparison);
  fs.writeFileSync(
    path.join(directory, 'report.md'),
    buildReport(comparison, models),
    { mode: 0o600 },
  );
  return { directory, comparison };
}

module.exports = {
  buildComparison,
  buildReport,
  costText,
  durationText,
  ensureInside,
  leaderboardRows,
  runtimeRecord,
  toolName,
  toolSurface,
  writeBenchmarkArtifacts,
  writeJson,
  writeProviderArtifacts,
};
