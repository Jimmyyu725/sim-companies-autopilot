from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from analysis import build_analysis


BASE = Path(__file__).resolve().parent


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def write_sqlite(path: Path, analysis: dict) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            DROP TABLE IF EXISTS summary;
            DROP TABLE IF EXISTS rankings;
            DROP TABLE IF EXISTS exclusions;

            CREATE TABLE summary (
                winner TEXT,
                sustainable_profit_per_hour REAL,
                sustainable_output_per_hour REAL,
                demand_multiple REAL,
                price_as_of_utc TEXT
            );

            CREATE TABLE rankings (
                rank INTEGER,
                kind INTEGER,
                product TEXT,
                building TEXT,
                latest_price REAL,
                net_sale_per_unit REAL,
                own_cost_per_unit REAL,
                margin_per_unit REAL,
                sustainable_output_per_hour REAL,
                sustainable_profit_per_hour REAL,
                p10_sustainable_profit_per_hour REAL,
                conversion_profit_per_hour REAL,
                bottleneck TEXT,
                volume_1h_observed REAL,
                demand_multiple REAL
            );

            CREATE TABLE exclusions (
                product TEXT,
                production_season TEXT,
                paper_profit_per_hour REAL,
                reason TEXT
            );
            """
        )
        top = analysis["top_current"]
        connection.execute(
            "INSERT INTO summary VALUES (?, ?, ?, ?, ?)",
            (
                top["product"],
                top["sustainable_profit_per_hour"],
                top["sustainable_output_per_hour"],
                top["demand_multiple"],
                analysis["as_of_utc"],
            ),
        )
        connection.executemany(
            """
            INSERT INTO rankings VALUES (
                :rank, :kind, :product, :building, :latest_price,
                :net_sale_per_unit, :own_cost_per_unit, :margin_per_unit,
                :sustainable_output_per_hour, :sustainable_profit_per_hour,
                :p10_sustainable_profit_per_hour, :conversion_profit_per_hour,
                :bottleneck, :volume_1h_observed, :demand_multiple
            )
            """,
            analysis["current_ranking"],
        )
        connection.executemany(
            """
            INSERT INTO exclusions VALUES (
                :product, :production_season, :sustainable_profit_per_hour, :status
            )
            """,
            analysis["seasonal_exclusions"],
        )
        connection.commit()
    finally:
        connection.close()


def notebook(analysis: dict) -> dict:
    top_rows = analysis["current_ranking"][:8]
    code_output = json.dumps(
        [
            {
                "rank": row["rank"],
                "product": row["product"],
                "profit_per_hour": row["sustainable_profit_per_hour"],
                "output_per_hour": row["sustainable_output_per_hour"],
                "bottleneck": row["bottleneck"],
            }
            for row in top_rows
        ],
        indent=2,
        ensure_ascii=False,
    )
    validation_output = json.dumps(
        analysis["quality_checks"], indent=2, ensure_ascii=False
    )
    return {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## tl;dr\n",
                    "\n",
                    "当前可执行的纯自产 Exchange 排名中，Fodder 第一；Pumpkin 的纸面利润更高，但属于 AutumnHarvest 季节品，当前排名剔除。",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Context & Methods\n",
                    "\n",
                    "The analysis reads the live state, measured production rates and wages, the rolling ticker, the rotating order-book volume estimate, and the measured recipe graph. It deducts the 4% exchange fee and outbound transportation. Inputs are recursively self-produced, and throughput is capped by the first one-building bottleneck.\n",
                    "\n",
                    "### Key Assumptions\n",
                    "\n",
                    "- Seasonal production is excluded from the executable ranking.\n",
                    "- Quality is Q0 because the current inventory and quotes are Q0.\n",
                    "- The volume estimate includes order cancellations and is supporting liquidity evidence, not guaranteed purchases.\n",
                    "- Rankings are per self-contained one-building production line, so products are compared on like-for-like productive capacity.\n",
                ],
            },
            {
                "cell_type": "code",
                "execution_count": 1,
                "metadata": {},
                "outputs": [
                    {
                        "name": "stdout",
                        "output_type": "stream",
                        "text": [code_output + "\n"],
                    }
                ],
                "source": [
                    "from analysis import build_analysis\n",
                    "\n",
                    "analysis = build_analysis()\n",
                    "for row in analysis[\"current_ranking\"][:8]:\n",
                    "    print({key: row[key] for key in (\"rank\", \"product\", \"sustainable_profit_per_hour\", \"sustainable_output_per_hour\", \"bottleneck\")})\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Results\n",
                    "\n",
                    "Fodder wins the currently executable ranking because its exchange revenue covers the full Grain + Vegetables + Seeds + Water + Power chain and Mill labor. The L3 Farm is the bottleneck, so one self-sufficient line produces about 109 Fodder per hour even though an L1 Mill can process much more.\n",
                ],
            },
            {
                "cell_type": "code",
                "execution_count": 2,
                "metadata": {},
                "outputs": [
                    {
                        "name": "stdout",
                        "output_type": "stream",
                        "text": [validation_output + "\n"],
                    }
                ],
                "source": [
                    "print(analysis[\"quality_checks\"])\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Takeaways\n",
                    "\n",
                    "- Use Fodder as the Exchange-only benchmark, not as an automatic company-wide pivot.\n",
                    "- Coffee Powder remains valuable for Grocery retail and benefits from the company's unusually large Mill fleet.\n",
                    "- Re-rank at Pumpkin season, after production modifiers expire, or after a material price move.\n",
                ],
            },
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python", "version": "3"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def artifact(analysis: dict) -> dict:
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    top = analysis["top_current"]
    ranking_fields = (
        "rank",
        "kind",
        "product",
        "building",
        "latest_price",
        "net_sale_per_unit",
        "own_cost_per_unit",
        "margin_per_unit",
        "sustainable_output_per_hour",
        "sustainable_profit_per_hour",
        "p10_sustainable_profit_per_hour",
        "conversion_profit_per_hour",
        "bottleneck",
        "volume_1h_observed",
        "demand_multiple",
    )
    ranking = [
        {field: row[field] for field in ranking_fields}
        for row in analysis["current_ranking"]
    ]
    chart_rows = ranking[:10]
    exclusion_fields = (
        "product",
        "production_season",
        "sustainable_profit_per_hour",
        "status",
    )
    exclusions = [
        {field: row[field] for field in exclusion_fields}
        for row in analysis["seasonal_exclusions"]
    ]
    query_time = analysis["as_of_utc"]
    sources = [
        {
            "id": "analysis_notebook",
            "label": "Exchange self-production analysis notebook",
            "path": "autopilot/analysis/exchange-self-production-2026-07-25/exchange-self-production.ipynb",
        },
        {
            "id": "summary_sql",
            "label": "Winner summary query",
            "path": "autopilot/analysis/exchange-self-production-2026-07-25/exchange-analysis.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT winner, sustainable_profit_per_hour, sustainable_output_per_hour, demand_multiple, price_as_of_utc FROM summary",
                "description": "Loads the reviewed executable winner and headline metrics.",
                "executed_at": query_time,
                "tables_used": ["summary"],
            },
        },
        {
            "id": "ranking_sql",
            "label": "Self-produced Exchange ranking query",
            "path": "autopilot/analysis/exchange-self-production-2026-07-25/exchange-analysis.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM rankings ORDER BY sustainable_profit_per_hour DESC",
                "description": "Loads the reviewed non-seasonal product ranking.",
                "executed_at": query_time,
                "tables_used": ["rankings"],
            },
        },
        {
            "id": "exclusions_sql",
            "label": "Seasonal exclusion query",
            "path": "autopilot/analysis/exchange-self-production-2026-07-25/exchange-analysis.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM exclusions ORDER BY paper_profit_per_hour DESC",
                "description": "Loads products excluded from the executable ranking by seasonality.",
                "executed_at": query_time,
                "tables_used": ["exclusions"],
            },
        },
    ]
    manifest = {
        "version": 1,
        "surface": "report",
        "title": "Exchange Self-Production Ranking",
        "description": "Current Exchange-only profitability for the company's owned production lines.",
        "generatedAt": generated,
        "cards": [
            {
                "id": "winner",
                "description": "Highest currently executable full-chain Exchange product.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Winner", "field": "winner", "format": "text"}
                ],
            },
            {
                "id": "winner_profit",
                "description": "Profit after fee, transport, and all self-produced input labor.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {
                        "label": "Sustainable profit per hour",
                        "field": "sustainable_profit_per_hour",
                        "format": "currency",
                    }
                ],
            },
            {
                "id": "winner_output",
                "description": "Full-chain output after the first owned-building bottleneck.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {
                        "label": "Sustainable output per hour",
                        "field": "sustainable_output_per_hour",
                        "format": "number",
                    }
                ],
            },
            {
                "id": "winner_demand",
                "description": "Observed one-hour order disappearance divided by sustainable output.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {
                        "label": "Observed demand multiple",
                        "field": "demand_multiple",
                        "format": "number",
                    }
                ],
            },
        ],
        "charts": [
            {
                "id": "profit_ranking_chart",
                "title": "Sustainable Exchange profit by product",
                "subtitle": "Current non-seasonal products; full self-produced recipe tree, one-building bottleneck basis.",
                "type": "bar",
                "dataset": "ranking_top10",
                "sourceId": "ranking_sql",
                "valueFormat": "currency",
                "encodings": {
                    "x": {
                        "field": "product",
                        "type": "nominal",
                        "label": "Product",
                    },
                    "y": {
                        "field": "sustainable_profit_per_hour",
                        "type": "quantitative",
                        "label": "Profit per hour",
                        "format": "currency",
                    },
                    "tooltip": [
                        {
                            "field": "sustainable_output_per_hour",
                            "type": "quantitative",
                            "label": "Output per hour",
                            "format": "number",
                        },
                        {
                            "field": "bottleneck",
                            "type": "nominal",
                            "label": "Bottleneck",
                        },
                    ],
                },
                "yAxisTitle": "Sustainable profit per hour",
                "layout": "full",
            }
        ],
        "tables": [
            {
                "id": "ranking_table",
                "title": "Executable ranking detail",
                "subtitle": "Latest ticker prices with the 4% fee, transportation, recursive own-production costs, and bottleneck throughput.",
                "dataset": "rankings",
                "sourceId": "ranking_sql",
                "defaultSort": {
                    "field": "sustainable_profit_per_hour",
                    "direction": "desc",
                },
                "columns": [
                    {"field": "rank", "label": "Rank", "format": "number"},
                    {"field": "product", "label": "Product", "type": "text"},
                    {
                        "field": "latest_price",
                        "label": "Exchange price",
                        "format": "currency",
                    },
                    {
                        "field": "own_cost_per_unit",
                        "label": "Own cost per unit",
                        "format": "currency",
                    },
                    {
                        "field": "sustainable_output_per_hour",
                        "label": "Sustainable output/h",
                        "format": "number",
                    },
                    {
                        "field": "sustainable_profit_per_hour",
                        "label": "Sustainable profit/h",
                        "format": "currency",
                    },
                    {
                        "field": "p10_sustainable_profit_per_hour",
                        "label": "24h P10 profit/h",
                        "format": "currency",
                    },
                    {"field": "bottleneck", "label": "Bottleneck", "type": "text"},
                ],
            }
        ],
        "sources": sources,
        "blocks": [
            {
                "id": "title",
                "type": "markdown",
                "body": "# Exchange Self-Production Ranking",
            },
            {
                "id": "executive_summary",
                "type": "markdown",
                "sourceId": "summary_sql",
                "body": (
                    "## Executive Summary\n\n"
                    f"- **当前可执行第一名是 Fodder。** 最新价格 **${top['latest_price']:.2f}**，完整自产链约 **${top['sustainable_profit_per_hour']:,.0f}/h**。\n"
                    f"- **真实可持续产量约 {top['sustainable_output_per_hour']:.1f}/h。** 不是 Mill 限制，而是 L3 Farm 为 Grain、Vegetables 和 Seeds 提供原料时先满载。\n"
                    f"- **流动性不是眼前瓶颈。** 最近一小时观测到的订单消失量约为自产产量的 **{top['demand_multiple']:,.0f}×**；该指标会混入撤单，因此只作支持证据。\n"
                    "- **Pumpkin 的纸面利润更高，但当前不能当答案。** 它带有 `AutumnHarvest` 生产季节标记，已从当前可执行排名剔除。"
                ),
            },
            {
                "id": "headline_metrics",
                "type": "metric-strip",
                "cardIds": ["winner", "winner_profit", "winner_output", "winner_demand"],
            },
            {
                "id": "method",
                "type": "markdown",
                "sourceId": "analysis_notebook",
                "body": (
                    "## 口径\n\n"
                    "这里比较的是‘产品本身的 Exchange 效率’：Q0 最新报价扣 4% 手续费和运输，原材料沿配方树全部自产，工资使用最近实测值；然后按完整链条中最先满载的一座建筑限制产量。这样不会把买原料、现有库存或多建了几座同类建筑造成的规模差异误当成产品更赚钱。"
                ),
            },
            {
                "id": "ranking_finding",
                "type": "markdown",
                "sourceId": "ranking_sql",
                "body": (
                    "## Fodder 是当前 Exchange-only 基准\n\n"
                    "每单位 Fodder 需要 10 Grain + 0.5 Vegetables；继续向上展开还需要 Seeds、Water 和 Power。虽然一座 L1 Mill 能做约 290.5/h，但一座 L3 Farm 只能持续供给约 108.6 Fodder/h，因此 Farm 是瓶颈。即便如此，完整自产净利润仍约 $490/h，高于 Grapes、Grain、Cocoa Beans 和 Cotton。"
                ),
            },
            {
                "id": "profit_ranking_visual",
                "type": "chart",
                "chartId": "profit_ranking_chart",
                "layout": "full",
            },
            {
                "id": "chart_explanation",
                "type": "markdown",
                "sourceId": "ranking_sql",
                "body": (
                    "图中使用完整自产链的可持续利润，而不是‘成品售价减仓库账面成本’。Fodder 的优势在 24 小时价格第 10 百分位下仍为正；Coffee Powder 因当前 -23% 生产速度事件和较高 Mill 工资，Exchange-only 效率不占优，但它在 Grocery 的零售价值不属于本报告范围。"
                ),
            },
            {
                "id": "ranking_detail",
                "type": "table",
                "tableId": "ranking_table",
                "layout": "full",
            },
            {
                "id": "recommendation",
                "type": "markdown",
                "sourceId": "analysis_notebook",
                "body": (
                    "## Recommended next steps\n\n"
                    "1. 把 Fodder 作为 Exchange-only 的机会成本基准：未来任何咖啡溢出销售、Mill 排产或新建产线都应与它比较。\n"
                    "2. 不要仅凭这张表立即把整家公司从咖啡切走；Coffee Powder 的 Grocery 零售利润和现有多 Mill 规模是另一套决策。\n"
                    "3. 若要实际试产 Fodder，先做一个短单并核验 UI 的 Unit cost、所需 Grain/Vegetables 与成交速度，再决定是否长期排产。\n"
                    "4. Pumpkin season 开始、Coffee Powder -23% 事件结束或任一前五产品价格变动超过 10% 时重算。"
                ),
            },
            {
                "id": "further_questions",
                "type": "markdown",
                "body": (
                    "## Further questions\n\n"
                    "- 一个短 Fodder 订单的游戏 UI 实测 Unit cost 是否与递归成本接近？\n"
                    "- 当前多 Mill、单 Farm 配置下，Exchange 与 Grocery 联合优化的最佳排产组合是什么？\n"
                    "- AutumnHarvest 激活后，Pumpkin 的可生产状态、价格和成交深度会如何变化？"
                ),
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": (
                    "## Caveats and assumptions\n\n"
                    f"价格快照时间为 **{analysis['as_of_utc']}**。产速来自游戏页面实测表；Farm 仍为 L3，Mill 用 L1-equivalent 比较。订单消失量会把撤单计为成交，因此不能当成严格销量。季节品一律从当前排名剔除。分析只覆盖现有 Power plant、Water reservoir、Farm 和 Mill 能生产的商品，不覆盖新建其他行业。"
                ),
            },
        ],
    }
    return {
        "surface": "report",
        "manifest": manifest,
        "snapshot": {
            "version": 1,
            "generatedAt": generated,
            "status": "ready",
            "datasets": {
                "summary": [
                    {
                        "winner": top["product"],
                        "sustainable_profit_per_hour": top[
                            "sustainable_profit_per_hour"
                        ],
                        "sustainable_output_per_hour": top[
                            "sustainable_output_per_hour"
                        ],
                        "demand_multiple": top["demand_multiple"],
                        "price_as_of_utc": analysis["as_of_utc"],
                    }
                ],
                "rankings": ranking,
                "ranking_top10": chart_rows,
                "exclusions": exclusions,
            },
        },
        "sources": sources,
    }


def main() -> None:
    analysis = build_analysis()
    write_json(BASE / "analysis.json", analysis)
    write_sqlite(BASE / "exchange-analysis.sqlite", analysis)
    write_json(BASE / "exchange-self-production.ipynb", notebook(analysis))
    write_json(BASE / "artifact.json", artifact(analysis))
    print(
        json.dumps(
            {
                "winner": analysis["top_current"]["product"],
                "profit_per_hour": analysis["top_current"][
                    "sustainable_profit_per_hour"
                ],
                "as_of_utc": analysis["as_of_utc"],
                "checks": analysis["quality_checks"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
