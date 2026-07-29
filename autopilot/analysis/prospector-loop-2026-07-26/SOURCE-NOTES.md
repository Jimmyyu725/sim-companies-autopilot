# Source Notes

## Decision question

Determine whether repeatedly building and scrapping one or more level-one Quarries is a low-cost way to earn Prospector achievement rewards.

## Required structure mapping

- Title: `Prospector Loop Economics`
- Executive summary: direct answer, verification gate, and recommended stopping point
- Key findings: material recycling, current debt/cash constraints, and tier economics
- Recommended next steps: one-cycle proof followed by a bounded loop
- Further questions: first-cycle counter behavior, live purchase quote, and slot-release timing
- Caveats and assumptions: material rather than cash recovery, untested repeat count, and opportunity cost

## Sources and authority

- Authenticated achievement API at 2026-07-27 02:40:46 UTC: Prospector 0/10 and no currently claimable reward rows.
- Current public company API: building value $251,850 and bonds payable $275,000.
- Local measured game facts: L1 Quarry material quantities, approximate value, and three-hour build time.
- Official construction guide: L1 and L2 buildings return their full investment as Q0 construction materials when scrapped.
- Official realm guide: Prospector thresholds and reward amounts.
- Official bonds guide: scrapping cannot reduce building value below 80% of bond liability.

## Table map

- Question: how reward and elapsed time change across Prospector tiers.
- Format: exact lookup table rather than a chart because the user needs thresholds, cumulative rewards, and one/two/three-slot times simultaneously.
- Fields: target scraps, tier and cumulative rewards, marginal reward per scrap, and elapsed hours by parallel slot count.

## Chart map

- Section: Prospector tier efficiency.
- Question: how cumulative achievement reward per elapsed hour changes by target tier using one spare slot.
- Family/type: categorical comparison, vertical bar.
- Fields: target label, cumulative reward, one-slot hours, and average reward per hour.
- Takeaway: efficiency peaks at the 200-scrap tier and falls thereafter.
- Palette: single-root blue, direct values, zero baseline, no redundant legend.

## Validation status

Share with caveats. Arithmetic, live progress, company values, and published mechanics were checked. The repeated-build counter behavior is not yet field-tested on this company; the first cycle is therefore a mandatory validation gate.
