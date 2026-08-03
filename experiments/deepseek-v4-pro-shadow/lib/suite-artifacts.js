'use strict';

const fs = require('fs');
const path = require('path');
const { costText, durationText, ensureInside, writeJson } = require('./artifacts.js');
const { sha256 } = require('./snapshot.js');

const USAGE_FIELDS = Object.freeze([
  'promptTokens',
  'cacheHitTokens',
  'cacheMissTokens',
  'outputTokens',
  'cacheWriteTokens',
  'durationMs',
]);

function sumKnown(rows, field) {
  const values = rows.map(row => Number(row?.usage?.[field]));
  return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null;
}

function sumNullableCost(rows, field) {
  const values = rows.map(row => row?.usage?.[field]);
  if (!values.length || values.some(value => value == null || !Number.isFinite(Number(value)))) {
    return null;
  }
  return Number(values.reduce((sum, value) => sum + Number(value), 0).toFixed(8));
}

function aggregateProvider(provider, scenarioRows) {
  const rows = scenarioRows.filter(row => row.provider === provider);
  const completed = rows.filter(row => row.completed);
  const usage = Object.fromEntries(USAGE_FIELDS.map(field => [field, sumKnown(rows, field)]));
  usage.minUsd = sumNullableCost(rows, 'minUsd');
  usage.maxUsd = sumNullableCost(rows, 'maxUsd');
  usage.estimatedUsd = sumNullableCost(rows, 'estimatedUsd');
  const totalScore = rows.reduce((sum, row) => sum + Number(row.score || 0), 0);
  const maximum = rows.reduce((sum, row) => sum + Number(row.maximum || 0), 0);
  return {
    provider,
    model: rows[0]?.model || null,
    completedScenarios: completed.length,
    totalScenarios: rows.length,
    totalScore: Number(totalScore.toFixed(4)),
    maximum,
    scorePct: maximum > 0 ? Number(((totalScore / maximum) * 100).toFixed(4)) : 0,
    averageScore: rows.length ? Number((totalScore / rows.length).toFixed(4)) : 0,
    totalRounds: rows.reduce((sum, row) => sum + Number(row.rounds || 0), 0),
    totalWallDurationMs: rows.reduce((sum, row) => sum + Number(row.wallDurationMs || 0), 0),
    usage,
  };
}

function finiteLeader(rows, field, lowerWins = false) {
  const eligible = rows.filter(row => Number.isFinite(Number(row[field])));
  if (!eligible.length) return null;
  return [...eligible].sort((left, right) => (
    lowerWins
      ? Number(left[field]) - Number(right[field])
      : Number(right[field]) - Number(left[field])
  ))[0].provider;
}

function exactCostLeader(rows) {
  const eligible = rows.filter(row => row.usage?.estimatedUsd != null);
  if (eligible.length !== rows.length || !eligible.length) return null;
  return [...eligible]
    .sort((left, right) => left.usage.estimatedUsd - right.usage.estimatedUsd)[0].provider;
}

function buildSuiteComparison(baseSnapshot, scenarioRuns, startedAt, finishedAt) {
  const scenarioRows = scenarioRuns.flatMap(run => (
    run.artifacts.comparison.rows.map(row => ({
      scenario: run.snapshot.scenario?.id || 'current',
      scenarioKey: run.scenarioKey,
      difficulty: run.snapshot.scenario?.difficulty || 'unclassified',
      purpose: run.snapshot.scenario?.purpose || null,
      ...row,
    }))
  ));
  const providers = [...new Set(scenarioRows.map(row => row.provider))];
  const aggregates = providers.map(provider => aggregateProvider(provider, scenarioRows));
  const scenarioComparisons = scenarioRuns.map(run => {
    const rows = scenarioRows.filter(row => row.scenarioKey === run.scenarioKey);
    const terra = rows.find(row => row.provider === 'terra');
    const deepseek = rows.find(row => row.provider === 'deepseek');
    return {
      scenarioKey: run.scenarioKey,
      scenario: run.snapshot.scenario?.id || 'current',
      difficulty: run.snapshot.scenario?.difficulty || 'unclassified',
      snapshotSha256: run.artifacts.comparison.fairness.snapshotSha256,
      rows,
      scoreDeltaTerraMinusDeepSeek: Number(
        (Number(terra?.score || 0) - Number(deepseek?.score || 0)).toFixed(4),
      ),
      wallRatioDeepSeekOverTerra: Number(terra?.wallDurationMs) > 0
        ? Number((Number(deepseek?.wallDurationMs) / Number(terra.wallDurationMs)).toFixed(4))
        : null,
      costRatioTerraOverDeepSeek: Number(deepseek?.usage?.estimatedUsd) > 0
        && terra?.usage?.estimatedUsd != null
        ? Number((Number(terra.usage.estimatedUsd) / Number(deepseek.usage.estimatedUsd)).toFixed(4))
        : null,
    };
  });
  return {
    schemaVersion: 1,
    benchmark: 'Sim Companies multi-scenario frozen-shadow suite',
    startedAt,
    finishedAt,
    wallDurationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    baseSnapshotSha256: sha256(JSON.stringify(baseSnapshot)),
    baseStateAsOf: baseSnapshot.stateAsOf,
    scenarioCount: scenarioRuns.length,
    providers,
    fairness: {
      oneImmutableBaseSnapshot: true,
      pairedScenarioSnapshots: true,
      samePromptWithinEveryPair: true,
      sameHighReasoningEffort: true,
      sameMaxOutputTokens: true,
      sameSemanticToolNames: scenarioRuns.every(
        run => run.artifacts.comparison.fairness.sameSemanticToolNames === true,
      ),
      productionModelChanged: false,
      liveBrowserOpened: false,
      liveGameMutations: 0,
      scorer: 'provider-neutral deterministic rubric v2',
    },
    scenarioRows,
    scenarioComparisons,
    aggregates,
    leaders: {
      observableCapabilityScore: finiteLeader(aggregates, 'totalScore'),
      aggregateLatency: finiteLeader(aggregates, 'totalWallDurationMs', true),
      exactApiCost: exactCostLeader(aggregates),
    },
    limitation: 'Five paired controlled scenarios improve coverage but remain one deterministic suite from one business snapshot; they measure observable operational behavior, not live profit outcomes or a statistically representative general benchmark.',
  };
}

function reportRow(row) {
  return [
    row.scenarioKey,
    row.difficulty,
    row.provider,
    `${row.score}/${row.maximum}`,
    String(row.rounds),
    durationText(row.wallDurationMs),
    String(row.usage?.promptTokens ?? 'UNKNOWN'),
    String(row.usage?.outputTokens ?? 'UNKNOWN'),
    costText(row.usage),
  ].join(' | ');
}

function aggregateRow(row) {
  return [
    row.provider,
    `${row.completedScenarios}/${row.totalScenarios}`,
    `${row.totalScore}/${row.maximum}`,
    `${row.scorePct.toFixed(2)}%`,
    String(row.totalRounds),
    durationText(row.totalWallDurationMs),
    String(row.usage?.promptTokens ?? 'UNKNOWN'),
    String(row.usage?.outputTokens ?? 'UNKNOWN'),
    costText(row.usage),
  ].join(' | ');
}

function buildSuiteReport(comparison) {
  return [
    '# Sim Companies 多场景模型影子基准',
    '',
    `- 场景数：${comparison.scenarioCount}`,
    `- 基础状态时间：${comparison.baseStateAsOf || 'UNKNOWN'}`,
    `- 开始：${comparison.startedAt}`,
    `- 完成：${comparison.finishedAt}`,
    '- 推理强度：两者均为 High',
    '- 真实浏览器打开：否',
    '- 真实游戏改动：0',
    '- 生产模型切换：否',
    '',
    '## 总成绩',
    '',
    'Provider | 完成场景 | 总分 | 得分率 | 总轮数 | 累计模型耗时 | Input tokens | Output tokens | API 费用',
    '--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:',
    ...comparison.aggregates.map(aggregateRow),
    '',
    '## 分场景',
    '',
    'Scenario | 难度 | Provider | 分数 | 轮数 | 耗时 | Input tokens | Output tokens | API 费用',
    '--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---:',
    ...comparison.scenarioRows.map(reportRow),
    '',
    '## 判读边界',
    '',
    comparison.limitation,
    '',
  ].join('\n');
}

function writeSuiteArtifacts(runsDirectory, suiteId, baseSnapshot, scenarioRuns, startedAt, finishedAt) {
  const directory = ensureInside(runsDirectory, path.join(runsDirectory, suiteId));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJson(path.join(directory, 'base-snapshot.json'), baseSnapshot);
  const comparison = buildSuiteComparison(baseSnapshot, scenarioRuns, startedAt, finishedAt);
  writeJson(path.join(directory, 'suite-comparison.json'), comparison);
  fs.writeFileSync(
    path.join(directory, 'suite-report.md'),
    buildSuiteReport(comparison),
    { mode: 0o600 },
  );
  return { directory, comparison };
}

module.exports = {
  USAGE_FIELDS,
  aggregateProvider,
  buildSuiteComparison,
  buildSuiteReport,
  writeSuiteArtifacts,
};
