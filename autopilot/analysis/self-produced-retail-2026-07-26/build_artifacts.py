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
            DROP TABLE IF EXISTS store_winners;
            DROP TABLE IF EXISTS feasible_candidates;
            DROP TABLE IF EXISTS all_products;

            CREATE TABLE summary (
                theoretical_winner TEXT,
                theoretical_store TEXT,
                theoretical_profit_per_store_level REAL,
                theoretical_minimum_slots INTEGER,
                theoretical_production_levels REAL,
                feasible_winner TEXT,
                feasible_store TEXT,
                feasible_profit_per_store_level REAL,
                feasible_profit_per_total_level REAL,
                feasible_minimum_slots INTEGER,
                coffee_profit_per_store_level REAL,
                price_as_of_utc TEXT
            );

            CREATE TABLE store_winners (
                store_rank INTEGER,
                store TEXT,
                product TEXT,
                current_net_profit_per_hour_per_store_level REAL,
                neutral_net_profit_per_hour_per_store_level REAL,
                current_optimal_retail_price REAL,
                current_units_per_hour_per_store_level REAL,
                current_own_cost_per_unit REAL,
                current_production_levels_needed_per_store_level REAL,
                minimum_distinct_building_slots INTEGER,
                current_profit_per_total_building_level REAL
            );

            CREATE TABLE feasible_candidates (
                feasible_rank INTEGER,
                store TEXT,
                product TEXT,
                current_net_profit_per_hour_per_store_level REAL,
                current_profit_per_total_building_level REAL,
                minimum_distinct_building_slots INTEGER,
                current_production_levels_needed_per_store_level REAL
            );

            CREATE TABLE all_products (
                overall_current_rank INTEGER,
                store TEXT,
                product TEXT,
                current_own_cost_per_unit REAL,
                current_optimal_retail_price REAL,
                current_units_per_hour_per_store_level REAL,
                current_net_profit_per_hour_per_store_level REAL,
                current_profit_per_total_building_level REAL,
                minimum_distinct_building_slots INTEGER,
                current_production_levels_needed_per_store_level REAL
            );
            """
        )
        theoretical = analysis["current_global_winner"]
        feasible = analysis["current_structurally_feasible_efficiency_winner"]
        coffee = next(
            row for row in analysis["all_products"] if row["kind"] == 119
        )
        connection.execute(
            "INSERT INTO summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                theoretical["product"],
                theoretical["store"],
                theoretical["current_net_profit_per_hour_per_store_level"],
                theoretical["minimum_distinct_building_slots"],
                theoretical["current_production_levels_needed_per_store_level"],
                feasible["product"],
                feasible["store"],
                feasible["current_net_profit_per_hour_per_store_level"],
                feasible["current_profit_per_total_building_level"],
                feasible["minimum_distinct_building_slots"],
                coffee["current_net_profit_per_hour_per_store_level"],
                analysis["as_of_utc"],
            ),
        )
        store_fields = (
            "store_rank",
            "store",
            "product",
            "current_net_profit_per_hour_per_store_level",
            "neutral_net_profit_per_hour_per_store_level",
            "current_optimal_retail_price",
            "current_units_per_hour_per_store_level",
            "current_own_cost_per_unit",
            "current_production_levels_needed_per_store_level",
            "minimum_distinct_building_slots",
            "current_profit_per_total_building_level",
        )
        connection.executemany(
            f"INSERT INTO store_winners VALUES ({','.join('?' for _ in store_fields)})",
            [tuple(row[field] for field in store_fields) for row in analysis["best_by_store"]],
        )
        feasible_rows = sorted(
            (
                row
                for row in analysis["all_products"]
                if row["minimum_distinct_building_slots"]
                <= analysis["company"]["maximumBuildings"]
            ),
            key=lambda row: row["current_profit_per_total_building_level"],
            reverse=True,
        )
        for rank, row in enumerate(feasible_rows, 1):
            row["feasible_rank"] = rank
        feasible_fields = (
            "feasible_rank",
            "store",
            "product",
            "current_net_profit_per_hour_per_store_level",
            "current_profit_per_total_building_level",
            "minimum_distinct_building_slots",
            "current_production_levels_needed_per_store_level",
        )
        connection.executemany(
            f"INSERT INTO feasible_candidates VALUES ({','.join('?' for _ in feasible_fields)})",
            [tuple(row[field] for field in feasible_fields) for row in feasible_rows],
        )
        all_fields = (
            "overall_current_rank",
            "store",
            "product",
            "current_own_cost_per_unit",
            "current_optimal_retail_price",
            "current_units_per_hour_per_store_level",
            "current_net_profit_per_hour_per_store_level",
            "current_profit_per_total_building_level",
            "minimum_distinct_building_slots",
            "current_production_levels_needed_per_store_level",
        )
        connection.executemany(
            f"INSERT INTO all_products VALUES ({','.join('?' for _ in all_fields)})",
            [tuple(row[field] for field in all_fields) for row in analysis["all_products"]],
        )
        connection.commit()
    finally:
        connection.close()


def notebook(analysis: dict) -> dict:
    winners = [
        {
            "store": row["store"],
            "product": row["product"],
            "current_profit_per_store_level": round(
                row["current_net_profit_per_hour_per_store_level"], 2
            ),
            "neutral_profit_per_store_level": round(
                row["neutral_net_profit_per_hour_per_store_level"], 2
            ),
            "minimum_slots": row["minimum_distinct_building_slots"],
            "production_levels": round(
                row["current_production_levels_needed_per_store_level"], 2
            ),
        }
        for row in analysis["best_by_store"]
    ]
    return {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "# Fully self-produced retail comparison\n",
                    "\n",
                    "## tl;dr\n",
                    "\n",
                    "BFR is the theoretical profit-per-store-level winner but needs 16 distinct slots and roughly 767 production levels per Sales Office level. Under the company's six-slot structural limit, Necklace is the strongest current candidate. Coffee Powder remains close on store-level profit and already matches the owned asset base.\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Context & Methods\n",
                    "\n",
                    "The analysis uses current retail saturation, the live economy-state-1 retail equation, current weather, company administration overhead, permanent production/sales modifiers, temporary resource modifiers, and the measured recursive recipe graph. Every input is internally produced; Exchange price, fee, and Transport are excluded.\n",
                    "\n",
                    "### Key Assumptions\n",
                    "\n",
                    "- Product quality is Q0.\n",
                    "- Profit includes labor for every production stage and the retail building.\n",
                    "- Minimum slots count one building for every distinct production type plus the retailer; higher levels can consolidate capacity within a slot.\n",
                    "- Capex, debt interest, construction downtime, and transition inventory are not included.\n",
                    "- Seasonal stores, Restaurant recipes, and Ramadan Sweets are excluded.\n",
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
                        "text": [json.dumps(winners, indent=2, ensure_ascii=False) + "\n"],
                    }
                ],
                "source": [
                    "from analysis import build_analysis\n",
                    "analysis = build_analysis()\n",
                    "for row in analysis['best_by_store']:\n",
                    "    print(row['store'], row['product'], row['current_net_profit_per_hour_per_store_level'], row['minimum_distinct_building_slots'])\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Data\n",
                    "\n",
                    "The snapshot contains 80 live retail rows and 46 evaluated non-seasonal products across seven permanent retailer types. Product membership comes from the current building encyclopedia pages.\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Results\n",
                    "\n",
                    "The absolute store-level ranking is dominated by aerospace because one Sales Office can absorb output from hundreds of production levels. The six-slot screen changes the answer to Necklace. Neutral weather leaves every store's winning product unchanged.\n",
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
                        "text": [
                            json.dumps(
                                analysis["quality_checks"], indent=2, ensure_ascii=False
                            )
                            + "\n"
                        ],
                    }
                ],
                "source": ["print(analysis['quality_checks'])\n"],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Takeaways\n",
                    "\n",
                    "- Do not use BFR's store-level headline for the current company.\n",
                    "- Necklace is the best six-slot paper candidate, but switching requires a full-chain rebuild.\n",
                    "- Keep Coffee Powder as the operating baseline until capex, transition downtime, and payback are compared.\n",
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
    theoretical = analysis["current_global_winner"]
    feasible = analysis["current_structurally_feasible_efficiency_winner"]
    coffee = next(row for row in analysis["all_products"] if row["kind"] == 119)
    winners = [
        {
            "store_rank": row["store_rank"],
            "store": row["store"],
            "product": row["product"],
            "current_profit_per_store_level": round(
                row["current_net_profit_per_hour_per_store_level"], 2
            ),
            "neutral_profit_per_store_level": round(
                row["neutral_net_profit_per_hour_per_store_level"], 2
            ),
            "optimal_retail_price": row["current_optimal_retail_price"],
            "units_per_hour_per_store_level": round(
                row["current_units_per_hour_per_store_level"], 3
            ),
            "own_cost_per_unit": round(row["current_own_cost_per_unit"], 2),
            "production_levels_needed": round(
                row["current_production_levels_needed_per_store_level"], 2
            ),
            "minimum_slots": row["minimum_distinct_building_slots"],
            "profit_per_total_building_level": round(
                row["current_profit_per_total_building_level"], 2
            ),
        }
        for row in analysis["best_by_store"]
    ]
    non_aerospace = [row for row in winners if row["store"] != "Sales Offices"]
    feasible_rows = sorted(
        (
            row
            for row in analysis["all_products"]
            if row["minimum_distinct_building_slots"] <= analysis["company"]["maximumBuildings"]
        ),
        key=lambda row: row["current_profit_per_total_building_level"],
        reverse=True,
    )[:8]
    feasible_data = [
        {
            "rank": rank,
            "store": row["store"],
            "product": row["product"],
            "profit_per_store_level": round(
                row["current_net_profit_per_hour_per_store_level"], 2
            ),
            "profit_per_total_building_level": round(
                row["current_profit_per_total_building_level"], 2
            ),
            "minimum_slots": row["minimum_distinct_building_slots"],
            "production_levels_needed": round(
                row["current_production_levels_needed_per_store_level"], 2
            ),
        }
        for rank, row in enumerate(feasible_rows, 1)
    ]
    summary = [
        {
            "theoretical_winner": theoretical["product"],
            "theoretical_profit_per_store_level": round(
                theoretical["current_net_profit_per_hour_per_store_level"], 2
            ),
            "theoretical_minimum_slots": theoretical["minimum_distinct_building_slots"],
            "feasible_winner": feasible["product"],
            "feasible_profit_per_store_level": round(
                feasible["current_net_profit_per_hour_per_store_level"], 2
            ),
            "feasible_profit_per_total_level": round(
                feasible["current_profit_per_total_building_level"], 2
            ),
            "coffee_profit_per_store_level": round(
                coffee["current_net_profit_per_hour_per_store_level"], 2
            ),
            "as_of_utc": analysis["as_of_utc"],
        }
    ]
    source_path = "autopilot/analysis/self-produced-retail-2026-07-26/self-produced-retail.sqlite"
    sources = [
        {
            "id": "notebook",
            "label": "Fully self-produced retail notebook",
            "path": "autopilot/analysis/self-produced-retail-2026-07-26/self-produced-retail.ipynb",
        },
        {
            "id": "summary_sql",
            "label": "Self-produced retail summary query",
            "path": source_path,
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM summary",
                "description": "Loads the theoretical winner, six-slot winner, and current Coffee baseline.",
                "executed_at": analysis["as_of_utc"],
                "tables_used": ["summary"],
            },
        },
        {
            "id": "store_sql",
            "label": "Retailer winner query",
            "path": source_path,
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM store_winners ORDER BY current_net_profit_per_hour_per_store_level DESC",
                "description": "Loads each permanent retailer's best fully self-produced Q0 product.",
                "executed_at": analysis["as_of_utc"],
                "tables_used": ["store_winners"],
            },
        },
        {
            "id": "feasible_sql",
            "label": "Six-slot candidate query",
            "path": source_path,
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM feasible_candidates ORDER BY current_profit_per_total_building_level DESC",
                "description": "Loads products whose full self-produced chain fits within six distinct building slots.",
                "executed_at": analysis["as_of_utc"],
                "tables_used": ["feasible_candidates"],
            },
        },
    ]
    manifest = {
        "version": 1,
        "surface": "report",
        "title": "Fully Self-Produced Retail",
        "description": "Profitability across permanent retail buildings after every input is self-produced.",
        "generatedAt": generated,
        "cards": [
            {
                "id": "feasible_winner",
                "description": "Best full-chain candidate that fits the current six-slot structure.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Six-slot winner", "field": "feasible_winner", "format": "text"}
                ],
            },
            {
                "id": "feasible_profit",
                "description": "Current net profit after all production and retail labor.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Net $ / h / retail level", "field": "feasible_profit_per_store_level", "format": "currency"}
                ],
            },
            {
                "id": "coffee_baseline",
                "description": "Current fully self-produced Coffee Powder estimate per Grocery level.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Coffee net $ / h / retail level", "field": "coffee_profit_per_store_level", "format": "currency"}
                ],
            },
        ],
        "charts": [
            {
                "id": "retailer_chart",
                "title": "Best product by non-aerospace retailer",
                "subtitle": "Current net dollars per hour per retail-building level; all recursive production labor included.",
                "type": "bar",
                "dataset": "non_aerospace_winners",
                "sourceId": "store_sql",
                "valueFormat": "currency",
                "encodings": {
                    "x": {"field": "store", "type": "nominal", "label": "Retailer"},
                    "y": {"field": "current_profit_per_store_level", "type": "quantitative", "label": "Net profit per hour per retail level", "format": "currency"},
                },
                "yAxisTitle": "Net $ / h / retail-building level",
                "layout": "full",
            },
            {
                "id": "feasible_chart",
                "title": "Six-slot full-chain candidates",
                "subtitle": "Current net dollars per hour divided by all production and retail building levels needed to sustain output.",
                "type": "bar",
                "dataset": "feasible_candidates",
                "sourceId": "feasible_sql",
                "valueFormat": "currency",
                "encodings": {
                    "x": {"field": "product", "type": "nominal", "label": "Product"},
                    "y": {"field": "profit_per_total_building_level", "type": "quantitative", "label": "Net profit per total building level", "format": "currency"},
                },
                "yAxisTitle": "Net $ / h / total building level",
                "layout": "full",
            },
        ],
        "tables": [
            {
                "id": "store_table",
                "title": "Winner inside each permanent retailer",
                "subtitle": "Current weather and modifiers; neutral-weather profit is included as a stability check.",
                "dataset": "store_winners",
                "sourceId": "store_sql",
                "defaultSort": {"field": "current_profit_per_store_level", "direction": "desc"},
                "columns": [
                    {"field": "store", "label": "Retailer", "type": "text"},
                    {"field": "product", "label": "Best product", "type": "text"},
                    {"field": "current_profit_per_store_level", "label": "Current $/h/store level", "format": "currency"},
                    {"field": "neutral_profit_per_store_level", "label": "Neutral $/h/store level", "format": "currency"},
                    {"field": "minimum_slots", "label": "Minimum slots", "type": "number"},
                    {"field": "production_levels_needed", "label": "Production levels needed", "format": "number"},
                    {"field": "profit_per_total_building_level", "label": "$/h/total level", "format": "currency"}
                ],
            }
        ],
        "sources": sources,
        "blocks": [
            {"id": "title", "type": "markdown", "body": "# Fully Self-Produced Retail"},
            {
                "id": "executive_summary",
                "type": "markdown",
                "sourceId": "summary_sql",
                "body": (
                    "## Executive Summary\n\n"
                    f'- **理论绝对第一是 Sales Offices 的 BFR：约 ${theoretical["current_net_profit_per_hour_per_store_level"]:,.0f}/h/零售等级。** 但它至少需要 {theoretical["minimum_distinct_building_slots"]} 种建筑槽，并要约 {theoretical["current_production_levels_needed_per_store_level"]:,.0f} 个生产等级喂满一级 Sales Office，对当前公司不可执行。\n'
                    f'- **当前六槽限制下，Fashion Store 的 Necklace 是纸面第一：约 ${feasible["current_net_profit_per_hour_per_store_level"]:,.0f}/h/店铺等级。** 完整链效率约 ${feasible["current_profit_per_total_building_level"]:,.0f}/h/总建筑等级。\n'
                    f'- **Coffee Powder 约 ${coffee["current_net_profit_per_hour_per_store_level"]:,.0f}/h/Grocery 等级。** Necklace 只在未计建造资本、停产切换和债务利息时领先；公司已有整套咖啡资产，因此不能据此立即转型。'
                ),
            },
            {"id": "metrics", "type": "metric-strip", "cardIds": ["feasible_winner", "feasible_profit", "coffee_baseline"]},
            {
                "id": "definition",
                "type": "markdown",
                "sourceId": "notebook",
                "body": "## 这次的 $/h 是完整自产利润\n\n每件商品从 Power、Water 和原料开始递归自产；利润扣除每一道生产工资和零售店工资。没有交易所买入、4% 手续费或 Transport。主列按当前天气与临时生产修正；neutral 列移除天气和临时修正，用来检查结论是否只靠短期事件。",
            },
            {
                "id": "retailer_finding",
                "type": "markdown",
                "sourceId": "store_sql",
                "body": "## 高店铺利润不等于当前公司能做\n\n除去数值极端的 Aerospace，Hardware 的 Tools、Car Dealership 的 Economy E-Car 和 Gas Station 的 Diesel 都高于现有 Coffee Powder；但它们的完整链分别至少需要 9、13 和 7 种建筑槽。当前容量只有 6，所以这些是未来大公司机会，不是现在可执行的替代品。",
            },
            {"id": "retailer_chart_block", "type": "chart", "chartId": "retailer_chart", "layout": "full"},
            {"id": "store_table_block", "type": "table", "tableId": "store_table", "layout": "full"},
            {
                "id": "feasible_finding",
                "type": "markdown",
                "sourceId": "feasible_sql",
                "body": "## 六槽闭环里 Necklace 最强，但 Coffee 最容易继续执行\n\nNecklace 的完整链需要 Fashion Factory、Mine、Factory、Power、Water 加 Fashion Store，刚好占满六种建筑。Coffee Powder 只需 Power、Water、Farm、Mill 加 Grocery，和现有资产完全一致。Necklace 的纸面效率更高，但它要求拆换整条产业链；在没有建造成本和回本期之前，Coffee 仍应是运营基线。",
            },
            {"id": "feasible_chart_block", "type": "chart", "chartId": "feasible_chart", "layout": "full"},
            {
                "id": "recommendations",
                "type": "markdown",
                "sourceId": "notebook",
                "body": "## Recommended next steps\n\n1. 继续把 Coffee Powder 当作当前运营基线，不因纸面榜立即拆建筑。\n2. 把 Necklace 作为未来转型候选，下一步单独计算六座建筑的建造/升级总成本、债务利息、停产损失和回本小时。\n3. Tools、汽车、燃油和 Aerospace 等待更多建筑槽后再评估；当前不具备完整自产闭环。\n4. 若真的转型，先做一轮最新 UI 生产/零售 dry quote，验证公式估计。",
            },
            {
                "id": "further_questions",
                "type": "markdown",
                "body": "## Further questions\n\n- Necklace 从零建链，相对继续升级咖啡的真实回本期是多少？\n- 若允许部分原料从 Exchange 购买，六槽约束下是否会出现更好的混合方案？\n- 公司升级后增加建筑槽时，Tools、Diesel 或 Economy E-Car 何时首次变得可执行？",
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": "## Caveats and assumptions\n\n结果按 Q0、当前 5.882% administration overhead、2% 永久生产加成、1% 永久销售加成和当前 1.083× 零售天气计算。Neutral 列移除天气和临时资源修正，且各店冠军不变。最低槽位只按不同建筑种类计数，假设可以通过升级在一个槽内集中等级。未计建造资本、升级时间、债务利息、切换停产、研究质量和库存周转。Restaurant、季节市场及 Ramadan Sweets 不在主榜。",
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
                "summary": summary,
                "store_winners": winners,
                "non_aerospace_winners": non_aerospace,
                "feasible_candidates": feasible_data,
            },
        },
    }


def main() -> None:
    analysis = build_analysis()
    write_json(BASE / "analysis.json", analysis)
    write_sqlite(BASE / "self-produced-retail.sqlite", analysis)
    write_json(BASE / "self-produced-retail.ipynb", notebook(analysis))
    write_json(BASE / "artifact.json", artifact(analysis))


if __name__ == "__main__":
    main()
