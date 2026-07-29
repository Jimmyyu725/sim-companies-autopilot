# Source Notes

## Decision scope

The ranking covers Q0 products made by the company's currently owned production-building types:
Power plant, Water reservoir, L3 Farm, and Mill. It is an Exchange-only comparison and does not
include Grocery retail profit or products that require a new building type.

## Sources

- `autopilot/.state.json`: current buildings, levels, measured Farm/Mill rates, and state timestamp.
- `autopilot/diaries/diary-2026-07-25-144728.md`: measured Power job quantity, duration, labor, and unit cost.
- `autopilot/diaries/diary-2026-07-25-173617.md`: measured Water job quantity, timestamps, labor, and unit cost.
- `autopilot/diaries/diary-2026-07-25-193417.md`: P1 Farm and Mill inspections and live production quotes.
- `shared/facts/game-facts.json`: measured recipes, transportation, Exchange fee, building mapping,
  and seasonality.
- `shared/price-tracker/data/prices.jsonl`: full Exchange ticker snapshots.
- `shared/price-tracker/data/book-state.json`: rotating order-book snapshot and lowest visible ask.
- `shared/price-tracker/data/volume.jsonl`: rotating order-level disappearance estimate.

## Metric definition

Sustainable profit per hour equals net Exchange revenue after the 4% fee and outbound
transportation, less labor for every recursively self-produced recipe activity. Output is capped by
the first one-building bottleneck in the full production tree. This compares product-line economics
without rewarding a product merely because the company already owns more copies of its final
building.

## Caveats

- Order disappearance includes cancellations and can overstate true purchases.
- Production rates and wages are measured UI values, but only Coffee Beans and Coffee Powder had a
  fresh same-day P1 quote. Other Farm/Mill products inherit the measured rate table while their
  building levels remain unchanged.
- Pumpkin is excluded because `productionSeason` is `AutumnHarvest`; its displayed off-season
  economics are not treated as currently executable.
- A short Fodder UI quote remains the preferred final execution check before changing production.
