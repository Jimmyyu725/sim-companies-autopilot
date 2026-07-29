# Source Notes

## Scope

This analysis answers which currently self-produced product is best for the owned Grocery store.
It does not rank future industries, restaurant demand, the seasonal Beach market, or Exchange-only
profitability.

## Sources

- `autopilot/.state.json`: current Grocery level, active sale, weather, retail averages, and
  saturation.
- `autopilot/diaries/diary-*.md`: executed Grocery orders and the game's printed Profit per unit and Profit
  per hour.
- `shared/facts/game-facts.json`: Grocery wages, retail eligibility, and production seasonality.

## Method

The game UI's printed Profit per hour controls the result. Weather adjustment adds back fixed
Grocery wages, scales gross hourly contribution by the weather ratio, and deducts fixed wages
again. This avoids incorrectly scaling fixed wages with weather.

## Coverage gap

Coffee Powder and Grapes have comparable current-regime quotes. Apples and Oranges do not have a
fresh post-acceleration quote and remain explicitly unranked. Steak is retained only as a historical
comparison because the company no longer owns a Slaughterhouse. Pumpkin is excluded as seasonal.
