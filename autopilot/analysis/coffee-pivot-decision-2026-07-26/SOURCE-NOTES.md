# Coffee pivot decision source notes

## Reporting job

- Question: Should the current company pivot away from Coffee now?
- Audience: Product stakeholder / company owner.
- Decision: Keep and optimize Coffee, or demolish and rebuild into another industry.
- Time frame: Live company state from July 26, 2026; the Coffee Powder production event ending at 2026-07-27T00:00:00Z; and the Coffee Beans event ending at 2026-08-03T00:00:00Z.
- Delivery mode: Portable HTML.

## Required executive structure mapping

- Title: `title`
- Executive Summary: `executive_summary`
- Key findings with evidence: `current_position`, `pivot_timing`, `options_finding`, `option_table_block`, `switching_economics`, `payback_table_block`, `pricing_opportunity`
- Recommended next steps: `recommendations`
- Further questions: `further_questions`
- Caveats and assumptions: `caveats`

## Sources and authority

- `decision-results.json`: Executed and validated decision calculations.
- `analysis.mjs`: Reproducible production, recursive cost, retail, capacity-matching, and payback calculations.
- `coffee-pivot-decision.sqlite`: Reviewed option and payback rows used by the report's actual SQLite chart/table source queries.
- `autopilot/.state.json`: Authenticated company cash, buildings, debt, and source freshness.
- `market-snapshot.json`: HTTP-200 retail, weather, production modifier, company, and authenticated snapshots captured at 2026-07-26T06:16:03.448Z.
- `autopilot/diaries/diary-2026-07-26-013129.md` and `brain.log`: Live Mill inspection and Coffee retail order used for formula reconciliation.
- `bundle-main.js` and `shared/facts/game-facts.json`: Current game formula and encyclopedia-derived recipes, wages, and raw rates.

## Validation

- The latest live 55-unit Coffee order recomputes to $1,598.45/h versus the displayed $1,597/h. The $1.45 gap is within the combined UI rounding of unit profit, countdown duration, and displayed profit/hour.
- All 80 retail snapshot rows are unique at the `(kind, quality)` grain.
- All five market snapshot endpoints returned HTTP 200.
- Every option output is finite and uses the same per-retail-level denominator.
- Coffee production and retail are live-verified; pivot candidates are formula-only and labeled as such.
- The current Mill upgrade ends before the Coffee Powder event. A complete 24-hour post-event observation window therefore ends at 2026-07-28T00:00:00Z (Chicago July 27, 19:00), the earliest recommended decision-grade review.
- The recommended 20% profit-advantage and seven-day company-level payback gates are decision guardrails, not game facts. They must be recalculated with integer buildings, current administration overhead, transition quotes, downtime, and interest.
- Removing both the current Powder -23% and Beans +21% events gives a Coffee formula sensitivity of about $1,223.35/h/store level versus Diesel at $1,369.24. The approximately 11.9% paper gap remains below the recommended guardrail.
- The current report retains the 06:16 UTC administration overhead for comparability. A later live Mill inspection printed $404/h instead of the earlier approximately $402/h, so absolute post-upgrade profits require a fresh overhead read at the review checkpoint.
- Overall rating: `Share with caveats` because transition capex, downtime, demolition, added interest, integer building levels, and post-pivot administration overhead are not yet quoted.

## Visual and table plan

- `option_efficiency_chart`: Bar comparison of net profit per hour per total building level for five structurally plausible scenarios. This denominator avoids ranking options only by retail-building output. Short direct category labels, a zero baseline, and no redundant legend. BFR and other infeasible outliers are excluded because they would distort the scale and are outside the decision set.
- `option_comparison`: Exact operating scenario comparison.
- `payback_comparison`: Per-store-level sensitivity of Diesel's paper advantage to unknown switching cost. It is not an executable company-level payback quote.

## Notebook status

- `coffee-pivot-decision.ipynb` is structurally valid and all Python code cells pass syntax validation.
- It was not executed because this NAS does not have `jupyter`, `nbformat`, or `nbclient` installed.
- Exact command to execute after installing those dependencies:

  `python -m jupyter nbconvert --execute --to notebook --inplace coffee-pivot-decision.ipynb`

- The canonical calculation is `analysis.mjs`, which executed successfully with the installed Node.js runtime.

## Delivery status

- Portable artifact validation and packaging passed.
- Verification status is `structural_only`: exact payload and semantic fallback checks passed, but enhanced-reader browser QA did not run because no compatible Chromium headless-shell is installed. The delivery tool did not download or install a browser.
