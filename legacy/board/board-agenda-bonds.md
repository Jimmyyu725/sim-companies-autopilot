# AGENDA (owner-submitted): should we ISSUE BONDS (take on debt) now that Lv.10 unlocked them?

**Submitted by the chairman (Jimmy) 2026-07-24 for the 21:00 board. Deliberate it seriously — the
chairman wants a real debt discussion tonight — but decide on MEASURED terms, per the skeptic rule.**

## Prerequisite the board MUST resolve first
Bonds unlocked at Lv.10 (`capabilities.bonds = true`), but the terms are still UNKNOWN: `/api/v3/bonds/0/`
returned 404 this morning, so the 09:00 board could not score debt and DEFERRED it. `board-data.js`
was fixed 2026-07-24 to try the real candidate endpoints (`bonds/rating`, `bonds/`, `bonds/sold`,
`bonds/owned`, `companies/me/bonds`). **CFO: read `board-data.json → cfo.bonds` first.**
- If it now returns the **coupon (from the credit rating), the issuance ceiling, and the tenor** →
  score the decision below on those MEASURED numbers.
- If it STILL 404s on every path → you CANNOT decide. Do NOT borrow on an assumed coupon (skeptic
  rule). Capture-repair is the only action this cycle; defer the decision one meeting.

## The decision rule (the board's own standard, from the 09:00 crude ruling)
**Issue bonds ONLY if a specific financed asset's REALIZABLE return-on-capital clearly beats the
coupon — on a MEASURED, market-absorbable return, not a paper or bookStale one.** Debt converts a
one-off cash constraint into a fixed recurring obligation; on a volatile-income game that is real risk.

## What would we actually borrow FOR? (score each; most do NOT justify debt today)
| candidate | cost | why debt helps / doesn't |
|---|---|---|
| **Oil rig** | $75.6k | The only thing big enough that debt would *accelerate* (cash $24.7k ≪ $81k gate, weeks away). BUT its return is `bookStale` — the 09:00 board's own fresh realizable rank put crude at only **$234/h / 322h payback**, not $889/h. **Borrowing $75k against an UNPROVEN return is the exact trap the board avoids.** Debt-financing crude requires: live sell-book probe FIRST, then coupon < the *measured* ROC. |
| **2nd Mill** | $30.6k | Already APPROVED and **fires organically** at the cash gate within hours — needs no debt. |
| **2nd store** | ~$11.4k | Triggered build, cheap, self-funds from the store's ~$650/h — no debt case. |
| general "grow faster" | — | We already have **$15.2k frozen capital** (4.75× cash) and a bean pile draining. Adding leverage on top of frozen WIP compounds fragility. |

## The honest framing for the board
Right now there is **no MEASURED, high-ROC, market-absorbable asset that debt would unlock** — the
Mill self-funds, crude's return is unproven, the store is cheap. So the likely answer is **"not yet,
but keep it as a live instrument":** the moment a PROVEN high-ROC line exists (e.g. crude AFTER a live
sell-book confirms its realizable $/h clears the coupon, or a saturating retail line that a new
building would relieve at measured $/h), debt to pull that build forward can beat waiting weeks for
cash — *if* coupon < realized ROC with margin.

## Deliverables from the board tonight
1. State the MEASURED coupon / ceiling / tenor (or "still 404, deferred") — CFO.
2. A written **debt policy**: the ROC-vs-coupon threshold and the absorption test any debt-financed
   asset must pass (never finance a MIRAGE/OVERSUPPLIED line; never finance a `bookStale` return).
3. A yes/no/deferred on issuing bonds THIS cycle, with the number that decides it.

**Chairman's steer:** I want debt on the table as a tool. But borrow only against a return we have
MEASURED and that the market provably absorbs — never against a bookStale or paper number.
