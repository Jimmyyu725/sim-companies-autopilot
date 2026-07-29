# AGENDA (owner-submitted, table at the next meeting): the single retail lane vs four products

**Submitted by the chairman (Jimmy) 2026-07-23 night. This is the FIRST-priority item.**

## The problem, in one line
We now produce (or are about to) **four** retail goods — coffee powder, grapes, steak, sausages —
but the grocery store has **exactly ONE sales lane**. Three of the four will freeze as inventory.

## The hard constraint (MEASURED — do not re-litigate)
- A store runs **ONE sales order at a time**. Read verbatim off the L2 store page (strategist,
  2026-07-23). **Upgrading a store adds sell SPEED, not a parallel lane. Only a second STORE
  building adds a second lane.** This already killed the 7-22 "$14k retail-capacity" question.

## The four products competing for that one lane (MEASURED)
| product | our production /h | retail velocity `unitsSoldAnHour` | note |
|---|---|---|---|
| coffee powder | ~40 (one Mill) | (verify) | current $/h king, owns the lane |
| grapes | ~95 | 95 | legacy, low $/u |
| steak (k7) | 25.93 (live L1) | 35 | real demand, retail $57.31 vs exch net $46.42 |
| sausages (k8) | 77.79 (live L1) | 110 | real demand; ALSO has a non-store outlet (quest) |

Slaughterhouse alone = **~104 meat units/h** needing a lane, on top of powder + grapes. One lane
cannot clear ~240 units/h of throughput. This is the flight-computer lesson turned inward: the
bottleneck is no longer market demand (steak/sausages genuinely sell), it is **our own sales-lane
capacity**.

## The decision for the board
Lv.10 (reached ~22:30 2026-07-23) just freed the **6th building slot**. The standing queue puts
**Bakery (~$42k, dough $/h high but `unitsSoldAnHour = 0` — 100% exchange-dependent)** in that slot.
**Re-open that against a 2nd grocery store**, because a 2nd store is what unlocks the meat we are
already paying wages to produce.

Weigh, with MEASURED numbers:
1. **6th slot = 2nd store vs Bakery?** A 2nd store is a second retail lane; cost = one store build
   (~$11–12k per the grocery per-level spec, cheaper than Bakery) + it makes the slaughterhouse's
   output actually sellable. Bakery adds $/h on paper but dumps 100% onto the exchange (no retail
   lane, `unitsSoldAnHour = 0`) — the very trap we just spent three workflows proving loses.
2. **Lane allocation until a 2nd store exists:** rank powder vs steak vs grapes vs sausages by
   *realizable* $/h (price × min(production, velocity) − cost), NOT paper $/h. Powder likely still
   wins; grapes likely retire. Decide what the single lane runs.
3. **Sausages → the "200 sausages → +1 building level" quest** is a store-free outlet — route
   sausages there first (make, don't buy: ~$560 of pigs, ~2.6h) so they don't fight the lane.
4. **Steak surplus → exchange only as last resort:** the steak q0 book is thin (**14,843 units**),
   so our own supply presses the price. Prefer a retail lane over dumping.

## Skeptic check the CEO must run before ratifying
- MEASURE the **coffee-powder retail velocity** and the **2nd-store build cost + build time** live
  before comparing — do not decide the 6th slot on ASSUMED numbers.
- Confirm the slaughterhouse can only run ONE product at a time too (steak OR sausages), so its
  own 104 u/h figure is really "25.93 steak OR 145 sausages", not both at once — size the lane
  math to whichever the board chooses to run.

**Chairman's steer (advice, not an order — you execute):** the value of a scarce building slot is
a *sales lane*, not raw production. Don't build more producers than we can sell. Decide the 6th
slot with that lens.
