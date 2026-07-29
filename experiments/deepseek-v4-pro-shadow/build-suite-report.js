#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { RUNS_DIR } = require('./benchmark.js');
const { writeJson } = require('./lib/artifacts.js');

const SCENARIO_LABELS = Object.freeze({
  'all-busy': '全部忙碌',
  'idle-mill': 'Mill 空闲恢复',
  'utility-surplus': '电力余量出售',
  'prospector-ready': 'Prospector rebuild',
  'multi-pressure': '多压力综合',
});

const DIFFICULTY_LABELS = Object.freeze({
  simple: '简单',
  medium: '中等',
  complex: '复杂',
});

const SCENARIO_RESULTS_SQL = `
SELECT
  scenario_order AS scenarioOrder,
  scenario_key AS scenarioKey,
  scenario,
  difficulty,
  provider,
  score,
  maximum,
  score_rate AS scoreRate,
  rounds,
  wall_seconds AS wallSeconds,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cost_usd AS costUsd,
  guard_failures AS guardFailures,
  confirmed_mutations AS confirmedMutations,
  completed
FROM benchmark_scenario_results
ORDER BY scenario_order ASC, provider DESC
`.trim();

const PROVIDER_SUMMARY_SQL = `
SELECT
  provider,
  completed_scenarios AS completedScenarios,
  total_scenarios AS totalScenarios,
  score,
  maximum,
  score_rate AS scoreRate,
  rounds,
  wall_seconds AS wallSeconds,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  cost_usd AS costUsd
FROM benchmark_provider_aggregates
ORDER BY provider DESC
`.trim();

const HEADLINE_METRICS_SQL = `
WITH paired AS (
  SELECT
    MAX(CASE WHEN provider = 'Terra' THEN score_rate END) AS terra_score_rate,
    MAX(CASE WHEN provider = 'DeepSeek' THEN score_rate END) AS deepseek_score_rate,
    MAX(CASE WHEN provider = 'Terra' THEN wall_seconds END) AS terra_wall_seconds,
    MAX(CASE WHEN provider = 'DeepSeek' THEN wall_seconds END) AS deepseek_wall_seconds,
    MAX(CASE WHEN provider = 'Terra' THEN cost_usd END) AS terra_cost_usd,
    MAX(CASE WHEN provider = 'DeepSeek' THEN cost_usd END) AS deepseek_cost_usd,
    MAX(CASE WHEN provider = 'Terra' THEN input_tokens END) AS terra_input_tokens,
    MAX(CASE WHEN provider = 'DeepSeek' THEN input_tokens END) AS deepseek_input_tokens,
    MAX(CASE WHEN provider = 'Terra' THEN output_tokens END) AS terra_output_tokens,
    MAX(CASE WHEN provider = 'DeepSeek' THEN output_tokens END) AS deepseek_output_tokens
  FROM benchmark_provider_aggregates
)
SELECT
  terra_score_rate AS terraScoreRate,
  deepseek_score_rate AS deepseekScoreRate,
  (terra_score_rate - deepseek_score_rate) * 100.0 AS scoreGapPoints,
  terra_wall_seconds AS terraWallSeconds,
  deepseek_wall_seconds AS deepseekWallSeconds,
  deepseek_wall_seconds / NULLIF(terra_wall_seconds, 0) AS deepseekLatencyRatio,
  deepseek_cost_usd AS deepseekCostUsd,
  terra_cost_usd AS terraCostUsd,
  terra_cost_usd / NULLIF(deepseek_cost_usd, 0) AS terraCostRatio,
  terra_input_tokens AS terraInputTokens,
  deepseek_input_tokens AS deepseekInputTokens,
  (deepseek_input_tokens - terra_input_tokens) * 1.0 / NULLIF(terra_input_tokens, 0) AS inputDeltaRate,
  terra_output_tokens AS terraOutputTokens,
  deepseek_output_tokens AS deepseekOutputTokens,
  deepseek_output_tokens * 1.0 / NULLIF(terra_output_tokens, 0) AS outputRatio
FROM paired
`.trim();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveSuite(input) {
  const resolved = path.resolve(input);
  const root = `${path.resolve(RUNS_DIR)}${path.sep}`;
  if (!`${resolved}${path.sep}`.startsWith(root)) {
    throw new Error('suite directory must remain inside the ignored runs directory');
  }
  return resolved;
}

function ratio(numerator, denominator) {
  return Number(denominator) > 0 ? Number((Number(numerator) / Number(denominator)).toFixed(4)) : null;
}

function reportInput(input) {
  const directory = resolveSuite(input);
  const suite = readJson(path.join(directory, 'suite-comparison.json'));
  const validation = readJson(path.join(directory, 'validation.json'));
  if (validation.status !== 'passed') throw new Error('suite validation must pass before report generation');
  const terra = suite.aggregates.find(row => row.provider === 'terra');
  const deepseek = suite.aggregates.find(row => row.provider === 'deepseek');
  if (!terra || !deepseek) throw new Error('both provider aggregates are required');
  const costRatio = ratio(terra.usage.estimatedUsd, deepseek.usage.estimatedUsd);
  const latencyRatio = ratio(deepseek.totalWallDurationMs, terra.totalWallDurationMs);
  const outputRatio = ratio(deepseek.usage.outputTokens, terra.usage.outputTokens);
  const inputDeltaRate = ratio(
    deepseek.usage.promptTokens - terra.usage.promptTokens,
    terra.usage.promptTokens,
  );
  const generatedAt = validation.validatedAt;
  const scenarioOrder = Object.keys(SCENARIO_LABELS);
  const rawScenarioRows = suite.scenarioRows.map(row => {
    const score = readJson(path.join(
      directory,
      'scenarios',
      row.scenarioKey,
      row.provider,
      'score.json',
    ));
    return {
      scenarioOrder: scenarioOrder.indexOf(row.scenarioKey) + 1,
      scenarioKey: row.scenarioKey,
      scenario: SCENARIO_LABELS[row.scenarioKey] || row.scenarioKey,
      difficulty: DIFFICULTY_LABELS[row.difficulty] || row.difficulty,
      provider: row.provider === 'terra' ? 'Terra' : 'DeepSeek',
      score: row.score,
      maximum: row.maximum,
      scoreRate: row.maximum > 0 ? row.score / row.maximum : null,
      rounds: row.rounds,
      wallSeconds: Number((row.wallDurationMs / 1000).toFixed(3)),
      inputTokens: row.usage.promptTokens,
      outputTokens: row.usage.outputTokens,
      costUsd: row.usage.estimatedUsd,
      guardFailures: score.evidence.guardFailures,
      confirmedMutations: score.evidence.confirmedMutations,
      completed: row.completed,
    };
  });
  const rawProviderRows = [terra, deepseek].map(row => ({
    provider: row.provider === 'terra' ? 'Terra' : 'DeepSeek',
    completedScenarios: row.completedScenarios,
    totalScenarios: row.totalScenarios,
    score: row.totalScore,
    maximum: row.maximum,
    scoreRate: row.scorePct / 100,
    rounds: row.totalRounds,
    wallSeconds: Number((row.totalWallDurationMs / 1000).toFixed(3)),
    inputTokens: row.usage.promptTokens,
    outputTokens: row.usage.outputTokens,
    costUsd: row.usage.estimatedUsd,
  }));
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE benchmark_scenario_results (
      scenario_order INTEGER NOT NULL,
      scenario_key TEXT NOT NULL,
      scenario TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      provider TEXT NOT NULL,
      score REAL NOT NULL,
      maximum REAL NOT NULL,
      score_rate REAL NOT NULL,
      rounds INTEGER NOT NULL,
      wall_seconds REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      guard_failures INTEGER NOT NULL,
      confirmed_mutations INTEGER NOT NULL,
      completed INTEGER NOT NULL
    );
    CREATE TABLE benchmark_provider_aggregates (
      provider TEXT NOT NULL,
      completed_scenarios INTEGER NOT NULL,
      total_scenarios INTEGER NOT NULL,
      score REAL NOT NULL,
      maximum REAL NOT NULL,
      score_rate REAL NOT NULL,
      rounds INTEGER NOT NULL,
      wall_seconds REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL
    );
  `);
  const insertScenario = database.prepare(`
    INSERT INTO benchmark_scenario_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rawScenarioRows) {
    insertScenario.run(
      row.scenarioOrder,
      row.scenarioKey,
      row.scenario,
      row.difficulty,
      row.provider,
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
      row.completed ? 1 : 0,
    );
  }
  const insertProvider = database.prepare(`
    INSERT INTO benchmark_provider_aggregates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rawProviderRows) {
    insertProvider.run(
      row.provider,
      row.completedScenarios,
      row.totalScenarios,
      row.score,
      row.maximum,
      row.scoreRate,
      row.rounds,
      row.wallSeconds,
      row.inputTokens,
      row.outputTokens,
      row.costUsd,
    );
  }
  const scenarioRows = database.prepare(SCENARIO_RESULTS_SQL).all();
  const providerRows = database.prepare(PROVIDER_SUMMARY_SQL).all();
  const headlineRows = database.prepare(HEADLINE_METRICS_SQL).all();
  database.close();

  const title = 'Sim Companies 多场景模型基准';
  const scenarioSource = {
    id: 'scenario_results_sql',
    label: '分场景冻结影子基准结果',
    path: 'queries/scenario-results.sql',
    query: {
      engine: 'sqlite',
      language: 'sql',
      sql: SCENARIO_RESULTS_SQL,
      description: 'Loads the ten independently rescored provider-by-scenario result rows.',
      executed_at: generatedAt,
      tables_used: ['benchmark_scenario_results'],
      filters: [
        'Five controlled scenarios from one immutable business snapshot.',
        'Both models used High reasoning and the same semantic tool names.',
        'All browser and game mutations were intercepted with executed:false.',
      ],
      metric_definitions: [
        'Scenario score = provider-neutral deterministic observable score out of 100.',
        'Guard failure = a model tool call rejected before any game execution.',
        'Confirmed mutation = a validated would-click intent with executed:false.',
        'Wall time = provider API loop duration for that scenario.',
        'Input and output tokens = sums of provider-reported usage for every request.',
        'Cost = per-request token allocation multiplied by official Standard/API list rates, then summed.',
      ],
    },
  };
  const headlineSource = {
    id: 'headline_metrics_sql',
    label: '模型汇总指标',
    path: 'queries/headline-metrics.sql',
    query: {
      engine: 'sqlite',
      language: 'sql',
      sql: HEADLINE_METRICS_SQL,
      description: 'Pivots the two independently validated provider aggregates into one headline row.',
      executed_at: generatedAt,
      tables_used: ['benchmark_provider_aggregates'],
      filters: ['Exactly Terra and DeepSeek across the same five scenarios.'],
      metric_definitions: [
        'Score rate = deterministic observable score divided by 500 available points.',
        'Latency ratio = DeepSeek cumulative wall time divided by Terra cumulative wall time.',
        'Cost ratio = Terra exact list-price cost divided by DeepSeek exact list-price cost.',
        'Output ratio = DeepSeek output tokens divided by Terra output tokens.',
      ],
    },
  };
  const validationSource = {
    id: 'suite_validation',
    label: '独立复算与隔离验证',
    path: 'benchmark/validation.json',
    query: {
      description: 'Independently recomputes scores, tokens, latency, official list-price cost, snapshot hashes, and zero-mutation guarantees.',
      executed_at: generatedAt,
      tables_used: ['benchmark.raw_transcripts', 'benchmark.raw_usage', 'benchmark.score_categories'],
      filters: ['85 deterministic checks; all passed.'],
      metric_definitions: [
        'Guard failure = a model tool call rejected by the isolated runtime before any game execution.',
        'Confirmed mutation = a validated would-click intent with executed:false inside the shadow runtime.',
      ],
    },
  };
  const pricingSource = {
    id: 'official_pricing',
    label: '官方 API 定价',
    href: 'https://openai.com/api/pricing/',
    query: {
      description: 'OpenAI GPT-5.6 Terra and DeepSeek V4 Pro official list prices checked on July 29, 2026.',
      executed_at: generatedAt,
      tables_used: ['openai.gpt_5_6_terra_pricing', 'deepseek.deepseek_v4_pro_pricing'],
      metric_definitions: [
        'Terra short-context Standard: $2.50/M uncached input, $0.25/M cached input, $3.125/M cache writes, $15/M output.',
        'DeepSeek V4 Pro: $0.003625/M cache-hit input, $0.435/M cache-miss input, $0.87/M output.',
      ],
    },
  };

  return {
    surface: 'report',
    manifest: {
      version: 1,
      surface: 'report',
      title,
      description: 'Terra High 与 DeepSeek V4 Pro High 在五个 Sim Companies 冻结影子场景中的能力、速度、Token 和费用对比。',
      generatedAt,
      sources: [scenarioSource, headlineSource, validationSource, pricingSource],
      cards: [
        {
          id: 'capability_card',
          description: '五个场景的确定性可观察总得分。',
          dataset: 'headline_metrics',
          sourceId: 'headline_metrics_sql',
          metrics: [
            { label: 'Terra 得分率', field: 'terraScoreRate', format: 'percent' },
            { label: 'DeepSeek', field: 'deepseekScoreRate', format: 'percent' },
            { label: '差距', field: 'scoreGapPoints', format: 'number', unit: '百分点', signed: true },
          ],
        },
        {
          id: 'latency_card',
          description: '五个场景的累计模型调用耗时。',
          dataset: 'headline_metrics',
          sourceId: 'headline_metrics_sql',
          metrics: [
            { label: 'Terra 累计耗时', field: 'terraWallSeconds', format: 'number', unit: '秒' },
            { label: 'DeepSeek', field: 'deepseekWallSeconds', format: 'number', unit: '秒' },
            { label: 'DeepSeek/Terra', field: 'deepseekLatencyRatio', format: 'number', unit: '×' },
          ],
        },
        {
          id: 'cost_card',
          description: '按每次调用的官方标准定价和实际缓存分配精算。',
          dataset: 'headline_metrics',
          sourceId: 'headline_metrics_sql',
          metrics: [
            { label: 'DeepSeek 总费用', field: 'deepseekCostUsd', format: 'currency' },
            { label: 'Terra', field: 'terraCostUsd', format: 'currency' },
            { label: 'Terra/DeepSeek', field: 'terraCostRatio', format: 'number', unit: '×' },
          ],
        },
        {
          id: 'token_card',
          description: '输入几乎相同，但 DeepSeek 生成了更多输出 Token。',
          dataset: 'headline_metrics',
          sourceId: 'headline_metrics_sql',
          metrics: [
            { label: 'DeepSeek 输出', field: 'deepseekOutputTokens', format: 'compact', unit: 'tokens' },
            { label: 'Terra 输出', field: 'terraOutputTokens', format: 'compact', unit: 'tokens' },
            { label: 'DeepSeek/Terra', field: 'outputRatio', format: 'number', unit: '×' },
          ],
        },
      ],
      charts: [
        {
          id: 'scenario_score_chart',
          title: '各场景模型得分',
          subtitle: '两者五场景均完成；最大分歧出现在“全部忙碌”和“多压力综合”。',
          type: 'bar',
          dataset: 'scenario_results',
          sourceId: 'scenario_results_sql',
          valueFormat: 'number',
          layout: 'full',
          xAxisTitle: '场景',
          yAxisTitle: '得分（满分 100）',
          encodings: {
            x: { field: 'scenario', type: 'nominal', label: '场景' },
            y: { field: 'score', type: 'quantitative', label: '得分' },
            color: { field: 'provider', type: 'nominal', label: '模型' },
            tooltip: [
              { field: 'difficulty', type: 'nominal', label: '难度' },
              { field: 'rounds', type: 'quantitative', label: '轮数' },
              { field: 'guardFailures', type: 'quantitative', label: '护栏拒绝' },
              { field: 'costUsd', type: 'quantitative', label: '费用', format: 'currency' },
            ],
          },
        },
      ],
      tables: [
        {
          id: 'scenario_detail_table',
          title: '分场景精确结果',
          subtitle: '五个成对场景；费用为官方标准价精算，耗时为模型 API 循环墙钟时间。',
          dataset: 'scenario_results',
          sourceId: 'scenario_results_sql',
          density: 'comfortable',
          defaultSort: { field: 'scenarioOrder', direction: 'asc' },
          columns: [
            { field: 'scenarioOrder', label: '顺序', type: 'number' },
            { field: 'scenario', label: '场景', type: 'text' },
            { field: 'difficulty', label: '难度', type: 'text' },
            { field: 'provider', label: '模型', type: 'text' },
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
            `- **能力几乎持平。** Terra 得到 **${terra.totalScore}/500（${terra.scorePct.toFixed(1)}%）**，DeepSeek 得到 **${deepseek.totalScore}/500（${deepseek.scorePct.toFixed(1)}%）**；差距只有 **${(terra.scorePct - deepseek.scorePct).toFixed(1)} 个百分点**，不足以单凭这一次套件宣布能力碾压。`,
            `- **Terra 明显更快。** Terra 累计模型耗时 **${(terra.totalWallDurationMs / 1000).toFixed(1)} 秒**，DeepSeek **${(deepseek.totalWallDurationMs / 1000).toFixed(1)} 秒**；DeepSeek 约慢 **${latencyRatio.toFixed(2)}×**。`,
            `- **DeepSeek 明显更便宜。** DeepSeek 五场景精算费用 **$${deepseek.usage.estimatedUsd.toFixed(5)}**，Terra **$${terra.usage.estimatedUsd.toFixed(5)}**；Terra 约贵 **${costRatio.toFixed(2)}×**。`,
            '- **当前建议：生产继续用 Terra，DeepSeek 进入扩大影子验证。** Terra 在“全部忙碌”的克制和复杂综合场景更稳；DeepSeek 在简单恢复与 Prospector 场景用更少轮数完成，而且成本优势巨大，值得继续验证后再决定是否小流量切换。',
          ].join('\n'),
        },
        {
          id: 'headline_metrics_block',
          type: 'metric-strip',
          cardIds: ['capability_card', 'latency_card', 'cost_card', 'token_card'],
        },
        {
          id: 'score_findings',
          type: 'markdown',
          sourceId: 'scenario_results_sql',
          body: [
            '## 能力相近，但错误形态不同',
            '',
            '**两者都完成了五个场景和全部必要收尾，说明 DeepSeek 并非“便宜但做不完”。** Terra 在全部忙碌场景以 100:97 领先，在复杂综合场景以 97:94 领先；DeepSeek 在 Mill 空闲恢复和 Prospector 场景各以 97:95 领先，电力余量出售双方均为 100。',
            '',
            '**差别主要来自无效尝试和动作节奏。** Terra 共出现 3 次无必要 `collect`；DeepSeek共出现 6 次护栏拒绝，其中复杂场景有一次生产时长仅超出目标约 0.004 小时，以及一次在未刷新时试图继续写操作。所有这些动作都在影子运行器中被拦截，未触碰游戏。',
          ].join('\n'),
        },
        { id: 'scenario_score_chart_block', type: 'chart', chartId: 'scenario_score_chart' },
        {
          id: 'scenario_chart_interpretation',
          type: 'markdown',
          sourceId: 'scenario_results_sql',
          body: [
            '## 复杂场景更能区分生产风险',
            '',
            '**综合场景里两者最终都完成了 rebuild、Mill 生产、Grocery 零售和 Power 出售。** Terra 依次执行并在每次写入后刷新；DeepSeek曾把 `produce`、`sell`、`exchange_sell` 放在同一轮，护栏拒绝了不满足条件的动作，随后逐项补做成功。',
            '',
            '**这意味着 DeepSeek 的恢复能力不错，但真实运行前仍要继续观察“并行工具调用冲动”。** 当前生产护栏足以阻断这类错误；如果未来切换 DeepSeek，不能为了省 Token 而削弱刷新与单写入约束。',
          ].join('\n'),
        },
        { id: 'scenario_table_block', type: 'table', tableId: 'scenario_detail_table' },
        {
          id: 'economics',
          type: 'markdown',
          body: [
            '## 成本优势来自定价，不是更少输入',
            '',
            `两者累计输入非常接近：Terra **${terra.usage.promptTokens.toLocaleString('en-US')}**，DeepSeek **${deepseek.usage.promptTokens.toLocaleString('en-US')}**，DeepSeek只比 Terra ${Math.abs(inputDeltaRate * 100).toFixed(1)}% ${inputDeltaRate < 0 ? '少' : '多'}。DeepSeek 输出 **${deepseek.usage.outputTokens.toLocaleString('en-US')}**，是 Terra 的 **${outputRatio.toFixed(2)}×**，也与其更长的墙钟时间一致。`,
            '',
            `尽管输出更多，DeepSeek仍便宜约 **${costRatio.toFixed(2)}×**，主要因为当前官方 V4 Pro 的缓存命中、未命中和输出单价远低于 Terra。价格可能调整，因此切换决策应持续按真实账单复算，不能把这次比例写死。`,
          ].join('\n'),
        },
        {
          id: 'recommendations',
          type: 'markdown',
          body: [
            '## 推荐的下一步',
            '',
            '1. **保持 Terra 为生产主脑。** 目前不用改 `BRAIN_MODEL`，避免一次套件后直接替换正在运行的公司。',
            '2. **让 DeepSeek再跑 20–30 个代表性影子唤醒。** 覆盖可收取任务、库存不足、债券/升级判断、市场深度变化、聊天与合同等本套件未覆盖的路径。',
            '3. **设置切换门槛。** 建议要求 DeepSeek 完成率 100%、复杂场景护栏拒绝率不高于 Terra、无重复确认，并在至少三个不同时段保持成本优势。',
            '4. **达到门槛后做小流量 canary。** 先让 DeepSeek处理只读或低风险唤醒，结构性操作仍由 Terra，确认真实稳定性后再扩大。',
          ].join('\n'),
        },
        {
          id: 'further_questions',
          type: 'markdown',
          body: [
            '## 还需要回答的问题',
            '',
            '- DeepSeek 在真实 API/页面出现 `UNKNOWN`、限流或 UI 变化时，能否像冻结场景一样恢复？',
            '- 债券、升级、建造和聊天合同需要长期规划；它在跨唤醒记忆上是否仍能保持同样质量？',
            '- 当前 DeepSeek 价格是长期价还是阶段性低价？如果价格上调，成本优势还剩多少？',
          ].join('\n'),
        },
        {
          id: 'caveats',
          type: 'markdown',
          body: [
            '## 假设与边界',
            '',
            '- 这是一个基础快照派生的五个确定性影子场景，不是统计学意义上的通用模型排名。',
            '- 分数只评价可观察工具行为、CEO 结构化输出、状态一致性和动作经济性；不评价隐藏思维链。',
            '- 所有写操作均为 `executed:false` 的内存结果，真实浏览器打开 0 次、真实游戏改动 0 次。',
            '- 费用按 API 返回的逐请求 Token 与 2026 年 7 月 29 日核对的官方标准价计算，不等同于账单中的税费、赠金或未来价格。',
            '- 独立验证共 85 项，全部通过；但这不能替代更长时间的真实 shadow/canary 观察。',
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
        provider_summary: providerRows,
        scenario_results: scenarioRows,
      },
    },
    sources: [scenarioSource, headlineSource, validationSource, pricingSource],
  };
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node build-suite-report.js <runs/suite-* directory>');
  const directory = resolveSuite(input);
  const artifact = reportInput(directory);
  const output = path.join(directory, 'artifact.json');
  writeJson(output, artifact);
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
  DIFFICULTY_LABELS,
  HEADLINE_METRICS_SQL,
  PROVIDER_SUMMARY_SQL,
  SCENARIO_LABELS,
  SCENARIO_RESULTS_SQL,
  reportInput,
  resolveSuite,
};
