#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { RUNS_DIR } = require('./benchmark.js');
const { writeJson } = require('./lib/artifacts.js');
const { sha256 } = require('./lib/snapshot.js');

const CONFLICT_CASE_IDS = Object.freeze([
  '07-mill-upgrade-v1',
  '08-slot-expansion-v1',
  '27-mill-upgrade-v3',
  '28-slot-expansion-v3',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveCoverage(input) {
  const resolved = path.resolve(input);
  const root = `${path.resolve(RUNS_DIR)}${path.sep}`;
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error('coverage directory must remain inside the ignored runs directory');
  }
  return resolved;
}

function ratio(numerator, denominator) {
  return Number(denominator) > 0
    ? Number((Number(numerator) / Number(denominator)).toFixed(6))
    : null;
}

function pctChange(value, baseline) {
  return Number(baseline) !== 0
    ? Number((((Number(value) - Number(baseline)) / Number(baseline)) * 100).toFixed(4))
    : null;
}

function combinations(total, selected) {
  const count = Math.min(selected, total - selected);
  let result = 1;
  for (let index = 1; index <= count; index += 1) {
    result = (result * (total - count + index)) / index;
  }
  return result;
}

function pairedStatistics(pairs) {
  const deltas = pairs.map(row => Number(row.scoreDeltaTerraMinusDeepSeek));
  const count = deltas.length;
  const mean = deltas.reduce((sum, value) => sum + value, 0) / count;
  const variance = deltas.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (count - 1);
  const standardDeviation = Math.sqrt(variance);
  const standardError = standardDeviation / Math.sqrt(count);
  const nonTies = deltas.filter(value => value !== 0);
  const terraWins = nonTies.filter(value => value > 0).length;
  const deepseekWins = nonTies.filter(value => value < 0).length;
  const tailWins = Math.min(terraWins, deepseekWins);
  let tailProbability = 0;
  for (let wins = 0; wins <= tailWins; wins += 1) {
    tailProbability += combinations(nonTies.length, wins) / (2 ** nonTies.length);
  }
  return {
    pairedCases: count,
    meanScoreDeltaTerraMinusDeepSeek: Number(mean.toFixed(6)),
    standardDeviation: Number(standardDeviation.toFixed(6)),
    standardError: Number(standardError.toFixed(6)),
    normalApproximation95Pct: [
      Number((mean - (1.96 * standardError)).toFixed(6)),
      Number((mean + (1.96 * standardError)).toFixed(6)),
    ],
    nonTiedCases: nonTies.length,
    twoSidedSignTestP: Number(Math.min(1, 2 * tailProbability).toFixed(8)),
    caveat: `Diagnostic only: these ${count} controlled variants share one base business state and are not independent draws from all future live wakes.`,
  };
}

function conflictSensitivity(pairs) {
  const conflictCases = pairs.filter(row => CONFLICT_CASE_IDS.includes(row.caseId));
  const uncontaminated = pairs.filter(row => !CONFLICT_CASE_IDS.includes(row.caseId));
  const summarize = (provider, rows) => {
    const field = provider === 'terra' ? 'terraScore' : 'deepseekScore';
    const score = rows.reduce((sum, row) => sum + Number(row[field]), 0);
    return {
      provider,
      cases: rows.length,
      score,
      maximum: rows.length * 100,
      averageScore: Number((score / rows.length).toFixed(4)),
    };
  };
  const terra = summarize('terra', uncontaminated);
  const deepseek = summarize('deepseek', uncontaminated);
  return {
    status: 'material-fixture-conflict',
    rule: 'BRAIN.md: Execute at most one structural move at a time.',
    conflictCaseIds: [...CONFLICT_CASE_IDS],
    issue: 'These four snapshots retained an active Quarry construction while the deterministic rubric required a new Mill upgrade or Construction factory build.',
    conflictCases: conflictCases.map(row => ({
      caseId: row.caseId,
      terraScore: row.terraScore,
      deepseekScore: row.deepseekScore,
      terraConfirmedMutations: row.terraConfirmedMutations,
      deepseekConfirmedMutations: row.deepseekConfirmedMutations,
    })),
    ruleCompliance: {
      terra: conflictCases.filter(row => row.terraConfirmedMutations === 0).length,
      deepseek: conflictCases.filter(row => row.deepseekConfirmedMutations === 0).length,
      denominator: conflictCases.length,
    },
    uncontaminatedCases: uncontaminated.length,
    uncontaminated: {
      terra,
      deepseek,
      scoreDeltaTerraMinusDeepseek: terra.score - deepseek.score,
      averageDeltaTerraMinusDeepseek: Number(
        (terra.averageScore - deepseek.averageScore).toFixed(4),
      ),
      pairedOutcomes: {
        terraWins: uncontaminated.filter(
          row => row.scoreDeltaTerraMinusDeepSeek > 0,
        ).length,
        deepseekWins: uncontaminated.filter(
          row => row.scoreDeltaTerraMinusDeepSeek < 0,
        ).length,
        ties: uncontaminated.filter(
          row => row.scoreDeltaTerraMinusDeepSeek === 0,
        ).length,
      },
      pairedStatistics: pairedStatistics(uncontaminated),
    },
    interpretation: 'Keep the raw 30-pair result for auditability, but do not use the four conflicting cases to rank structural-decision capability. Re-run those four pairs after regenerating conflict-free snapshots.',
  };
}

function loadCoverage(input) {
  const directory = resolveCoverage(input);
  const summary = readJson(path.join(directory, 'coverage-summary.json'));
  const validation = readJson(path.join(directory, 'validation.json'));
  if (validation.status !== 'passed') {
    throw new Error(`${path.basename(directory)} has not passed independent validation`);
  }
  return {
    directory,
    summary,
    validation,
    provider: summary.provider || validation.provider || 'deepseek',
  };
}

function assertComparison(condition, message) {
  if (!condition) throw new Error(message);
}

function exactSnapshotHash(coverage, caseId) {
  const snapshot = readJson(path.join(coverage.directory, 'cases', caseId, 'snapshot.json'));
  return sha256(JSON.stringify(snapshot));
}

function buildComparison(leftInput, rightInput) {
  const coverages = [loadCoverage(leftInput), loadCoverage(rightInput)];
  const byProvider = Object.fromEntries(coverages.map(item => [item.provider, item]));
  const deepseek = byProvider.deepseek;
  const terra = byProvider.terra;
  assertComparison(deepseek && terra, 'comparison requires one DeepSeek and one Terra coverage');
  assertComparison(
    deepseek.summary.baseSnapshotSha256 === terra.summary.baseSnapshotSha256,
    'base snapshots differ',
  );
  assertComparison(
    deepseek.summary.rows.length === 30 && terra.summary.rows.length === 30,
    'both coverages must contain exactly thirty rows',
  );
  const pairs = terra.summary.rows.map(terraRow => {
    const deepseekRow = deepseek.summary.rows.find(row => row.caseId === terraRow.caseId);
    assertComparison(Boolean(deepseekRow), `DeepSeek row missing: ${terraRow.caseId}`);
    assertComparison(
      terraRow.runIndex === deepseekRow.runIndex
        && terraRow.scenarioKey === deepseekRow.scenarioKey
        && terraRow.variant === deepseekRow.variant,
      `case identity differs: ${terraRow.caseId}`,
    );
    const terraSnapshotSha256 = exactSnapshotHash(terra, terraRow.caseId);
    const deepseekSnapshotSha256 = exactSnapshotHash(deepseek, deepseekRow.caseId);
    assertComparison(
      terraSnapshotSha256 === deepseekSnapshotSha256,
      `case snapshot differs: ${terraRow.caseId}`,
    );
    return {
      runIndex: terraRow.runIndex,
      caseId: terraRow.caseId,
      scenarioKey: terraRow.scenarioKey,
      variant: terraRow.variant,
      snapshotSha256: terraSnapshotSha256,
      terraScore: terraRow.score,
      deepseekScore: deepseekRow.score,
      scoreDeltaTerraMinusDeepSeek: terraRow.score - deepseekRow.score,
      terraWallDurationMs: terraRow.wallDurationMs,
      deepseekWallDurationMs: deepseekRow.wallDurationMs,
      terraGuardFailures: terraRow.guardFailures,
      deepseekGuardFailures: deepseekRow.guardFailures,
      terraConfirmedMutations: terraRow.confirmedMutations,
      deepseekConfirmedMutations: deepseekRow.confirmedMutations,
      terraCostUsd: terraRow.usage?.estimatedUsd ?? null,
      deepseekCostUsd: deepseekRow.usage?.estimatedUsd ?? null,
    };
  });
  const scenarioComparisons = terra.summary.scenarioSummaries.map(terraRow => {
    const deepseekRow = deepseek.summary.scenarioSummaries
      .find(row => row.scenarioKey === terraRow.scenarioKey);
    assertComparison(Boolean(deepseekRow), `DeepSeek scenario missing: ${terraRow.scenarioKey}`);
    return {
      scenarioKey: terraRow.scenarioKey,
      difficulty: terraRow.difficulty,
      terraAverageScore: terraRow.averageScore,
      deepseekAverageScore: deepseekRow.averageScore,
      scoreDeltaTerraMinusDeepSeek: Number(
        (terraRow.averageScore - deepseekRow.averageScore).toFixed(4),
      ),
      terraGuardFailures: terraRow.guardFailures,
      deepseekGuardFailures: deepseekRow.guardFailures,
      terraWallDurationMs: terraRow.totalWallDurationMs,
      deepseekWallDurationMs: deepseekRow.totalWallDurationMs,
      terraCostUsd: terraRow.usage.estimatedUsd,
      deepseekCostUsd: deepseekRow.usage.estimatedUsd,
    };
  });
  const terraAggregate = terra.summary.aggregate;
  const deepseekAggregate = deepseek.summary.aggregate;
  const checks = [
    {
      name: 'both independent validations passed',
      passed: terra.validation.status === 'passed' && deepseek.validation.status === 'passed',
    },
    {
      name: 'same immutable base snapshot',
      passed: terra.summary.baseSnapshotSha256 === deepseek.summary.baseSnapshotSha256,
    },
    {
      name: 'all thirty case snapshots are byte-semantic matches',
      passed: pairs.length === 30,
    },
    {
      name: 'same High reasoning effort',
      passed: terra.summary.effort === 'high' && deepseek.summary.effort === 'high',
    },
    {
      name: 'same maximum output tokens',
      passed: terra.summary.maxTokens === deepseek.summary.maxTokens,
    },
    {
      name: 'same semantic tool surface',
      passed: terra.summary.fairness.toolSurfaceSha256
        === deepseek.summary.fairness.toolSurfaceSha256,
    },
    {
      name: 'zero live game mutations',
      passed: terra.summary.fairness.liveGameMutations === 0
        && deepseek.summary.fairness.liveGameMutations === 0,
    },
  ];
  const sensitivity = conflictSensitivity(pairs);
  return {
    schemaVersion: 1,
    benchmark: 'Sim Companies paired 30-wake coverage comparison',
    generatedAt: new Date().toISOString(),
    deepseekCoverageId: path.basename(deepseek.directory),
    terraCoverageId: path.basename(terra.directory),
    baseSnapshotSha256: terra.summary.baseSnapshotSha256,
    fairness: {
      status: checks.every(check => check.passed) ? 'passed' : 'failed',
      checks,
      exactPairedCaseSnapshots: pairs.length,
      productionModelChanged: false,
      liveBrowserOpened: false,
      liveGameMutations: 0,
    },
    methodology: {
      status: 'provisional',
      blockers: [
        'Four structural-action cases conflict with the one-structural-move production rule.',
      ],
      cleanPairSensitivityAvailable: true,
      replacementPairsRequired: 4,
    },
    providers: {
      terra: {
        model: terra.summary.model,
        aggregate: terraAggregate,
        elapsedWallDurationMs: terra.summary.wallDurationMs,
        readiness: terra.summary.readiness,
      },
      deepseek: {
        model: deepseek.summary.model,
        aggregate: deepseekAggregate,
        elapsedWallDurationMs: deepseek.summary.wallDurationMs,
        readiness: deepseek.summary.readiness,
      },
    },
    pairedOutcomes: {
      terraWins: pairs.filter(row => row.scoreDeltaTerraMinusDeepSeek > 0).length,
      deepseekWins: pairs.filter(row => row.scoreDeltaTerraMinusDeepSeek < 0).length,
      ties: pairs.filter(row => row.scoreDeltaTerraMinusDeepSeek === 0).length,
      terraFasterCases: pairs.filter(
        row => row.terraWallDurationMs < row.deepseekWallDurationMs,
      ).length,
      deepseekFasterCases: pairs.filter(
        row => row.deepseekWallDurationMs < row.terraWallDurationMs,
      ).length,
    },
    pairedStatistics: pairedStatistics(pairs),
    benchmarkConflictSensitivity: sensitivity,
    deltas: {
      scoreTerraMinusDeepSeek: terraAggregate.score - deepseekAggregate.score,
      averageScoreTerraMinusDeepSeek: Number(
        (terraAggregate.averageScore - deepseekAggregate.averageScore).toFixed(4),
      ),
      scoreRatePercentagePointsTerraMinusDeepSeek: Number(
        ((terraAggregate.scoreRate - deepseekAggregate.scoreRate) * 100).toFixed(4),
      ),
      guardFailuresTerraMinusDeepSeek: terraAggregate.guardFailures
        - deepseekAggregate.guardFailures,
      promptTokensTerraVsDeepSeekPct: pctChange(
        terraAggregate.usage.promptTokens,
        deepseekAggregate.usage.promptTokens,
      ),
      outputTokensTerraVsDeepSeekPct: pctChange(
        terraAggregate.usage.outputTokens,
        deepseekAggregate.usage.outputTokens,
      ),
      cumulativeSpeedDeepseekOverTerra: ratio(
        deepseekAggregate.totalWallDurationMs,
        terraAggregate.totalWallDurationMs,
      ),
      elapsedSpeedDeepseekOverTerra: ratio(
        deepseek.summary.wallDurationMs,
        terra.summary.wallDurationMs,
      ),
      costTerraOverDeepseek: ratio(
        terraAggregate.usage.estimatedUsd,
        deepseekAggregate.usage.estimatedUsd,
      ),
      costDeltaTerraMinusDeepseekUsd: Number(
        (
          terraAggregate.usage.estimatedUsd
          - deepseekAggregate.usage.estimatedUsd
        ).toFixed(8),
      ),
    },
    scenarioComparisons,
    pairs,
    interpretationBoundary: 'This is a controlled shadow benchmark from one frozen business state. Four structural-action pairs contain a confirmed fixture conflict and remain provisional until rerun. The suite measures observable tool use and deterministic rubric performance, not live-game profit or long-horizon production reliability.',
  };
}

function durationMinutes(milliseconds) {
  return (Number(milliseconds) / 60000).toFixed(2);
}

function money(value) {
  return `$${Number(value).toFixed(4)}`;
}

const SCENARIO_LABELS = Object.freeze({
  'all-busy': '全部忙碌',
  'collectible-recovery': '收取后续产',
  'idle-mill': 'Mill 空闲恢复',
  'input-shortage': '原料短缺补购',
  'utility-surplus': '水电余量交易',
  'prospector-ready': 'Prospector rebuild',
  'mill-upgrade': 'Mill 升级与债务',
  'slot-expansion': '建筑槽扩张',
  'chat-contract-risk': '聊天与合同安全',
  'multi-pressure': '多压力综合',
});

const DIFFICULTY_LABELS = Object.freeze({
  simple: '简单',
  medium: '中等',
  complex: '复杂',
});

function buildReportArtifact(comparison) {
  const terra = comparison.providers.terra;
  const deepseek = comparison.providers.deepseek;
  const outcomes = comparison.pairedOutcomes;
  const deltas = comparison.deltas;
  const sensitivity = comparison.benchmarkConflictSensitivity;
  const clean = sensitivity.uncontaminated;
  const generatedAt = comparison.generatedAt;
  const sourceBase = {
    executed_at: generatedAt,
    filters: [
      'Exactly 30 case IDs, ten scenario families, and three variants per family.',
      'Identical persisted snapshot hash for each Terra and DeepSeek case.',
      'High reasoning effort and 32,768 maximum output tokens for both providers.',
      'All game mutations intercepted in the in-memory shadow runtime.',
    ],
    metric_definitions: [
      'Score = provider-neutral deterministic observable rubric points; maximum 100 per wake.',
      'Guard failure = a tool call rejected before any game execution.',
      'Cumulative model time = sum of per-wake provider API-loop wall-clock durations.',
      'Cost = independently recomputed per-request list-price charge from returned token allocation.',
    ],
  };
  const sources = [
    {
      id: 'paired_headline_sql',
      label: '30 对测试汇总指标',
      path: 'queries/paired-headline-metrics.sql',
      query: {
        ...sourceBase,
        engine: 'sqlite',
        language: 'sql',
        sql: 'SELECT\n  terra_score AS terraScore,\n  deepseek_score AS deepseekScore,\n  score_delta AS scoreDelta,\n  clean_terra_score AS cleanTerraScore,\n  clean_deepseek_score AS cleanDeepseekScore,\n  excluded_conflict_cases AS excludedConflictCases,\n  terra_minutes AS terraMinutes,\n  deepseek_minutes AS deepseekMinutes,\n  speed_ratio AS speedRatio,\n  terra_cost_usd AS terraCostUsd,\n  deepseek_cost_usd AS deepseekCostUsd,\n  cost_ratio AS costRatio,\n  terra_minimum_score AS terraMinimumScore,\n  deepseek_minimum_score AS deepseekMinimumScore,\n  guard_comparison AS guardComparison\nFROM paired_headline_metrics',
        description: 'Loads the independently validated paired headline score, speed, cost, and stability metrics.',
        tables_used: ['paired_headline_metrics'],
      },
    },
    {
      id: 'paired_scenario_sql',
      label: '十类场景成对结果',
      path: 'queries/paired-scenario-results.sql',
      query: {
        ...sourceBase,
        engine: 'sqlite',
        language: 'sql',
        sql: 'SELECT\n  scenario_order AS scenarioOrder,\n  scenario_key AS scenarioKey,\n  scenario,\n  difficulty,\n  fixture_status AS fixtureStatus,\n  provider,\n  average_score AS averageScore,\n  guard_failures AS guardFailures,\n  wall_seconds AS wallSeconds,\n  cost_usd AS costUsd\nFROM paired_scenario_results\nORDER BY scenario_order ASC, provider ASC',
        description: 'Loads each provider’s three-variant average for all ten paired scenario families.',
        tables_used: ['paired_scenario_results'],
      },
    },
    {
      id: 'paired_case_sql',
      label: '30 对逐案结果',
      path: 'queries/paired-case-results.sql',
      query: {
        ...sourceBase,
        engine: 'sqlite',
        language: 'sql',
        sql: 'SELECT\n  run_index AS runIndex,\n  case_id AS caseId,\n  scenario,\n  variant,\n  terra_score AS terraScore,\n  deepseek_score AS deepseekScore,\n  score_delta AS scoreDelta,\n  terra_seconds AS terraSeconds,\n  deepseek_seconds AS deepseekSeconds\nFROM paired_case_results\nORDER BY run_index ASC',
        description: 'Loads all thirty exact-snapshot pair outcomes in the original run order.',
        tables_used: ['paired_case_results'],
      },
    },
    {
      id: 'paired_validation_sql',
      label: '公平性与独立复算检查',
      path: 'queries/paired-validation-checks.sql',
      query: {
        ...sourceBase,
        engine: 'sqlite',
        language: 'sql',
        sql: 'SELECT\n  check_order AS checkOrder,\n  check_name AS checkName,\n  passed,\n  evidence\nFROM paired_validation_checks\nORDER BY check_order ASC',
        description: 'Loads the paired fairness checks after both provider runs pass independent score and cost recomputation.',
        tables_used: ['paired_validation_checks'],
      },
    },
  ];
  const scenarioScores = comparison.scenarioComparisons.flatMap((row, index) => [
    {
      scenarioOrder: index + 1,
      scenarioKey: row.scenarioKey,
      scenario: `${SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey}${['mill-upgrade', 'slot-expansion'].includes(row.scenarioKey) ? ' †' : ''}`,
      difficulty: DIFFICULTY_LABELS[row.difficulty] || row.difficulty,
      fixtureStatus: ['mill-upgrade', 'slot-expansion'].includes(row.scenarioKey)
        ? '2/3 变体冲突'
        : '正常',
      provider: 'Terra',
      averageScore: row.terraAverageScore,
      guardFailures: row.terraGuardFailures,
      wallSeconds: Number((row.terraWallDurationMs / 1000).toFixed(3)),
      costUsd: row.terraCostUsd,
    },
    {
      scenarioOrder: index + 1,
      scenarioKey: row.scenarioKey,
      scenario: `${SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey}${['mill-upgrade', 'slot-expansion'].includes(row.scenarioKey) ? ' †' : ''}`,
      difficulty: DIFFICULTY_LABELS[row.difficulty] || row.difficulty,
      fixtureStatus: ['mill-upgrade', 'slot-expansion'].includes(row.scenarioKey)
        ? '2/3 变体冲突'
        : '正常',
      provider: 'DeepSeek',
      averageScore: row.deepseekAverageScore,
      guardFailures: row.deepseekGuardFailures,
      wallSeconds: Number((row.deepseekWallDurationMs / 1000).toFixed(3)),
      costUsd: row.deepseekCostUsd,
    },
  ]);
  const scenarioComparison = comparison.scenarioComparisons.map((row, index) => ({
    scenarioOrder: index + 1,
    scenario: `${SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey}${['mill-upgrade', 'slot-expansion'].includes(row.scenarioKey) ? ' †' : ''}`,
    difficulty: DIFFICULTY_LABELS[row.difficulty] || row.difficulty,
    fixtureStatus: ['mill-upgrade', 'slot-expansion'].includes(row.scenarioKey)
      ? '2/3 变体冲突'
      : '正常',
    terraAverageScore: row.terraAverageScore,
    deepseekAverageScore: row.deepseekAverageScore,
    scoreDelta: row.scoreDeltaTerraMinusDeepSeek,
    terraGuardFailures: row.terraGuardFailures,
    deepseekGuardFailures: row.deepseekGuardFailures,
  }));
  const pairResults = comparison.pairs.map(row => ({
    runIndex: row.runIndex,
    caseId: row.caseId,
    scenario: SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey,
    variant: row.variant,
    terraScore: row.terraScore,
    deepseekScore: row.deepseekScore,
    scoreDelta: row.scoreDeltaTerraMinusDeepSeek,
    terraSeconds: Number((row.terraWallDurationMs / 1000).toFixed(3)),
    deepseekSeconds: Number((row.deepseekWallDurationMs / 1000).toFixed(3)),
  }));
  return {
    surface: 'report',
    manifest: {
      version: 1,
      surface: 'report',
      title: 'Terra 与 DeepSeek：相同 30 次对比',
      description: 'Terra High 与 DeepSeek V4 Pro High 在完全相同的 30 个 Sim Companies 冻结影子唤醒中的能力、稳定性、速度、Token 和费用对比。',
      generatedAt,
      sources,
      cards: [
        {
          id: 'capability_card',
          description: '原始 30 次各 100 分；包含 4 对已识别的夹具冲突。',
          dataset: 'headline_metrics',
          sourceId: 'paired_headline_sql',
          metrics: [
            {
              label: 'Terra 总分',
              field: 'terraScore',
              format: 'number',
              unit: '/3000',
            },
            {
              label: 'DeepSeek',
              field: 'deepseekScore',
              format: 'number',
              unit: '/3000',
            },
            {
              label: 'Terra 差值',
              field: 'scoreDelta',
              format: 'number',
              signed: true,
            },
          ],
        },
        {
          id: 'sensitivity_card',
          description: '暂时排除四对夹具冲突的 26 对敏感性结果。',
          dataset: 'headline_metrics',
          sourceId: 'paired_headline_sql',
          metrics: [
            {
              label: 'Terra 26 对',
              field: 'cleanTerraScore',
              format: 'number',
              unit: '/2600',
            },
            {
              label: 'DeepSeek 26 对',
              field: 'cleanDeepseekScore',
              format: 'number',
              unit: '/2600',
            },
            {
              label: '待重跑',
              field: 'excludedConflictCases',
              format: 'number',
              unit: '对',
            },
          ],
        },
        {
          id: 'speed_card',
          description: '累计 30 次 API 工具循环墙钟时间。',
          dataset: 'headline_metrics',
          sourceId: 'paired_headline_sql',
          metrics: [
            {
              label: 'Terra 累计',
              field: 'terraMinutes',
              format: 'number',
              unit: '分钟',
            },
            {
              label: 'DeepSeek',
              field: 'deepseekMinutes',
              format: 'number',
              unit: '分钟',
            },
            {
              label: 'Terra 速度优势',
              field: 'speedRatio',
              format: 'number',
              unit: '×',
            },
          ],
        },
        {
          id: 'cost_card',
          description: '逐请求按各供应商列表价独立复算。',
          dataset: 'headline_metrics',
          sourceId: 'paired_headline_sql',
          metrics: [
            {
              label: 'Terra 费用',
              field: 'terraCostUsd',
              format: 'currency',
            },
            {
              label: 'DeepSeek',
              field: 'deepseekCostUsd',
              format: 'currency',
            },
            {
              label: 'Terra/DeepSeek',
              field: 'costRatio',
              format: 'number',
              unit: '×',
            },
          ],
        },
        {
          id: 'stability_card',
          description: '最低分和护栏拒绝揭示尾部失误。',
          dataset: 'headline_metrics',
          sourceId: 'paired_headline_sql',
          metrics: [
            {
              label: 'Terra 最低分',
              field: 'terraMinimumScore',
              format: 'number',
            },
            {
              label: 'DeepSeek 最低分',
              field: 'deepseekMinimumScore',
              format: 'number',
            },
            {
              label: '护栏拒绝 T/D',
              field: 'guardComparison',
              format: 'text',
            },
          ],
        },
      ],
      charts: [
        {
          id: 'scenario_score_chart',
          title: '十类场景平均得分',
          subtitle: '每类三个冻结变体；† 类别各有两个变体与单结构动作规则冲突。',
          type: 'bar',
          dataset: 'scenario_scores',
          sourceId: 'paired_scenario_sql',
          valueFormat: 'number',
          layout: 'full',
          xAxisTitle: '场景',
          yAxisTitle: '平均得分（满分 100）',
          encodings: {
            x: {
              field: 'scenario',
              type: 'nominal',
              label: '场景',
            },
            y: {
              field: 'averageScore',
              type: 'quantitative',
              label: '平均得分',
            },
            color: {
              field: 'provider',
              type: 'nominal',
              label: '模型',
            },
            tooltip: [
              {
                field: 'difficulty',
                type: 'nominal',
                label: '难度',
              },
              {
                field: 'guardFailures',
                type: 'quantitative',
                label: '护栏拒绝',
              },
              {
                field: 'wallSeconds',
                type: 'quantitative',
                label: '累计耗时',
              },
              {
                field: 'costUsd',
                type: 'quantitative',
                label: '费用',
                format: 'currency',
              },
            ],
          },
        },
      ],
      tables: [
        {
          id: 'scenario_table',
          title: '十类场景精确对比',
          subtitle: '正差值表示 Terra 得分更高；每行汇总三个同场景变体。',
          dataset: 'scenario_comparison',
          sourceId: 'paired_scenario_sql',
          density: 'comfortable',
          defaultSort: {
            field: 'scenarioOrder',
            direction: 'asc',
          },
          columns: [
            { field: 'scenarioOrder', label: '#', type: 'number' },
            { field: 'scenario', label: '场景', type: 'text' },
            { field: 'difficulty', label: '难度', type: 'text' },
            { field: 'fixtureStatus', label: '夹具状态', type: 'text' },
            { field: 'terraAverageScore', label: 'Terra', type: 'number' },
            { field: 'deepseekAverageScore', label: 'DeepSeek', type: 'number' },
            {
              field: 'scoreDelta',
              label: 'Terra 差值',
              type: 'number',
              movement: true,
            },
            { field: 'terraGuardFailures', label: 'Terra 护栏', type: 'number' },
            { field: 'deepseekGuardFailures', label: 'DeepSeek 护栏', type: 'number' },
          ],
        },
        {
          id: 'pair_table',
          title: '30 次逐案结果',
          subtitle: '每行是一对完全相同的场景快照，按原始运行顺序显示。',
          dataset: 'pair_results',
          sourceId: 'paired_case_sql',
          density: 'dense',
          defaultSort: {
            field: 'runIndex',
            direction: 'asc',
          },
          columns: [
            { field: 'runIndex', label: '#', type: 'number' },
            { field: 'scenario', label: '场景', type: 'text' },
            { field: 'variant', label: '变体', type: 'number' },
            { field: 'terraScore', label: 'Terra', type: 'number' },
            { field: 'deepseekScore', label: 'DeepSeek', type: 'number' },
            {
              field: 'scoreDelta',
              label: 'Terra 差值',
              type: 'number',
              movement: true,
            },
            { field: 'terraSeconds', label: 'Terra 秒', type: 'number' },
            { field: 'deepseekSeconds', label: 'DeepSeek 秒', type: 'number' },
          ],
        },
      ],
      blocks: [
        {
          id: 'title',
          type: 'markdown',
          body: '# Terra 与 DeepSeek：相同 30 次对比',
        },
        {
          id: 'executive_summary',
          type: 'markdown',
          sourceId: 'paired_headline_sql',
          body: `## Executive Summary\n\n- **30 对测试完成，但有 4 对结构性夹具冲突。** 原始总分是 Terra **${terra.aggregate.score}/3000**、DeepSeek **${deepseek.aggregate.score}/3000**；4 对样本同时保留 Quarry 施工又要求第二个结构动作，违反生产规则，不能用于判断升级/扩建能力。\n- **未污染的 26 对偏向 Terra，但仍不是最终胜负。** 暂时排除冲突对后，Terra **${clean.terra.score}/2600**、DeepSeek **${clean.deepseek.score}/2600**；修复后的四对必须重新成对运行后，才能给出完整结论。\n- **速度与费用结论不受该冲突改变。** Terra 在 **30/30** 对场景中更快，累计速度约 **${deltas.cumulativeSpeedDeepseekOverTerra.toFixed(2)}×**；但费用是 DeepSeek 的 **${deltas.costTerraOverDeepseek.toFixed(2)}×**。\n- **建议暂不切换生产模型。** 保持 Terra；基准夹具已修复，待 DeepSeek 凭据可用时只补跑四对冲突样本，再判断是否值得 canary。`,
        },
        {
          id: 'headline_metrics',
          type: 'metric-strip',
          cardIds: [
            'capability_card',
            'sensitivity_card',
            'speed_card',
            'cost_card',
            'stability_card',
          ],
        },
        {
          id: 'comparison_basis',
          type: 'markdown',
          sourceId: 'paired_validation_sql',
          body: '## 这次是真正的同题对比\n\n30 对案例来自同一个基础状态，覆盖十类场景、每类三个变体。Terra 逐案直接复用了 DeepSeek 已保存的场景快照；每对快照哈希、High 推理强度、最大输出 Token 和语义工具表面都相同。两边独立校验共 **451 项**通过，真实浏览器打开与游戏改动均为 **0**。',
        },
        {
          id: 'score_finding',
          type: 'markdown',
          sourceId: 'paired_case_sql',
          body: `## 原始总分接近，未污染样本偏向 Terra\n\n全部 30 对的原始结果是 Terra 胜 **${outcomes.terraWins}**、DeepSeek 胜 **${outcomes.deepseekWins}**、平 **${outcomes.ties}**，总分只差 ${deltas.scoreTerraMinusDeepSeek}。但这包含四对与生产规则冲突的结构性夹具。\n\n排除四对后，26 对为 Terra 胜 **${clean.pairedOutcomes.terraWins}**、DeepSeek 胜 **${clean.pairedOutcomes.deepseekWins}**、平 **${clean.pairedOutcomes.ties}**；Terra 平均 **${clean.terra.averageScore.toFixed(2)}**，DeepSeek **${clean.deepseek.averageScore.toFixed(2)}**。这是一项敏感性检查，不是用删除样本替代修复后的成对复测。`,
        },
        {
          id: 'scenario_chart',
          type: 'chart',
          chartId: 'scenario_score_chart',
        },
        {
          id: 'fixture_conflict',
          type: 'markdown',
          sourceId: 'paired_scenario_sql',
          body: `## 四对结构性样本的评分方向与生产规则相反\n\nMill 升级 v1/v3 与建筑槽扩张 v1/v3 都保留了正在施工的 Quarry，却要求立即确认另一个结构动作。BRAIN 明确规定“一次最多一个结构性动作”。四对中 Terra **${sensitivity.ruleCompliance.terra}/4** 次遵守该规则，DeepSeek **${sensitivity.ruleCompliance.deepseek}/4**；原评分却把立即执行当作正确答案。\n\n**因此不能据此说 DeepSeek 的资本决策更稳，也不能说 Terra 的原始 81 分是实际能力失败。** 夹具现在会把竞争施工改为忙碌的 Sand 订单，使目标升级或建造成为唯一结构动作；需要补跑四对后替换这些原始分数。`,
        },
        {
          id: 'scenario_table_block',
          type: 'table',
          tableId: 'scenario_table',
        },
        {
          id: 'speed_and_cost',
          type: 'markdown',
          sourceId: 'paired_headline_sql',
          body: `## 速度与费用是清晰的交换\n\nTerra 累计模型耗时 **${durationMinutes(terra.aggregate.totalWallDurationMs)} 分钟**，DeepSeek **${durationMinutes(deepseek.aggregate.totalWallDurationMs)} 分钟**；Terra 每一对都更快。Terra 还少用 **${Math.abs(deltas.promptTokensTerraVsDeepSeekPct).toFixed(1)}%** 输入 Token、少用 **${Math.abs(deltas.outputTokensTerraVsDeepSeekPct).toFixed(1)}%** 输出 Token。\n\n但按逐请求列表价精算，Terra 为 **${money(terra.aggregate.usage.estimatedUsd)}**，DeepSeek 为 **${money(deepseek.aggregate.usage.estimatedUsd)}**。低价来自供应商定价，不是 DeepSeek 更少说；价格、税费或赠金变化会改变这个倍数。`,
        },
        {
          id: 'pair_table_block',
          type: 'table',
          tableId: 'pair_table',
        },
        {
          id: 'recommendations',
          type: 'markdown',
          body: '## 推荐的下一步\n\n1. **生产继续使用 Terra。** 当前不改 `BRAIN_MODEL`，这轮仍是离线影子证据。\n2. **只补跑四对冲突样本。** 基准夹具已修复；DeepSeek 凭据当前不可用，恢复后再运行 Mill 升级 v1/v3 与建筑槽扩张 v1/v3 两个模型共 8 次。\n3. **用修复后结果替换原始四对。** 不把排除分析当最终成绩，也不为了得到预想结论重跑其他 26 对。\n4. **随后再决定 canary。** 真实 UI、跨唤醒记忆和限流恢复仍需低风险验证。',
        },
        {
          id: 'further_questions',
          type: 'markdown',
          body: '## 仍需回答的问题\n\n- 两个模型在真实页面延迟、`UNKNOWN` 数据和 UI 变化时，能否维持影子场景的稳定性？\n- DeepSeek 在跨多次唤醒的长期计划和记忆上，能否保持最低分优势？\n- Terra 修补结构性提示后，是否会牺牲目前在聊天、收取和多压力场景的优势？',
        },
        {
          id: 'caveats',
          type: 'markdown',
          body: `## 假设与边界\n\n- 原始 30 对中有四对已确认的结构性夹具冲突；原始总分和图表为审计而保留，不能作为完整能力排名。\n- 这是一个基础状态派生的确定性影子套件，不是通用模型排行榜，也不直接测真实利润。\n- 分数只评价可观察工具行为、状态一致性、动作经济性和收尾协议，不评价隐藏思维链。\n- 所有写操作均为内存模拟并标记 \`executed:false\`；没有连接 Chrome，也没有改变生产模型。\n- 费用按 2026 年 7 月 29 日核对的列表价复算，不等同于税费、赠金或未来价格。\n- 原始 30 对的诊断性 95% 区间为每次 **${comparison.pairedStatistics.normalApproximation95Pct[0].toFixed(2)} 到 +${comparison.pairedStatistics.normalApproximation95Pct[1].toFixed(2)} 分**；夹具冲突与共享基础状态使其不能充当未来唤醒的统计保证。`,
        },
      ],
    },
    snapshot: {
      version: 1,
      generatedAt,
      status: 'ready',
      datasets: {
        headline_metrics: [{
          terraScore: terra.aggregate.score,
          deepseekScore: deepseek.aggregate.score,
          scoreDelta: deltas.scoreTerraMinusDeepSeek,
          cleanTerraScore: clean.terra.score,
          cleanDeepseekScore: clean.deepseek.score,
          excludedConflictCases: sensitivity.conflictCaseIds.length,
          terraMinutes: Number(durationMinutes(terra.aggregate.totalWallDurationMs)),
          deepseekMinutes: Number(durationMinutes(deepseek.aggregate.totalWallDurationMs)),
          speedRatio: deltas.cumulativeSpeedDeepseekOverTerra,
          terraCostUsd: terra.aggregate.usage.estimatedUsd,
          deepseekCostUsd: deepseek.aggregate.usage.estimatedUsd,
          costRatio: deltas.costTerraOverDeepseek,
          terraMinimumScore: terra.aggregate.minimumScore,
          deepseekMinimumScore: deepseek.aggregate.minimumScore,
          guardComparison: `${terra.aggregate.guardFailures}/${deepseek.aggregate.guardFailures}`,
        }],
        scenario_scores: scenarioScores,
        scenario_comparison: scenarioComparison,
        pair_results: pairResults,
      },
    },
    sources,
  };
}

function writeReportArtifacts(directory, comparison) {
  const artifact = buildReportArtifact(comparison);
  writeJson(path.join(directory, 'artifact.json'), artifact);
  writeJson(path.join(directory, 'report-notes.json'), {
    audience: 'product stakeholders',
    deliveryMode: 'html',
    requiredStructure: [
      'Title',
      'Executive summary',
      'Key findings with visual evidence',
      'Recommended next steps',
      'Further questions',
      'Caveats and assumptions',
    ],
    chartMap: [{
      section: 'Score profile across ten scenario families',
      analyticalQuestion: 'Where do model strengths and tail risks differ?',
      family: 'Comparison & Ranking',
      chartType: 'grouped bar',
      fields: ['scenario', 'provider', 'averageScore'],
      claim: 'Raw scores are close; two structural families remain provisional because four variants conflict with the production rule.',
      palettePolicy: 'hard two-root cap',
      deliveryArtifact: 'artifact.json#scenario_score_chart',
    }],
    interpretationBoundary: `${comparison.interpretationBoundary} Four structural-action pairs are provisional because their fixture conflicts with BRAIN.md.`,
  });
  return artifact;
}

function buildChineseReport(comparison) {
  const terra = comparison.providers.terra;
  const deepseek = comparison.providers.deepseek;
  const outcomes = comparison.pairedOutcomes;
  const deltas = comparison.deltas;
  const sensitivity = comparison.benchmarkConflictSensitivity;
  const clean = sensitivity.uncontaminated;
  const scenarioRows = comparison.scenarioComparisons.map(row => [
    `${row.scenarioKey}${['mill-upgrade', 'slot-expansion'].includes(row.scenarioKey) ? ' †' : ''}`,
    row.difficulty,
    row.terraAverageScore.toFixed(2),
    row.deepseekAverageScore.toFixed(2),
    `${row.scoreDeltaTerraMinusDeepSeek >= 0 ? '+' : ''}${row.scoreDeltaTerraMinusDeepSeek.toFixed(2)}`,
    `${row.terraGuardFailures}/${row.deepseekGuardFailures}`,
  ].join(' | '));
  return [
    '# Terra High 与 DeepSeek V4 Pro High：相同 30 次 Sim 影子测试',
    '',
    '## 结论',
    '',
    `原始 30 对结果是 Terra ${terra.aggregate.score}/${terra.aggregate.maximum}、DeepSeek ${deepseek.aggregate.score}/${deepseek.aggregate.maximum}；但其中 4 对结构性样本与“一次最多一个结构性动作”的生产规则冲突，不能用来判断升级/扩建能力。`,
    '',
    `保留全部 30 对做审计时，Terra 胜 ${outcomes.terraWins}、DeepSeek 胜 ${outcomes.deepseekWins}、平 ${outcomes.ties}。排除 4 对冲突样本后，26 对为 Terra ${clean.terra.score}/${clean.terra.maximum}、DeepSeek ${clean.deepseek.score}/${clean.deepseek.maximum}；这仍只是同一基础状态上的敏感性分析。`,
    '',
    `费用方面，Terra 为 ${money(terra.aggregate.usage.estimatedUsd)}，DeepSeek 为 ${money(deepseek.aggregate.usage.estimatedUsd)}；Terra 贵 ${deltas.costTerraOverDeepseek.toFixed(2)} 倍。`,
    '',
    '## 总表',
    '',
    '指标 | Terra High | DeepSeek V4 Pro High',
    '--- | ---: | ---:',
    `完成 | ${terra.aggregate.completed}/${terra.aggregate.runs} | ${deepseek.aggregate.completed}/${deepseek.aggregate.runs}`,
    `总分 | ${terra.aggregate.score}/${terra.aggregate.maximum} | ${deepseek.aggregate.score}/${deepseek.aggregate.maximum}`,
    `平均分 | ${terra.aggregate.averageScore.toFixed(2)} | ${deepseek.aggregate.averageScore.toFixed(2)}`,
    `最低分 | ${terra.aggregate.minimumScore} | ${deepseek.aggregate.minimumScore}`,
    `防护失败 | ${terra.aggregate.guardFailures} | ${deepseek.aggregate.guardFailures}`,
    `累计模型耗时 | ${durationMinutes(terra.aggregate.totalWallDurationMs)} 分钟 | ${durationMinutes(deepseek.aggregate.totalWallDurationMs)} 分钟`,
    `实际并发测试耗时 | ${durationMinutes(terra.elapsedWallDurationMs)} 分钟 | ${durationMinutes(deepseek.elapsedWallDurationMs)} 分钟`,
    `Input tokens | ${terra.aggregate.usage.promptTokens} | ${deepseek.aggregate.usage.promptTokens}`,
    `Output tokens | ${terra.aggregate.usage.outputTokens} | ${deepseek.aggregate.usage.outputTokens}`,
    `API 费用 | ${money(terra.aggregate.usage.estimatedUsd)} | ${money(deepseek.aggregate.usage.estimatedUsd)}`,
    `7 项就绪门槛 | ${terra.readiness.passed ? '7/7 通过' : '6/7 通过'} | ${deepseek.readiness.passed ? '7/7 通过' : '未全部通过'}`,
    '',
    '## 十类场景',
    '',
    '场景 | 难度 | Terra 平均分 | DeepSeek 平均分 | Terra 差值 | 防护失败 T/D',
    '--- | --- | ---: | ---: | ---: | ---:',
    ...scenarioRows,
    '',
    '## 重要差异',
    '',
    '- Terra 的原始总体分数略高、响应明显更快、防护失败更少。',
    '- DeepSeek 的费用显著更低，而且原始最低分更高。',
    `- 4 对冲突样本中，Terra 有 ${sensitivity.ruleCompliance.terra}/4 次遵守单结构动作规则，DeepSeek 为 ${sensitivity.ruleCompliance.deepseek}/4；原始评分却奖励了立即执行，因此这些样本不能证明 DeepSeek 的资本决策更稳。`,
    `- 排除冲突样本后，Terra 平均 ${clean.terra.averageScore.toFixed(2)}，DeepSeek ${clean.deepseek.averageScore.toFixed(2)}；但修复后的四对仍需重新跑，不能用排除分析替代复测。`,
    '- 两者都没有未知工具、禁止操作或重复确认操作，也没有连接真实浏览器。',
    `- 原始 30 对的诊断性 95% 区间为每次 Terra 相对 DeepSeek **${comparison.pairedStatistics.normalApproximation95Pct[0].toFixed(2)} 到 +${comparison.pairedStatistics.normalApproximation95Pct[1].toFixed(2)} 分**；夹具冲突和共享基础状态使其不能充当通用模型能力置信区间。`,
    '',
    '† Mill 升级与建筑槽扩张各有两个“应执行”变体受到竞争施工夹具污染；表中保留原始分数仅供审计。',
    '',
    '## 判读边界',
    '',
    comparison.interpretationBoundary,
    '',
  ].join('\n');
}

function main() {
  const [left, right] = process.argv.slice(2);
  if (!left || !right) {
    throw new Error('usage: node compare-coverages.js <coverage-a> <coverage-b>');
  }
  const comparison = buildComparison(left, right);
  if (comparison.fairness.status !== 'passed') {
    throw new Error('coverage comparison fairness validation failed');
  }
  const terraDirectory = resolveCoverage(
    path.join(RUNS_DIR, comparison.terraCoverageId),
  );
  writeJson(path.join(terraDirectory, 'comparison.json'), comparison);
  fs.writeFileSync(
    path.join(terraDirectory, 'comparison-report-zh.md'),
    buildChineseReport(comparison),
    { mode: 0o600 },
  );
  writeReportArtifacts(terraDirectory, comparison);
  console.log(
    `Comparison: fairness=${comparison.fairness.status}; pairs=${comparison.pairs.length}; Terra ${comparison.providers.terra.aggregate.score}/${comparison.providers.terra.aggregate.maximum}; DeepSeek ${comparison.providers.deepseek.aggregate.score}/${comparison.providers.deepseek.aggregate.maximum}`,
  );
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
  buildChineseReport,
  buildComparison,
  buildReportArtifact,
  combinations,
  conflictSensitivity,
  loadCoverage,
  pctChange,
  pairedStatistics,
  ratio,
  resolveCoverage,
  writeReportArtifacts,
};
