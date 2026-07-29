import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const directory = path.dirname(fileURLToPath(import.meta.url));
const results = JSON.parse(fs.readFileSync(path.join(directory, "decision-results.json"), "utf8"));
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

const optionRows = results.options.map((option, index) => ({
  decision_order: index + 1,
  option_key: option.key,
  option: option.option,
  capital_need: option.capitalNeed,
  optimistic_deployable_funds: results.company.optimisticDeployableFunds,
  funding_gap: Math.max(0, option.optimisticFundingGap),
  modeled_profit_per_hour: option.modeledProfitPerHour,
  output_per_hour: option.outputPerHour,
  slots_required: option.slotsRequired,
  evidence_level: option.evidenceLevel,
  decision: option.decision,
  capital_basis: option.capitalBasis,
}));
const chartKeys = new Set([
  "coffee_add_farm",
  "tools_level_one",
  "tools_fully_fed",
  "satellite_level_one",
]);
const chartRows = optionRows.filter((row) => chartKeys.has(row.option_key));

const databasePath = path.join(directory, "coffee-vs-tools-aerospace.sqlite");
const database = new DatabaseSync(databasePath);
database.exec(`
  DROP TABLE IF EXISTS option_comparison;
  DROP TABLE IF EXISTS capital_comparison;
  CREATE TABLE option_comparison (
    decision_order INTEGER NOT NULL,
    option_key TEXT NOT NULL,
    option TEXT NOT NULL,
    capital_need REAL NOT NULL,
    optimistic_deployable_funds REAL NOT NULL,
    funding_gap REAL NOT NULL,
    modeled_profit_per_hour REAL NOT NULL,
    output_per_hour REAL NOT NULL,
    slots_required INTEGER NOT NULL,
    evidence_level TEXT NOT NULL,
    decision TEXT NOT NULL,
    capital_basis TEXT NOT NULL
  );
  CREATE TABLE capital_comparison AS SELECT * FROM option_comparison WHERE 0;
`);
const insertOption = database.prepare(
  "INSERT INTO option_comparison VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
for (const row of optionRows) insertOption.run(...Object.values(row));
const insertChart = database.prepare(
  "INSERT INTO capital_comparison VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
for (const row of chartRows) insertChart.run(...Object.values(row));
const optionSql = "SELECT * FROM option_comparison ORDER BY decision_order ASC";
const capitalSql = "SELECT * FROM capital_comparison ORDER BY capital_need ASC";
const reviewedOptions = database.prepare(optionSql).all();
const reviewedCapital = database.prepare(capitalSql).all();
database.close();

const company = results.company;
const coffee = results.currentCoffee;
const toolsFull = results.options.find((option) => option.key === "tools_fully_fed");
const toolsL1 = results.options.find((option) => option.key === "tools_level_one");
const satelliteL1 = results.options.find((option) => option.key === "satellite_level_one");
const satelliteFull = results.options.find((option) => option.key === "satellite_fully_fed");
const farmOption = results.options.find((option) => option.key === "coffee_add_farm");
const structurallyBlocked = results.structurallyInfeasibleAerospace
  .map((row) => `${row.product}（${row.minimumSlots}槽）`).join("、");

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "现在不该拆 Coffee 转型",
    description: "按当前公司槽位、整数产能、资本和债务，比较继续 Coffee、Tools 与 Aerospace。",
    generatedAt: results.generatedAtUtc,
    cards: [],
    charts: [
      {
        id: "capital_need_chart",
        title: "近期方案的乐观资本需求",
        subtitle: `拆除返料按可完全抵扣采购处理；理论可动用上限约 $${Math.round(company.optimisticDeployableFunds).toLocaleString("en-US")}，但债券尚未证明可保存或售出。`,
        type: "bar",
        dataset: "capital",
        sourceId: "capital_sql",
        valueFormat: "currency",
        encodings: {
          x: { field: "option", type: "nominal", label: "方案" },
          y: { field: "capital_need", type: "quantitative", label: "资本需求", format: "currency" },
        },
        yAxisTitle: "资本需求 $",
        layout: "full",
      },
    ],
    tables: [
      {
        id: "option_comparison",
        title: "Coffee、Tools 与 Satellite 的可执行比较",
        subtitle: "利润为当前统一模型；资本已尽量复用现有资产并乐观抵扣拆除材料。",
        dataset: "options",
        sourceId: "options_sql",
        defaultSort: { field: "decision_order", direction: "asc" },
        columns: [
          { field: "decision_order", label: "顺序", type: "number" },
          { field: "option", label: "方案", type: "text" },
          { field: "capital_need", label: "资本需求", format: "currency" },
          { field: "funding_gap", label: "乐观资金缺口", format: "currency" },
          { field: "modeled_profit_per_hour", label: "模型净利/小时", format: "currency" },
          { field: "output_per_hour", label: "终品/小时", format: "number" },
          { field: "slots_required", label: "所需槽位", type: "number" },
          { field: "decision", label: "判断", type: "text" },
          { field: "evidence_level", label: "证据", type: "text" },
        ],
      },
    ],
    sources: [
      {
        id: "decision_results",
        label: "Executed Coffee versus Tools and Aerospace decision analysis",
        path: "chrome-automation/sim/autopilot/analysis/coffee-vs-tools-aerospace-2026-07-26/decision-results.json",
      },
      {
        id: "options_sql",
        label: "Reviewed transition option query",
        path: "chrome-automation/sim/autopilot/analysis/coffee-vs-tools-aerospace-2026-07-26/coffee-vs-tools-aerospace.sqlite",
        query: {
          engine: "sqlite",
          sql: optionSql,
          description: "Loads the reviewed current-company transition options in decision order.",
          executed_at: results.generatedAtUtc,
          tables_used: ["option_comparison"],
        },
      },
      {
        id: "capital_sql",
        label: "Reviewed near-term capital comparison query",
        path: "chrome-automation/sim/autopilot/analysis/coffee-vs-tools-aerospace-2026-07-26/coffee-vs-tools-aerospace.sqlite",
        query: {
          engine: "sqlite",
          sql: capitalSql,
          description: "Loads four near-term capital scenarios; the full Satellite case is excluded from the chart because its scale is not actionable.",
          executed_at: results.generatedAtUtc,
          tables_used: ["capital_comparison"],
        },
      },
      {
        id: "analysis_script",
        label: "Reproducible transition, capacity, and constrained-retail analysis",
        path: "chrome-automation/sim/autopilot/analysis/coffee-vs-tools-aerospace-2026-07-26/analysis.mjs",
      },
      {
        id: "company_state",
        label: "Authenticated current company state",
        path: "chrome-automation/sim/autopilot/.state.json",
      },
      {
        id: "market_snapshot",
        label: "Current public market, weather, and modifier snapshot",
        path: "chrome-automation/sim/autopilot/analysis/tools-vs-coffee-2026-07-26/market-snapshot.json",
      },
      {
        id: "game_facts",
        label: "Measured recipes, rates, wages, building costs, and mechanics",
        path: "chrome-automation/sim/shared/facts/game-facts.json",
      },
      {
        id: "bond_evidence",
        label: "Finance screenshot observation and current bundle bond-limit formula",
        path: "chrome-automation/sim/autopilot/analysis/coffee-vs-tools-aerospace-2026-07-26/bond-cap-evidence.md",
      },
      {
        id: "live_mill_quote",
        label: "Latest live Mill upgrade and finance diary",
        path: "chrome-automation/sim/autopilot/diaries/diary-2026-07-26-194017.md",
      },
    ],
    blocks: [
      {
        id: "title",
        type: "markdown",
        body: "# 现在不该拆 Coffee 转型",
      },
      {
        id: "executive_summary",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Executive Summary\n\n- **继续 Coffee，不直接借债拆楼。** 当前 Coffee 是唯一有实盘生产与零售证据的完整链；Tools 和 Satellite 的高收益仍是公式筛选值。\n- **当前瓶颈是 Farm，不是 Mill。** 第三座 Mill 到 L2 后，Mill 约可承载 140.6 Powder/h，但现有 L3 Farm 同时供应 Seeds 与 Beans，只能长期支撑约 ${round(coffee.sustainablePowderPerHourAfterCurrentConstruction, 1)}/h。\n- **一座新 L1 Farm 几乎追平完整 Tools。** 约 $${farmOption.capitalNeed.toLocaleString("en-US")}、不拆楼，模型从约 $${round(coffee.constrainedRetail.profitPerHour).toLocaleString("en-US")}/h 提到 $${round(farmOption.modeledProfitPerHour).toLocaleString("en-US")}/h；完整 Tools 约 $${round(toolsFull.modeledProfitPerHour).toLocaleString("en-US")}/h，只多约 $${round(toolsFull.modeledProfitPerHour - farmOption.modeledProfitPerHour)}/h，却要约 $${toolsFull.capitalNeed.toLocaleString("en-US")}。\n- **Aerospace 现在不可执行。** 只有 Satellite 的9类建筑能装进10槽，但最小全 L1 链仍低于 Coffee 且资金不足；满负荷链约需 $${(satelliteFull.capitalNeed / 1e6).toFixed(1)}m。`,
      },
      {
        id: "farm_bottleneck",
        type: "markdown",
        sourceId: "decision_results",
        body: `## 先补 Farm，比升级或拆线更合理\n\n当前施工完成后，三座 L2 Mill 的总能力约 140.6 Powder/h；Coffee 全配方把 Farm 同时用于 Seeds 与 Coffee Beans，因此 L3 Farm 把长期吞吐压在约 ${round(coffee.sustainablePowderPerHourAfterCurrentConstruction, 1)}/h。增加一座 L1 Farm 后，模型吞吐约 ${round(coffee.sustainablePowderPerHourWithOneNewFarm, 1)}/h，接近现有 Mill 能力，仍保留2个空槽。\n\n**含义：** 先取得新 Farm 的实时建造报价和新增管理费，比借大债升级全部 Mill 或拆 Coffee 更有信息价值，也更可逆。`,
      },
      {
        id: "tools_finding",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Tools 有长期潜力，但当前完整转型回报太薄\n\n最小全 L1 Tools 链可以在10槽内运行，但受 L1 Electronics factory 限制只有约 ${round(toolsL1.outputPerHour, 1)} Tools/h，模型约 $${round(toolsL1.modeledProfitPerHour).toLocaleString("en-US")}/h，低于继续 Coffee。要达到此前 $${round(toolsFull.modeledProfitPerHour).toLocaleString("en-US")}/h 的纸面值，需要9类建筑、14级上游产能；复用现有 Power、Water、Farm 并拆三座 Mill 后，仍约需 $${toolsFull.capitalNeed.toLocaleString("en-US")}，比乐观资金上限多 $${Math.max(0, toolsFull.optimisticFundingGap).toLocaleString("en-US")}。\n\n**含义：** Tools 可以保留为未来候选或不拆线的小试验，不能作为现在的全公司转型。`,
      },
      {
        id: "capital_chart_block",
        type: "chart",
        chartId: "capital_need_chart",
        layout: "full",
      },
      {
        id: "option_table_block",
        type: "table",
        tableId: "option_comparison",
        layout: "full",
      },
      {
        id: "aerospace_finding",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Satellite 是槽位上唯一可行的 Aerospace，但不是资本上可行\n\n${structurallyBlocked}都超过当前10槽。Satellite 虽只需9类建筑，但全 L1 链受 Electronics factory 限制，约每 ${results.satellite.levelOneHoursPerUnit} 小时才产1颗，模型约 $${round(satelliteL1.modeledProfitPerHour).toLocaleString("en-US")}/h；即使拆掉全部 Coffee 专用建筑并把返料当成现金等价物，仍约需 $${satelliteL1.capitalNeed.toLocaleString("en-US")}。满喂一级 Sales Office 则要54级上游产能，资本估算约 $${(satelliteFull.capitalNeed / 1e6).toFixed(1)}m。\n\n**含义：** 航空航天只是后期方向，当前借债强转会把公司从已验证现金流换成无法融资、无法实测的高风险模型。`,
      },
      {
        id: "debt_finding",
        type: "markdown",
        sourceId: "decision_results",
        body: `## 债券上限不是现金\n\n当前快照现金约 $${company.cash.toLocaleString("en-US")}、已售债务 $${company.debtPrincipal.toLocaleString("en-US")}、利息 $${company.dailyInterest.toLocaleString("en-US")}/日。按用户截图和当前 bundle 公式，新增 offer 的理论上限约 $${company.observedMaximumNewBondOffer.toLocaleString("en-US")}；扣 $${company.cashFloor.toLocaleString("en-US")} 现金底线后，乐观可动用约 $${Math.round(company.optimisticDeployableFunds).toLocaleString("en-US")}。但现有债券动作没有确认 offer 真正保存，后续 dry-read 又回到0，也没有新现金到账。\n\n**含义：** 在修复并验证债券提交前，不能把这 $${company.observedMaximumNewBondOffer.toLocaleString("en-US")} 当成已可用融资。`,
      },
      {
        id: "recommendations",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Recommended next steps\n\n1. 等当前第三座 Mill 完成 L2，不拆任何 Coffee 建筑。\n2. 下一项结构评估改为新建一座 L1 Farm：先拿实时价格、管理费变化与可持续 Seeds/Beans 排程，再决定是否确认。\n3. 暂停“为了扩产而连续把三座 Mill 升 L3”的机械执行。三次最新报价约 $${coffee.threeMillUpgradeProgramCost.toLocaleString("en-US")}；在 Farm 和零售出口未扩展前，新增 Mill 产能不能转化为长期利润。\n4. 不为 Tools 或 Aerospace 新增债务。Tools 只在未来用空槽做不拆 Coffee 的小试；Satellite 等资本、等级和更多槽位后再评估。\n5. 单独修复债券动作的提交后验证；只有 sold records 与现金真的增加，才把融资计入可用资金。`,
      },
      {
        id: "further_questions",
        type: "markdown",
        body: "## Further questions\n\n- 新 L1 Farm 的实时建造价、管理费变化和回本小时是多少？\n- Farm 在 Seeds 与 Coffee Beans 之间怎样排程，才能持续喂满三座 L2 Mill？\n- Tools 的 Construction factory + Hardware 两槽小试，在实时买入原料后是否仍有正的全包利润？",
      },
      {
        id: "caveats",
        type: "markdown",
        sourceId: "decision_results",
        body: `## Caveats and assumptions\n\n公司状态来自 ${results.sourceStateAsOfUtc}，市场快照来自 ${results.sourceMarketAsOfUtc}。利润统一使用 Q0、当前天气、当前临时 modifier、递归自产成本和零售工资；没有重新报价新增建筑后的 administration overhead，因此 Farm、Tools 与 Satellite 的绝对利润都需要 live quote 后复算。拆除返料按100%避免等值采购处理，是偏向转型的乐观假设，并不等于收到现金。Satellite 超过 L6 的资本使用已测得的线性升级曲线外推，不是实时 UI 报价。债券理论上限也不是成交保证。验证评级：Share with caveats。`,
      },
    ],
  },
  snapshot: {
    version: 1,
    generatedAt: results.generatedAtUtc,
    status: "ready",
    datasets: {
      options: reviewedOptions,
      capital: reviewedCapital,
    },
  },
};

fs.writeFileSync(path.join(directory, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  artifact: path.join(directory, "artifact.json"),
  optionRows: reviewedOptions.length,
  chartRows: reviewedCapital.length,
}, null, 2));
