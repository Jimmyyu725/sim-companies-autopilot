from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from pathlib import Path


BASE = Path(__file__).resolve().parent
SIM_ROOT = BASE.parents[2]
FACTS_PATH = SIM_ROOT / "shared/facts/game-facts.json"
NAMES_PATH = SIM_ROOT / "shared/price-tracker/data/names.json"
BUNDLE_PATH = SIM_ROOT / "bundle-main.js"
SNAPSHOT_PATH = BASE / "market-snapshot.json"

# Product membership is measured from the current building encyclopedia pages.
RETAIL_STORES = {
    "G": {
        "name": "Grocery Store",
        "kinds": [3, 4, 5, 7, 8, 9, 119, 123, 124, 125, 126, 122, 127, 140, 152],
    },
    "C": {"name": "Electronics Store", "kinds": [24, 25, 26, 27, 28, 98]},
    "H": {"name": "Fashion Store", "kinds": [60, 61, 62, 63, 64, 65, 70, 71]},
    "d": {"name": "Hardware Store", "kinds": [102, 103, 108, 109, 110]},
    "A": {"name": "Gas Station", "kinds": [11, 12]},
    "2": {"name": "Car Dealership", "kinds": [53, 54, 55, 56, 57]},
    "B": {"name": "Sales Offices", "kinds": [91, 94, 95, 96, 97, 99]},
}

DISPLAY_NAMES = {
    53: "Economy E-Car",
    54: "Luxury E-Car",
    63: "Stiletto Heel",
    70: "Luxury Watch",
    91: "Sub-Orbital Rocket",
    94: "BFR",
    95: "Jumbo Jet",
    96: "Luxury Jet",
    97: "Single Engine Plane",
    99: "Satellite",
    119: "Coffee Powder",
    127: "Frozen Pizza",
    152: "Ramadan Sweets",
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def exact_base_wage(rounded_wage: float) -> float:
    """Recover the game's 0.1x average-salary wage bands from rounded facts."""
    return round(float(rounded_wage) / 345.0, 1) * 345.0


def load_retail_models(kinds: set[int]) -> dict[int, dict]:
    source = BUNDLE_PATH.read_text(encoding="utf-8")
    separator = "'),1:JSON.parse('"
    start = source.index(separator) + len(separator)
    end = source.index("')},kKe", start)
    raw = source[start:end]
    models = {}
    for kind in kinds:
        match = re.search(rf'"{kind}":(\{{[^{{}}]+\}})', raw)
        if not match:
            raise ValueError(f"Retail model for kind {kind} was not found")
        models[kind] = json.loads(match.group(1))
    return models


def retail_units_per_hour(
    retail_price: float,
    saturation: float,
    model: dict,
    sales_modifier_percent: float,
    weather_multiplier: float,
    quality: int = 0,
) -> float:
    demand_factor = min(2.0, max(0.0, 2.0 - saturation))
    price_factor = max(0.9, demand_factor / 2.0 + 0.5)
    quality_factor = quality / 12.0
    variable_cost = 370.0 * (
        model["buildingLevelsNeededPerUnitPerHour"]
        * model["modeledUnitsSoldAnHour"]
        + 1.0
    ) * (demand_factor / 2.0 * (1.0 + quality_factor * 0.3))
    modeled_units = model["modeledUnitsSoldAnHour"] * price_factor
    modeled_price = model["modeledProductionCostPerUnit"] + (
        variable_cost + model["modeledStoreWages"]
    ) / modeled_units
    curve_weight = (
        variable_cost + model["modeledStoreWages"]
    ) / (modeled_price - model["modeledProductionCostPerUnit"]) ** 2
    curve = variable_cost - (retail_price - modeled_price) ** 2 * curve_weight
    numerator = (retail_price - model["modeledProductionCostPerUnit"]) * 3600.0
    numerator -= model["modeledStoreWages"]
    denominator = curve + model["modeledStoreWages"]
    if numerator <= 0 or denominator <= 0:
        return 0.0
    return (
        3600.0
        / (numerator / denominator)
        * (1.0 + sales_modifier_percent / 100.0)
        * weather_multiplier
    )


def price_domain(model: dict) -> tuple[float, float]:
    demand_factor = 1.0
    # The domain width does not depend on saturation after modeled_price is known,
    # so use the exact formula again in optimize_price rather than this helper.
    del demand_factor
    return (0.01, float("inf"))


def optimize_price(
    own_cost: float,
    saturation: float,
    model: dict,
    store_wage: float,
    sales_modifier_percent: float,
    weather_multiplier: float,
) -> tuple[float, float, float]:
    demand_factor = min(2.0, max(0.0, 2.0 - saturation))
    price_factor = max(0.9, demand_factor / 2.0 + 0.5)
    variable_cost = 370.0 * (
        model["buildingLevelsNeededPerUnitPerHour"]
        * model["modeledUnitsSoldAnHour"]
        + 1.0
    ) * (demand_factor / 2.0)
    modeled_units = model["modeledUnitsSoldAnHour"] * price_factor
    modeled_price = model["modeledProductionCostPerUnit"] + (
        variable_cost + model["modeledStoreWages"]
    ) / modeled_units
    lower_domain = model["modeledProductionCostPerUnit"] + 0.01
    upper_domain = 2.0 * modeled_price - model["modeledProductionCostPerUnit"] - 0.01
    lower = min(upper_domain, max(lower_domain, own_cost))
    upper = max(lower, upper_domain)

    def profit(price: float) -> tuple[float, float]:
        units = retail_units_per_hour(
            price,
            saturation,
            model,
            sales_modifier_percent,
            weather_multiplier,
        )
        return (price - own_cost) * units - store_wage, units

    left, right = lower, upper
    for _ in range(120):
        third = (right - left) / 3.0
        m1, m2 = left + third, right - third
        if profit(m1)[0] < profit(m2)[0]:
            left = m1
        else:
            right = m2
    center_cents = round((left + right) / 2.0 * 100)
    candidate_cents = set(
        range(max(math.ceil(lower * 100), center_cents - 200),
              min(math.floor(upper * 100), center_cents + 200) + 1)
    )
    candidate_cents.add(math.ceil(lower * 100))
    candidate_cents.add(math.floor(upper * 100))
    best = None
    for cents in candidate_cents:
        price = cents / 100.0
        value, units = profit(price)
        candidate = (value, price, units)
        if best is None or candidate > best:
            best = candidate
    assert best is not None
    return best[1], best[2], best[0]


def build_analysis() -> dict:
    facts = load_json(FACTS_PATH)
    names = load_json(NAMES_PATH)
    snapshot = load_json(SNAPSHOT_PATH)
    candidate_kinds = {
        kind for store in RETAIL_STORES.values() for kind in store["kinds"]
    }
    models = load_retail_models(candidate_kinds)
    retail_rows = {
        int(row["kind"]): row
        for row in snapshot["retail"]
        if int(row["kind"]) in candidate_kinds and row.get("quality") is None
    }
    missing_retail = sorted(candidate_kinds - set(retail_rows))
    if missing_retail:
        raise ValueError(f"Missing current retail rows for kinds: {missing_retail}")

    overhead = float(snapshot["company"]["administrationOverhead"])
    permanent_production = float(
        snapshot["company"]["permanentProductionModifierPercent"]
    )
    permanent_sales = float(snapshot["company"]["permanentSalesModifierPercent"])
    weather = float(snapshot["weather"]["sellingSpeedMultiplier"])
    temporary_modifiers = {
        int(row["kind"]): float(row["speedModifier"])
        for row in snapshot["productionModifiers"]
    }

    def resource_name(kind: int) -> str:
        return DISPLAY_NAMES.get(kind, names.get(str(kind), f"kind {kind}").title())

    def production_rate(kind: int, current: bool) -> float:
        resource = facts["resources"][str(kind)]
        rate = float(resource["ratePerHourRaw"]) * (1.0 + permanent_production / 100.0)
        if current:
            rate *= 1.0 + temporary_modifiers.get(kind, 0.0) / 100.0
        if rate <= 0:
            raise ValueError(f"Non-positive production rate for kind {kind}")
        return rate

    @lru_cache(maxsize=None)
    def own_cost(kind: int, current: bool) -> float:
        resource = facts["resources"][str(kind)]
        building = facts["buildings"][resource["producedAt"]]
        direct_labor = exact_base_wage(building["wage"]) * overhead / production_rate(kind, current)
        return direct_labor + sum(
            float(quantity) * own_cost(int(input_kind), current)
            for input_kind, quantity in resource["recipe"].items()
        )

    def activity_levels(kind: int, current: bool, multiplier: float = 1.0, result=None):
        if result is None:
            result = {}
        resource = facts["resources"][str(kind)]
        building = resource["producedAt"]
        result[building] = result.get(building, 0.0) + multiplier / production_rate(kind, current)
        for input_kind, quantity in resource["recipe"].items():
            activity_levels(
                int(input_kind), current, multiplier * float(quantity), result
            )
        return result

    results = []
    exclusions = []
    for store_code, store in RETAIL_STORES.items():
        store_wage = exact_base_wage(facts["buildings"][store_code]["wage"]) * overhead
        for kind in store["kinds"]:
            resource = facts["resources"][str(kind)]
            if resource.get("retailSeason") or resource.get("productionSeason"):
                exclusions.append(
                    {
                        "store": store["name"],
                        "kind": kind,
                        "product": resource_name(kind),
                        "reason": f'Seasonal: {resource.get("retailSeason") or resource.get("productionSeason")}',
                    }
                )
                continue
            retail = retail_rows[kind]
            saturation = float(retail["saturation"])
            current_cost = own_cost(kind, True)
            neutral_cost = own_cost(kind, False)
            current_price, current_units, current_profit = optimize_price(
                current_cost,
                saturation,
                models[kind],
                store_wage,
                permanent_sales,
                weather,
            )
            neutral_price, neutral_units, neutral_profit = optimize_price(
                neutral_cost,
                saturation,
                models[kind],
                store_wage,
                permanent_sales,
                1.0,
            )
            current_activities = activity_levels(kind, True)
            neutral_activities = activity_levels(kind, False)
            current_prod_levels = sum(current_activities.values()) * current_units
            neutral_prod_levels = sum(neutral_activities.values()) * neutral_units
            production_building_types = sorted(current_activities)
            results.append(
                {
                    "store_code": store_code,
                    "store": store["name"],
                    "kind": kind,
                    "product": resource_name(kind),
                    "quality": 0,
                    "saturation": round(saturation, 6),
                    "average_retail_price": retail.get("averagePrice"),
                    "current_own_cost_per_unit": round(current_cost, 6),
                    "current_optimal_retail_price": round(current_price, 2),
                    "current_units_per_hour_per_store_level": round(current_units, 6),
                    "current_net_profit_per_hour_per_store_level": round(current_profit, 6),
                    "current_production_levels_needed_per_store_level": round(current_prod_levels, 6),
                    "production_building_types": production_building_types,
                    "production_building_type_count": len(production_building_types),
                    "minimum_distinct_building_slots": len(production_building_types) + 1,
                    "current_profit_per_total_building_level": round(
                        current_profit / (1.0 + current_prod_levels), 6
                    ),
                    "neutral_own_cost_per_unit": round(neutral_cost, 6),
                    "neutral_optimal_retail_price": round(neutral_price, 2),
                    "neutral_units_per_hour_per_store_level": round(neutral_units, 6),
                    "neutral_net_profit_per_hour_per_store_level": round(neutral_profit, 6),
                    "neutral_production_levels_needed_per_store_level": round(neutral_prod_levels, 6),
                    "neutral_profit_per_total_building_level": round(
                        neutral_profit / (1.0 + neutral_prod_levels), 6
                    ),
                }
            )

    results.sort(
        key=lambda row: row["current_net_profit_per_hour_per_store_level"],
        reverse=True,
    )
    for rank, row in enumerate(results, 1):
        row["overall_current_rank"] = rank
    best_by_store = []
    for store in RETAIL_STORES.values():
        rows = [row for row in results if row["store"] == store["name"]]
        best = dict(max(rows, key=lambda row: row["current_net_profit_per_hour_per_store_level"]))
        best_by_store.append(best)
    best_by_store.sort(
        key=lambda row: row["current_net_profit_per_hour_per_store_level"],
        reverse=True,
    )
    for rank, row in enumerate(best_by_store, 1):
        row["store_rank"] = rank

    best_by_slot_efficiency = max(
        results, key=lambda row: row["current_profit_per_total_building_level"]
    )
    slot_capacity = int(snapshot["company"]["maximumBuildings"])
    structurally_feasible = [
        row
        for row in results
        if row["minimum_distinct_building_slots"] <= slot_capacity
    ]
    feasible_store_profit_winner = max(
        structurally_feasible,
        key=lambda row: row["current_net_profit_per_hour_per_store_level"],
    )
    feasible_efficiency_winner = max(
        structurally_feasible,
        key=lambda row: row["current_profit_per_total_building_level"],
    )
    checks = {
        "live_api_statuses_all_200": all(
            value == 200 for value in snapshot["statuses"].values()
        ),
        "retail_stores_covered": len(RETAIL_STORES),
        "nonseasonal_products_evaluated": len(results),
        "seasonal_products_excluded": len(exclusions),
        "all_products_have_positive_production_rates": all(
            row["current_own_cost_per_unit"] > 0 for row in results
        ),
        "all_store_winners_present": len(best_by_store) == len(RETAIL_STORES),
        "current_weather_multiplier": weather,
        "buyer_exchange_fee_and_transport": "Not applicable: full self-production",
    }
    return {
        "as_of_utc": snapshot["capturedAtUtc"],
        "scope": "Q0 products made through a fully self-produced recipe chain and sold in permanent retail buildings.",
        "metric": "Retail revenue minus all recursive production labor and retail-store wages, per hour per retail-store level.",
        "company": snapshot["company"],
        "weather": snapshot["weather"],
        "current_global_winner": results[0],
        "current_slot_efficiency_winner": best_by_slot_efficiency,
        "current_structurally_feasible_store_profit_winner": feasible_store_profit_winner,
        "current_structurally_feasible_efficiency_winner": feasible_efficiency_winner,
        "best_by_store": best_by_store,
        "all_products": results,
        "exclusions": exclusions,
        "quality_checks": checks,
    }


if __name__ == "__main__":
    print(json.dumps(build_analysis(), indent=2, ensure_ascii=False))
