# Personal Assistant quests — measured outcomes

The PA fires an offer every hour or two, each one a multiple-choice with real cash or
inventory consequences. Every strategist run so far has decided them cold and then forgotten
the result. This file is the memory. **Only write a row here after seeing the outcome** — a
predicted payout is not an outcome (DOCTRINE §0).

Mechanism, selectors and badge-clearing are in STRATEGIST.md step 5; this file is only about
*what to answer*.

## Measured outcomes

| Offer | Chosen | Outcome | Verdict |
|---|---|---|---|
| Mafia boss wants 2,000 transport units to move "stuff", "promised to pay $4,500" | *"For that kind of money, I will drive the truck myself"* (accept) | **"Your truck did not get caught but mafia paid you just $1,700."** Cash $24,401 → $26,101 (**+$1,700 exactly**), transport 2,108 → 108. Net worth **+$934** after the $766 of transport given up. | ACCEPT — but price it at $1,700, not $4,500 |
| Immigrant construction workers: 200 sausages → +1 building level | *"When can they start?"* (accept) | Farm L2 → L3 for ~$2,525 of sausages. Answering without the goods returns *"You do not have 200 sausages"* and **leaves the offer open** — buy, then answer again. Game picks the building (it chose the Farm, our least-useful target). | ACCEPT — a building level is worth far more than the food. **From 2026-07-24 make them, don't buy them:** the Slaughterhouse produces sausages at a measured 77.79/h from 0.0625 pig each, so 200 units is ~2.6h and ~$560 of pigs against the $2,525 we paid the market. |
| Man wants advice, mentions smoking | advise him to quit | Gave us a quadcopter | ACCEPT/advise well |
| Unfair coin gamble | decline | Rewarded with a luxury watch | DECLINE |
| Charity: $1,000 hurricane relief | decline | No reward, no penalty | DECLINE |
| Employees want a Christmas party, $500–1,500 | *"Tell them to get back to work!"* | No reward, no penalty, $0 spent | DECLINE |
| Buy our seeds at $0.40 | decline | — | DECLINE — $0.40 beats the $0.30 exchange but seeds are Mill feedstock at ~$2.51 chain value |
| School needs eggs for Easter | *"I could not care less"* — resolved without a strategist | No cash or inventory moved | unknown; we hold no eggs |
| **Yearly fair wants fruit/sausages**: 2,500 apples @ $4.50/u, or 1,200 sausages @ $14.30/u | *"Yes, send 2,500 apples @$4.50 a unit"* while holding **0 apples** | **"We do not have enough apples, let's source it first."** Cash unchanged $26,330. **All three options still present** — the offer stayed OPEN. | ACCEPT the apples branch **only after sourcing**; see below |
| **Friend's cinema pricing**, 1,000 seats, we keep 50% of profits: (a) $1/seat full, (b) $4/seat 60% sold, (c) **$2 over-60s + $4 others**, (d) decline | *(c) "$2 for over 60s year-old and $4 for everyone else."* (2026-07-24 09:45 CDT) | **"A local newspaper noticed the discount and made a free advertisement. The cinema was full. 50% of people paid $4, everyone else was over 60 and paid $2. Your total earnings are: $3,000, you get $1,500."** No inventory cost, pure cash. | **PICK (c) — price discrimination.** It fills the elastic senior seats at $2 that $4 leaves empty AND keeps $4 from the rest → $3,000 vs $2,400 (b) vs $1,000 (a). The "wise" branch paid the most and cost nothing. |
| **Politician wants a donation**: *"I just need your money to make billions and billions of dollars for this country"* — (1) write a $1,000 cheque, (2) "Are you for real? (Hang up)" | *(2) "Are you for real? (Hang up)"* (2026-07-24 12:03 CDT) | Offer resolved, **$0 spent** (cash $24,741 unchanged), **no reward text, no penalty**. | **DECLINE** — a transparent cash-sink con; the "promise" returns $0 to us (pattern #2 ceiling / #3 decline cash-sinks). Not every decline is rewarded — this one simply cost nothing. |
| **Wall-street "derivative" con**: a visitor pitches *"a new equity derivative instrument… similar to a call option on a basket of ETFs, but has fluctuating strike price dependent on settlement price of unrelated commodity futures"* — (1) "I am in! Here's $2,000", (2) "Wait, what? I am not interested" | *(2) "Wait, what? I am not interested"* (2026-07-24 13:32 CDT) | Offer resolved (`after:[]`), **$0 spent** (cash $24,179 unchanged before→after), **no reward text, no penalty**. Badge cleared to paUnread 0 on reload. | **DECLINE** — same shape as the politician scam: opaque, deliberately-nonsensical instrument, **no stated return** at all → the pessimistic (and here only) payout is $0 (pattern #2 ceiling / #3 decline cash-sinks). |
| **Sales dept wants a party**: *"business is going well. The sales department wants to celebrate. Maybe we could organize something for them?"* — (1) "Yes, budget $3,000 for a party.", (2) "No time for parties at this moment, we should all focus on the business." | *(2) "No time for parties…"* (2026-07-24 15:33 CDT) | Offer resolved (`after:[]`), **$0 spent** (cash $26,537 before → $27,315 after — rose on store banking, no $3k drop), **no reward text, no penalty**. Badge cleared to paUnread 0; fast loop logged "CHAT assistant clear". | **DECLINE** — pure cash-sink party vignette, bigger sibling of the earlier $500–1,500 party (also declined, $0). No stated return; $3k = 11% of cash and would delay the 2nd-Mill gate (pattern #3 decline cash-sinks). |
| **Enable email notifications?** (settings vignette, no cash/inventory): *"we might miss important updates… I noticed your email notifications are switched off."* — (1) "Good catch! Switch it on!", (2) "No, I rather be surprised by changes coming out of nowhere" | *(2) decline* (2026-07-24 15:56 CDT) | Offer resolved (`after:[]`), **$0 cost** (cash $28,598, climbing), **no reward text, no penalty**. Badge cleared to paUnread 0. | **DECLINE (2)** — judgment call: this is an AUTONOMOUS operation, so a bot gains nothing from game notification emails, and (1) is an **outward-facing** change (sends real Sim Companies emails to the owner's inbox y326433462@gmail.com) I'm not durably authorized to make unattended. Kept the status quo (off) — reversible, so a future run may revisit if an in-game reward for the "wise" branch is ever observed. No penalty for declining. |
| **SimConstruction favor / bricks**: *"SimConstruction called to ask for a favor. They urgently need 2,000 [bricks] to avoid breaking a contract and paying a penalty. They offered a free service in exchange."* — (1) "Sure, I can help out, send the bricks.", (2) "Sorry, I am too busy and we do not have the bricks." | *(2) decline* (2026-07-24 17:54 CDT) | Offer resolved (`after:[]`), **$0 cost** (cash $28,591 unchanged before→after; we held **0 bricks**). No reward/penalty text (a decline). Badge cleared to paUnread 0. | **DECLINE unless bricks are already cheap-to-hold AND a long time-gated upgrade is queued.** Community (proboards/subreddit, **UNVERIFIED**): the "free service" = your **next upgrade completes in half the time**. But we hold 0 bricks, so accepting means BUYING 2,000 — MEASURED live book **$2.85/u = $5,700** (+~4% fee/transport ≈ $5,900), which is ≈ the entire remaining gap to the 2nd-Mill gate ($34,560 − $28,591 = $5,969); STRATEGIST §4 forbids starving the active build. The time-perk is worth ≤~$864 even generously (halving a few build-hours of a $216/h asset) and **may not even apply to a NEW building** (2nd Mill is construction, not a "renovation"), and our next build is CASH-gated not time-gated. Net clearly negative → decline, and declining is honest (we truly have 0 bricks). Re-evaluate ONLY if we ever produce bricks cheaply (a Construction factory) with a genuinely long, time-gated upgrade in queue. |

### The open "yearly fair" offer (parked 2026-07-23 18:40 CDT — read this before touching it)

**Status: deliberately left OPEN.** It is the reason `Your Personal Assistant 1` still shows unread
and `chat-pending.flag` keeps reappearing. That is a known, accepted cost — not a bug to chase.
**2026-07-23 20:25: the cost is now capped.** `chat-ack.json` (`paUnread:1, needMoney:8000,
expiresAt 07-24 08:00 CDT`) tells tick.js to suppress the strategist wake while cash is under
$8,000 — the level at which the apple plan becomes executable ($2,850 of water above the $5,000
floor). Verified live: `WAKE chat — ack holds, blocked on cash ($4680 < $8000), suppressed`. The
ack self-deletes the moment cash clears $8,000, so the next heartbeat wakes a strategist to
execute. `capturePaOffer()` keeps recording every offer meanwhile, so nothing goes invisible.

**Re-checked against the Slaughterhouse (2026-07-23 20:20): apples still wins, and by more than
it looked.** With measured rates the sausage branch is 1,200 ÷ 77.79/h = **15.4h** of the brand-new
Slaughterhouse for a premium of only $2,580 over selling the same sausages on the exchange
($14.30 promised vs $12.15 net). Apples is 2,500 ÷ 612.69/h = **4.1h** of a farm whose beans are
already ~42h over-stocked, for ~$4,160 all-in against $11,250 promised. Take the apples.

**Take the apples branch, not the sausages branch.** Measured at 18:11: apples $2.50 ask, sausages
$12.70 ask.
- Apples: 2,500 × $4.50 = **$11,250** revenue against $2.50 + $0.388 transport = **~$7,220** to buy
  ⇒ +$4,030 (56% on capital).
- Sausages: 1,200 × $14.30 = $17,160 against ~$15,287 ⇒ +$1,873 (12% on capital) and a far bigger
  cash hit. Strictly worse on both counts.

**Source by PRODUCING, not buying.** The farm (L3) makes apples at ~606/h from 3 water + 1 seed each.
2,500 apples ≈ 4.1h of farm time + 7,500 water (~$2,820 at $0.376) + ~$530 wages ≈ **$3,270**, i.e.
~$1.31/unit against $2.89 landed on the exchange. That more than doubles the profit to ~$7,980 **and**
cuts the cash outlay to under half. The farm's opportunity cost is genuinely low right now: grapes are
shelf-capped by the single retail queue and beans already have a ~47h Mill buffer.

**Why it was NOT executed on 2026-07-23:** the Slaughterhouse gate ($28,500 for a permanent $1,013/h
asset at 22h payback) was ~1.5h from firing, and STRATEGIST §4 forbids starving the active build gate.
Even the cheap production route needs ~$2,820 of water up front, which pushes the gate out ~4h ≈ $4,255
of forgone Slaughterhouse profit. Permanent capacity beats a one-shot, and DOCTRINE §4 prefers spend
that shortens the path to the next level.

**Execute when:** the Slaughterhouse has fired AND cash − $5,000 floor ≥ ~$3,000 of water money AND the
farm is free. Then: farm → APPLES x2500, wait, then re-answer *"Yes, send 2,500 apples"*.
**Downside is bounded and positive even if the fair welches** (pa-quests rule 2 — a promised payout is
a ceiling): 2,500 self-grown apples cost ~$1.31/unit and clear at ~$2.02 net on the exchange or ~$3.63
net in the store, so the apples are a profitable asset on their own. That is what makes this close to
a free option — but it is still an *unverified* payout, so do not let it outrank a build gate.

## The pattern these rows support

1. **Transactional offers with a stated cost and a stated payout have always delivered
   something.** Both accepted trades paid (sausages → a building level; mafia → $1,700).
2. **A "promised" number is a ceiling, not a price.** The mafia promised $4,500 and paid
   $1,700 — 38%. Evaluate accept/decline against the *pessimistic* payout: here even $1,700
   against $766 of transport was clearly worth it, so the decision survived the haircut.
   If an offer only clears at the promised number, decline it.
2b. **Answering short is free, and it keeps the offer open — use it as a parking brake.**
   Confirmed twice now, and on a 3-choice offer (2026-07-23 "yearly fair"): picking a branch
   whose goods we do not hold returns a "we do not have enough X, let's source it first"
   message, moves no cash, and leaves every option clickable. So when an offer is attractive
   but the cash is spoken for, answer short rather than declining — it costs nothing and
   preserves the option. The price of parking is that `paUnread` stays 1 and the fast loop
   keeps re-raising `chat-pending.flag`; that is expected, not a fault.
3. **Pure cash-sink vignettes with no stated return (charity, parties) are declines**, and
   declining has never been penalised. Some are rewarded.
4. **Value goods we hand over at their chain value, not spot** — seeds and coffee beans feed
   the Mill at ~$2.51/unit, so an "above market" offer for them can still be a bad trade.
   Transport was the opposite case: pure market goods, re-buyable at $0.383 with a 385k-unit
   book behind it, so giving 2,000 away cost exactly what it says.
5. **Not every event is a trade.** Some are flavour with three dialogue choices and no
   cash effect — pick the good-faith answer (the wise one is often rewarded) and move on.

## Before answering an unknown offer

- Read it with `autopilot/actions/pa-read.js`, price both branches from the **live ticker**, and check the
  warehouse (`probe-inventory.js`) for whatever it asks for.
- If it wants goods we do not hold, buy them first — answering short is safe (the sausage
  case proves the offer stays open) but buying first avoids relying on that.
- Community reference, if an offer is unfamiliar: a mod pointed at the **PA Quest Guide on the
  official subreddit** (linked from the in-game *Guide for beginners*), and there is a
  long-running forum thread at `simcompanies.proboards.com/thread/35/personal-assistant-quests`
  (WebFetch gets a 400 from proboards; search-result snippets do surface the outcomes —
  that is how the $1,700 mafia figure was known before committing, and it proved exact).
  Treat community text as a hypothesis (DOCTRINE §7); the measured column above is fact.
