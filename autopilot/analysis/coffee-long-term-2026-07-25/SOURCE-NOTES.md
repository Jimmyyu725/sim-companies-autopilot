# Coffee long-run report source notes

## Reporting job

- Question: Should Coffee remain apple.co Corp's long-run core product?
- Audience: Product stakeholders / owner.
- Decision: Continue investing in the full self-produced coffee chain, or change direction.
- Time frame: Current operating evidence through July 25, 2026, with normalized long-run capacity.
- Baseline: Sustainably profitable Grocery Coffee Powder absorption versus end-to-end self-produced capacity.
- Delivery mode: Portable HTML.

## Required executive structure mapping

- Title: `title`
- Executive Summary: `executive_summary`
- Key findings with visual evidence: `economics_finding`, `price_finding`, and `capacity_finding`
- Recommended next steps: `recommendation`
- Further questions: `further_questions`
- Caveats and assumptions: `caveats`

## Source inventory

- `autopilot/.state.json`: normalized state, measured rates, prices, debt, and one-hour volume estimate.
- `autopilot/diaries/diary-*.md`: production unit costs and game-printed retail economics.
- `shared/price-tracker/data/prices.jsonl`: rolling exchange asks.
- `shared/facts/game-facts.json`: recipes and building facts.
- `analysis.py`: reproducible standard-library calculations used to populate the report.
- `coffee-long-term-analysis.ipynb`: notebook companion.

## Chart map

| Segment | Question | Chart | Fields | Claim |
|---|---|---|---|---|
| Economics | Does coffee outperform available retail alternatives? | Bar | product, observed_profit_per_hour | Coffee Powder has the strongest observed profit/hour. |
| Price stability | Is the overflow channel stable enough to use? | Line | hour_utc, exchange_price | The recent exchange price remained in a narrow range. |
| Capacity | Where does production sit versus the retail target? | Horizontal bar | scenario, powder_per_hour | Production, then the Farm, constrains the current chain. |

## Validation

- Overall assessment: Share with caveats.
- Verified: price statistics recomputed from 736 observations; retail throughput and profit recomputed from game-printed dialogs; Mill and Farm modifiers normalized; Farm shared-lane formula independently checked; first Mill payback reconciled from quote, incremental output, margin, and debt interest.
- Main caveat: less than one day of price history and unequal retail comparison samples.
- Missing measurement: live Power plant output and unit cost after construction.

## Notebook execution status

The notebook is structurally valid, but this host does not have `jupyter`, `nbformat`, or `nbclient`.
The identical calculations in `analysis.py` executed successfully with Python 3. To execute the
notebook after those dependencies are available:

```bash
python3 -m jupyter nbconvert --execute --to notebook --inplace coffee-long-term-analysis.ipynb
```

## Report delivery status

The portable report passed canonical artifact validation, packaging, payload-equality checks, and
structural verification. The packaged verifier could not complete browser QA: its default
headless-shell was unavailable, and the installed Google Chrome reported an extraction-environment
mismatch. The delivered semantic chart tables remain available as the fallback.
