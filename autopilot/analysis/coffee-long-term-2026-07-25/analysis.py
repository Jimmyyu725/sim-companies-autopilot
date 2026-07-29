from __future__ import annotations

import glob
import json
import math
import re
import sqlite3
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path


ANALYSIS_DIR = Path(__file__).resolve().parent
SIM_ROOT = ANALYSIS_DIR.parents[2]
AUTOPILOT_DIR = SIM_ROOT / "autopilot"
SHARED_DIR = SIM_ROOT / "shared"


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = math.floor((len(ordered) - 1) * fraction)
    return ordered[index]


def parse_retail_observations() -> list[dict]:
    quote_pattern = re.compile(
        r'(?P<product>COFFEE POWDER|STEAK|GRAPES) Stock: (?P<qty>[\d,]+) '
        r'Profit per unit: \$(?P<profit_unit>[\d.]+) Finishes: .*? in '
        r'(?P<duration>[\dhms, ]+) '
        r'Profit per hour: \$(?P<profit_hour>[\d,]+)',
        re.IGNORECASE,
    )
    weather_pattern = re.compile(r'"sellingSpeedMultiplier":(?P<weather>[\d.]+)')
    observations = []
    for path_text in glob.glob(str(AUTOPILOT_DIR / "diary-*.md")):
        path = Path(path_text)
        text = path.read_text(encoding="utf-8", errors="replace")
        weather_match = weather_pattern.search(text)
        for match in quote_pattern.finditer(text):
            duration = match.group("duration")
            hours_match = re.search(r"(\d+)h", duration)
            minutes_match = re.search(r"(\d+)m", duration)
            seconds_match = re.search(r"(\d+)s", duration)
            duration_hours = (
                int(hours_match.group(1) if hours_match else 0)
                + int(minutes_match.group(1) if minutes_match else 0) / 60
                + int(seconds_match.group(1) if seconds_match else 0) / 3600
            )
            qty = int(match.group("qty").replace(",", ""))
            weather = float(weather_match.group("weather")) if weather_match else None
            units_per_hour = qty / duration_hours
            observations.append(
                {
                    "source": path.name,
                    "product": match.group("product").upper(),
                    "qty": qty,
                    "profit_per_unit": float(match.group("profit_unit")),
                    "profit_per_hour": int(match.group("profit_hour").replace(",", "")),
                    "units_per_hour": units_per_hour,
                    "weather_multiplier": weather,
                    "base_units_per_hour": units_per_hour / weather if weather else None,
                    "base_profit_per_hour": (
                        int(match.group("profit_hour").replace(",", "")) / weather
                        if weather
                        else None
                    ),
                }
            )
    return observations


def build_analysis() -> dict:
    state = json.loads((AUTOPILOT_DIR / ".state.json").read_text(encoding="utf-8"))
    price_rows = [
        json.loads(line)
        for line in (SHARED_DIR / "price-tracker/data/prices.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    latest_timestamp = price_rows[-1]["t"]
    price_rows = [row for row in price_rows if row["t"] >= latest_timestamp - 86_400]
    powder_prices = [float(row["p"]["119"]) for row in price_rows if "119" in row["p"]]
    price_mean = statistics.fmean(powder_prices)
    price_sd = statistics.pstdev(powder_prices)

    hourly_buckets: dict[str, list[float]] = {}
    for row in price_rows:
        if "119" not in row["p"]:
            continue
        hour = datetime.fromtimestamp(row["t"], timezone.utc).strftime("%Y-%m-%d %H:00")
        hourly_buckets.setdefault(hour, []).append(float(row["p"]["119"]))
    price_hourly = [
        {"hour_utc": hour, "exchange_price": round(statistics.fmean(values), 3)}
        for hour, values in sorted(hourly_buckets.items())
    ]

    retail_observations = parse_retail_observations()
    powder_fast = [
        row
        for row in retail_observations
        if row["product"] == "COFFEE POWDER" and row["profit_per_unit"] <= 11.2
    ]
    powder_weather_normalized = [
        row for row in powder_fast if row["base_units_per_hour"] is not None
    ]
    retail_base_capacity = statistics.median(
        row["base_units_per_hour"] for row in powder_weather_normalized
    )
    retail_base_profit = statistics.median(
        row["base_profit_per_hour"] for row in powder_weather_normalized
    )

    powder_cost_pattern = re.compile(
        r"COFFEE POWDER Finishes:.*?Unit cost: \$(?P<unit_cost>[\d.]+)",
        re.IGNORECASE,
    )
    powder_unit_costs = []
    for path_text in glob.glob(str(AUTOPILOT_DIR / "diary-*.md")):
        text = Path(path_text).read_text(encoding="utf-8", errors="replace")
        powder_unit_costs.extend(
            float(match.group("unit_cost"))
            for match in powder_cost_pattern.finditer(text)
        )
    powder_unit_cost = statistics.median(powder_unit_costs)
    transport_price = float(state["keyPrices"]["transport"])
    exchange_net_margin = price_mean * 0.96 - transport_price - powder_unit_cost

    mill_rate_modified = float(state["printedRates"]["119"])
    mill_rate_normal = mill_rate_modified / 0.77
    farm_seed_rate = float(state["printedRates"]["66"])
    farm_bean_rate_modified = float(state["printedRates"]["118"])
    farm_bean_rate_normal = farm_bean_rate_modified / 1.21
    farm_powder_capacity = 1 / (
        10 / farm_seed_rate + 10 / farm_bean_rate_normal
    )

    capacity_scenarios = [
        {
            "scenario": "Current two L1 Mills (-23% modifier)",
            "powder_per_hour": round(mill_rate_modified * 2, 2),
            "basis": "Measured current production",
        },
        {
            "scenario": "Two L1 Mills (modifier normalized)",
            "powder_per_hour": round(mill_rate_normal * 2, 2),
            "basis": "Long-run Mill capacity",
        },
        {
            "scenario": "One L2 + one L1 Mill",
            "powder_per_hour": round(mill_rate_normal * 3, 2),
            "basis": "Mill capacity",
        },
        {
            "scenario": "Current L3 Farm shared lane",
            "powder_per_hour": round(farm_powder_capacity, 2),
            "basis": "Normalized Seeds + Beans capacity",
        },
        {
            "scenario": "Two L2 Mills",
            "powder_per_hour": round(mill_rate_normal * 4, 2),
            "basis": "Mill capacity",
        },
        {
            "scenario": "Grocery profitable base absorption",
            "powder_per_hour": round(retail_base_capacity, 2),
            "basis": "Weather-normalized observed retail",
        },
    ]

    retail_comparison = []
    for product in ("COFFEE POWDER", "STEAK", "GRAPES"):
        product_rows = [
            row for row in retail_observations if row["product"] == product
        ]
        if product == "COFFEE POWDER":
            product_rows = powder_fast
        retail_comparison.append(
            {
                "product": product.title(),
                "observed_profit_per_hour": round(
                    statistics.median(row["profit_per_hour"] for row in product_rows)
                ),
                "observation_count": len(product_rows),
                "basis": "Median fast-price observations"
                if product == "COFFEE POWDER"
                else "Latest available observation",
            }
        )

    first_mill_increment = mill_rate_normal
    first_mill_incremental_profit = first_mill_increment * exchange_net_margin
    historical_upgrade_quote = 30_560

    return {
        "as_of_utc": datetime.fromtimestamp(latest_timestamp, timezone.utc).isoformat(),
        "source_state_as_of_utc": state["t"],
        "price_window": {
            "start_utc": datetime.fromtimestamp(price_rows[0]["t"], timezone.utc).isoformat(),
            "end_utc": datetime.fromtimestamp(price_rows[-1]["t"], timezone.utc).isoformat(),
            "samples": len(powder_prices),
            "mean": round(price_mean, 3),
            "p10": round(percentile(powder_prices, 0.10), 3),
            "median": round(statistics.median(powder_prices), 3),
            "p90": round(percentile(powder_prices, 0.90), 3),
            "coefficient_of_variation": round(price_sd / price_mean, 4),
        },
        "economics": {
            "powder_unit_cost": round(powder_unit_cost, 2),
            "exchange_net_margin_at_mean_price": round(exchange_net_margin, 2),
            "fast_retail_profit_per_unit_median": round(
                statistics.median(row["profit_per_unit"] for row in powder_fast), 2
            ),
            "fast_retail_profit_per_hour_median": round(
                statistics.median(row["profit_per_hour"] for row in powder_fast)
            ),
            "weather_normalized_retail_profit_per_hour": round(retail_base_profit),
            "volume_1h_estimate": state["volume1h"]["coffee ground"],
        },
        "capacity": {
            "grocery_base_absorption_per_hour": round(retail_base_capacity, 2),
            "mill_rate_per_l1_normal": round(mill_rate_normal, 2),
            "farm_l3_shared_lane_powder_equivalent": round(farm_powder_capacity, 2),
            "first_l2_mill_increment_per_hour": round(first_mill_increment, 2),
        },
        "upgrade_case": {
            "historical_quote": historical_upgrade_quote,
            "incremental_profit_per_hour_at_exchange_margin": round(
                first_mill_incremental_profit
            ),
            "simple_payback_hours": round(
                historical_upgrade_quote / first_mill_incremental_profit
            ),
            "full_debt_interest_per_hour": round(
                historical_upgrade_quote * 0.005 / 24, 2
            ),
        },
        "price_hourly": price_hourly,
        "capacity_scenarios": capacity_scenarios,
        "retail_comparison": retail_comparison,
        "validation": {
            "decision": "Coffee should remain the core long-run product.",
            "confidence": "Share with caveats",
            "key_caveat": (
                "The price history covers less than one day; modifiers and weather must be "
                "normalized and Power plant live output is not measured yet."
            ),
        },
    }


def write_sqlite(path: Path, analysis: dict) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            DROP TABLE IF EXISTS summary;
            DROP TABLE IF EXISTS retail_comparison;
            DROP TABLE IF EXISTS price_hourly;
            DROP TABLE IF EXISTS capacity_scenarios;

            CREATE TABLE summary (
                exchange_margin REAL,
                retail_profit_per_hour REAL,
                fast_retail_profit_per_hour REAL,
                normalized_production REAL,
                retail_absorption REAL,
                mill_upgrade_payback_hours REAL,
                mill_upgrade_interest_per_hour REAL,
                volume_1h_estimate REAL
            );
            CREATE TABLE retail_comparison (
                product TEXT,
                observed_profit_per_hour REAL,
                observation_count INTEGER,
                basis TEXT
            );
            CREATE TABLE price_hourly (
                hour_utc TEXT,
                exchange_price REAL
            );
            CREATE TABLE capacity_scenarios (
                scenario TEXT,
                powder_per_hour REAL,
                basis TEXT
            );
            """
        )
        economics = analysis["economics"]
        capacity = analysis["capacity"]
        upgrade = analysis["upgrade_case"]
        connection.execute(
            "INSERT INTO summary VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                economics["exchange_net_margin_at_mean_price"],
                economics["weather_normalized_retail_profit_per_hour"],
                economics["fast_retail_profit_per_hour_median"],
                capacity["mill_rate_per_l1_normal"] * 2,
                capacity["grocery_base_absorption_per_hour"],
                upgrade["simple_payback_hours"],
                upgrade["full_debt_interest_per_hour"],
                economics["volume_1h_estimate"],
            ),
        )
        connection.executemany(
            "INSERT INTO retail_comparison VALUES (:product, :observed_profit_per_hour, :observation_count, :basis)",
            analysis["retail_comparison"],
        )
        connection.executemany(
            "INSERT INTO price_hourly VALUES (:hour_utc, :exchange_price)",
            analysis["price_hourly"],
        )
        connection.executemany(
            "INSERT INTO capacity_scenarios VALUES (:scenario, :powder_per_hour, :basis)",
            analysis["capacity_scenarios"],
        )
        connection.commit()
    finally:
        connection.close()


if __name__ == "__main__":
    result = build_analysis()
    if len(sys.argv) == 3 and sys.argv[1] == "--sqlite":
        write_sqlite(Path(sys.argv[2]), result)
    else:
        print(json.dumps(result, indent=2))
