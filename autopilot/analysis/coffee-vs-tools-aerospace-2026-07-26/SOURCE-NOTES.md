# Coffee versus Tools and Aerospace source notes

## Reporting job

- Question: Should the current company keep Coffee or borrow, demolish, and pivot to Tools or Aerospace?
- Audience: Company owner.
- Grain: Current company transition plus quality-zero, fully self-produced retail economics.
- Delivery mode: Portable HTML executive report.

## Sources

- `decision-results.json`: Executed transition and constrained-profit results.
- `analysis.mjs`: Reproducible slot, recursive capacity, retail, capex, salvage, and funding logic.
- `../tools-vs-coffee-2026-07-26/analysis-results.json`: Corrected 46-product current-market ranking.
- `../tools-vs-coffee-2026-07-26/market-snapshot.json`: Current public retail, weather, modifier, and company snapshot.
- `../../.state.json`: Authenticated company cash, debt, slots, buildings, and inventory snapshot.
- `../../../shared/facts/game-facts.json`: Measured recipes, building costs, wages, rates, and scrap mechanic.
- `bond-cap-evidence.md`: User screenshot observation plus the current bundle's remaining-bond formula.
- `../../diaries/diary-2026-07-26-194017.md`: Latest live Mill L2-to-L3 quote and finance follow-up.

## Validation

- Current standard capacity is 10 slots, with 7 used and 3 free.
- Current committed sold debt is 22 × $5,000 = $110,000; daily interest is $550.
- The post-construction Coffee chain is Farm-limited at about 97.9 Powder/hour; a constrained Grocery L2 model gives about $1,779/hour.
- A minimum all-L1 Tools chain is Electronics-limited at about 16 Tools/hour and models about $1,335/hour.
- Fully feeding Hardware L1 needs 9 building types and 14 upstream integer levels. Reusing Power, Water, and Farm still requires six new types and at least three Coffee-building demolitions.
- Satellite is the only Aerospace final product whose building types fit 10 slots. Fully feeding Sales Office L1 needs 54 upstream integer levels; the estimated capital above level 6 extrapolates the measured linear upgrade curve and is not a live quote.
- Overall rating: `Share with caveats`. Tools and Satellite have not been live-built or retail-tested, returned demolition materials are not cash, and unsold bonds are not guaranteed proceeds.

## Visual contract

- Question: Which near-term options fit inside the optimistic deployable-funds ceiling?
- Takeaway: A new L1 Farm is the lowest-capital way to relieve the current Coffee bottleneck; the minimum Tools chain earns less than Coffee, while fully-fed Tools and Satellite exceed available financing.
- Family: Sorted categorical bar.
- Surface: Native `bar` chart in the canonical portable report artifact.
- Dataset: Four reviewed rows from SQLite; full Satellite is kept in the exact table because its scale would flatten the actionable bars.
- Palette: Single blue root with direct category labels; no redundant legend.
