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
            DROP TABLE IF EXISTS product_ranking;

            CREATE TABLE summary (
                spot_winner TEXT,
                spot_profit_per_hour_per_level REAL,
                spot_offer_depth INTEGER,
                stable_winner TEXT,
                stable_profit_per_hour_per_level REAL,
                stable_offer_depth INTEGER,
                price_as_of_utc TEXT
            );

            CREATE TABLE product_ranking (
                product_rank INTEGER,
                kind INTEGER,
                product TEXT,
                quality INTEGER,
                buy_price REAL,
                offer_depth INTEGER,
                optimal_retail_price REAL,
                gross_spread_per_unit REAL,
                units_per_hour_per_store_level REAL,
                wage_per_hour_per_store_level REAL,
                net_profit_per_hour_per_store_level REAL,
                depth_hours_per_store_level REAL
            );
            """
        )
        spot = analysis["spot_winner"]
        stable = analysis["stable_winner"]
        connection.execute(
            "INSERT INTO summary VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                f'{spot["product"]} Q{spot["quality"]}',
                spot["net_profit_per_hour_per_store_level"],
                spot["offer_depth"],
                f'{stable["product"]} Q{stable["quality"]}',
                stable["net_profit_per_hour_per_store_level"],
                stable["offer_depth"],
                analysis["as_of_utc"],
            ),
        )
        connection.executemany(
            """
            INSERT INTO product_ranking VALUES (
                :product_rank, :kind, :product, :quality, :buy_price,
                :offer_depth, :optimal_retail_price, :gross_spread_per_unit,
                :units_per_hour_per_store_level, :wage_per_hour_per_store_level,
                :net_profit_per_hour_per_store_level, :depth_hours_per_store_level
            )
            """,
            analysis["best_by_product"],
        )
        connection.commit()
    finally:
        connection.close()


def notebook(analysis: dict) -> dict:
    ranking_output = json.dumps(
        analysis["best_by_product"], indent=2, ensure_ascii=False
    )
    checks_output = json.dumps(
        analysis["quality_checks"], indent=2, ensure_ascii=False
    )
    return {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "# Electronics Store dollar/hour analysis\n",
                    "\n",
                    "## tl;dr\n",
                    "\n",
                    "当前瞬时最高是 Q1 Laptops；若要求同价位至少 1,000 件，当前最高是 Q7 Smart Phones。结果均按每一级 Electronics Store 表示。",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Context & Methods\n",
                    "\n",
                    "The notebook combines a timestamped Exchange order-book snapshot with the current economy-state-1 retail equation extracted from the live game bundle. For every product and visible quality tier, it searches retail prices in $0.01 increments and deducts the current administration-adjusted Electronics Store wage. Exchange buyers pay neither the seller's 4% fee nor seller-side Transport.\n",
                    "\n",
                    "### Key assumptions\n",
                    "\n",
                    "- Results are per Electronics Store level; throughput and wages both scale with store level while administration overhead is held at its current value.\n",
                    "- The stable winner requires at least 1,000 units at the quoted best price for that quality.\n",
                    "- Exchange prices are instantaneous and retail saturation updates over time.\n",
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
                        "text": [ranking_output + "\n"],
                    }
                ],
                "source": [
                    "from analysis import build_analysis\n",
                    "analysis = build_analysis()\n",
                    "print(analysis['best_by_product'])\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Results\n",
                    "\n",
                    "The spot winner benefits from a cheap but shallow Q1 Laptop offer. Q7 Smart Phones trade a small amount of hourly profit for much deeper sourcing, making them the more robust continuous-arbitrage choice.\n",
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
                        "text": [checks_output + "\n"],
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
                    "- Buy Q1 Laptops only while the $1,170 offer remains available.\n",
                    "- Use Q7 Smart Phones as the current deep-liquidity default.\n",
                    "- Recalculate immediately before buying because the ranking is quote-sensitive.\n",
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
    spot = analysis["spot_winner"]
    stable = analysis["stable_winner"]
    ranking = analysis["best_by_product"]
    query_time = analysis["as_of_utc"]
    sources = [
        {
            "id": "notebook",
            "label": "Electronics retail analysis notebook",
            "path": "autopilot/analysis/electronics-retail-2026-07-26/electronics-retail.ipynb",
        },
        {
            "id": "summary_sql",
            "label": "Electronics retail winner query",
            "path": "autopilot/analysis/electronics-retail-2026-07-26/electronics-retail.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM summary",
                "description": "Loads the spot and deep-liquidity Electronics Store winners.",
                "executed_at": query_time,
                "tables_used": ["summary"],
            },
        },
        {
            "id": "ranking_sql",
            "label": "Electronics retail product ranking query",
            "path": "autopilot/analysis/electronics-retail-2026-07-26/electronics-retail.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM product_ranking ORDER BY net_profit_per_hour_per_store_level DESC",
                "description": "Loads each product's best currently quoted quality and optimized retail price.",
                "executed_at": query_time,
                "tables_used": ["product_ranking"],
            },
        },
    ]
    manifest = {
        "version": 1,
        "surface": "report",
        "title": "Electronics Store Retail Arbitrage",
        "description": "Current Exchange-to-Electronics-Store net profit per hour.",
        "generatedAt": generated,
        "cards": [
            {
                "id": "spot_winner",
                "description": "Highest profit at the current best offer, regardless of depth.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Spot winner", "field": "spot_winner", "format": "text"}
                ],
            },
            {
                "id": "spot_profit",
                "description": "Net dollars per hour per Electronics Store level.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {
                        "label": "Spot net profit / h / level",
                        "field": "spot_profit_per_hour_per_level",
                        "format": "currency",
                    }
                ],
            },
            {
                "id": "stable_winner",
                "description": "Best candidate with at least 1,000 units at the quoted price.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Deep-liquidity winner", "field": "stable_winner", "format": "text"}
                ],
            },
        ],
        "charts": [
            {
                "id": "profit_chart",
                "title": "Best quality tier by product",
                "subtitle": "Net profit per hour per Electronics Store level; current administration overhead included.",
                "type": "bar",
                "dataset": "ranking",
                "sourceId": "ranking_sql",
                "valueFormat": "currency",
                "encodings": {
                    "x": {
                        "field": "product",
                        "type": "nominal",
                        "label": "Product",
                    },
                    "y": {
                        "field": "net_profit_per_hour_per_store_level",
                        "type": "quantitative",
                        "label": "Net profit per hour per store level",
                        "format": "currency",
                    },
                },
                "yAxisTitle": "Net $ / h / Electronics Store level",
                "layout": "full",
            }
        ],
        "tables": [
            {
                "id": "ranking_table",
                "title": "Current optimized comparison",
                "subtitle": "One-cent retail-price search; only each product's best quality tier is shown.",
                "dataset": "ranking",
                "sourceId": "ranking_sql",
                "columns": [
                    {"field": "product_rank", "label": "Rank", "type": "number"},
                    {"field": "product", "label": "Product", "type": "text"},
                    {"field": "quality", "label": "Quality", "type": "number"},
                    {"field": "buy_price", "label": "Buy", "format": "currency"},
                    {"field": "offer_depth", "label": "Depth", "type": "number"},
                    {"field": "optimal_retail_price", "label": "Best retail", "format": "currency"},
                    {"field": "units_per_hour_per_store_level", "label": "Units/h/level", "format": "number"},
                    {"field": "net_profit_per_hour_per_store_level", "label": "Net $/h/level", "format": "currency"}
                ],
            }
        ],
        "sources": sources,
        "blocks": [
            {"id": "title", "type": "markdown", "body": "# Electronics Store Retail Arbitrage"},
            {
                "id": "executive_summary",
                "type": "markdown",
                "sourceId": "summary_sql",
                "body": (
                    "## Executive Summary\n\n"
                    f'- **瞬时最高：{spot["product"]} Q{spot["quality"]}，约 '
                    f'${spot["net_profit_per_hour_per_store_level"]:.2f}/h/店铺等级。** '
                    f'交易所买价 ${spot["buy_price"]:.2f}，最优零售价 '
                    f'${spot["optimal_retail_price"]:.2f}；但当前同价仅 {spot["offer_depth"]:,} 件。\n'
                    f'- **深度至少 1,000 件时：{stable["product"]} Q{stable["quality"]} 最优，约 '
                    f'${stable["net_profit_per_hour_per_store_level"]:.2f}/h/店铺等级。** '
                    f'当前同价深度 {stable["offer_depth"]:,} 件。\n'
                    "- 买方不承担卖家的 4% Exchange 手续费，也不消耗买方仓库 Transport；计算只用买价、零售收入和 Electronics Store 工资。"
                ),
            },
            {"id": "metrics", "type": "metric-strip", "cardIds": ["spot_winner", "spot_profit", "stable_winner"]},
            {
                "id": "key_finding",
                "type": "markdown",
                "sourceId": "ranking_sql",
                "body": "## Key findings\n\nLaptops 的第一名来自一档便宜但较浅的 Q1 报价。Smart Phones 的收益略低，但 Q7 同价货源更深，更适合连续补货。只比较单件差价会忽略质量对销量、零售价对成交速度以及店铺工资，因此这里以最终净 $/h 排名。",
            },
            {"id": "chart", "type": "chart", "chartId": "profit_chart", "layout": "full"},
            {"id": "table", "type": "table", "tableId": "ranking_table", "layout": "full"},
            {
                "id": "recommendations",
                "type": "markdown",
                "sourceId": "notebook",
                "body": "## Recommended next steps\n\n1. 若只做当前一批，优先抢 Q1 Laptops 的 $1,170 报价。\n2. 若希望长期自动补货，当前优先 Q7 Smart Phones；每次补货前重新计算。\n3. 不要为了这个排名立即建 Electronics Store：公司当前没有该建筑且没有空槽，建造还会改变 administration overhead，需要在规划建筑时重新测算。",
            },
            {
                "id": "further_questions",
                "type": "markdown",
                "body": "## Further questions\n\n- 若未来腾出一个建筑槽，Electronics Store 与现有 Grocery/Mill 的机会成本谁更低？\n- 加入预计建造成本、拆除成本和 administration overhead 增量后，回本期多长？",
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": "## Caveats and assumptions\n\n结果使用 2026-07-26 05:59:39 UTC 的 Exchange 报价和当日零售 saturation。交易所报价会随时变化。结果按每一级 Electronics Store 表示，并暂时固定当前 5.882% administration overhead；实际新建或升级店铺会改变 overhead，因此未来实际绝对收益可能略低。‘稳定’仅定义为当前同价位深度至少 1,000 件，不代表未来价格保证。",
            },
        ],
    }
    summary = [
        {
            "spot_winner": f'{spot["product"]} Q{spot["quality"]}',
            "spot_profit_per_hour_per_level": round(spot["net_profit_per_hour_per_store_level"], 2),
            "spot_offer_depth": spot["offer_depth"],
            "stable_winner": f'{stable["product"]} Q{stable["quality"]}',
            "stable_profit_per_hour_per_level": round(stable["net_profit_per_hour_per_store_level"], 2),
            "stable_offer_depth": stable["offer_depth"],
            "price_as_of_utc": analysis["as_of_utc"],
        }
    ]
    return {
        "surface": "report",
        "manifest": manifest,
        "snapshot": {
            "version": 1,
            "generatedAt": generated,
            "status": "ready",
            "datasets": {"summary": summary, "ranking": ranking},
        },
    }


def main() -> None:
    analysis = build_analysis()
    write_json(BASE / "analysis.json", analysis)
    write_sqlite(BASE / "electronics-retail.sqlite", analysis)
    write_json(BASE / "electronics-retail.ipynb", notebook(analysis))
    write_json(BASE / "artifact.json", artifact(analysis))


if __name__ == "__main__":
    main()
