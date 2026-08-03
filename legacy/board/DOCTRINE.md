# Sim Companies Operating Doctrine — apple.co Corp (company 5714348)

Standing instructions for the autopilot and for whoever is driving it. Authored 2026-07-21
after taking the account over at Lv.3 / $8,981. Everything in the Verified Mechanics section
was measured or read out of the game's own code — nothing here is folklore.

## 0. The skeptic rule (above all others)

Before asserting any number, rule, or fact as the basis for a decision, ask: **have I measured
this — from the game, the API, the code — this session, or am I remembering / inferring / reading
it off ambiguous UI text?** State measured facts plainly; flag inferred ones as assumptions and
verify them before they gate a real spend or an irreversible action. The costliest errors in
this operation (a 7-hour stall on a wrong water divisor; a sound plan rejected 3-0 on wrong
build times; "scrap loses money" when it returns 100%) were all a reasonable assumption worn as
a fact. When a number feels too obvious to check, that is the one to check. Never fabricate a
measurement to fill a gap. This binds every layer — the fast loop's config, the board's briefs,
the strategist's judgement, and me in any session.

**Read `LESSONS.md` before touching tooling.** It is the engineering/operations post-mortem — every
tooling, shell, and workflow mistake that cost time or money, with its fix (the 600s `claude -p`
background-task limit; `pkill -f` killing its own shell; deploying unwatched changes; runners that
clobber unhandled flags; a hung browser probe idling the farm). DOCTRINE is the game rules; LESSONS
is how not to break the machine that plays. Add a row there whenever a new mistake burns you.

## 1. Objective

Maximise company level and net worth, in that order of leverage. Level gates everything:
building slots, order length, research, executives. Cash is the means, not the goal.

Standing targets, nearest first:

| Target | Unlocks | Status |
|---|---|---|
| Lv.5 Family business | 5 buildings, order limit 5h → **24h** | next |
| Lv.10 Sole trader | 6 buildings, research, bonds | later |
| Lv.15 | 8 buildings, **executives** (CTO → patent rate) | later |

The 24h order limit at Lv.5 is the single biggest quality-of-life jump: one order covers a
whole night instead of needing a refill every five hours.

## 2. Authority — what may be done without asking

Free to act:
- Place, cancel and re-price production and retail orders.
- Buy inputs and construction materials on the exchange.
- Sell surplus on the exchange.
- Upgrade or construct buildings **within the cash guardrail** (§4).
- Change what a building produces, including switching industry.
- Talk to other players (§7).
- Read and analyse the public front-end bundle and the game's own APIs.

Must ask first:
- Scrapping, downgrading, or auctioning a building.

**Cash decisions are delegated in full — never ask about money.** Spend, upgrade and build
on judgement. The discipline that replaces approval is arithmetic, not permission:

Never, under any circumstance:
- Real money. No purchases, ever.
- Sim Boosts. The five in the account stay untouched.
- Client-side tampering to gain advantage. The patent roll, order results and prices are all
  server-side; patching bundle constants only falsifies the display. It is also cheating.
- Deceiving other players — see §6.

## 3. Decision rules

**Rule 1 — the game's own numbers beat my arithmetic.** The grocery store prints
`Profit per hour` for any quantity/price pair, net of wages and the real cost basis. Probe it
and sort. Only model something by hand when the UI will not show it.

**Rule 2 — find the bottleneck before spending.** Capacity is worthless behind a constraint.
The farm out-produces the store roughly 2.5:1, so a second farm adds almost nothing while a
store upgrade doubles throughput. Recompute after every structural change; the bottleneck moves.

**Rule 3 — margin is a risk measure, not a vanity metric.** $4,813/h at 14.5% margin dies if
inputs rise 15%. $2,929/h at 85% margin does not. Prefer the robust line unless the thin one
is several times better.

**Rule 3b — cost the working capital, not just the building.** A high-value line ties up
inputs before it earns anything: flight computers need ~$554k of materials in flight to run a
5h order against a $155k building. Rank by capital employed, not by sticker price — and note
that acceleration enlarges orders, so it inflates the float too.

**Rule 4 — headline numbers are traps until proven otherwise.** Before believing any ranking,
check `retailSeason` / `productionSeason` (off-season prices are fiction at low level),
`sincePhase` against the **realm's** phase — this realm is at 8, so nothing is phase-locked
and treating high-tier goods as unreachable is a mistake —
`productionMechanic` (accumulator resources ignore the flat rate), and whether the market can
absorb the output at all.

**Rule 4d — rank industries by REALIZABLE $/h, never paper $/h (enforced in code 2026-07-24).**
Paper "$/h = margin × rate" ranked flight computers ($2,636–3,849/bldg-hr) at the top while the
realm buys ~0.057/h — a mirage that three workflows and a near-miss build all traced to the same
error. It is now fixed in code: `realizable.js` haircuts the rate by demand you can actually claim
and emits a `verdict` per product; `industry-report.js` ranks by `realizablePerHour` and drops
`MIRAGE` goods; `board/.realizable.json` exposes `byKind[k].{verdict, realizableRate,
realizablePerHour, realizableFraction, bookStale}` to the strategist and board. RULES:
(1) any spend/build/pivot ranks on `realizablePerHour`, never the sticker $/h;
(2) NEVER scale a `MIRAGE` or `OVERSUPPLIED` product; `B2B-THIN` is fill-in only; only `B2B-DEEP`
and `RETAIL-OK` are scale targets;
(3) do NOT judge demand by `resources[k].consumption` — PROVEN unreliable (crude oil and dough read
0 like dead aerospace parts yet sell deeply); the recipe-graph derived demand in `realizable.js` is
the signal that separates a deep-B2B good from a dead lake;
(4) a `bookStale:true` B2B number is ±2× (no live sell-book) — re-probe the sell-book depth before
any large B2B capex;
(5) `realizableFraction < 0.05` = a lake you cannot drain regardless of $/unit.
Re-run `node realizable.js` after every `board-data.json` refresh so saturation/price moves apply.

**Rule 4b — verify game rules by TESTING, never by reading the UI wording.** On 2026-07-22
the phrase "You can scrap buildings from level 5" was read as *building* level 5; it means
*company* level 5 (we qualified at Lv.7). "Scrap recovers 73%" was wrong too — scrap returns
100% of a building's cumulative materials, verified by matching the L2 store's scrap dialog
(24/330/96/6) to its cumulative build cost to the unit. UI text is ambiguous; the bundle
constants and the live dialog are ground truth. Before asserting any mechanic, open the
dialog or read the code — do not infer from a sentence.

**Rule 4c — running often is not the same as learning the truth.** learn.js ran 763 times in
a day and still could not resolve the XP formula; the board unanimously REJECTED a sound plan
because all three executives were fed the same wrong numbers. Frequency compounds a wrong
model, it does not correct it. Truth comes from measurement and from being challenged, not
from repetition. When every source agrees, ask whether they share one bad input. Treat a
"reasonable assumption" as unverified until a number proves it — especially before killing a
proposal on it.

**Rule 5 — small test, then scale.** New product or new market: one modest order, read the
realised rate and price, then commit.

**Rule 5b — the sweet spot: no shortage, no overflow** (owner directive 2026-07-21). Time
and money must both sit at the working point, never idle and never over-committed:
- *Orders* run exactly to the next decision horizon — min(acceleration expiry, next build
  gate at the current earn rate), clamped [2h, 24h]. Cancelling forfeits prepaid wages, so
  never commit past a moment the plan is known to change; churning shorter than the horizon
  wastes switchover gaps.
- *Cash* above the $500 reserve exists to be converted — into inputs the queue will consume
  or the next building. Cash idling above the active gate is overflow.
- *Inventory* is frozen cash: inputs stocked to the consumption horizon (roughly 2×), not
  beyond; outputs sold, not piled.

**Rule 6 — never leave the bottleneck idle.** An idle store is the most expensive thing in
the game. Collect early (orders release output continuously), keep the queue fed.

**Rule 7 — report honestly.** State what was verified and what was assumed. If an action
failed, say so with the evidence. No claiming success from an unread response.

## 4. Cash policy — self-governed

No approval gates. The rules below are self-imposed because they are correct, not because
anyone has to be asked:

- **Operating reserve $500.** Enough to restart a production run. Below it the bot stops
  discretionary spending; it does not stop working.
- **Upgrades are priced, not switched.** An upgrade doubling a building's output earns back
  its cost at that building's *actual* observed rate. Build it only if payback ≤ 48h. This is
  why the farm keeps failing its own test: it already out-produces the store, so doubling it
  gains nothing — the arithmetic rejects it without anyone having to intervene.
- **Inputs are bought, never waited for.** An idle building costs more than the market spread.
  Ceiling $8,000 per purchase, guarded by the reserve.
- Wages for a production order are charged up front — count them as spent when queueing.
- Prefer spending that shortens the path to the next level over spending that only adds cash.

## 5. Cadence — 24/7, zero idle

**No building is ever idle.** Every tick, each free building is walked down a fallback chain:

`run-tick.sh` fires from cron every 2 minutes but exits in milliseconds unless
`next-due.txt` says a building is about to free up, so the real cadence is event-driven:
act within ~2 minutes of any completion. A 20-minute heartbeat overrides that gate — retail
revenue accumulates as an uncollected bubble on the store, and cash that has not been
collected cannot fund the next building, so waiting out an 80-minute sales order would strand
it for the whole order.

Every tick: collect → read state → for each free building —

1. place the best-scoring production or sales order;
2. if inputs are short, buy them (`BUY MISSING`, capped by `maxInputBuy` and the cash floor);
3. if it still cannot work, **upgrade it** — idle time converted into permanent capacity
   beats idle time converted into nothing;
4. only if all three fail, log it as a genuine stall.

Unattended-operation requirements, all in place:
- cron entry survives sessions and reboots (system crontab, not session-scoped);
- session expiry is detected each tick and re-authenticated from the 600-mode `.creds`;
- `bot.log` and `observations.jsonl` rotate at 5 MB;
- one `flock` serialises everything against the single shared browser tab.

## 6. Learning while playing

Every number in `config.json` is a snapshot and will rot. The bot therefore re-derives its
own parameters from play:

- **Live retail averages** — read from the game's `/resources-retail-info/` feed each tick,
  so the price sweep stays centred on the real market rather than last night's figures.
- **Observed sell rates** — every placed order yields quantity ÷ projected hours, which
  already bakes in store level, weather and any modifier not modelled by hand.
- **XP model** — `learn.js` scores "XP per unit shipped" against "XP per dollar booked" over
  every observed interval and reports which fits. Until one wins clearly it stays `unclear`;
  a guess is not an answer.

`observations.jsonl` is the append-only record; `knowledge.json` is the derived view, and
learned values take precedence over config defaults. `learn.js` runs at the end of each tick.

## 7. Talking to other players

Chat is now permitted. It is a real channel to real people, so:

- **Be honest about what I am.** If asked whether this is automated, say yes. Never claim to
  be Jimmy typing in real time.
- **Trade in good faith.** Quote prices honestly, honour what is agreed, do not renege.
- **No manipulation.** No pump-and-dump talk, no fake scarcity, no coordinated price rigging,
  no pressure tactics, no exploiting newer players' inexperience.
- **No spam.** Reply when spoken to, open a conversation only when there is a concrete reason
  (a trade, a question, an answer someone asked for).
- **Useful over clever.** The community knows this game far better than a two-hour analysis
  does. Ask questions; treat what is learned as a hypothesis to verify, not gospel.
- **Never share** credentials, cookies, session details, or anything about the automation
  setup beyond "it is scripted".
- Keep it in English unless the other player writes in Chinese.

## 8. Verified mechanics (measured, not assumed)

**Production rate — READ IT, DO NOT MODEL IT (corrected 2026-07-23 20:10 CDT).**
Every building page prints `Production: X/h` under each product it can make. That number is
ground truth and it is free; use it (Rule 1). The old rule in this section —
`producedPerHourRaw × 0.8087` — is a **Farm** constant that was wrongly generalised:

| building | measured constant | held across |
|---|---|---|
| Farm (L3) | **0.8169** | all 12 products (seeds 2,695.85/h = 1100 × 3 × 0.8169) |
| Mill (L1) | **0.4639** | powder 17.86/h, flour 88.13/h, fodder 287.57/h |
| Slaughterhouse (L1) | **0.4322** | steak 25.93/h, sausages 77.79/h |

Four significant figures, every product of a building agreeing — so `C` is a real per-building
constant, not noise. The formula is `raw × level × C_building × (1 + productionModifier/100)`,
and wages are `base × level × administrationOverhead` (1.0294 live: Mill $380→$391, Farm L3
$104×3→$321, Slaughterhouse $414→$429).

**What the error cost.** tick.js hardcoded `50 × 0.8087 = 31.1/h` for coffee powder. On
2026-07-23 08:20 it sized a grind it believed was ~12h; the game quoted **20h57m and charged
$8,136 of wages up front**, and wages are forfeited on cancel — an unrecoverable
over-commitment of the kind Rule 5b exists to prevent. The Slaughterhouse was armed at
$995/h / 23h payback on a modelled 48.5 steak/h; the real figure is 25.93/h, so it earns
**$324/h and pays back in ~72h**. Every modelled `$/h` in `industry-report.js` for a
*processor* therefore carries roughly **2× optimism — halve it before believing it.**

**The fix, and the free lunch inside it.** `printed-rates.js` walks every owned building and
merges the printed rates into `config.printedRates`, which `tick.js` prefers over the model.
Run it every strategist run. And the product cards **render before the building finishes** —
the Slaughterhouse's steak and sausage rates were read while it was still under construction,
so a new line can be priced from the game's own numbers hours before it produces anything.

Actual output is the printed rate × the acceleration factor while acceleration lasts.
**Measured 2026-07-22 16:30 CDT:
the acceleration ended at 15:42 CDT as a cliff straight to ×1.** The owner-expected ×2 tier
never appeared — auth-data still carries the expired ×3 entry, and new orders price at ×1
(orange retail order placed 15:44 CDT projected 147.8/h = store L2 base × weather, no accel).
Companion mechanic, also measured: **in-flight orders keep the multiplier they were quoted
at placement** — the grape order placed 15:13 CDT ran at ×3 (~980/h observed via warehouse
accrual) until its 19:54 CDT completion, 4.2h past the expiry. Lesson for any future
accelerated account: just before a known step-down, place the longest allowed order — it
carries the old rate past the cliff. tick.js reads the live multiplier each run and flags
regime changes in the log.

**Retail.** The store's `Profit per unit` with zero stock equals *net revenue* per unit (cost
basis is zero), so real profit = that minus my unit cost. Measured net-revenue ratios and
sell rates at store Lv.1: apples $3.63 @ 239.5/h, oranges $4.10 @ 199/h, grapes $4.80 @ 169/h,
coffee powder $41.41 @ 112/h. Sell rate is per product and varies wildly — apple pie manages
only ~10/h. Weather applies a `sellingSpeedMultiplier` (0.80 when measured).

**The store was the bottleneck.** Farm 606 apples/h vs store 239.5/h. Upgraded to Lv.2 on
2026-07-21 for $3,323 (materials in the warehouse offset $8,030 of an $11,373 sticker).

**Collecting.** The header "Collect ready resources" is a *hint banner*, not a control.
The real one is the resource bubble over each building on `/landscape/`:
`div.js-landscape-busy-info`. Orders expose `amountAvailableNow` and release output
continuously, so collecting early is free money.

**Levels.** Thresholds every 5 levels. XP comes from production *and* retail, not retail
alone — collecting 5,330 seeds and starting an order moved XP +10. The exact formula is still
unresolved; `xp-ledger.jsonl` accumulates observations and `calibrate.js` tests the two
candidate models (per unit vs per revenue).

**Research / patents.** `n5 = 0.0625` — each research point yields a patent with 6.25%
probability, rolled server-side. Quality thresholds `SBr = [12, 50, 500, 2000, 5000, 10000…]`.
The only lever is executive `cto` skill, summed as chief 100% / matching apprentice 50% /
other chiefs 25%, then damped (halved above 80, halved again above 60). A full team of
100-skill executives reaches ~13%; 100% is unreachable by construction. Patents accumulate,
so splitting a commit wastes nothing. Not worth touching before Lv.15 — Quality 1 alone costs
~192 research points (~$22k). Constants archived in `research.json`.

**Building economics.** Wages differ enormously and must be charged against output: Farm $104/h,
Grocery $139/h, Mill $380/h, Catering $656/h, Hangar $759/h. Scraped pages live in
`encyclopedia/`; `industry-report.js` joins them with live prices and ranks by net $/h and payback.

## 9. Current standing plan

1. Keep the store fed. It is the throughput constraint even at Lv.2.
2. Water is the binding input — 4 per grape / 3 per apple; the farm block pre-buys it and
   sizes orders to on-hand stock (rewritten 2026-07-22 after the overnight deadlock).
3. Push levels for slots and the order-limit jumps.
4. The economy is at ×1 steady state since 2026-07-22 15:42 CDT (acceleration over, no ×2
   tier ever appeared). All $/h figures measured under ×3 are historical; trust only rates
   measured after that timestamp.
5. Expansion after the Mill, by owner decision (no Catering): Bakery (dough, best payback in
   the game at ~32h), then Oil rig (crude/methane, 69–73% margin, fuel demand never dies),
   then level upgrades over new slots, then a Construction factory at Lv.10.
