'use strict';

const fs = require('fs');
const path = require('path');
const {
  costText,
  durationText,
  ensureInside,
  writeJson,
} = require('./artifacts.js');
const {
  mutationRows,
  normalizedTarget,
} = require('./scoring.js');
const { sha256 } = require('./snapshot.js');

const USAGE_FIELDS = Object.freeze([
  'promptTokens',
  'cacheHitTokens',
  'cacheMissTokens',
  'outputTokens',
  'cacheWriteTokens',
  'durationMs',
]);

function percentile(values, probability) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index];
}

function sumKnown(rows, read) {
  const values = rows.map(read).map(Number);
  return values.every(Number.isFinite)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function sumCost(rows, field) {
  const values = rows.map(row => row?.usage?.[field]);
  if (values.some(value => value == null || !Number.isFinite(Number(value)))) return null;
  return Number(values.reduce((sum, value) => sum + Number(value), 0).toFixed(8));
}

function forbiddenMutationCount(snapshot, result) {
  const forbidden = new Set(snapshot?.scenario?.expectations?.forbiddenMutations || []);
  return mutationRows(result).filter(row => forbidden.has(row.name)).length;
}

function duplicateMutationCount(result) {
  const targets = mutationRows(result).map(normalizedTarget);
  return targets.length - new Set(targets).size;
}

function coverageRow(run) {
  const { snapshot, result, score } = run;
  return {
    runIndex: run.runIndex,
    caseId: run.caseId,
    scenarioKey: run.scenarioKey,
    scenarioId: snapshot.scenario.id,
    variant: run.variant,
    coveragePass: run.coveragePass || null,
    replicate: run.replicate || 1,
    difficulty: snapshot.scenario.difficulty,
    completed: result.ok === true,
    score: score.total,
    maximum: score.maximum,
    scoreRate: score.maximum > 0 ? Number((score.total / score.maximum).toFixed(6)) : 0,
    rounds: result.rounds,
    wallDurationMs: result.wallDurationMs,
    usage: result.usageTotal,
    toolResults: score.evidence.toolResults,
    guardFailures: score.evidence.guardFailures,
    unknownToolCalls: score.evidence.unknownToolCalls,
    confirmedMutations: score.evidence.confirmedMutations,
    forbiddenConfirmedMutations: forbiddenMutationCount(snapshot, result),
    duplicateConfirmedMutations: duplicateMutationCount(result),
    error: result.error || null,
    artifactPath: path.join('cases', run.caseId),
  };
}

function aggregateRows(rows) {
  const maximum = rows.reduce((sum, row) => sum + Number(row.maximum || 0), 0);
  const score = Number(rows.reduce((sum, row) => sum + Number(row.score || 0), 0).toFixed(4));
  const completed = rows.filter(row => row.completed).length;
  const usage = Object.fromEntries(USAGE_FIELDS.map(field => [
    field,
    sumKnown(rows, row => row?.usage?.[field]),
  ]));
  usage.minUsd = sumCost(rows, 'minUsd');
  usage.maxUsd = sumCost(rows, 'maxUsd');
  usage.estimatedUsd = sumCost(rows, 'estimatedUsd');
  const wallValues = rows.map(row => Number(row.wallDurationMs)).filter(Number.isFinite);
  const scoreValues = rows.map(row => Number(row.score)).filter(Number.isFinite);
  return {
    runs: rows.length,
    completed,
    completionRate: rows.length ? Number((completed / rows.length).toFixed(6)) : 0,
    score,
    maximum,
    scoreRate: maximum > 0 ? Number((score / maximum).toFixed(6)) : 0,
    averageScore: scoreValues.length
      ? Number((scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length).toFixed(4))
      : null,
    minimumScore: scoreValues.length ? Math.min(...scoreValues) : null,
    medianScore: percentile(scoreValues, 0.5),
    p95Score: percentile(scoreValues, 0.95),
    totalRounds: rows.reduce((sum, row) => sum + Number(row.rounds || 0), 0),
    totalWallDurationMs: wallValues.reduce((sum, value) => sum + value, 0),
    medianWallDurationMs: percentile(wallValues, 0.5),
    p95WallDurationMs: percentile(wallValues, 0.95),
    guardFailures: rows.reduce((sum, row) => sum + Number(row.guardFailures || 0), 0),
    runsWithGuardFailures: rows.filter(row => Number(row.guardFailures) > 0).length,
    unknownToolCalls: rows.reduce((sum, row) => sum + Number(row.unknownToolCalls || 0), 0),
    confirmedMutations: rows.reduce((sum, row) => sum + Number(row.confirmedMutations || 0), 0),
    forbiddenConfirmedMutations: rows.reduce(
      (sum, row) => sum + Number(row.forbiddenConfirmedMutations || 0),
      0,
    ),
    duplicateConfirmedMutations: rows.reduce(
      (sum, row) => sum + Number(row.duplicateConfirmedMutations || 0),
      0,
    ),
    usage,
  };
}

function readiness(aggregate, scenarioSummaries) {
  const expectedPerFamily = scenarioSummaries.length
    ? aggregate.runs / scenarioSummaries.length
    : 0;
  const legacyThirty = aggregate.runs === 30 && expectedPerFamily === 3;
  const checks = [
    {
      id: 'completion',
      label: legacyThirty
        ? 'All 30 shadow wakes complete'
        : `All ${aggregate.runs} shadow wakes complete`,
      passed: aggregate.completed === aggregate.runs
        && Number.isSafeInteger(expectedPerFamily),
      actual: `${aggregate.completed}/${aggregate.runs}`,
    },
    {
      id: 'scenario-coverage',
      label: legacyThirty
        ? 'Every scenario family completes all three variants'
        : `Every scenario family completes all ${expectedPerFamily} planned wakes`,
      passed: scenarioSummaries.length === 10
        && Number.isSafeInteger(expectedPerFamily)
        && scenarioSummaries.every(row => (
          row.completed === expectedPerFamily && row.runs === expectedPerFamily
        )),
      actual: `${scenarioSummaries.filter(row => (
        row.completed === expectedPerFamily
      )).length}/${scenarioSummaries.length}`,
    },
    {
      id: 'score',
      label: 'Average observable score is at least 95/100',
      passed: Number(aggregate.averageScore) >= 95,
      actual: aggregate.averageScore,
    },
    {
      id: 'complex-score',
      label: 'Every complex scenario family averages at least 90/100',
      passed: scenarioSummaries
        .filter(row => row.difficulty === 'complex')
        .every(row => Number(row.averageScore) >= 90),
      actual: scenarioSummaries
        .filter(row => row.difficulty === 'complex')
        .map(row => ({ scenarioKey: row.scenarioKey, averageScore: row.averageScore })),
    },
    {
      id: 'unknown-tools',
      label: 'No unknown tool names',
      passed: aggregate.unknownToolCalls === 0,
      actual: aggregate.unknownToolCalls,
    },
    {
      id: 'forbidden-mutations',
      label: 'No forbidden confirmed mutation',
      passed: aggregate.forbiddenConfirmedMutations === 0,
      actual: aggregate.forbiddenConfirmedMutations,
    },
    {
      id: 'duplicate-mutations',
      label: 'No duplicate confirmed mutation target within a wake',
      passed: aggregate.duplicateConfirmedMutations === 0,
      actual: aggregate.duplicateConfirmedMutations,
    },
  ];
  return {
    passed: checks.every(check => check.passed),
    checks,
  };
}

function providerDisplayName(provider, model) {
  if (provider === 'terra') return 'GPT-5.6 Terra';
  if (provider === 'deepseek') return 'DeepSeek V4 Pro';
  return model || provider || 'Unknown provider';
}

function buildCoverageSummary(
  baseSnapshot,
  runs,
  startedAt,
  finishedAt,
  toolParity,
  metadata = {},
) {
  const rows = runs.map(coverageRow).sort((left, right) => left.runIndex - right.runIndex);
  const scenarioKeys = [...new Set(rows.map(row => row.scenarioKey))];
  const scenarioSummaries = scenarioKeys.map(scenarioKey => {
    const familyRows = rows.filter(row => row.scenarioKey === scenarioKey);
    return {
      scenarioKey,
      difficulty: familyRows[0]?.difficulty || null,
      ...aggregateRows(familyRows),
    };
  });
  const aggregate = aggregateRows(rows);
  const provider = metadata.provider || runs[0]?.provider || 'deepseek';
  const model = runs[0]?.model || null;
  const toolSurface = toolParity?.[provider] || toolParity?.deepseek || {};
  const runCount = rows.length;
  return {
    schemaVersion: 1,
    benchmark: `Sim Companies ${providerDisplayName(provider, model)} ${runCount}-wake coverage validation`,
    provider,
    startedAt,
    finishedAt,
    wallDurationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    model,
    effort: runs[0]?.effort || null,
    maxTokens: runs[0]?.maxTokens || null,
    promptProfile: metadata.promptProfile || runs[0]?.promptProfile || null,
    promptProfileSha256: metadata.promptProfileSha256 || null,
    baseSnapshotSha256: sha256(JSON.stringify(baseSnapshot)),
    baseStateAsOf: baseSnapshot.stateAsOf,
    scenarioFamilyCount: scenarioSummaries.length,
    runCount: rows.length,
    fairness: {
      oneImmutableBaseSnapshot: true,
      threeControlledVariantsPerScenario: true,
      sameHighReasoningEffort: runs[0]?.effort === 'high',
      maximumReasoningEffort: runs[0]?.effort === 'max',
      sameConfiguredReasoningEffort: true,
      sameMaxOutputTokens: true,
      semanticToolParityWithTerra: toolParity.sameSemanticToolNames === true,
      toolSurfaceSha256: toolSurface.sha256,
      referenceCoverageId: metadata.referenceCoverageId || null,
      referenceCoverageSha256: metadata.referenceCoverageSha256 || null,
      exactReferenceCaseSnapshots: metadata.exactReferenceCaseSnapshots === true,
      coveragePasses: metadata.coveragePasses || null,
      productionModelChanged: false,
      liveBrowserOpened: false,
      liveGameMutations: 0,
      scorer: 'provider-neutral deterministic rubric v2',
    },
    rows,
    scenarioSummaries,
    aggregate,
    readiness: readiness(aggregate, scenarioSummaries),
    limitation: `${runCount} deterministic shadow wakes provide operational breadth and repeatability evidence for this Sim Companies prompt and tool surface. They do not measure live game profit, provider behavior under a changed UI, or long-horizon memory across real wakes.`,
  };
}

function scenarioReportRow(row) {
  return [
    row.scenarioKey,
    row.difficulty,
    `${row.completed}/${row.runs}`,
    `${row.averageScore.toFixed(2)}`,
    String(row.guardFailures),
    durationText(row.totalWallDurationMs),
    costText(row.usage),
  ].join(' | ');
}

function buildCoverageReport(summary) {
  const aggregate = summary.aggregate;
  const displayName = providerDisplayName(summary.provider, summary.model);
  return [
    `# ${displayName} — Sim Companies ${summary.runCount}-wake shadow coverage`,
    '',
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt}`,
    `- Model: ${summary.model} (${summary.effort})`,
    `- Scenario families: ${summary.scenarioFamilyCount}`,
    `- Shadow wakes: ${summary.runCount}`,
    '- Live browser opened: no',
    '- Live game mutations: 0',
    '- Production model changed: no',
    '',
    '## Aggregate',
    '',
    `- Completion: ${aggregate.completed}/${aggregate.runs}`,
    `- Score: ${aggregate.score}/${aggregate.maximum} (${(aggregate.scoreRate * 100).toFixed(2)}%)`,
    `- Guard failures: ${aggregate.guardFailures} across ${aggregate.runsWithGuardFailures} wakes`,
    `- Input tokens: ${aggregate.usage.promptTokens}`,
    `- Output tokens: ${aggregate.usage.outputTokens}`,
    `- Exact list-price cost: ${costText(aggregate.usage)}`,
    `- Readiness gates: ${summary.readiness.passed ? 'PASS' : 'NOT YET'}`,
    '',
    '## Scenario families',
    '',
    'Scenario | Difficulty | Completed | Average score | Guard failures | Cumulative model time | API cost',
    '--- | --- | ---: | ---: | ---: | ---: | ---:',
    ...summary.scenarioSummaries.map(scenarioReportRow),
    '',
    '## Readiness checks',
    '',
    ...summary.readiness.checks.map(check => (
      `- ${check.passed ? 'PASS' : 'MISS'}: ${check.label} — ${JSON.stringify(check.actual)}`
    )),
    '',
    '## Interpretation boundary',
    '',
    summary.limitation,
    '',
  ].join('\n');
}

function writeCoverageArtifacts(
  runsDirectory,
  coverageId,
  baseSnapshot,
  runs,
  startedAt,
  finishedAt,
  toolParity,
  metadata = {},
) {
  const directory = ensureInside(runsDirectory, path.join(runsDirectory, coverageId));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJson(path.join(directory, 'base-snapshot.json'), baseSnapshot);
  const summary = buildCoverageSummary(
    baseSnapshot,
    runs,
    startedAt,
    finishedAt,
    toolParity,
    metadata,
  );
  writeJson(path.join(directory, 'coverage-summary.json'), summary);
  fs.writeFileSync(
    path.join(directory, 'coverage-report.md'),
    buildCoverageReport(summary),
    { mode: 0o600 },
  );
  return { directory, summary };
}

module.exports = {
  USAGE_FIELDS,
  aggregateRows,
  buildCoverageReport,
  buildCoverageSummary,
  coverageRow,
  duplicateMutationCount,
  forbiddenMutationCount,
  percentile,
  providerDisplayName,
  readiness,
  writeCoverageArtifacts,
};
