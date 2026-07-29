# Tools versus Coffee source notes

## Reporting job

- Question: Does Tools lead both profit margin and hourly profit, and where does Coffee rank?
- Audience: Company owner.
- Grain: Quality-zero, fully self-produced retail products, normalized to one retail-store level.
- Time frame: Current public market snapshot captured at 2026-07-27T00:12:16.813Z.
- Delivery mode: Portable HTML.

## Sources and authority

- `analysis-results.json`: Executed ranking and comparison results.
- `analysis.mjs`: Reproducible recursive production-cost, retail-speed, price-optimization, and ranking logic.
- `tools-vs-coffee.sqlite`: Reviewed two-row comparison dataset used by the report chart and table.
- `market-snapshot.json`: Current public Sim Companies retail, weather, production-modifier, and company data.
- `../coffee-pivot-decision-2026-07-26/analysis.mjs`: Prior corrected model used as the formula baseline.
- `../../diaries/diary-2026-07-26-185017.md`: Latest completed live Coffee Powder retail observation used as operational context.
- `../../../shared/facts/game-facts.json` and `../../../bundle-main.js`: Current recipes, wages, raw rates, and retail model constants.

## Validation

- All four public API requests returned HTTP 200; otherwise `analysis.mjs` would have stopped.
- The result contains 46 non-seasonal candidates with unique hourly, margin, and total-level-efficiency ranks.
- Tools and Coffee use the same current market snapshot, weather multiplier, salary assumptions, recursive self-production cost, and retail-wage treatment.
- The SQLite chart/table query returns exactly two reviewed rows and matches the rounded values in `analysis-results.json`.
- Current printed Mill output is 46.86 Coffee Powder per hour at level 2, matching the corrected production formula after the Powder event ended.
- The latest live Coffee order sold 41 units at $40.50 in 16 minutes 31 seconds and displayed $1,626 per hour. This is an actual level-2 order using historical inventory cost and the UI's displayed-profit convention, so it is operational evidence rather than a like-for-like substitute for the normalized model.
- Overall rating: `Share with caveats`. Tools has not been built or live-tested, and the ranking excludes capital cost, integer construction, demolition, downtime, debt interest, and transport.

## Metric definitions

- Net profit margin: modeled hourly net profit divided by modeled hourly retail revenue.
- Net profit per hour per store level: retail revenue less recursive self-production cost and retail wage, normalized to one retail-store level.
- Net profit per unit after retail wage: hourly net profit divided by hourly retail units.
- Profit per total building level: hourly net profit divided by one store level plus the fractional upstream production levels required to feed it.

## Visual plan

- `hourly_profit_chart`: A two-bar comparison of normalized net profit per hour per store level. It makes the approximately 2x relationship immediately visible.
- `product_comparison`: The exact table remains the authoritative surface for margin, unit profit, ranks, and minimum slots.
