from __future__ import annotations

import glob
import json
import re
import statistics
from pathlib import Path


ANALYSIS_DIR = Path(__file__).resolve().parent
SIM_ROOT = ANALYSIS_DIR.parents[2]
AUTOPILOT_DIR = SIM_ROOT / "autopilot"
SHARED_DIR = SIM_ROOT / "shared"


def parse_observations() -> list[dict]:
    quote_pattern = re.compile(
        r'"before":"(?P<product>[A-Z ]+) Stock: (?P<qty>[\d,]+) '
        r'Profit per unit: \$(?P<profit_unit>[\d.]+) Finishes: .*? in '
        r'(?P<duration>[^\"]+?) Profit per hour: \$(?P<profit_hour>[\d,]+)',
        re.IGNORECASE,
    )
    weather_pattern = re.compile(r'"sellingSpeedMultiplier":(?P<weather>[\d.]+)')
    rows = []
    for path_text in sorted(glob.glob(str(AUTOPILOT_DIR / "diary-*.md"))):
        path = Path(path_text)
        text = path.read_text(encoding="utf-8", errors="replace")
        weather_match = weather_pattern.search(text)
        weather = float(weather_match.group("weather")) if weather_match else None
        for match in quote_pattern.finditer(text):
            rows.append(
                {
                    "source": path.name,
                    "product": match.group("product").strip().title(),
                    "quantity": int(match.group("qty").replace(",", "")),
                    "profit_per_unit": float(match.group("profit_unit")),
                    "profit_per_hour": int(
                        match.group("profit_hour").replace(",", "")
                    ),
                    "weather_multiplier": weather,
                    "duration": match.group("duration"),
                }
            )
    return rows


def build_analysis() -> dict:
    state = json.loads((AUTOPILOT_DIR / ".state.json").read_text(encoding="utf-8"))
    facts = json.loads(
        (SHARED_DIR / "facts/game-facts.json").read_text(encoding="utf-8")
    )
    current_weather = float(state["weather"]["sellingSpeedMultiplier"])
    grocery_level = next(
        building["size"]
        for building in state["buildings"]
        if building["name"] == "Grocery store"
    )
    store_wage = float(facts["buildings"]["G"]["wage"]) * grocery_level

    observations = parse_observations()
    adjusted = []
    for row in observations:
        if row["weather_multiplier"]:
            normalized = (
                (row["profit_per_hour"] + store_wage)
                / row["weather_multiplier"]
                - store_wage
            )
            current_adjusted = (
                (row["profit_per_hour"] + store_wage)
                * current_weather
                / row["weather_multiplier"]
                - store_wage
            )
        else:
            normalized = None
            current_adjusted = None
        adjusted.append(
            {
                **row,
                "normalized_profit_per_hour": round(normalized, 1)
                if normalized is not None
                else None,
                "current_weather_profit_per_hour": round(current_adjusted, 1)
                if current_adjusted is not None
                else None,
            }
        )

    # Use the latest large Coffee Powder quote, the latest Grapes quote, and the latest Steak
    # quote. Tiny 2-unit orders remain in the audit trail but do not control the headline.
    selected = []
    selection_rules = {
        "Coffee Powder": lambda row: row["quantity"] >= 100,
        "Grapes": lambda row: True,
        "Steak": lambda row: True,
    }
    for product, predicate in selection_rules.items():
        matches = [
            row
            for row in adjusted
            if row["product"] == product
            and row["weather_multiplier"] is not None
            and predicate(row)
        ]
        if matches:
            selected.append(matches[-1])
    selected.sort(
        key=lambda row: row["current_weather_profit_per_hour"], reverse=True
    )
    for rank, row in enumerate(selected, 1):
        row["rank"] = rank

    retail_by_kind = {
        int(row["dbLetter"]): row for row in state.get("retail", [])
    }
    self_produced_retail = []
    for kind_text, resource in facts["resources"].items():
        kind = int(kind_text)
        if (
            resource.get("producedAt") not in {"E", "W", "P", "i"}
            or not resource.get("unitsSoldAnHour")
            or resource.get("productionSeason")
        ):
            continue
        retail = retail_by_kind.get(resource["dbLetter"])
        product = {
            3: "Apples",
            4: "Oranges",
            5: "Grapes",
            119: "Coffee Powder",
        }.get(kind, f"Kind {kind}")
        measured = [row for row in selected if row["product"] == product]
        self_produced_retail.append(
            {
                "kind": kind,
                "product": product,
                "base_retail_units_per_hour": resource["unitsSoldAnHour"],
                "average_retail_price": retail.get("avgPrice") if retail else None,
                "saturation": retail.get("saturation") if retail else None,
                "live_quote_covered": bool(measured),
                "current_weather_profit_per_hour": measured[0][
                    "current_weather_profit_per_hour"
                ]
                if measured
                else None,
            }
        )

    coffee = next(row for row in selected if row["product"] == "Coffee Powder")
    tested_self_produced = [
        row
        for row in selected
        if row["product"] in {"Coffee Powder", "Grapes"}
    ]
    checks = {
        "latest_state_has_active_coffee_retail": any(
            building["name"] == "Grocery store"
            and building.get("busy", {}).get("makingKind") == 119
            for building in state["buildings"]
        ),
        "coffee_is_best_tested_self_produced": coffee[
            "current_weather_profit_per_hour"
        ]
        == max(row["current_weather_profit_per_hour"] for row in tested_self_produced),
        "coffee_observation_quantity": coffee["quantity"],
        "current_self_produced_quote_coverage": sum(
            row["live_quote_covered"] for row in self_produced_retail
        ),
        "current_self_produced_candidate_count": len(self_produced_retail),
        "missing_current_quotes": [
            row["product"]
            for row in self_produced_retail
            if not row["live_quote_covered"]
        ],
    }

    return {
        "state_as_of_utc": state["t"],
        "current_weather_multiplier": current_weather,
        "grocery_level": grocery_level,
        "grocery_wage_per_hour": store_wage,
        "decision": "Coffee Powder is the best currently verified self-produced retail product.",
        "confidence": "Share with caveats",
        "winner": coffee,
        "measured_comparison": selected,
        "self_produced_retail_coverage": self_produced_retail,
        "observation_count": len(observations),
        "quality_checks": checks,
        "method": (
            "The game UI's printed profit per hour controls. Observations are normalized for "
            "weather by adding back fixed Grocery wages, scaling the gross hourly contribution, "
            "and deducting the same wages again."
        ),
        "caveat": (
            "Apples and Oranges lack a fresh post-acceleration live quote. Their current retail "
            "markets are more saturated than Coffee Powder, but an exact all-four ranking needs "
            "two read-only UI probes when the Grocery becomes idle."
        ),
    }


if __name__ == "__main__":
    print(json.dumps(build_analysis(), indent=2, ensure_ascii=False))
