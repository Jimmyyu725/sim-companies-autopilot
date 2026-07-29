# Electronics Store retail analysis source notes

## Reporting job

- Question: Which Electronics Store product currently produces the most net dollars per hour when bought on the Exchange and sold at retail?
- Audience: Company owner / operating stakeholder.
- Decision: Pick the current spot purchase and a deeper-liquidity default, without yet deciding to construct a store.
- Delivery mode: Portable HTML with a reproducible notebook companion.

## Sources

- `market-snapshot.json`: Authenticated live Exchange best offers by quality plus current retail average, saturation, and demand, captured at `2026-07-26T05:59:39.636Z`.
- `/srv/appdata/chrome-automation/sim/bundle-main.js`: Current game client bundle. The analysis extracts economy-state-1 retail model inputs for kinds 24, 25, 26, 27, 28, and 98 and reconstructs the active retail equation.
- Current company state at capture: level 12, 5.882% administration overhead, permanent sales modifier 1%, no Electronics Store, and zero free building slots.

## Metric definition

Net dollars per hour per Electronics Store level equals `(optimized retail price - current Exchange buy price) × modeled units sold per hour - current administration-adjusted store wages`. The search uses one-cent retail-price increments for every currently visible quality tier.

The buyer pays the displayed Exchange price only. The seller's 4% Exchange fee and outbound Transport do not apply to the buyer and are both zero in this calculation.

## Validation

- Every Electronics Store product has at least one evaluated quality tier.
- Every offer uses the same current retail equation and company modifiers.
- The full quality-tier ranking and each product's best tier are retained in `analysis.json`.
- The current spot winner and the minimum-1,000-unit deep-liquidity winner are asserted in the calculation output.

## Caveats

- Exchange prices and order-book depth can change immediately.
- Retail saturation is time-varying.
- Results hold the current administration overhead constant. Constructing or upgrading a store may raise overhead and lower absolute profit per hour.
- The current company has no Electronics Store and no free slot, so this report is a hypothetical operating comparison, not a recommendation to build immediately.

## Notebook execution status

The notebook is structurally valid, but this host does not have `jupyter`, `nbformat`, or `nbclient`. The identical standard-library calculation in `analysis.py` was executed successfully with Python 3.

## Report delivery status

The portable report passed canonical artifact validation and packaging. Structural verification passed. Browser rendering QA was unavailable because this host does not have a compatible Chromium headless-shell; the report retains its semantic table as the chart fallback.
