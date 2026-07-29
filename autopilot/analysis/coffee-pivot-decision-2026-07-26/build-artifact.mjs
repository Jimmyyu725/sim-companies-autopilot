import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const results = JSON.parse(
  fs.readFileSync(path.join(scriptDirectory, "decision-results.json"), "utf8"),
);

const rounded = (value, digits = 2) => Number(value.toFixed(digits));

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  return [
    hours > 0 ? `${hours}小时` : "",
    minutes > 0 ? `${minutes}分` : "",
    `${seconds}秒`,
  ].join("");
}

const optionRows = results.options.map((option, index) => ({
  decision_rank: index + 1,
  chart_label: [
    "Coffee now",
    "Coffee post-event",
    "Diesel",
    "Chocolate",
    "Necklace",
  ][index],
  option: option.option,
  own_cost_per_unit: rounded(option.ownCost),
  optimal_price: rounded(option.price),
  net_profit_per_hour_per_store_level: rounded(
    option.netProfitPerHourPerStoreLevel,
  ),
  profit_per_total_building_level: rounded(option.profitPerTotalBuildingLevel),
  production_levels: rounded(option.productionLevels),
  minimum_slots: option.minimumSlots,
  transition: option.transition,
  evidence: option.evidence,
}));

const paybackRows = results.decisionEconomics.switchingCostPaybackScenarios.map(
  (scenario) => ({
    switching_cost: scenario.switchingCost,
    payback_hours: rounded(scenario.paybackHoursAtPaperAdvantage, 1),
    payback_days: rounded(scenario.paybackHoursAtPaperAdvantage / 24, 1),
  }),
);

const databasePath = path.join(scriptDirectory, "coffee-pivot-decision.sqlite");
const database = new DatabaseSync(databasePath);
database.exec(`
  DROP TABLE IF EXISTS option_comparison;
  DROP TABLE IF EXISTS payback_comparison;
  CREATE TABLE option_comparison (
    decision_rank INTEGER NOT NULL,
    chart_label TEXT NOT NULL,
    option TEXT NOT NULL,
    own_cost_per_unit REAL NOT NULL,
    optimal_price REAL NOT NULL,
    net_profit_per_hour_per_store_level REAL NOT NULL,
    profit_per_total_building_level REAL NOT NULL,
    production_levels REAL NOT NULL,
    minimum_slots INTEGER NOT NULL,
    transition TEXT NOT NULL,
    evidence TEXT NOT NULL
  );
  CREATE TABLE payback_comparison (
    switching_cost REAL NOT NULL,
    payback_hours REAL NOT NULL,
    payback_days REAL NOT NULL
  );
`);
const insertOption = database.prepare(`
  INSERT INTO option_comparison VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const row of optionRows) {
  insertOption.run(
    row.decision_rank,
    row.chart_label,
    row.option,
    row.own_cost_per_unit,
    row.optimal_price,
    row.net_profit_per_hour_per_store_level,
    row.profit_per_total_building_level,
    row.production_levels,
    row.minimum_slots,
    row.transition,
    row.evidence,
  );
}
const insertPayback = database.prepare(
  "INSERT INTO payback_comparison VALUES (?, ?, ?)",
);
for (const row of paybackRows) {
  insertPayback.run(row.switching_cost, row.payback_hours, row.payback_days);
}
const optionSql =
  "SELECT * FROM option_comparison ORDER BY decision_rank ASC";
const paybackSql =
  "SELECT * FROM payback_comparison ORDER BY switching_cost ASC";
const reviewedOptionRows = database.prepare(optionSql).all();
const reviewedPaybackRows = database.prepare(paybackSql).all();
database.close();

const currentScenario = results.companyScenarios[0];
const postEventScenario = results.companyScenarios[1];
const baselineCoffee = results.baselineCoffeeOption;
const dieselAdvantage =
  results.decisionEconomics.dieselPaperAdvantagePerHourPerStoreLevel;
const dieselAdvantagePercent =
  results.decisionEconomics.dieselPaperAdvantagePercent * 100;
const dieselBaselineAdvantagePercent =
  results.decisionEconomics.dieselBaselineAdvantagePercent * 100;
const pivotTiming = results.pivotTiming;
const guardrails = pivotTiming.recommendedGuardrails;

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "Coffee Pivot Decision",
    description:
      "Decision memo on whether the current Sim Companies business should leave Coffee.",
    generatedAt: results.generatedAtUtc,
    cards: [],
    charts: [
      {
        id: "option_efficiency_chart",
        title: "Profit per total building level by option",
        subtitle:
          "Current Q0 formulas; transition capex, downtime, and added interest are excluded.",
        type: "bar",
        dataset: "options",
        sourceId: "options_sql",
        valueFormat: "currency",
        encodings: {
          x: {
            field: "chart_label",
            type: "nominal",
            label: "Option",
          },
          y: {
            field: "profit_per_total_building_level",
            type: "quantitative",
            label: "Net profit per hour per total building level",
            format: "currency",
          },
        },
        yAxisTitle: "Net $ / h / total building level",
        layout: "full",
      },
    ],
    tables: [
      {
        id: "option_comparison",
        title: "Operating options",
        subtitle:
          "Current Q0 formula comparison; transition cost and downtime are excluded and therefore favor pivoting.",
        dataset: "options",
        sourceId: "options_sql",
        defaultSort: {
          field: "decision_rank",
          direction: "asc",
        },
        columns: [
          {
            field: "decision_rank",
            label: "Decision order",
            type: "number",
          },
          { field: "option", label: "Option", type: "text" },
          {
            field: "net_profit_per_hour_per_store_level",
            label: "Net $/h/store level",
            format: "currency",
          },
          {
            field: "profit_per_total_building_level",
            label: "Net $/h/total level",
            format: "currency",
          },
          {
            field: "minimum_slots",
            label: "Minimum slots",
            type: "number",
          },
          { field: "transition", label: "Transition", type: "text" },
          { field: "evidence", label: "Evidence", type: "text" },
        ],
      },
      {
        id: "payback_comparison",
        title: "Diesel switching-cost payback",
        subtitle:
          "Uses Diesel's formula-only $105.57/h/store-level advantage over post-event Coffee before downtime or added interest.",
        dataset: "payback",
        sourceId: "payback_sql",
        defaultSort: {
          field: "switching_cost",
          direction: "asc",
        },
        columns: [
          {
            field: "switching_cost",
            label: "Switching cost",
            format: "currency",
          },
          {
            field: "payback_hours",
            label: "Payback hours",
            format: "number",
          },
          {
            field: "payback_days",
            label: "Payback days",
            format: "number",
          },
        ],
      },
    ],
    sources: [
      {
        id: "decision_results",
        label: "Executed Coffee pivot decision results",
        path: "chrome-automation/sim/autopilot/analysis/coffee-pivot-decision-2026-07-26/decision-results.json",
      },
      {
        id: "options_sql",
        label: "Operating option comparison query",
        path: "chrome-automation/sim/autopilot/analysis/coffee-pivot-decision-2026-07-26/coffee-pivot-decision.sqlite",
        query: {
          engine: "sqlite",
          sql: optionSql,
          description:
            "Loads the five reviewed Coffee and pivot operating scenarios in decision order.",
          executed_at: results.generatedAtUtc,
          tables_used: ["option_comparison"],
        },
      },
      {
        id: "payback_sql",
        label: "Diesel switching-cost payback query",
        path: "chrome-automation/sim/autopilot/analysis/coffee-pivot-decision-2026-07-26/coffee-pivot-decision.sqlite",
        query: {
          engine: "sqlite",
          sql: paybackSql,
          description:
            "Loads switching-cost sensitivities using Diesel's paper advantage over post-event Coffee.",
          executed_at: results.generatedAtUtc,
          tables_used: ["payback_comparison"],
        },
      },
      {
        id: "analysis_script",
        label: "Reproducible Coffee pivot analysis",
        path: "chrome-automation/sim/autopilot/analysis/coffee-pivot-decision-2026-07-26/analysis.mjs",
      },
      {
        id: "live_diary",
        label: "Live Coffee retail and Mill action diary",
        path: "chrome-automation/sim/autopilot/diaries/diary-2026-07-26-013129.md",
      },
      {
        id: "market_snapshot",
        label: "Sim Companies API market snapshot",
        path: "chrome-automation/sim/autopilot/analysis/self-produced-retail-2026-07-26/market-snapshot.json",
      },
      {
        id: "current_state",
        label: "Authenticated company state snapshot",
        path: "chrome-automation/sim/autopilot/.state.json",
      },
      {
        id: "notebook",
        label: "Coffee pivot decision companion notebook",
        path: "chrome-automation/sim/autopilot/analysis/coffee-pivot-decision-2026-07-26/coffee-pivot-decision.ipynb",
      },
    ],
    blocks: [
      {
        id: "title",
        type: "markdown",
        body: "# Coffee Pivot Decision",
      },
      {
        id: "executive_summary",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Executive Summary\n\n- **最早在芝加哥时间7月27日19:00做决策级复盘，之前不转型。** 这给 Coffee Powder 的 -23% 活动结束后留下完整24小时实绩。\n- **到点也不是自动转型。** Diesel 必须在整数建筑布局、最新管理费、停工和利息全部计入后，保守全公司利润至少高 ${rounded(guardrails.minimumVerifiedCompanyProfitAdvantagePercent * 100)}%，且公司级全包切换成本在 ${guardrails.maximumCompanyLevelPaybackDays} 天内回本。\n- **当前证据没有过线。** Coffee 的 -23% 临时减产结束后，Diesel 纸面只领先约 $${rounded(dieselAdvantage).toLocaleString("en-US")}/小时/店级，即 ${rounded(dieselAdvantagePercent, 1)}%；这个差距尚未扣除建造、拆除、停产和新增利息。\n- **现在继续 Coffee。** 当前现金约 $${results.company.cash.toLocaleString("en-US")}、债务 $${results.company.debtPrincipal.toLocaleString("en-US")}、每天利息 $${results.company.dailyInterest.toLocaleString("en-US")}，且没有空余标准槽位。`,
      },
      {
        id: "definition",
        type: "markdown",
        sourceId: "analysis_script",
        body: "## 判断转型看完整公司，而不是单个商店数字\n\n这里的比较单位是每级零售店每小时的完整自产利润：从 Power、Water 和原料开始递归扣除全部生产工资，再扣零售工资。转型决策还要叠加现有资产、槽位、建设资金、停产时间和融资成本。只看商店界面的瞬时 Profit per hour，会忽略生产跟不上时的空闲时间。",
      },
      {
        id: "current_position",
        type: "markdown",
        sourceId: "decision_results",
        body: `## 当前最该做的是完成 Coffee 扩产\n\n最新状态中，正常生产的 Mill 合计${results.company.activeMillLevels}级，另一座正在升级；完成后总计${results.company.millLevels}级。公司另有3级 Farm、1级 Water、1级 Power 和2级 Grocery，没有空余标准槽位。当前 Coffee Powder 仍受 -23% 临时减产，结束时间为芝加哥时间7月26日19:00。最新实盘订单为${results.liveOrder.quantity}件、$${results.liveOrder.price.toFixed(2)}、${formatDuration(results.liveOrder.durationSeconds)}，反算约 $${rounded(results.liveOrder.recomputedProfitPerHour)}/小时；游戏显示 $${results.liveOrder.displayedProfitPerHour.toLocaleString("en-US")}/小时，微小差异来自界面舍入。\n\n**含义：** Coffee 的核心机制已经实盘验证；现在拆线等于在负面临时事件即将结束、Mill 正在升级、债务已经较高时放弃最可信的资产。`,
      },
      {
        id: "pivot_timing",
        type: "markdown",
        sourceId: "decision_results",
        body: `## 转型时间由三道门决定\n\n**硬时间门：** Mill 升级在芝加哥时间7月26日04:34完成，Coffee Powder 的 -23% 活动在19:00结束，因此活动结束才是更晚、也更重要的门槛。约20:42可以看到第一轮全新100件生产—零售闭环，但只适合低置信检查。\n\n**决策时间门：** 从19:00起连续观察24小时，最早在7月27日19:00做转型级复盘。若期间发生升级，需剔除升级现金流，或从升级完成后重新开始24小时窗口。\n\n**执行门：** 候选产业必须用全公司净利润口径保守领先至少 ${rounded(guardrails.minimumVerifiedCompanyProfitAdvantagePercent * 100)}%，全包切换成本在 ${guardrails.maximumCompanyLevelPaybackDays} 天内回本，优势在至少 ${guardrails.minimumStableSnapshotCount} 个新市场快照及24小时内保持，并且转型后仍保留 $${guardrails.minimumCashAfterTransition.toLocaleString("en-US")} 现金底线。任一条件失败，就继续 Coffee。`,
      },
      {
        id: "options_finding",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Diesel 纸面领先，但仍达不到执行门槛\n\n当前事件下 Coffee 被临时压低；Powder 活动结束后的快照公式值约为 $${rounded(results.postEventCoffeeOption.netProfitPerHourPerStoreLevel)}/小时/店级。Diesel 约为 $${rounded(results.dieselOption.netProfitPerHourPerStoreLevel)}，领先 ${rounded(dieselAdvantagePercent, 1)}%。即使再移除 Coffee Beans 当前 +21% 活动，Coffee 的模型值约为 $${rounded(baselineCoffee.netProfitPerHourPerStoreLevel)}，Diesel 也只领先 ${rounded(dieselBaselineAdvantagePercent, 1)}%。两种口径都低于建议的 ${rounded(guardrails.minimumVerifiedCompanyProfitAdvantagePercent * 100)}% 风控线，而且 Diesel 需要7种建筑槽并重建整条链。`,
      },
      {
        id: "option_efficiency_chart_block",
        type: "chart",
        chartId: "option_efficiency_chart",
        layout: "full",
      },
      {
        id: "option_table_block",
        type: "table",
        tableId: "option_comparison",
        layout: "full",
      },
      {
        id: "switching_economics",
        type: "markdown",
        sourceId: "decision_results",
        body: `## 很小的纸面优势会被切换成本迅速吃掉\n\n按 Diesel 相对 post-event Coffee 的 $${rounded(dieselAdvantage)}/小时/店级优势计算，即使切换只花 $10,000，也要约 ${rounded(results.decisionEconomics.switchingCostPaybackScenarios[0].paybackHoursAtPaperAdvantage, 1)} 小时才能回本；$30,000 需要约 ${rounded(results.decisionEconomics.switchingCostPaybackScenarios[1].paybackHoursAtPaperAdvantage / 24, 1)} 天。这仍然没有计入停产和新增债务利息。\n\n**含义：** 在拿到可执行的建造、拆除与融资报价之前，转型的期望收益没有通过最低门槛。`,
      },
      {
        id: "payback_table_block",
        type: "table",
        tableId: "payback_comparison",
        layout: "full",
      },
      {
        id: "pricing_opportunity",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Coffee 还有比转型更便宜的利润提升\n\n当前 Mill 升级完成后的5级产能，在 -23% 事件下约能供应 ${rounded(currentScenario.powderThroughputPerHour)} 粉/小时。若将2级 Grocery 的价格调整到约 $${rounded(currentScenario.matchedRetailPrice)}，使销售速度匹配生产速度，按最新批次成本估计完整公司约 $${rounded(currentScenario.estimatedCompanyProfitPerHour).toLocaleString("en-US")}/小时。事件结束后，在其他条件不变的公式场景中，约为 ${rounded(postEventScenario.powderThroughputPerHour)} 粉/小时和 $${rounded(postEventScenario.estimatedCompanyProfitPerHour).toLocaleString("en-US")}/小时。\n\n这是公式预测而非未来实盘保证，但它说明应先把零售定价目标从“商店瞬时 PPH”改成“受产能约束的全链利润”。`,
      },
      {
        id: "recommendations",
        type: "markdown",
        sourceId: "decision_results",
        body: "## Recommended next steps\n\n1. 现在不拆建筑，完成当前 Mill 升级并保持 Coffee 全链生产。\n2. 从芝加哥时间7月26日19:00开始记录24小时 Coffee 的实际生产、零售与净现金变化。\n3. 在7月27日19:00使用最新管理费、市场饱和度和整数建筑布局重新计算。\n4. 同时取得 Diesel 的真实拆除、建造、升级、停工和融资报价；只有利润优势、7天回本、稳定性和$5,000现金底线全部通过才执行。\n5. 若未通过，继续 Coffee；在 Coffee Beans 当前 +21% 活动结束并再观察24小时后，于芝加哥时间8月3日19:00做下一次基线复盘。",
      },
      {
        id: "further_questions",
        type: "markdown",
        body: "## Further questions\n\n- Coffee 负面事件结束后的首个完整周期，实际 Powder 成本、销售速度和公司净现金增量是多少？\n- Diesel 从当前公司结构转型的可执行总成本与停产小时是多少？\n- 当前零售扫描器应如何在库存有限时选择匹配生产瓶颈的价格？",
      },
      {
        id: "caveats",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Caveats and assumptions\n\n结论使用7月26日06:16 UTC市场快照和${new Date(results.sourceFreshness.companyStateAtUtc).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC公司状态。Coffee 的生产和零售公式已经由现场订单验证；Diesel、Chocolate、Necklace 没有现役完整产业链，只能视为游戏公式推算。候选利润仍固定使用06:16快照的 administration overhead；升级后 Mill 界面工资已从早先的约$402/h变为$${results.liveMillWagesPerHour ?? "UNKNOWN"}/h，说明绝对利润需要在升级完成后重算。候选表还未计整数升级、建设资本、拆除、停工、新增债务利息或市场饱和度变化，因此对转型偏乐观。现有回本表只是每店级纸面增量的敏感性，不是可执行的全公司报价。验证评级为 Share with caveats。`,
      },
    ],
  },
  snapshot: {
    version: 1,
    generatedAt: results.generatedAtUtc,
    status: "ready",
    datasets: {
      options: reviewedOptionRows,
      payback: reviewedPaybackRows,
    },
  },
};

fs.writeFileSync(
  path.join(scriptDirectory, "artifact.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
console.log(JSON.stringify({
  artifact: path.join(scriptDirectory, "artifact.json"),
  optionRows: optionRows.length,
  paybackRows: paybackRows.length,
}, null, 2));
