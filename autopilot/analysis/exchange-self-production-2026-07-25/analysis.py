from __future__ import annotations

import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path


ANALYSIS_DIR = Path(__file__).resolve().parent
SIM_ROOT = ANALYSIS_DIR.parents[2]
AUTOPILOT_DIR = SIM_ROOT / "autopilot"
SHARED_DIR = SIM_ROOT / "shared"

OWNED_PRODUCTION_BUILDINGS = {"E", "W", "P", "i"}
DISPLAY_NAMES = {
    119: "Coffee Powder",
    136: "Cocoa Beans",
}

# These four overrides come from recent live production dialogs, not the raw game model.
# Power: 62,863 units / 24h, labor $10,404 (2026-07-25T19:47Z).
# Water: 14,400 units from 2026-07-25T22:37:09.600Z to 2026-07-26T07:17:45.600Z,
# labor $3,152. Farm and Mill wages are fresh P1 building inspections at 00:34Z.
MEASURED_RATES = {
    1: 62_863 / 24,
    2: 14_400 / ((8 * 3_600 + 40 * 60 + 36) / 3_600),
}
MEASURED_WAGES = {
    "E": 10_404 / 24,
    "W": 3_152 / ((8 * 3_600 + 40 * 60 + 36) / 3_600),
    "P": 329.0,
    "i": 402.0,
}


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[math.floor((len(ordered) - 1) * fraction)]


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def display_name(kind: int, names: dict[str, str]) -> str:
    return DISPLAY_NAMES.get(kind, names[str(kind)].title())


def expand_activity(
    kind: int,
    facts: dict,
    rates: dict[int, float],
    multiplier: float = 1.0,
    activities: dict[int, float] | None = None,
) -> dict[int, float]:
    """Expand one final unit into every production activity in its self-made recipe tree."""
    if activities is None:
        activities = {}
    if kind not in rates:
        raise ValueError(f"No measured rate for required self-produced kind {kind}")
    activities[kind] = activities.get(kind, 0.0) + multiplier
    for input_kind, quantity in facts["resources"][str(kind)]["recipe"].items():
        expand_activity(
            int(input_kind),
            facts,
            rates,
            multiplier * float(quantity),
            activities,
        )
    return activities


def observed_volume(
    rows: list[dict], kind: int, now: int, hours: int
) -> tuple[float, float, int]:
    selected = [row for row in rows if row["t1"] > now - hours * 3_600]
    units = sum(float(row.get("u", {}).get(str(kind), 0)) for row in selected)
    ambiguous = sum(float(row.get("amb", {}).get(str(kind), 0)) for row in selected)
    observations = sum(1 for row in selected if str(kind) in row.get("u", {}))
    return units, ambiguous, observations


def build_analysis() -> dict:
    state = load_json(AUTOPILOT_DIR / ".state.json")
    facts = load_json(SHARED_DIR / "facts/game-facts.json")
    names = load_json(SHARED_DIR / "price-tracker/data/names.json")
    book_state = load_json(SHARED_DIR / "price-tracker/data/book-state.json")
    price_rows = [
        json.loads(line)
        for line in (SHARED_DIR / "price-tracker/data/prices.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    volume_rows = [
        json.loads(line)
        for line in (SHARED_DIR / "price-tracker/data/volume.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]

    latest = price_rows[-1]
    latest_prices = {int(kind): float(price) for kind, price in latest["p"].items()}
    transport_price = latest_prices[13]
    window_rows = [row for row in price_rows if row["t"] >= latest["t"] - 86_400]
    volume_now = max(row["t1"] for row in volume_rows)

    rates = {
        int(kind): float(rate)
        for kind, rate in state["printedRates"].items()
        if not kind.startswith("_")
    }
    rates.update(MEASURED_RATES)

    candidates = []
    for kind_text, resource in facts["resources"].items():
        kind = int(kind_text)
        building = resource.get("producedAt")
        if (
            building not in OWNED_PRODUCTION_BUILDINGS
            or not resource.get("isExchangeTradable")
            or kind not in rates
            or kind not in latest_prices
        ):
            continue

        activities = expand_activity(kind, facts, rates)
        hours_by_building: dict[str, float] = {}
        own_cost = 0.0
        for activity_kind, quantity in activities.items():
            activity_resource = facts["resources"][str(activity_kind)]
            activity_building = activity_resource["producedAt"]
            hours = quantity / rates[activity_kind]
            hours_by_building[activity_building] = (
                hours_by_building.get(activity_building, 0.0) + hours
            )
            own_cost += hours * MEASURED_WAGES[activity_building]

        sustainable_output = min(1 / hours for hours in hours_by_building.values())
        bottleneck = max(hours_by_building, key=hours_by_building.get)
        transportation = float(resource["transportation"])
        exchange_price = latest_prices[kind]
        net_sale = exchange_price * 0.96 - transportation * transport_price
        margin = net_sale - own_cost

        producer_wage = MEASURED_WAGES[building]
        direct_input_opportunity = sum(
            float(quantity)
            * (
                latest_prices[int(input_kind)] * 0.96
                - float(facts["resources"][str(input_kind)]["transportation"])
                * transport_price
            )
            for input_kind, quantity in resource["recipe"].items()
        )
        conversion_margin = (
            net_sale
            - producer_wage / rates[kind]
            - direct_input_opportunity
        )

        price_values = [
            float(row["p"][str(kind)])
            for row in window_rows
            if str(kind) in row["p"]
        ]
        p10_price = percentile(price_values, 0.10)
        p10_net_sale = p10_price * 0.96 - transportation * transport_price
        volume_1h, ambiguous_1h, volume_observations_1h = observed_volume(
            volume_rows, kind, volume_now, 1
        )
        volume_24h, ambiguous_24h, volume_observations_24h = observed_volume(
            volume_rows, kind, volume_now, 24
        )
        book = book_state.get("books", {}).get(str(kind), {})
        book_age_minutes = (
            (latest["t"] - int(book["t"])) / 60 if book.get("t") else None
        )
        seasonal = bool(resource.get("productionSeason"))

        candidates.append(
            {
                "kind": kind,
                "product": display_name(kind, names),
                "building": facts["buildings"][building]["name"],
                "building_letter": building,
                "latest_price": round(exchange_price, 4),
                "price_p10_24h": round(p10_price, 4),
                "price_median_24h": round(statistics.median(price_values), 4),
                "price_samples_24h": len(price_values),
                "transport_per_unit": transportation,
                "transport_price": round(transport_price, 4),
                "net_sale_per_unit": round(net_sale, 4),
                "own_cost_per_unit": round(own_cost, 4),
                "margin_per_unit": round(margin, 4),
                "direct_output_per_hour": round(rates[kind], 2),
                "direct_profit_per_hour": round(margin * rates[kind], 1),
                "sustainable_output_per_hour": round(sustainable_output, 2),
                "sustainable_profit_per_hour": round(margin * sustainable_output, 1),
                "p10_sustainable_profit_per_hour": round(
                    (p10_net_sale - own_cost) * sustainable_output, 1
                ),
                "conversion_profit_per_hour": round(
                    conversion_margin * rates[kind], 1
                ),
                "bottleneck": facts["buildings"][bottleneck]["name"],
                "hours_by_building": {
                    facts["buildings"][letter]["name"]: round(hours, 6)
                    for letter, hours in hours_by_building.items()
                },
                "volume_1h_observed": round(volume_1h),
                "volume_1h_ambiguous": round(ambiguous_1h),
                "volume_observations_1h": volume_observations_1h,
                "volume_24h_observed": round(volume_24h),
                "volume_24h_ambiguous": round(ambiguous_24h),
                "volume_observations_24h": volume_observations_24h,
                "demand_multiple": round(volume_1h / sustainable_output, 1),
                "book_lowest_ask": book.get("top"),
                "book_age_minutes": round(book_age_minutes, 1)
                if book_age_minutes is not None
                else None,
                "seasonal": seasonal,
                "production_season": resource.get("productionSeason"),
                "status": "Excluded: seasonal" if seasonal else "Current candidate",
            }
        )

    current = sorted(
        (row for row in candidates if not row["seasonal"]),
        key=lambda row: row["sustainable_profit_per_hour"],
        reverse=True,
    )
    for rank, row in enumerate(current, 1):
        row["rank"] = rank
    seasonal = sorted(
        (row for row in candidates if row["seasonal"]),
        key=lambda row: row["sustainable_profit_per_hour"],
        reverse=True,
    )

    top = current[0]
    checks = {
        "candidate_count": len(candidates),
        "current_candidate_count": len(current),
        "all_candidates_have_prices": all(row["latest_price"] > 0 for row in candidates),
        "all_candidates_have_positive_rates": all(
            row["direct_output_per_hour"] > 0 for row in candidates
        ),
        "seasonal_products_excluded": [row["product"] for row in seasonal],
        "top_product": top["product"],
        "top_remains_positive_at_24h_p10": top[
            "p10_sustainable_profit_per_hour"
        ]
        > 0,
        "top_demand_exceeds_sustainable_output": top["demand_multiple"] > 1,
    }

    return {
        "as_of_utc": datetime.fromtimestamp(latest["t"], timezone.utc).isoformat(),
        "state_as_of_utc": state["t"],
        "scope": (
            "Products made by currently owned production-building types: Power plant, "
            "Water reservoir, L3 Farm, and L1-equivalent Mill. Seasonal production is "
            "excluded from the executable ranking."
        ),
        "method": {
            "exchange_fee": 0.04,
            "transport_price": round(transport_price, 4),
            "profit_metric": (
                "Net exchange revenue minus all recursively self-produced input labor; "
                "output is capped by the first one-building bottleneck in the full recipe tree."
            ),
            "demand_metric": (
                "Rotating order-book disappearance estimate; includes cancellations and can "
                "overstate true purchases."
            ),
        },
        "top_current": top,
        "current_ranking": current,
        "seasonal_exclusions": seasonal,
        "quality_checks": checks,
        "source_files": [
            "autopilot/.state.json",
            "autopilot/diaries/diary-2026-07-25-144728.md",
            "autopilot/diaries/diary-2026-07-25-173617.md",
            "autopilot/diaries/diary-2026-07-25-193417.md",
            "shared/facts/game-facts.json",
            "shared/price-tracker/data/prices.jsonl",
            "shared/price-tracker/data/book-state.json",
            "shared/price-tracker/data/volume.jsonl",
        ],
    }


if __name__ == "__main__":
    print(json.dumps(build_analysis(), indent=2, ensure_ascii=False))
