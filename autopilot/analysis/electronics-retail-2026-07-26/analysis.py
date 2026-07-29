from __future__ import annotations

import json
import math
import re
from pathlib import Path


BASE = Path(__file__).resolve().parent
SIM_ROOT = BASE.parents[2]
SNAPSHOT_PATH = BASE / "market-snapshot.json"
BUNDLE_PATH = SIM_ROOT / "bundle-main.js"
KINDS = {24, 25, 26, 27, 28, 98}


def load_snapshot() -> dict:
    return json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))


def load_retail_models() -> dict[int, dict]:
    """Read current economy-state-1 retail model inputs from the live game bundle."""
    source = BUNDLE_PATH.read_text(encoding="utf-8")
    separator = "'),1:JSON.parse('"
    start = source.index(separator) + len(separator)
    end = source.index("')},kKe", start)
    raw = source[start:end]
    models = {}
    for kind in KINDS:
        match = re.search(rf'"{kind}":(\{{[^{{}}]+\}})', raw)
        if not match:
            raise ValueError(f"Retail model for kind {kind} was not found")
        models[kind] = json.loads(match.group(1))
    return models


def retail_units_per_hour(
    retail_price: float,
    quality: int,
    saturation: float,
    model: dict,
    store_level: int = 1,
    sales_modifier_percent: float = 1,
) -> float:
    """Reconstruct the current client bundle's economy-state-1 retail equation."""
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
    seconds_per_unit = numerator / denominator
    return (
        3600.0
        / (seconds_per_unit / store_level)
        * (1.0 + sales_modifier_percent / 100.0)
    )


def evaluate_offer(snapshot: dict, product: dict, offer: dict, model: dict) -> dict:
    actual_wage_per_level = (
        snapshot["electronics_store"]["base_salary_per_level_per_hour"]
        * snapshot["current_administration_overhead"]
    )
    buy_price = float(offer["price"])
    max_price_cents = math.ceil(
        max(product["average_retail_price"] * 3.0, buy_price * 2.0) * 100
    )
    best = None
    for price_cents in range(math.ceil(buy_price * 100), max_price_cents + 1):
        retail_price = price_cents / 100.0
        units_per_hour = retail_units_per_hour(
            retail_price,
            int(offer["quality"]),
            float(product["saturation"]),
            model,
            sales_modifier_percent=snapshot["permanent_sales_modifier_percent"],
        )
        net_profit_per_hour = (
            (retail_price - buy_price) * units_per_hour - actual_wage_per_level
        )
        candidate = (net_profit_per_hour, retail_price, units_per_hour)
        if best is None or candidate > best:
            best = candidate
    assert best is not None
    profit, retail_price, units_per_hour = best
    return {
        "kind": product["kind"],
        "product": product["product"],
        "quality": int(offer["quality"]),
        "buy_price": buy_price,
        "offer_depth": int(offer["quantity"]),
        "optimal_retail_price": retail_price,
        "gross_spread_per_unit": round(retail_price - buy_price, 2),
        "units_per_hour_per_store_level": round(units_per_hour, 6),
        "wage_per_hour_per_store_level": round(actual_wage_per_level, 6),
        "net_profit_per_hour_per_store_level": round(profit, 6),
        "depth_hours_per_store_level": round(offer["quantity"] / units_per_hour, 2),
        "buyer_exchange_fee": 0.0,
        "buyer_transport_cost": 0.0,
    }


def build_analysis() -> dict:
    snapshot = load_snapshot()
    models = load_retail_models()
    offers = []
    for product in snapshot["products"]:
        for offer in product["offers"]:
            offers.append(
                evaluate_offer(snapshot, product, offer, models[product["kind"]])
            )
    offers.sort(
        key=lambda row: row["net_profit_per_hour_per_store_level"], reverse=True
    )
    for rank, row in enumerate(offers, 1):
        row["rank"] = rank

    best_by_product = []
    for product in snapshot["products"]:
        rows = [row for row in offers if row["kind"] == product["kind"]]
        winner = dict(rows[0])
        best_by_product.append(winner)
    best_by_product.sort(
        key=lambda row: row["net_profit_per_hour_per_store_level"], reverse=True
    )
    for rank, row in enumerate(best_by_product, 1):
        row["product_rank"] = rank

    deep_candidates = [row for row in offers if row["offer_depth"] >= 1_000]
    stable_winner = max(
        deep_candidates,
        key=lambda row: row["net_profit_per_hour_per_store_level"],
    )
    spot_winner = offers[0]
    checks = {
        "products_covered": len(snapshot["products"]),
        "quality_offers_evaluated": len(offers),
        "all_products_have_a_winner": len(best_by_product) == len(snapshot["products"]),
        "all_results_are_positive": all(
            row["net_profit_per_hour_per_store_level"] > 0 for row in offers
        ),
        "spot_winner": f'{spot_winner["product"]} Q{spot_winner["quality"]}',
        "stable_winner_minimum_depth_1000": (
            f'{stable_winner["product"]} Q{stable_winner["quality"]}'
        ),
        "buyer_fee_and_transport_are_zero": all(
            row["buyer_exchange_fee"] == 0 and row["buyer_transport_cost"] == 0
            for row in offers
        ),
        "one_cent_price_grid": True,
    }
    return {
        "as_of_utc": snapshot["captured_at_utc"],
        "scope": "Exchange purchase followed by Electronics Store retail sale.",
        "metric": (
            "Net dollars per hour per Electronics Store level after current administration-adjusted "
            "store wages. Buyer Exchange fee and Transport cost are zero."
        ),
        "assumptions": {
            "store_level": 1,
            "administration_overhead_held_at_current_value": snapshot[
                "current_administration_overhead"
            ],
            "sales_modifier_percent": snapshot["permanent_sales_modifier_percent"],
            "price_optimization_increment": 0.01,
            "stable_offer_minimum_depth": 1000,
        },
        "spot_winner": spot_winner,
        "stable_winner": stable_winner,
        "best_by_product": best_by_product,
        "all_offers": offers,
        "quality_checks": checks,
    }


if __name__ == "__main__":
    print(json.dumps(build_analysis(), indent=2, ensure_ascii=False))
