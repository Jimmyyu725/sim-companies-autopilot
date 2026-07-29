# Fully self-produced retail report source notes

## Reporting job

- Question: Which products and retail buildings produce the most dollars per hour when every input is self-produced?
- Audience: Product stakeholders / company owner.
- Decision: Keep expanding Coffee, consider a different six-slot industry, or defer higher-complexity retailers until the company has more slots.
- Time frame: Live retail and company state captured July 26, 2026; current and neutral-weather views.
- Delivery mode: Portable HTML.

## Required executive structure mapping

- Title: `title`
- Executive Summary: `executive_summary`
- Key findings with visual evidence: `retailer_finding`, `retailer_chart_block`, `store_table_block`, `feasible_finding`, `feasible_chart_block`
- Recommended next steps: `recommendations`
- Further questions: `further_questions`
- Caveats and assumptions: `caveats`

## Sources

- `market-snapshot.json`: Live `/api/v4/0/resources-retail-info/`, `/api/v2/weather/0/`, `/api/v2/production-modifiers/0/`, company public infrastructure, and authenticated permanent modifiers.
- `shared/facts/game-facts.json`: Measured recipes, raw rates, production buildings, wage bands, and seasonality.
- `shared/facts/encyclopedia/building-{G,C,H,d,A,2,B}.txt`: Current product membership for every permanent retailer.
- `bundle-main.js`: Current economy-state-1 retail model inputs and equation.
- `analysis.py`: Reproducible standard-library recursive production-cost, price-optimization, and capacity calculation.

## Metric definitions

- Net profit per hour per retail level: optimized retail revenue minus labor at every recursive production stage and the retail building.
- Production levels needed: the sum of all production building-level equivalents required to continuously supply one retail-building level at its optimized selling speed.
- Profit per total building level: net profit divided by one retail level plus all required production-level equivalents.
- Minimum distinct slots: one slot for each unique production building type plus the retail building. Capacity may be consolidated by upgrading within each slot.

## Chart map

| Segment | Question | Chart | Fields | Supported claim |
|---|---|---|---|---|
| Retailer ceiling | What wins inside each non-aerospace retailer? | Ranked bar | store, current_profit_per_store_level | Tools, E-Car, Diesel, Pizza, Necklace, and Televisions are each store's current best product. |
| Six-slot candidates | What is structurally possible now? | Ranked bar | product, profit_per_total_building_level | Necklace is the strongest paper candidate that fits six distinct slots. |

## Validation

- All five live APIs returned HTTP 200 at capture.
- 80 retail rows were captured; 46 non-seasonal products across seven permanent retailers were evaluated.
- All seven retailers have a winner; current and neutral-weather winners match for every store.
- BFR's extreme headline is kept visible but separated from the operational recommendation because it needs 16 distinct slots and hundreds of production levels.
- Exchange fee, purchase price, and Transport are intentionally absent because the calculation is fully self-produced.

## Notebook execution status

The notebook is structurally valid, but this host does not have `jupyter`, `nbformat`, or `nbclient`. The identical standard-library calculation in `analysis.py` executed successfully with Python 3.

## Omitted scopes

- Restaurant recipes are not one-resource retail products and need a separate meal/recipe model.
- Seasonal markets and Ramadan Sweets are excluded from the permanent current ranking.
- Capex, debt interest, construction downtime, research quality, and transition inventory are not included; they are required before an actual industry switch.

## Report delivery status

The portable report passed canonical artifact validation and packaging. Structural verification passed. Browser rendering QA was unavailable because this host does not have a compatible Chromium headless-shell; both charts retain semantic table fallbacks.
