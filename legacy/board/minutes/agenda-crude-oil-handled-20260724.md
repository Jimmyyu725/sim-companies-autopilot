# AGENDA (owner-submitted): pivot the endgame toward CRUDE OIL (Oil rig) production?

**Submitted by the chairman (Jimmy) 2026-07-24. Deliberate with the NEW realizable metric (Rule 4d
/ `board/.realizable.json`), not paper $/h. This is the chairman's preferred direction — size it
with MEASURED numbers, don't rubber-stamp it.**

## Why crude is a real candidate (it PASSED the mirage filter)
Crude oil is the strongest non-Catering durable good the new `realizable.js` surfaces:
- `verdict = B2B-DEEP`, derived demand **199.8/h** (refineries → fuels → ~everything burns it).
- `realizablePerHour ≈ $754/bldg-hr` (pre-wage) — an HONEST post-haircut number, not the old paper
  $1,649. It survived the filter that killed aerospace ($0).
- Non-Catering, durable (fuel demand does not fade like a fad), 72%-ish margin.

## The three hard truths the board MUST weigh before "ALL crude"
1. **`bookStale = TRUE` → the $754 is ±2×.** No live crude sell-book was captured this cycle, so the
   metric used the price-trend coin-flip (pk 0.5). Per Rule 4d, **probe the real crude sell-book
   depth (`/api/v3/market/0/10/`) BEFORE any Oil-rig capex.** If the book is a deep lake, pk (and the
   $/h) halves; if thin/draining, it rises.
2. **Realm absorption ceiling ≈ 200/h; one rig makes 97/h.** So ~**2 Oil rigs saturate the entire
   realm's crude demand** — the metric already caps ONE rig's realizable crude at **34/h** (of its
   97/h output; α·derived=68, ×pk 0.5 = 34). "ALL crude" as a MONOCULTURE (3+ rigs) would oversupply
   and press our own price — the same lake trap, just at higher volume. Size to ≤ what the realm
   (minus other producers) actually absorbs.
3. **Methane is dead weight.** The Oil rig co-produces methane (k74) = `B2B-THIN`, realizable **$22**.
   Do not count it toward the case; the rig is a crude play only.

## The real decision for the board (not yes/no, but how much + how)
- **How many Oil rigs?** Rank crude's realizable $/h against the alternatives at each additional rig,
  accounting for the 200/h ceiling. Likely answer: 1–2 rigs YES (within absorption), a full
  monoculture NO. Use `industry-report.js` (now realizable-ranked) + the sell-book probe.
- **Sell crude, or REFINE it?** Oil rig → Refinery → diesel/plastic/fuel may realize more than raw
  crude and dodge crude's own oversupply. Score the refined products in `board/.realizable.json`
  (diesel/plastic verdicts) before deciding the chain depth.
- **Capital:** $76k + $518/h wage per rig is heavy; cost the working capital (Rule 3b), not just the
  sticker. We are at ~$16k cash — this is a multi-week accumulation, not a now-build.
- **Sequencing vs the standing queue** (coffee → Slaughterhouse → Bakery → Oil rig): Oil rig is
  already the durable anchor of the queue. This proposal asks whether to *lean harder* into it.

## Chairman's steer (advice — you execute)
I like crude as the durable endgame. But "全部原油" only works up to the realm's ~200/h ceiling, and
the $754 is unproven until the sell-book is probed. Decide the **rig count and sell-vs-refine** on
MEASURED numbers, and never let it become a lake we can't drain (Rule 4d, `realizableFraction`).
