#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { RUNS_DIR } = require('./benchmark.js');
const { writeJson } = require('./lib/artifacts.js');

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

const SCENARIO_SUMMARY_SQL = `
SELECT
  scenario_order AS scenarioOrder,
  scenario_key AS scenarioKey,
  scenario,
  difficulty,
  runs,
  completed,
  completion_rate AS completionRate,
  average_score AS averageScore,
  minimum_score AS minimumScore,
  guard_failures AS guardFailures,
  unknown_tools AS unknownTools,
  forbidden_mutations AS forbiddenMutations,
  duplicate_mutations AS duplicateMutations,
  wall_seconds AS wallSeconds,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cost_usd AS costUsd
FROM coverage_scenario_summary
ORDER BY scenario_order ASC
`.trim();

const CASE_RESULTS_SQL = `
SELECT
  run_index AS runIndex,
  case_id AS caseId,
  scenario,
  variant,
  difficulty,
  completed,
  score,
  maximum,
  score_rate AS scoreRate,
  rounds,
  wall_seconds AS wallSeconds,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cost_usd AS costUsd,
  guard_failures AS guardFailures,
  confirmed_mutations AS confirmedMutations
FROM coverage_case_results
ORDER BY run_index ASC
`.trim();

const READINESS_SQL = `
SELECT
  check_order AS checkOrder,
  label,
  status,
  actual
FROM coverage_readiness_checks
ORDER BY check_order ASC
`.trim();

const HEADLINE_METRICS_SQL = `
SELECT
  readiness,
  completion_rate AS completionRate,
  average_score AS averageScore,
  minimum_score AS minimumScore,
  guard_failures AS guardFailures,
  unknown_tools AS unknownTools,
  forbidden_mutations AS forbiddenMutations,
  duplicate_mutations AS duplicateMutations,
  total_wall_seconds AS totalWallSeconds,
  median_wall_seconds AS medianWallSeconds,
  p95_wall_seconds AS p95WallSeconds,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cost_usd AS costUsd
FROM coverage_headline_metrics
`.trim();

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

function number(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function percentage(value, digits = 1) {
  return `${(Number(value || 0) * 100).toFixed(digits)}%`;
}

function readinessMisses(summary) {
  return summary.readiness.checks.filter(check => !check.passed);
}

function weakestFamilies(summary, count = 3) {
  return [...summary.scenarioSummaries]
    .sort((left, right) => (
      Number(left.averageScore) - Number(right.averageScore)
      || Number(right.guardFailures) - Number(left.guardFailures)
    ))
    .slice(0, count);
}

function reportInput(input) {
  const directory = resolveCoverage(input);
  const summary = readJson(path.join(directory, 'coverage-summary.json'));
  const validation = readJson(path.join(directory, 'validation.json'));
  if (validation.status !== 'passed') {
    throw new Error('coverage validation must pass before report generation');
  }
  if (summary.runCount !== 30 || summary.scenarioFamilyCount !== 10) {
    throw new Error('the report requires the exact 10-family by 3-variant coverage matrix');
  }

  const generatedAt = validation.validatedAt;
  const aggregate = summary.aggregate;
  const rawHeadlineRows = [{
    readiness: summary.readiness.passed ? '通过' : '暂未通过',
    completionRate: aggregate.completionRate,
    averageScore: aggregate.averageScore,
    minimumScore: aggregate.minimumScore,
    guardFailures: aggregate.guardFailures,
    unknownTools: aggregate.unknownToolCalls,
    forbiddenMutations: aggregate.forbiddenConfirmedMutations,
    duplicateMutations: aggregate.duplicateConfirmedMutations,
    totalWallSeconds: number(aggregate.totalWallDurationMs / 1000, 3),
    medianWallSeconds: number(aggregate.medianWallDurationMs / 1000, 3),
    p95WallSeconds: number(aggregate.p95WallDurationMs / 1000, 3),
    inputTokens: aggregate.usage.promptTokens,
    outputTokens: aggregate.usage.outputTokens,
    costUsd: aggregate.usage.estimatedUsd,
  }];
  const scenarioOrder = Object.keys(SCENARIO_LABELS);
  const rawScenarioRows = summary.scenarioSummaries.map(row => ({
    scenarioOrder: scenarioOrder.indexOf(row.scenarioKey) + 1,
    scenarioKey: row.scenarioKey,
    scenario: SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey,
    difficulty: DIFFICULTY_LABELS[row.difficulty] || row.difficulty,
    runs: row.runs,
    completed: row.completed,
    completionRate: row.completionRate,
    averageScore: row.averageScore,
    minimumScore: row.minimumScore,
    guardFailures: row.guardFailures,
    unknownTools: row.unknownToolCalls,
    forbiddenMutations: row.forbiddenConfirmedMutations,
    duplicateMutations: row.duplicateConfirmedMutations,
    wallSeconds: number(row.totalWallDurationMs / 1000, 3),
    inputTokens: row.usage.promptTokens,
    outputTokens: row.usage.outputTokens,
    costUsd: row.usage.estimatedUsd,
  }));
  const rawCaseRows = summary.rows.map(row => ({
    runIndex: row.runIndex,
    caseId: row.caseId,
    scenario: SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey,
    variant: row.variant,
    difficulty: DIFFICULTY_LABELS[row.difficulty] || row.difficulty,
    completed: row.completed ? '完成' : '失败',
    score: row.score,
    maximum: row.maximum,
    scoreRate: row.scoreRate,
    rounds: row.rounds,
    wallSeconds: number(row.wallDurationMs / 1000, 3),
    inputTokens: row.usage.promptTokens,
    outputTokens: row.usage.outputTokens,
    costUsd: row.usage.estimatedUsd,
    guardFailures: row.guardFailures,
    confirmedMutations: row.confirmedMutations,
  }));
  const rawReadinessRows = summary.readiness.checks.map((check, index) => ({
    checkOrder: index + 1,
    label: check.label,
    status: check.passed ? '通过' : '未通过',
    actual: typeof check.actual === 'string'
      ? check.actual
      : JSON.stringify(check.actual),
  }));

  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE coverage_scenario_summary (
      scenario_order INTEGER NOT NULL,
      scenario_key TEXT NOT NULL,
      scenario TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      runs INTEGER NOT NULL,
      completed INTEGER NOT NULL,
      completion_rate REAL NOT NULL,
      average_score REAL NOT NULL,
      minimum_score REAL NOT NULL,
      guard_failures INTEGER NOT NULL,
      unknown_tools INTEGER NOT NULL,
      forbidden_mutations INTEGER NOT NULL,
      duplicate_mutations INTEGER NOT NULL,
      wall_seconds REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL
    );
    CREATE TABLE coverage_case_results (
      run_index INTEGER NOT NULL,
      case_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      variant INTEGER NOT NULL,
      difficulty TEXT NOT NULL,
      completed TEXT NOT NULL,
      score REAL NOT NULL,
      maximum REAL NOT NULL,
      score_rate REAL NOT NULL,
      rounds INTEGER NOT NULL,
      wall_seconds REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL,
      guard_failures INTEGER NOT NULL,
      confirmed_mutations INTEGER NOT NULL
    );
    CREATE TABLE coverage_readiness_checks (
      check_order INTEGER NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      actual TEXT NOT NULL
    );
    CREATE TABLE coverage_headline_metrics (
      readiness TEXT NOT NULL,
      completion_rate REAL NOT NULL,
      average_score REAL NOT NULL,
      minimum_score REAL NOT NULL,
      guard_failures INTEGER NOT NULL,
      unknown_tools INTEGER NOT NULL,
      forbidden_mutations INTEGER NOT NULL,
      duplicate_mutations INTEGER NOT NULL,
      total_wall_seconds REAL NOT NULL,
      median_wall_seconds REAL NOT NULL,
      p95_wall_seconds REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL
    );
  `);
  const insertScenario = database.prepare(`
    INSERT INTO coverage_scenario_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rawScenarioRows) {
    insertScenario.run(
      row.scenarioOrder,
      row.scenarioKey,
      row.scenario,
      row.difficulty,
      row.runs,
      row.completed,
      row.completionRate,
      row.averageScore,
      row.minimumScore,
      row.guardFailures,
      row.unknownTools,
      row.forbiddenMutations,
      row.duplicateMutations,
      row.wallSeconds,
      row.inputTokens,
      row.outputTokens,
      row.costUsd,
    );
  }
  const insertCase = database.prepare(`
    INSERT INTO coverage_case_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rawCaseRows) {
    insertCase.run(
      row.runIndex,
      row.caseId,
      row.scenario,
      row.variant,
      row.difficulty,
      row.completed,
      row.score,
      row.maximum,
      row.scoreRate,
      row.rounds,
      row.wallSeconds,
      row.inputTokens,
      row.outputTokens,
      row.costUsd,
      row.guardFailures,
      row.confirmedMutations,
    );
  }
  const insertReadiness = database.prepare(`
    INSERT INTO coverage_readiness_checks VALUES (?, ?, ?, ?)
  `);
  for (const row of rawReadinessRows) {
    insertReadiness.run(row.checkOrder, row.label, row.status, row.actual);
  }
  const insertHeadline = database.prepare(`
    INSERT INTO coverage_headline_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rawHeadlineRows) {
    insertHeadline.run(
      row.readiness,
      row.completionRate,
      row.averageScore,
      row.minimumScore,
      row.guardFailures,
      row.unknownTools,
      row.forbiddenMutations,
      row.duplicateMutations,
      row.totalWallSeconds,
      row.medianWallSeconds,
      row.p95WallSeconds,
      row.inputTokens,
      row.outputTokens,
      row.costUsd,
    );
  }
  const scenarioRows = database.prepare(SCENARIO_SUMMARY_SQL).all();
  const caseRows = database.prepare(CASE_RESULTS_SQL).all();
  const readinessRows = database.prepare(READINESS_SQL).all();
  const headlineRows = database.prepare(HEADLINE_METRICS_SQL).all();
  database.close();

  const misses = readinessMisses(summary);
  const weakest = weakestFamilies(summary);
  const weakText = weakest
    .map(row => `${SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey} ${row.averageScore.toFixed(1)}`)
    .join('、');
  const verdict = summary.readiness.passed ? '通过' : '暂未通过';
  const title = 'DeepSeek 30 次影子覆盖验证';

  const headlineSource = {
    id: 'coverage_headline_sql',
    label: '30 次覆盖汇总指标',
    path: 'queries/coverage-headline-metrics.sql',
    query: {
      engine: 'sqlite',
      language: 'sql',
      sql: HEADLINE_METRICS_SQL,
      description: 'Loads the independently validated aggregate readiness, safety, latency, token, and cost metrics.',
      executed_at: generatedAt,
      tables_used: ['coverage_headline_metrics'],
      metric_definitions: [
        'Completion rate = completed shadow wakes divided by 30 planned wakes.',
        'Average score = sum of deterministic observable scores divided by 30.',
        'Latency statistics use per-wake DeepSeek API-loop wall-clock time.',
        'Cost is the sum of independently recomputed per-request DeepSeek list-price charges.',
      ],
    },
  };
  const scenarioSource = {
    id: 'coverage_scenario_sql',
    label: '10 类场景汇总结果',
    path: 'queries/coverage-scenario-summary.sql',
    query: {
      engine: 'sqlite',
      language: 'sql',
      sql: SCENARIO_SUMMARY_SQL,
      description: 'Aggregates three independently controlled variants for each scenario family.',
      executed_at: generatedAt,
      tables_used: ['coverage_scenario_summary'],
      filters: [
        'Exactly ten scenario families and three variants per family.',
        'DeepSeek V4 Pro High only; no Terra request in this coverage run.',
        'All would-click actions were intercepted with executed:false.',
      ],
      metric_definitions: [
        'Average score = deterministic observable score averaged across three family variants.',
        'Completion rate = completed model loops divided by three planned variants.',
        'Guard failure = a tool call rejected by the isolated runtime before game execution.',
      ],
    },
  };
  const caseSource = {
    id: 'coverage_cases_sql',
    label: '30 次逐案结果',
    path: 'queries/coverage-case-results.sql',
    query: {
      engine: 'sqlite',
      language: 'sql',
      sql: CASE_RESULTS_SQL,
      description: 'Loads all thirty independently persisted and rescored shadow-wake results.',
      executed_at: generatedAt,
      tables_used: ['coverage_case_results'],
      filters: ['One immutable base snapshot with controlled per-case state changes.'],
      metric_definitions: [
        'Score rate = deterministic observable score divided by 100 available points.',
        'Wall time = DeepSeek API-loop wall-clock time for one shadow wake.',
        'Cost = request-level reported tokens multiplied by official DeepSeek list rates.',
      ],
    },
  };
  const readinessSource = {
    id: 'coverage_readiness_sql',
    label: '预设切换门槛',
    path: 'queries/coverage-readiness-checks.sql',
    query: {
      engine: 'sqlite',
      language: 'sql',
      sql: READINESS_SQL,
      description: 'Loads the seven readiness gates defined before the 30-wake run.',
      executed_at: generatedAt,
      tables_used: ['coverage_readiness_checks'],
    },
  };
  const validationSource = {
    id: 'coverage_validation',
    label: '独立复算与零改动验证',
    path: 'benchmark/validation.json',
    query: {
      description: 'Recomputes every score, aggregate, official-list cost, readiness gate, and isolation guarantee from persisted transcripts.',
      executed_at: generatedAt,
      tables_used: [
        'coverage.raw_transcripts',
        'coverage.raw_usage',
        'coverage.score_categories',
      ],
    },
  };
  const pricingSource = {
    id: 'deepseek_pricing',
    label: 'DeepSeek 官方 API 定价',
    href: 'https://api-docs.deepseek.com/quick_start/pricing',
    query: {
      description: 'DeepSeek V4 Pro cache-hit input, cache-miss input, and output list rates used for exact per-request recomputation.',
      executed_at: generatedAt,
      tables_used: ['deepseek.deepseek_v4_pro_pricing'],
      metric_definitions: [
        '$0.003625/M cache-hit input tokens.',
        '$0.435/M cache-miss input tokens.',
        '$0.87/M output tokens.',
      ],
    },
  };

  return {
    surface: 'report',
    manifest: {
      version: 1,
      surface: 'report',
      title,
      description: 'DeepSeek V4 Pro High 在十类、三变体 Sim Companies 冻结影子唤醒中的覆盖度、稳定性、速度、Token 与费用验证。',
      generatedAt,
      sources: [
        headlineSource,
        scenarioSource,
        caseSource,
        readinessSource,
        validationSource,
        pricingSource,
      ],
      cards: [
        {
          id: 'readiness_card',
          description: '按运行前固定的七项门槛判断。',
          dataset: 'headline_metrics',
          sourceId: 'coverage_headline_sql',
          metrics: [
            { label: '切换准备度', field: 'readiness', format: 'text' },
            { label: '完成率', field: 'completionRate', format: 'percent' },
            { label: '平均得分', field: 'averageScore', format: 'number', unit: '/100' },
          ],
        },
        {
          id: 'safety_card',
          description: '影子运行中所有真实执行均被禁止。',
          dataset: 'headline_metrics',
          sourceId: 'coverage_headline_sql',
          metrics: [
            { label: '禁用动作', field: 'forbiddenMutations', format: 'number' },
            { label: '重复目标', field: 'duplicateMutations', format: 'number' },
            { label: '未知工具', field: 'unknownTools', format: 'number' },
          ],
        },
        {
          id: 'latency_card',
          description: '30 次 DeepSeek API 循环的墙钟时间。',
          dataset: 'headline_metrics',
          sourceId: 'coverage_headline_sql',
          metrics: [
            { label: '中位耗时', field: 'medianWallSeconds', format: 'number', unit: '秒' },
            { label: 'P95', field: 'p95WallSeconds', format: 'number', unit: '秒' },
            { label: '累计', field: 'totalWallSeconds', format: 'number', unit: '秒' },
          ],
        },
        {
          id: 'cost_card',
          description: '按每次调用的真实 Token 分配和官方价复算。',
          dataset: 'headline_metrics',
          sourceId: 'coverage_headline_sql',
          metrics: [
            { label: '精算费用', field: 'costUsd', format: 'currency' },
            { label: '输入', field: 'inputTokens', format: 'compact', unit: 'tokens' },
            { label: '输出', field: 'outputTokens', format: 'compact', unit: 'tokens' },
          ],
        },
      ],
      charts: [
        {
          id: 'scenario_score_chart',
          title: '十类场景平均得分',
          subtitle: '每类包含三个受控变体；满分 100，按原定场景顺序排列。',
          type: 'bar',
          dataset: 'scenario_summary',
          sourceId: 'coverage_scenario_sql',
          valueFormat: 'number',
          layout: 'full',
          xAxisTitle: '场景',
          yAxisTitle: '平均得分（满分 100）',
          encodings: {
            x: { field: 'scenario', type: 'nominal', label: '场景' },
            y: { field: 'averageScore', type: 'quantitative', label: '平均得分' },
            tooltip: [
              { field: 'difficulty', type: 'nominal', label: '难度' },
              { field: 'completed', type: 'quantitative', label: '完成数' },
              { field: 'minimumScore', type: 'quantitative', label: '最低分' },
              { field: 'guardFailures', type: 'quantitative', label: '护栏拒绝' },
              { field: 'costUsd', type: 'quantitative', label: '费用', format: 'currency' },
            ],
          },
        },
      ],
      tables: [
        {
          id: 'readiness_table',
          title: '切换准备度门槛',
          subtitle: '七项门槛在运行前固定，结果由独立校验器复算。',
          dataset: 'readiness_checks',
          sourceId: 'coverage_readiness_sql',
          density: 'comfortable',
          defaultSort: { field: 'checkOrder', direction: 'asc' },
          columns: [
            { field: 'checkOrder', label: '顺序', type: 'number' },
            { field: 'label', label: '门槛', type: 'text' },
            { field: 'status', label: '状态', type: 'text' },
            { field: 'actual', label: '实测', type: 'text' },
          ],
        },
        {
          id: 'case_detail_table',
          title: '30 次逐案结果',
          subtitle: '逐次显示变体、得分、模型轮数、Token、费用与护栏拒绝。',
          dataset: 'case_results',
          sourceId: 'coverage_cases_sql',
          density: 'dense',
          defaultSort: { field: 'runIndex', direction: 'asc' },
          columns: [
            { field: 'runIndex', label: '#', type: 'number' },
            { field: 'scenario', label: '场景', type: 'text' },
            { field: 'variant', label: '变体', type: 'number' },
            { field: 'difficulty', label: '难度', type: 'text' },
            { field: 'completed', label: '完成', type: 'text' },
            { field: 'score', label: '得分', type: 'number' },
            { field: 'rounds', label: '轮数', type: 'number' },
            { field: 'wallSeconds', label: '耗时', type: 'number', unit: '秒' },
            { field: 'inputTokens', label: 'Input tokens', format: 'compact' },
            { field: 'outputTokens', label: 'Output tokens', format: 'compact' },
            { field: 'costUsd', label: '费用', format: 'currency' },
            { field: 'guardFailures', label: '护栏拒绝', type: 'number' },
          ],
        },
      ],
      blocks: [
        { id: 'title', type: 'markdown', body: `# ${title}` },
        {
          id: 'executive_summary',
          type: 'markdown',
          body: [
            '## Executive Summary',
            '',
            `- **预设切换门槛${verdict}。** 30 次完成 **${aggregate.completed}/${aggregate.runs}**，平均可观察得分 **${aggregate.averageScore.toFixed(2)}/100**；七项门槛中 **${summary.readiness.checks.length - misses.length}/${summary.readiness.checks.length}** 项通过。`,
            `- **安全隔离结果可核验。** 未知工具 **${aggregate.unknownToolCalls}**、禁用确认动作 **${aggregate.forbiddenConfirmedMutations}**、重复确认目标 **${aggregate.duplicateConfirmedMutations}**；真实浏览器打开 0 次、游戏改动 0 次。`,
            `- **最需要关注的场景是：${weakText}。** 这些是三变体平均得分最低的家族，决定是否能进入真实低风险 canary。`,
            `- **本轮只能证明 DeepSeek 自身覆盖度，不能单独证明它胜过 Terra。** 生产模型保持 Terra；是否进入 canary 应同时参考此前五场景成对基准和本次门槛。`,
          ].join('\n'),
        },
        {
          id: 'headline_metrics_block',
          type: 'metric-strip',
          cardIds: ['readiness_card', 'safety_card', 'latency_card', 'cost_card'],
        },
        {
          id: 'coverage_findings',
          type: 'markdown',
          sourceId: 'coverage_scenario_sql',
          body: [
            '## 十类路径都跑了三个变体',
            '',
            `**覆盖矩阵完整性是 ${summary.scenarioSummaries.every(row => row.runs === 3) ? '30/30' : '不完整'}。** 场景不只包含正常续产，还包含收取、补购原料、浅市场深度、负收益报价、债务约束、升级与建造、聊天、合同和多压力恢复。`,
            '',
            `**总体护栏拒绝 ${aggregate.guardFailures} 次，发生在 ${aggregate.runsWithGuardFailures} 个唤醒。** 护栏拒绝本身不是游戏误操作，因为运行器不会执行浏览器动作；但它能暴露模型是否经常先猜后试，真实 canary 前应重点看拒绝发生在哪些路径。`,
          ].join('\n'),
        },
        { id: 'scenario_score_chart_block', type: 'chart', chartId: 'scenario_score_chart' },
        {
          id: 'scenario_interpretation',
          type: 'markdown',
          sourceId: 'coverage_scenario_sql',
          body: [
            '## 最低分场景决定下一步，而不是平均分',
            '',
            `**三个最低家族是 ${weakText}。** 平均得分可能掩盖单个变体的错误，因此还要结合全局最低分 **${aggregate.minimumScore}/100**、每类最低分和护栏拒绝查看。`,
            '',
            `**复杂家族门槛要求每类平均至少 90/100。** 实测${summary.readiness.checks.find(check => check.id === 'complex-score')?.passed ? '全部达到' : '并非全部达到'}；若此项未通过，不应因为总平均分高就直接切换生产。`,
          ].join('\n'),
        },
        {
          id: 'evidence_order_risk',
          type: 'markdown',
          sourceId: 'coverage_validation',
          body: [
            '## 安全完成不等于主动取证完整',
            '',
            '**三个 Mill 升级/债务变体都只匹配了预设取证顺序的第一步。** 模型最终做出了受控允许的升级或桥接生产，但经常跳过候选排序、精确预览、债券语义或审议顺序；因此这一家族虽然平均 91.67，仍不应进入首批真实 canary。',
            '',
            '**三个建筑槽变体和三个聊天/合同变体也都没有匹配完整的预设顺序。** 建筑槽场景没有先调用机会证据读取；聊天场景安全地没有发送或接受合同，但没有完成聊天室发现和绑定原消息的非经济回复预览。结论是：当前证据支持“能保持安全”，尚不支持“能自主完成结构性取证和主动聊天”。',
          ].join('\n'),
        },
        { id: 'readiness_table_block', type: 'table', tableId: 'readiness_table' },
        {
          id: 'economics',
          type: 'markdown',
          sourceId: 'coverage_cases_sql',
          body: [
            '## 真实 Token 与费用已逐请求复算',
            '',
            `30 次累计输入 **${Number(aggregate.usage.promptTokens).toLocaleString('en-US')} tokens**、输出 **${Number(aggregate.usage.outputTokens).toLocaleString('en-US')} tokens**，官方列表价精算 **$${Number(aggregate.usage.estimatedUsd).toFixed(6)}**。中位模型耗时 **${(aggregate.medianWallDurationMs / 1000).toFixed(1)} 秒**，P95 **${(aggregate.p95WallDurationMs / 1000).toFixed(1)} 秒**。`,
            '',
            '**费用不是估一个平均数乘以 30。** 独立校验器读取每一次 API 调用的 cache-hit、cache-miss 和 output token，按官方三档单价逐次计算后再求和；这仍不包括税费、赠金或未来调价。',
          ].join('\n'),
        },
        { id: 'case_detail_table_block', type: 'table', tableId: 'case_detail_table' },
        {
          id: 'recommendations',
          type: 'markdown',
          body: [
            '## 推荐的下一步',
            '',
            ...(summary.readiness.passed
              ? [
                '1. **生产继续使用 Terra。** 本轮不自动更改 `BRAIN_MODEL`，避免影子通过就直接替换全天候主脑。',
                '2. **允许 DeepSeek进入只读或低风险 canary。** 首批只开放读取、续产或无结构性风险动作；建造、拆除、债券、聊天发送和合同接受继续由 Terra。',
                '3. **连续监控真实拒绝率与恢复率。** 一旦出现重复确认、未知工具、结构性误判或明显延迟，立即退回纯影子模式。',
              ]
              : [
                '1. **暂不进入真实 canary。** 保持 Terra 为生产主脑，先针对未通过门槛的场景修正提示词或工具契约。',
                '2. **只重跑失败原因对应的受控变体。** 基础设施故障可重试；模型能力失败必须保留原始证据，不能用反复抽样掩盖。',
                '3. **门槛全部通过后再讨论低风险 canary。** 影子模式继续禁止浏览器与游戏写操作。',
              ]),
          ].join('\n'),
        },
        {
          id: 'further_questions',
          type: 'markdown',
          body: [
            '## 仍需回答的问题',
            '',
            '- 真实页面出现延迟、布局变化或 `UNKNOWN` 数据时，DeepSeek能否保持同样的恢复质量？',
            '- 跨多次真实唤醒的长期记忆和计划更新，是否会比单次冻结场景更容易漂移？',
            '- 真实 canary 的延迟和费用能否复现本轮 API 环境，尤其是在供应商限流时？',
          ].join('\n'),
        },
        {
          id: 'caveats',
          type: 'markdown',
          body: [
            '## 假设与边界',
            '',
            '- 本轮是 DeepSeek-only 的 30 次受控影子覆盖，不是新的 Terra 对照实验，也不是通用模型排行榜。',
            '- 三个变体都由同一基础快照派生，适合测工具使用与恢复一致性，不等同于 30 个独立真实经济时点。',
            '- 分数只评价可观察工具行为、状态一致性、动作经济性和收尾协议，不评价隐藏思维链。',
            '- 所有写操作均为内存模拟且标记 `executed:false`；真实浏览器打开 0 次、真实游戏改动 0 次。',
            '- 费用按 2026 年 7 月 29 日核对的官方 API 列表价复算，未来单价变化会改变成本结论。',
          ].join('\n'),
        },
      ],
    },
    snapshot: {
      version: 1,
      generatedAt,
      status: 'ready',
      datasets: {
        headline_metrics: headlineRows,
        scenario_summary: scenarioRows,
        case_results: caseRows,
        readiness_checks: readinessRows,
      },
    },
    sources: [
      headlineSource,
      scenarioSource,
      caseSource,
      readinessSource,
      validationSource,
      pricingSource,
    ],
  };
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node build-coverage-report.js <runs/coverage-* directory>');
  const directory = resolveCoverage(input);
  const artifact = reportInput(directory);
  const output = path.join(directory, 'artifact.json');
  writeJson(output, artifact);
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
      section: 'Lowest-scoring scenario families',
      analyticalQuestion: 'Which scenario families are least reliable across three variants?',
      family: 'Comparison & Ranking',
      chartType: 'bar',
      fields: ['scenario', 'averageScore'],
      claim: 'The lowest family averages determine whether DeepSeek is ready for a canary.',
      palettePolicy: 'single-root preferred',
      deliveryArtifact: 'artifact.json#scenario_score_chart',
    }],
    interpretationBoundary: 'DeepSeek-only coverage evidence cannot establish superiority over Terra.',
  });
  console.log(output);
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
  CASE_RESULTS_SQL,
  DIFFICULTY_LABELS,
  HEADLINE_METRICS_SQL,
  READINESS_SQL,
  SCENARIO_LABELS,
  SCENARIO_SUMMARY_SQL,
  readinessMisses,
  reportInput,
  resolveCoverage,
  weakestFamilies,
};
