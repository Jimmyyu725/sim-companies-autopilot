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
            DROP TABLE IF EXISTS measured_comparison;
            DROP TABLE IF EXISTS coverage;
            CREATE TABLE summary (
                winner TEXT,
                observed_profit_per_hour REAL,
                current_weather_profit_per_hour REAL,
                normalized_profit_per_hour REAL,
                current_weather_multiplier REAL,
                state_as_of_utc TEXT
            );
            CREATE TABLE measured_comparison (
                rank INTEGER,
                product TEXT,
                quantity INTEGER,
                profit_per_unit REAL,
                observed_profit_per_hour REAL,
                observation_weather REAL,
                current_weather_profit_per_hour REAL,
                normalized_profit_per_hour REAL,
                source TEXT
            );
            CREATE TABLE coverage (
                kind INTEGER,
                product TEXT,
                base_retail_units_per_hour REAL,
                average_retail_price REAL,
                saturation REAL,
                live_quote_covered INTEGER,
                current_weather_profit_per_hour REAL
            );
            """
        )
        winner = analysis["winner"]
        connection.execute(
            "INSERT INTO summary VALUES (?, ?, ?, ?, ?, ?)",
            (
                winner["product"],
                winner["profit_per_hour"],
                winner["current_weather_profit_per_hour"],
                winner["normalized_profit_per_hour"],
                analysis["current_weather_multiplier"],
                analysis["state_as_of_utc"],
            ),
        )
        connection.executemany(
            """
            INSERT INTO measured_comparison VALUES (
                :rank, :product, :quantity, :profit_per_unit, :profit_per_hour,
                :weather_multiplier, :current_weather_profit_per_hour,
                :normalized_profit_per_hour, :source
            )
            """,
            analysis["measured_comparison"],
        )
        connection.executemany(
            """
            INSERT INTO coverage VALUES (
                :kind, :product, :base_retail_units_per_hour, :average_retail_price,
                :saturation, :live_quote_covered, :current_weather_profit_per_hour
            )
            """,
            analysis["self_produced_retail_coverage"],
        )
        connection.commit()
    finally:
        connection.close()


def build_notebook(analysis: dict) -> dict:
    output = json.dumps(
        analysis["measured_comparison"], indent=2, ensure_ascii=False
    )
    checks = json.dumps(analysis["quality_checks"], indent=2, ensure_ascii=False)
    return {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## tl;dr\n",
                    "\n",
                    "Coffee Powder is the best currently verified self-produced Grocery retail product. Its latest order printed $1,639/h in strong weather; the current-weather estimate is about $1,050/h and the weather-normalized estimate is about $949/h.\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Context & Methods\n",
                    "\n",
                    "The game UI's printed Profit per hour is the source of truth. Weather adjustment adds back fixed Grocery wages, rescales gross hourly contribution by the weather ratio, and deducts wages again.\n",
                    "\n",
                    "### Key Assumptions\n",
                    "\n",
                    "- Grocery wages equal the measured base wage times the current building level.\n",
                    "- Retail speed scales with the game's weather multiplier.\n",
                    "- Apples and Oranges remain unranked precisely because no fresh post-acceleration quote exists.\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": ["## Data\n", "\n", "Inputs are the active state, measured game facts, and executed retail quotes in autopilot diaries.\n"],
            },
            {
                "cell_type": "code",
                "execution_count": 1,
                "metadata": {},
                "outputs": [
                    {"name": "stdout", "output_type": "stream", "text": [output + "\n"]}
                ],
                "source": [
                    "from analysis import build_analysis\n",
                    "analysis = build_analysis()\n",
                    "print(analysis[\"measured_comparison\"])\n",
                ],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Results\n",
                    "\n",
                    "Coffee Powder remains far ahead after weather normalization. Steak is a historical comparator but is no longer self-produced; Grapes is the only other current self-produced product with a fresh comparable quote.\n",
                ],
            },
            {
                "cell_type": "code",
                "execution_count": 2,
                "metadata": {},
                "outputs": [
                    {"name": "stdout", "output_type": "stream", "text": [checks + "\n"]}
                ],
                "source": ["print(analysis[\"quality_checks\"])\n"],
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "## Takeaways\n",
                    "\n",
                    "- Keep Coffee Powder as the Grocery default.\n",
                    "- Re-optimize price every order because weather changes the best price and speed.\n",
                    "- Probe Apples and Oranges only when the store is naturally idle; do not interrupt the active Coffee Powder sale.\n",
                ],
            },
        ],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def build_artifact(analysis: dict) -> dict:
    generated = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    winner = analysis["winner"]
    comparison_fields = (
        "rank",
        "product",
        "quantity",
        "profit_per_unit",
        "profit_per_hour",
        "weather_multiplier",
        "current_weather_profit_per_hour",
        "normalized_profit_per_hour",
        "source",
    )
    comparison = [
        {field: row[field] for field in comparison_fields}
        for row in analysis["measured_comparison"]
    ]
    coverage = analysis["self_produced_retail_coverage"]
    sources = [
        {
            "id": "notebook",
            "label": "Retail profitability notebook",
            "path": "autopilot/analysis/retail-profitability-2026-07-25/retail-profitability.ipynb",
        },
        {
            "id": "summary_sql",
            "label": "Retail winner summary query",
            "path": "autopilot/analysis/retail-profitability-2026-07-25/retail-analysis.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM summary",
                "description": "Loads the verified retail winner and weather-adjusted metrics.",
                "executed_at": analysis["state_as_of_utc"],
                "tables_used": ["summary"],
            },
        },
        {
            "id": "comparison_sql",
            "label": "Measured retail comparison query",
            "path": "autopilot/analysis/retail-profitability-2026-07-25/retail-analysis.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM measured_comparison ORDER BY current_weather_profit_per_hour DESC",
                "description": "Loads weather-adjusted executed retail quotes.",
                "executed_at": analysis["state_as_of_utc"],
                "tables_used": ["measured_comparison"],
            },
        },
        {
            "id": "coverage_sql",
            "label": "Current self-produced retail coverage query",
            "path": "autopilot/analysis/retail-profitability-2026-07-25/retail-analysis.sqlite",
            "query": {
                "engine": "sqlite",
                "sql": "SELECT * FROM coverage ORDER BY product",
                "description": "Shows which current self-produced retail candidates have fresh quotes.",
                "executed_at": analysis["state_as_of_utc"],
                "tables_used": ["coverage"],
            },
        },
    ]
    manifest = {
        "version": 1,
        "surface": "report",
        "title": "Current Retail Profitability",
        "description": "Weather-adjusted Grocery retail profitability for the company's tested products.",
        "generatedAt": generated,
        "cards": [
            {
                "id": "winner",
                "description": "Best currently verified self-produced retail product.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [{"label": "Winner", "field": "winner", "format": "text"}],
            },
            {
                "id": "current_profit",
                "description": "Estimated next-order profit at the current weather multiplier.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Current-weather profit per hour", "field": "current_weather_profit_per_hour", "format": "currency"}
                ],
            },
            {
                "id": "base_profit",
                "description": "Estimated profit at neutral 1.0x weather.",
                "dataset": "summary",
                "sourceId": "summary_sql",
                "metrics": [
                    {"label": "Weather-normalized profit per hour", "field": "normalized_profit_per_hour", "format": "currency"}
                ],
            },
        ],
        "charts": [
            {
                "id": "retail_chart",
                "title": "Measured retail profit by product",
                "subtitle": "Executed UI quotes adjusted to the current 1.083x weather; Steak is historical and no longer self-produced.",
                "type": "bar",
                "dataset": "comparison",
                "sourceId": "comparison_sql",
                "valueFormat": "currency",
                "encodings": {
                    "x": {"field": "product", "type": "nominal", "label": "Product"},
                    "y": {"field": "current_weather_profit_per_hour", "type": "quantitative", "label": "Profit per hour", "format": "currency"},
                },
                "yAxisTitle": "Current-weather profit per hour",
                "layout": "full",
            }
        ],
        "tables": [
            {
                "id": "coverage_table",
                "title": "Current self-produced retail coverage",
                "subtitle": "Non-seasonal products from owned production buildings; missing quotes remain explicitly unranked.",
                "dataset": "coverage",
                "sourceId": "coverage_sql",
                "columns": [
                    {"field": "product", "label": "Product", "type": "text"},
                    {"field": "average_retail_price", "label": "Retail average", "format": "currency"},
                    {"field": "saturation", "label": "Saturation", "format": "number"},
                    {"field": "live_quote_covered", "label": "Fresh quote", "type": "text"},
                    {"field": "current_weather_profit_per_hour", "label": "Current-weather profit/h", "format": "currency"},
                ],
            }
        ],
        "sources": sources,
        "blocks": [
            {"id": "title", "type": "markdown", "body": "# Current Retail Profitability"},
            {
                "id": "executive_summary",
                "type": "markdown",
                "sourceId": "summary_sql",
                "body": (
                    "## Executive Summary\n\n"
                    "- **Coffee Powder 是当前已验证的自产零售第一名。** 最新 Grocery 订单打印 **$1,639/h**。\n"
                    f"- 该订单在 **{winner['weather_multiplier']:.3f}×** 好天气下锁定；按当前 **{analysis['current_weather_multiplier']:.3f}×** 天气折算，下一单约 **${winner['current_weather_profit_per_hour']:,.0f}/h**。\n"
                    f"- 中性天气下估计约 **${winner['normalized_profit_per_hour']:,.0f}/h**，仍明显高于现有可比实测。\n"
                    "- Apples 和 Oranges 缺少相同运行阶段的最新 UI 报价，因此精确的四产品全榜仍需补两个只读探测。"
                ),
            },
            {"id": "metrics", "type": "metric-strip", "cardIds": ["winner", "current_profit", "base_profit"]},
            {
                "id": "method",
                "type": "markdown",
                "sourceId": "notebook",
                "body": (
                    "## 天气调整后的答案仍是 Coffee Powder\n\n"
                    "游戏 UI 的 `Profit per hour` 是主证据。天气调整不是简单除以天气倍率：先把 Grocery 的固定工资加回去，只缩放销售贡献，再扣除同一份工资。这样不会在坏天气时低估固定工资的影响。"
                ),
            },
            {"id": "chart", "type": "chart", "chartId": "retail_chart", "layout": "full"},
            {
                "id": "chart_note",
                "type": "markdown",
                "sourceId": "comparison_sql",
                "body": (
                    "Coffee Powder 的领先幅度足够大：按当前天气约 $1.05k/h；历史 Steak 约 $341/h，但公司已没有 Slaughterhouse；Grapes 约 $124/h。价格、成本与天气会变，所以每个新订单仍应实时扫价，而不是固定 $40.30。"
                ),
            },
            {"id": "coverage", "type": "table", "tableId": "coverage_table", "layout": "full"},
            {
                "id": "recommendation",
                "type": "markdown",
                "sourceId": "notebook",
                "body": (
                    "## Recommended next steps\n\n"
                    "1. Grocery 默认继续卖 Coffee Powder。\n"
                    "2. 每轮订单继续实时试价，以 `Profit per hour` 最大化，而不是锁死价格。\n"
                    "3. 等当前零售订单自然结束后，再补 Apples 和 Oranges 的只读价格扫描；不要中断当前 Coffee Powder 订单。\n"
                    "4. 多余 Coffee Powder 才进入 Exchange，避免较低的 Exchange 收益挤占零售队列。"
                ),
            },
            {
                "id": "caveats",
                "type": "markdown",
                "body": (
                    "## Caveats and assumptions\n\n"
                    "结论是‘当前已验证自产零售产品中的第一名’，不是全游戏所有未来产业的永久排名。Apples/Oranges 当前报价缺失；Steak 仅作历史比较；Pumpkin 因季节性剔除。天气调整假设零售速度与游戏天气倍率成比例，并使用 Grocery L2 的固定工资。"
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
                        "winner": winner["product"],
                        "observed_profit_per_hour": winner["profit_per_hour"],
                        "current_weather_profit_per_hour": winner["current_weather_profit_per_hour"],
                        "normalized_profit_per_hour": winner["normalized_profit_per_hour"],
                        "current_weather_multiplier": analysis["current_weather_multiplier"],
                        "state_as_of_utc": analysis["state_as_of_utc"],
                    }
                ],
                "comparison": comparison,
                "coverage": coverage,
            },
        },
        "sources": sources,
    }


def main() -> None:
    analysis = build_analysis()
    write_json(BASE / "analysis.json", analysis)
    write_sqlite(BASE / "retail-analysis.sqlite", analysis)
    write_json(BASE / "retail-profitability.ipynb", build_notebook(analysis))
    write_json(BASE / "artifact.json", build_artifact(analysis))
    print(
        json.dumps(
            {
                "winner": analysis["winner"]["product"],
                "observed_profit_per_hour": analysis["winner"]["profit_per_hour"],
                "current_weather_profit_per_hour": analysis["winner"]["current_weather_profit_per_hour"],
                "normalized_profit_per_hour": analysis["winner"]["normalized_profit_per_hour"],
                "checks": analysis["quality_checks"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
