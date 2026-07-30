# Sim Companies autopilot — detailed handoff

This is the operational reference for the autonomous Sim Companies company on `jimmynas`.

To resume safely:

1. Read this file.
2. Read `autopilot/CURRENT.json`; use `MASTER.md` only as append-only audit history.
3. Inspect `autopilot/next-wake.json` and the tail of `autopilot/brain.log`.
4. Check both locks before any browser work.

Reply to Jimmy in Simplified Chinese. Keep code and documentation in English. Never print secret
values. Verify live evidence before asserting or changing state.

## 1. Runtime ownership

Since 2026-07-29, the sole company operator is the provider-routed LLM autopilot in `autopilot/`.
The production trial uses DeepSeek V4 Pro at Max reasoning for the main brain and CFO/COO/CMO.
The prior OpenAI Terra/Luna path remains intact as a one-command rollback and is activated
automatically after two consecutive failed DeepSeek wakes. The former fast-loop, strategist, and
board layers are preserved under `legacy/` as history only. They are inactive and their old data is
not current business evidence.

- Sim root: `/srv/appdata/chrome-automation/sim/`
- Company ID: `5714348`
- Persistent Chrome: `127.0.0.1:9222`
- Server time zone: `America/Chicago`
- Browser mutex: `.tick.lock`
- Full-wake mutex: `autopilot/.brain.lock`

Never run an ad-hoc CDP probe while `.tick.lock` is held.

## 2. Canonical layout

```text
sim/
├── autopilot/                 active LLM brain, state, actions, memory, alarms, tests
│   ├── actions/               browser/UI primitives
│   ├── chat/                  chat policy, persistence, UI plans, leads, negotiation, safety gates
│   ├── reference/             PA material loaded only when needed
│   └── tests/                 deterministic unit tests
├── shared/                    CDP, config, market tracker, measured facts
│   ├── facts/
│   └── price-tracker/
└── legacy/                    historical pre-LLM system
    ├── fast-loop/
    ├── strategist/
    └── board/
```

Compatibility symlinks remain at the root (`brain`, `pages`, `price-tracker`, `cdp.js`,
`config.json`, facts files, PA references, and `JOURNAL.md`). They protect older utilities and the
existing price-tracker systemd unit. New runtime code, cron entries, and documentation must use the
canonical directories.

The remaining root-level probe, report, capture, and extraction scripts are unscheduled development
artifacts. They are not part of either the active autopilot or the archived three-layer runtime.

## 3. Active autopilot

| Path | Purpose |
|---|---|
| `autopilot/BRAIN.md` | Goal-driven CEO mandate: sustainable-profit objective, current Coffee baseline, opportunity discovery, alternative comparison, bounded experiments, evidence/safety boundaries, capital protocol, and alarm discipline. Read every wake. |
| `autopilot/CURRENT.json` | Authoritative structured current checkpoint: state-tied cash/debt, verified work, blockers, plan, and next decision time. Replaced atomically each wake. |
| `autopilot/MASTER.md` | Append-only terse audit history. It is not injected as current truth and cannot override CURRENT or fresh state. |
| `autopilot/brain.js` | Provider-aware Chat Completions engine and active DeepSeek V4 Pro Max production path. It rejects an entire multi-tool response before executing any call. |
| `autopilot/brain56.js` | Retained OpenAI Responses API rollback engine (`gpt-5.6-terra`, High). |
| `autopilot/brain-provider.js` | Owner-only runtime provider selector, credential preflight, health counter, and automatic DeepSeek-to-OpenAI fallback after two consecutive failed wakes. |
| `autopilot/deepseek-execution-prompt.js` | Small DeepSeek-specific protocol adapter. It adds no business authority and makes one-tool, refresh, evidence, retry, and close sequencing explicit. |
| `autopilot/action-contracts.js` | Strict per-action schemas plus matching runtime validation. Do not rely on a hard-coded schema count; chat and other guarded capabilities evolve independently. |
| `autopilot/failure-budget.js` | Per-target two-failure circuit breaker for one wake. |
| `autopilot/runtime-guard.js` | Enforces refresh between mutations and blocks finish until refresh, journal, CURRENT checkpoint, and alarm requirements pass. If the model reaches its configured round boundary after every enforced close gate has already passed, the engines record a deterministic successful finish instead of overwriting the valid alarm with a five-minute failure retry; an incomplete close still fails safely. |
| `autopilot/building-utilization-policy.js` | Journal hard gate: fresh state may not contain an idle standard production/sales building, an unresolved standard sales building, or a completed-but-uncollected job; seasonal/free-and-locked buildings are excluded. Waiting for an upgrade, financing, or evidence is not an idle exception. |
| `autopilot/building-page-activity.js` | Shared exact-page classifier for construction, active retail sale, enabled production/retail idle forms, and UNKNOWN generic busy text. Evidence is bound to the exact building ID, level, route, and freshness window. |
| `autopilot/production-policy.js` | Duration limits, Mill micro-batch protection, deadline-bound `finishBefore` sizing, and a pre-browser guard that prevents non-Coffee bridges from consuming verified Power/Water Coffee reserves. |
| `autopilot/production-card-binding.js` | Browser-safe exact production-card binder using the resolved resource kind plus unique image slug; supports hashed assets and abundance layouts while rejecting parent/multi-card ambiguity. |
| `autopilot/journal-entry.js` | Validates the concise CEO decision brief, including the best opportunity/risk, 2–4 material alternatives, and an operating role for every positive warehouse item; deterministically includes exact cash/debt/slots and every captured product in NAS/Windows diaries. |
| `autopilot/act.js` | Guarded dispatcher. Grocery sales optimize the live UI curve; confirmed exchange sales must match a fresh reserve-safe inspection exactly. |
| `autopilot/chat/` | Chat trust boundary, NAS-local persistence, identity-neutral output policy, public/private UI plans, contact/subscription/message helpers, lead extraction, negotiation, and contract gating. |
| `autopilot/chat/llm-decision-provider.js` | Optional bounded Responses API planner for chat. It has no browser/tools/action dispatcher, returns drafts or a non-mutating contract candidate only, and fail-closes on missing evidence. |
| `autopilot/chat-shadow.js` | Unscheduled read-only/shadow observer entry point. It has completed bounded live reads, acquires `.brain.lock` before `.tick.lock`, stays away from an imminent brain wake, and exposes no send or contract action. |
| `autopilot/chat-active.js` | Unscheduled production-capable chat launcher. It defaults to shadow, uses the same lock/wake boundary and a 90-second deadline, and requires explicit mode/LLM/real-send switches before an exact source-bound reply can be confirmed. |
| `autopilot/chat/active-store.js` | Owner-only durable active-attempt state machine. It binds the exact action, issues a one-use execution claim, and requires `ARMED → CONFIRMING → VERIFIED`; ambiguous or partially armed attempts are not replayable. |
| `autopilot/inspect-building.js` | P1 read-only building-page inspector for live level, printed rates, wages, and optional quantity quotes. Successful rate reads update the short-lived rate cache and deterministic surplus plan without changing the game. |
| `autopilot/coffee-reserve-policy.js` | Pure 24-hour Coffee-chain reserve calculation from every current Mill's fresh per-building rate and temporary-modifier expiry, with a 10% buffer and fail-closed sellable quantities. |
| `autopilot/inspection-rate-cache.js` | Atomically stores level-tied, per-building printed rates plus modifier evidence; stale, level-mismatched, or modifier-unknown evidence cannot authorize a reserve. |
| `autopilot/inspect-exchange-sale.js` | Read-only exchange preflight: reserve, live book/depth, 4% fee, Transport, quality lot, exact UI form economics, and no submission. |
| `autopilot/exchange-sale-helpers.js` | Pure order-book, transport, UI-economics, and exchange-inspection helpers. |
| `autopilot/exchange-sale-safety.js` | Final execution-layer guard for fresh state/plan, available stock, Transport, exact five-minute inspection match, and positive game-form profit. |
| `autopilot/mill-upgrade-policy.js` | Pure deterministic Pareto comparison of evidence-backed Mill upgrade candidates; ranks merit without using current cash. |
| `autopilot/council-evidence.js` | Shared read-only collector that gives CFO/COO/CMO separate live finance, operations/P1, and retail/order-book evidence packs before deliberation. |
| `autopilot/council.js` | Runs the three council roles independently against automatic evidence. It follows the active main-brain provider: DeepSeek V4 Pro Max during the trial and OpenAI Luna High after rollback. Each role has bounded timeout/retry, API/JSON failures remain `UNKNOWN`, one invalid vote may receive one validation-feedback repair and must pass the same strict validator, and a non-sensitive per-role audit is written to `council-audit.jsonl`. |
| `autopilot/council-verdict.js` | Validates structured council citations against exact evidence values and rejects unsupported claims. |
| `autopilot/api-result.js` | Adds source/status/time plus explicit pagination and truncation metadata to generic API reads. |
| `autopilot/tool-output.js` | Bounds large tool results by whole fields and marks every omission explicitly; no raw JSON clipping. |
| `autopilot/retail-optimizer.js` | Generates the retail price grid, parses printed UI economics, and selects maximum positive profit/hour. |
| `autopilot/actions/*.js` | UI primitives for collect, produce, buy, retail/exchange sell, build, upgrade, scrap, bonds, PA, chat, contracts, robots, and read-only auctions. |
| `autopilot/state.js` | Captures and normalizes fresh live state into `autopilot/.state.json`. |
| `autopilot/state-helpers.js` | Deterministic parsing for busy jobs, slots, inventory lots, rolling volume, and bonds. |
| `autopilot/gate.js` | Zero-LLM alarm gate, run every minute. |
| `autopilot/run-brain.sh` | Preflights the selected provider before browser access, consumes the alarm, captures state, runs the matching main/council engines, records provider health, guarantees a future alarm, checks it, and writes/pushes logs. |
| `autopilot/check-alarm.js` | Prevents sleeping more than three minutes past the earliest known completion. |
| `autopilot/usage-summary.js` | Aggregates all main-brain and council calls for one wake, appends token/cost ranges to its diary, and writes `wake-usage.jsonl`. |
| `autopilot/tests/` | Unit coverage for state semantics, schemas, validation, and the failure breaker. |

Runtime files:

- `autopilot/.active-brain-provider` — owner-only `deepseek` or `openai` selector. It is intentionally
  ignored by Git; a missing file safely defaults to retained OpenAI.
- `autopilot/.brain-provider-health.json` — owner-only consecutive-failure state and fallback audit.
- `autopilot/next-wake.json` — pending future alarm.
- `autopilot/.last-wake.json` — consumed alarm and wake reason.
- `autopilot/.state.json` — last normalized state.
- `autopilot/.inspection-rates.json` — short-lived level-tied building-rate evidence.
- `autopilot/.exchange-sale-inspections.json` — per-resource latest read-only exchange preflights.
  A failure invalidates only the same resource kind; confirming a sale consumes only that kind's
  exact `inspectionId`, so one product cannot erase or replay another product's approval.
- `autopilot/JOURNAL.md` — detailed long-form history.
- `autopilot/diaries/diary-*.md` — one tool/reasoning transcript per wake; the `autopilot/` root
  intentionally contains no per-wake diary files.
- `autopilot/brain.log`, `gate.log`, per-call `usage.jsonl`, and per-wake `wake-usage.jsonl` — operational logs and usage. Every file under `autopilot/diaries/` receives its usage/cost summary before Windows synchronization.

Changing `autopilot/BRAIN.md` takes effect on the next wake; no service restart is required.

### Chat architecture and current rollout status

The chat implementation has completed bounded live shadow reads, but it is **not an active
service**. There is no chat cron entry, systemd unit, timer, or continuously running worker.
`safe-reply`/`full` are not deployed or scheduled, and the new runtime has sent no message.
Incoming-contract acceptance remains disabled independently.

There are two launchers:

- `autopilot/chat-shadow.js` is the read/observe/draft launcher and has no send action.
- `autopilot/chat-active.js` is the production-capable read/reply state machine. It defaults to
  `shadow`, so its existence does not enable sends.

The first 2026-07-27 live canary with strict rendered-component provenance observed 159 messages
across four public rooms and one private thread. It admitted 139 messages to the strict ledger,
excluded 20 as observation-only, extracted 97 strict-ledger offers, and recorded zero errors,
`confirm:true` calls, sends, or contract actions. Its NAS-local records are under
`autopilot/.chat-shadow/`. This validates live reading/ingestion only, not a real send postcondition.

Two production-shaped `autopilot/chat-active.js` shadow canaries also completed successfully at
04:51 and 04:52 CDT on 2026-07-27. Each read one private contact plus the `Sales` and
`Aerospace sales` rooms, admitted 63 strict inbound messages, made four LLM decisions, and produced
four proposals with zero errors, previews, confirmations, outcomes, or sends. The durable active
attempt registry remained empty. This validates the active read-and-decision path only; real
sending remains disabled and unscheduled.

The public-plan rollout received two later strict-shadow canaries. At 06:38 CDT, a cycle admitted
40 strict inbound messages and failed closed before preview because an inbound offer was incorrectly
treated as an outbound economic commitment; there were zero claims, confirmations, or sends. The
classifier now evaluates only the outbound allowlisted template and records plan failures with a
fixed privacy-safe code. At 06:50 CDT, the follow-up admitted 40 strict inbound messages, made four
LLM decisions, produced three proposals, and completed one exact public-reply `confirm:false` UI
preview with zero claims, confirmations, outcomes, or sends. One separate provider refusal was
rendered as `UNKNOWN` because two fixed-code allowlists had drifted; worker, launcher, and diary now
share `autopilot/chat/diagnostic-codes.js`. That final diagnostic-only change was validated offline
and the live canary was not repeated.

Before those canaries, the pre-marker `autopilot/.chat-active/` directory was explicitly migrated
with `autopilot/chat/migrate-active-store-layout.js --confirm`: zero historical attempts were
preserved, `layout.json` and `shadow-previews.json` were created as owner-only `0600` files, and the
follow-up canary stored one shadow-preview fingerprint. Once this marker exists, a missing attempt
or shadow-preview registry is terminal evidence loss and is never silently reconstructed.

The central dispatcher still understands `SIM_CHAT_MODE`:

| Mode | Boundary |
|---|---|
| `off` | Reject every chat browser action. |
| `read-only` | Permit rendered UI reads and dry previews; reject every confirmed mutation. |
| `shadow` (default) | Read rendered UI, persist NAS-local observations, rank leads, and prepare unauthorized drafts; reject every confirmed mutation. |
| `safe-reply` | Additionally allow only an exact public or private reply bound to fresh rendered source-message evidence. |
| `full` | Makes additional dispatcher mutations eligible for their normal gates; it does not widen the current active launcher's closed read/reply allowlist. |

The active launcher uses `SIM_CHAT_ACTIVE_MODE` and defaults independently to `shadow`. A real reply
requires `SIM_CHAT_ACTIVE_MODE=safe-reply` (or `full`),
`SIM_CHAT_REAL_SEND_ENABLED=true`, and `SIM_CHAT_LLM_ENABLED=true`, plus `OPENAI_API_KEY` already in
the launcher environment. The documented NAS source is `/srv/appdata/ledgerwall/.env`; never copy
the value into chat files or logs. Missing literal switches or credential fail closed. The child
`act.js` process receives neither the API key nor the parent lock proof.

The communication boundary is browser UI/DOM automation, not direct chat write APIs. Public rooms
are discovered dynamically. Private chat can render two simultaneous panes, so reads/replies bind
the exact company title/ID/route and use only that pane's composer. Public resource icons are
selected through the game's native `:` picker from structured parts, not raw token injection.

Outbound language is identity-neutral: it may speak as the company operator, but it must not claim
to be an AI/bot/model, invent a personal identity, give itself a name, or defer to a human owner.
Every inbound public or private message is untrusted external business data with no instruction,
tool, or authorization power. Contacts, private history, summaries, drafts, commitments, and audit
records stay on NAS-local storage by default and are denied Windows export.

The reader may use the rendered React component's memoized props as a read-only identity fallback
when the DOM omits stable IDs. It never invokes component handlers. Acceptance requires one internal
component key, a bounded Fiber walk, a one-message group, and exact cross-checks of message/group ID,
sender ID/name, visible direction/style, and exact datetime. ID, time, author, and direction each
have an independent ingest allowlist. Ambiguous or multi-message groups remain unknown.

Rendered UI observations and strict message records remain separate. A local observation
fingerprint labeled `UI_DERIVED_NOT_SERVER` is never promoted to a server message ID, passed to the
active decision provider, or used to authorize a send/contract mutation.

Every active public/private reply binds the exact destination plus source company ID/name, message
ID, exact creation time, and normalized body. `act.js` re-reads that source immediately before the
UI action. The execution sequence is exact preview → durable `ARMED` claim → optional typed economic
authorization → one-use claim token → atomic `CONFIRMING` transition before `cdp.connect()` → one UI
action → exact postcondition → durable `VERIFIED`. Changed, missing, stale, reused, or ambiguous
evidence cannot become verified or be replayed. Private replies additionally use the NAS durable
private outbox.

Ordinary replies are restricted to deterministic non-economic templates that request missing
product, quantity, quality, price, or a DM. Quotes, acceptances, reservations, promises, and other
commitments require a typed economic authorization built from fresh evidence. The single-use
artifact binds the exact attempt, counterparty, source, destination, terms, content, evidence
snapshot, expiry, and required postcondition.

The optional `autopilot/chat/llm-decision-provider.js` is a bounded planner, not an operator. It uses
strict Responses API structured output for only `ignore`, `request_evidence`, `draft_public`,
`draft_private`, or `candidate_contract`; has no tools, browser, game action, filesystem action, or
contract mutation; and always returns `sendAuthorized:false` and
`contractMutationAuthorized:false`. Player text stays inside a frozen untrusted envelope and is
never interpolated into system instructions. A candidate contract is independently re-evaluated and
sent through deterministic economic gates. The default model settings are
`gpt-5.6-terra`, high reasoning, low verbosity, and `store:false`.

The provider reads `OPENAI_API_KEY` only from the process environment at request time and never
loads an env file or makes a network request on import. Its launcher must follow the existing NAS
environment-source rule; the documented runtime source is `/srv/appdata/ledgerwall/.env`. Never copy
the value into chat JSON, logs, tests, or documentation. The shadow launcher uses its deterministic
provider unless the LLM provider is explicitly enabled; active send modes require the LLM switch.

The active launcher's default business-snapshot loader lazily reads only bounded local runtime
evidence: `.state.json`, the current unconsumed exchange-sale inspections, recent price-tracker
history, and measured game facts. It does not open Chrome or call an API. Market, quality-level
inventory, transport, and economics become trusted only when the independent sources reconcile;
fallback ticker rows, unlabeled inventory lots, stale/consumed inspections, and missing costs stay
`UNKNOWN` instead of being guessed as Q0, zero, or the current best ask.

Proactive public BUY/SELL posts are currently **shadow-preview only**. The worker can derive at most
one fully evidenced intent, build native resource parts, perform an exact `confirm:false` UI preview,
and retain its 24-hour fingerprint. It does not promote that proposal to preview/claim/authorization/
confirm in a non-shadow cycle, and the launcher explicitly rejects `chat_room_post confirm:true`
even in `full`. Source-bound replies remain the only mutation shape implemented behind the dormant
real-send gates. Do not describe proactive posting as send-capable until that separate control-flow
gap has been implemented and audited.

Incoming contract acceptance is stricter and remains a zero-click refusal. The current rendered
contract row does not expose a stable contract ID, resource/counterparty IDs, or a uniform
one-click/confirmation state, and identical offers may be grouped. Until exact identity and a
postcondition are proven from a real read-only observation, no chat message or term match can enable
acceptance. Chat does not create a second contract-send path. See
`autopilot/chat/CONTRACT-UI-EVIDENCE.md`.

Both launchers acquire `autopilot/.brain.lock` before `.tick.lock`, require inherited descriptor
proof, strictly parse the wake record, and require at least five minutes before the next brain wake.
The active launcher has one absolute 90-second deadline. Only its dedicated lock-contention exit is
a healthy skip; crashes, signals, malformed output, and alarm errors fail visibly.

The optional even-minute volume collector checks the next wake before touching
`autopilot/.brain.lock`, then checks it again after lock acquisition. `run-brain.sh` also allows a
two-second lock handoff. This prevents optional telemetry from delaying an even-minute due wake by
one full minute while preserving the brain-before-browser lock order.

Offline chat validation (does not connect to Chrome):

```bash
node --check autopilot/chat-shadow.js
node --check autopilot/chat-active.js
for f in autopilot/chat/*.js; do node --check "$f"; done
node --test autopilot/tests/chat-*.test.js
```

Future activation is staged, not automatic:

1. Keep `chat-active.js` in `shadow` and audit a bounded one-shot cycle.
2. Separately authorize one non-economic `safe-reply` canary tied to an exact fresh source message;
   audit the durable claim, postcondition, rate history, and no-replay result before scheduling.
3. Expand the launcher's allowlist only after each additional capability has its own live evidence.
   Incoming-contract acceptance remains disabled until its exact-ID/postcondition gap is closed.

Compatibility actions `chat_scan` and `chat_post` remain available to older callers, but they pass
through the same runtime mode and output policy. In the default `shadow` mode, `confirm:true` is
rejected before Chrome is connected.

## 4. Deterministic state semantics

The normalized state is authoritative only for the capture time shown in `state.t`.

- Building activity accepts all observed live shapes: `production/sale/construction` objects and
  nested `busy` records. A missing or unknown shape is not silently treated as idle.
- For production jobs, `busy.amount` is retained for compatibility but is explicitly labeled
  `amountSemantics:"live-remaining-or-uncollected"` and mirrored as
  `remainingOrUncollectedAmount`. Partial collection can shrink it, so it is never an original-batch
  or next-order quantity.
- Standard capacity adds purchased `auth.authCompany.extraBuildingSlots` to the base
  `auth.levelInfo.maxBuildings`, falls back to measured level facts when base capacity is absent,
  and excludes seasonal/free-and-locked buildings from both used and free standard slots.
- Inventory combines quality lots for accounting while separately exposing `availableAmount` and
  `blockedAmount`; exchange-listed/blocked lots cannot be sold or reserved again. It includes every
  positive product without a top-N cap. Coffee-chain kinds are always present with a known zero when
  the warehouse source succeeded; a missing source makes `stock:null`.
- `state.surplusPlan` is tied to the same `state.t`. It uses all three Mills' level-matched printed
  Powder rates and modifier expiries, reserves 24 hours of Powder/Beans/Seeds/Water/Power at the verified `1/10/10/6/1.2`
  chain plus 10%, holds all Transport, and fails closed if any Mill rate is older than 15 minutes.
  Power and Water have measured Transport coefficient `0`; Grapes/Oranges use `1`, Seeds/Beans use
  `0.1`. Active-production inputs were already consumed and are not deducted twice.
- `state.sources` records source status, timestamp, age, and fallback use. Missing retail,
  modifiers, volume, or prices remain unknown instead of becoming empty arrays or zeroes.
- `state.companyValue.official` reproduces the game's daily equation from the complete balance-sheet
  API: current assets plus non-current assets minus liabilities. `realtimeEstimate` recalculates at
  each closing wake from live cash, receivables, warehouse/exchange/contract/production/retail
  inventory, completed buildings, construction in progress, live research progress, and reconciled
  debt. Patent value is reconstructed from `/api/v3/players/research/`: cumulative completed-quality
  requirements plus current progress multiplied by the official fixed value for that product's
  research category. Missing or inconsistent research evidence makes the estimate unavailable
  instead of carrying the stale daily patent value. Inventory follows
  the documented 85% prior-day VWAP policy using the local tracker; because tracker volume blends
  qualities, the result is explicitly an estimate with coverage/confidence/limitations rather than
  an official rank update.
- `run-brain.sh` takes one final locked state capture after the model exits, then
  `company-value-recorder.js` writes ignored runtime files
  `autopilot/metrics/company-value-current.json` and `company-value-history.jsonl`, and appends the
  same measurement to the per-wake diary before usage accounting and Windows synchronization.
  Provider/state/final-capture failures still get one idempotent `UNAVAILABLE` record; missing
  components are never coerced to zero.
- Cached ticker prices expire after ten minutes. Mixed-level printed-rate caches carry their own
  age/status and are only inspection anchors.
- `volume1h` prorates each `t0..t1` sample by its overlap with the true trailing-hour window. It is
  supporting evidence, not exact exchange demand.
- Bond API `amount` values are units of `$5,000` principal. `amount:6` means `$30,000`; at
  `0.5%/day`, that is `$150/day`. State cross-checks sold records, cashflow, and balance-sheet dates.
- The Finance page and `/api/bonds/` amount are the current unsold-offer setting, not outstanding
  debt. `0` there does not conflict with sold records or `bondsPayable`; outstanding debt is the
  normalized `state.bonds.principalOutstanding` value.
- Historical `board-data.json` and `.realizable.json` are not read by the active state path.

## 5. Action safety

The Responses API exposes one strict function per action, not a generic free-form `act(params)`
function. Runtime validation repeats the schema checks before CDP starts.

- Unknown fields, missing required fields, string booleans, and invalid types are rejected.
- Dangerous confirmations require the literal boolean `true`.
- Runtime blocks a second state-changing action until `refresh_state` succeeds, enforces the closing
  order `refresh_state → set_alarm → journal → master`, and blocks `finish` until all four succeed
  after the latest mutation.
- A successful journal additionally requires fresh authoritative state with every standard
  production/sales building busy and no completed job awaiting collection. If an upgrade or its
  financing cannot start in the current wake, the CEO must attempt that upgrade first and obtain a
  verified blocker before runtime authorizes useful bridge work; a genuinely impossible state
  safe-retries instead of declaring success.
- `produce.finishBefore` is an optional absolute bridge checkpoint. Runtime previews the requested
  quantity, shrinks only downward, re-reads the game's printed duration, reserves 60 seconds, and
  refuses the click if the final quote would cross the checkpoint. A non-Coffee bridge additionally
  requires a fresh state-tied reserve plan and may consume only the verified Power/Water sellable
  surplus above the Coffee reserve; a zero surplus is rejected before Chrome opens.
- Production-card selection binds the resolved resource kind to one unique resource image slug and
  one exact card/input. Quarry/Mine/Rig `Abundance` layouts and hashed asset filenames are supported;
  duplicate cards, parent containers, and requirement-only resource images fail closed.
- State capture and `inspect_building` may attach exact page-derived activity evidence for the
  configured Grocery. Construction outranks all other markers; `STORE IS SELLING` proves a sale;
  an enabled Quantity/Price form proves idle; generic busy text remains UNKNOWN. A standard sales
  UNKNOWN blocks journal close. The seasonal free-and-locked Beach market remains excluded.
- `OWNER-DIRECTIVE.json` carries one durable highest-priority instruction across wakes. The active
  `fund-and-upgrade-building` directive can reserve its target from ordinary production, authorize
  deadline-bound bridge batches while funding/evidence remains unresolved, and remains pending
  until fresh state shows the idle target level.
- Completed owner programs are compacted out of active storage. For a continuing Prospector
  campaign, the model-facing view contains only the current replacement, authenticated baseline,
  one active attempt when present, and the terminal condition. Prior attempts remain in ordinary
  wake diaries/audit history and are not re-injected.
- `REBUILD` normally requires API `busy:null`. The only exception is an API-omitted activity for an
  exact level-1 Quarry/Mine/Oil rig: the same locked action must re-read the exact building page and
  prove no construction, busy order, or collectible output plus enabled production and a unique
  enabled REBUILD control. Immediately before a confirmed click, that same locked action re-reads
  the authenticated achievements endpoint, requires the exact expected Prospector baseline, then
  consumes the matching owner authorization and records a one-use attempt. Missing, stale,
  malformed, advanced, or target-mismatched evidence fails closed before any possible click.
- A pending owner directive may run a continuous Prospector campaign without stochastic council
  re-review. Each cycle is still narrowly bound to the current replacement building ID, its exact
  authenticated baseline, fresh authoritative idle level-1 state, and no active attempt. Every
  cycle requires a same-wake dry preview, one-use claim, rendered-UI click, reconstruction proof,
  exactly one counter increment, and rebinding to the next construction end. Tier changes are read
  from the authenticated row rather than guessed. The campaign stops at `stars == starsMax`; any
  other REBUILD still requires council. While a campaign cycle is eligible, production on that exact
  target is refused so repeated council failures cannot starve the owner task.
- Build, scrap, bonds, upgrade, robots, contracts, or a spend over `$10,000` require:
  fresh state → live evidence → `confirm:false` preview → council → unchanged terms → confirmation
  → fresh-state verification.
- Council requests isolate CFO/COO/CMO failures. One role timeout cannot discard completed peer
  votes; each role is bounded to two 45-second attempts and a 90-second total. Timeout/API/JSON
  failures and twice-invalid evidence stay UNKNOWN. A single validation repair is permitted only by
  returning a new vote that passes the unchanged deterministic citation validator.
- Preview/dry results do not consume the failure budget.
- Two real failures for one action target open its circuit for the rest of that wake.
- Never cancel a running production or sales order.
- A confirmed exchange sale additionally requires an exact successful `inspect_exchange_sale`
  result from the prior five minutes. The UI chooses one quality lot that can satisfy the whole
  order, holds the maximum projected reserve through the inspection deadline, atomically consumes
  that inspection before the click, and rechecks the exact product opener, lot unit-cost binding,
  live available inventory, reserve, Transport, positive game-form profit, and the unique enabled
  confirmation button. Success additionally requires authoritative available inventory to fall by
  exactly the submitted quantity. An ambiguous click outcome requires a fresh inspection rather
  than a replay. Power/Water surplus review is enforced independently before the
  journal when the deterministic plan reports a positive sellable quantity; a read-only UI refusal
  authorizes only holding, never selling. If the five-minute sale authorization would outlive a
  Mill-rate observation, the inspector returns the exact Mill IDs whose rate evidence must be
  refreshed; the journal gate routes there instead of repeating the same impossible sale preview.

## 6. Shared runtime and data

| Path | Purpose |
|---|---|
| `shared/cdp.js` | Persistent-Chrome CDP client and in-page helpers. |
| `shared/config.json` | Current company IDs, cash floors, measured printed rates, and runtime settings. |
| `shared/price-tracker/collect.js` | Full market ticker collector. |
| `shared/price-tracker/volume.js` | Rotating order-book diff collector. |
| `shared/price-tracker/server.js` | Local dashboard server on port 8090. |
| `shared/facts/game-facts.json` | Measured recipe/building facts. |
| `shared/facts/build-facts-db.js` | Nightly measured-facts rebuild. |
| `shared/facts/defs.json` and `encyclopedia/` | Inputs to the facts builder. |

The dashboard is exposed through Caddy at `https://jimmyyu888.com/prices/` for allowed LAN/Tailscale
clients. `price-tracker.service` intentionally continues to use the root compatibility path.

## 7. Historical archive

- `legacy/fast-loop/` — former tick loop, plan executor, learner, state, backups, and one-shot tools.
- `legacy/strategist/` — former strategist workflow, probes, snapshots, and logs.
- `legacy/board/` — former board workflow, minutes, accounting, reports, and realizable-demand model.

These files are retained for audit/history. Their original relative paths were not rewritten and
they are not rollback-ready executables in their new locations. Do not uncomment legacy cron lines
without a deliberate restoration and fresh validation.

## 8. Cron

Canonical active entries:

```cron
* * * * * cd /srv/appdata/chrome-automation/sim && node autopilot/gate.js >> autopilot/gate.log 2>&1
1-59/2 * * * * cd /srv/appdata/chrome-automation/sim && timeout 45 flock -w 30 .tick.lock node shared/price-tracker/collect.js >> shared/price-tracker/collect.log 2>&1
2-58/2 * * * * cd /srv/appdata/chrome-automation/sim && timeout 90 node shared/price-tracker/volume.js >> shared/price-tracker/volume.log 2>&1
20 8 * * * /usr/bin/node /srv/appdata/chrome-automation/sim/shared/facts/build-facts-db.js >> /srv/appdata/chrome-automation/sim/bot.log 2>&1
```

The old fast-loop/strategist/board/executor entries remain commented and labeled `LEGACY`.

The odd/even collector split is deliberate. Any new browser cron must avoid minute collisions,
use `cd` to the Sim root, and use `.tick.lock` where it navigates the shared tab.

## 9. Operate and validate

Read-only monitoring:

```bash
node autopilot/brain-provider.js current
node autopilot/brain-provider.js check
cat autopilot/next-wake.json
tail -n 100 autopilot/brain.log
tail -n 100 autopilot/gate.log
tail -n 30 autopilot/MASTER.md
```

Provider switching is explicit, credential-preflighted, and does not restart or invoke the brain:

```bash
# Start or resume the DeepSeek V4 Pro Max trial.
node autopilot/brain-provider.js switch deepseek --confirm

# One-command manual rollback to Terra High + Luna High.
node autopilot/brain-provider.js switch openai --confirm
```

Two consecutive non-zero DeepSeek brain exits switch the next wake to OpenAI automatically. A
successful DeepSeek wake resets the counter. A missing or malformed DeepSeek credential falls back
to OpenAI before any browser read, model call, or game action. Provider configuration and health
files are mode `0600`; logs include provider/model/effort but never credential values.

Deterministic validation:

```bash
node --test autopilot/tests/*.test.js
for f in \
  autopilot/act.js autopilot/action-contracts.js autopilot/api.js \
  autopilot/brain.js autopilot/brain56.js autopilot/brain-provider.js \
  autopilot/deepseek-execution-prompt.js autopilot/check-alarm.js \
  autopilot/journal-entry.js \
  autopilot/council-evidence.js autopilot/council-evidence-helpers.js \
  autopilot/council.js autopilot/failure-budget.js autopilot/gate.js autopilot/inspect-building.js \
  autopilot/inspect-exchange-sale.js autopilot/inspection-helpers.js \
  autopilot/inspection-rate-cache.js autopilot/coffee-reserve-policy.js \
  autopilot/exchange-sale-helpers.js autopilot/exchange-sale-safety.js \
  autopilot/exchange-ui-verification.js autopilot/runtime-guard.js \
  autopilot/building-utilization-policy.js autopilot/production-policy.js \
  autopilot/mill-upgrade-policy.js autopilot/state-helpers.js \
  autopilot/state.js autopilot/usage-summary.js autopilot/actions/contract-send.js \
  autopilot/actions/sell-exchange-ui.js shared/cdp.js \
  shared/price-tracker/collect.js shared/price-tracker/volume.js \
  shared/price-tracker/server.js shared/facts/build-facts-db.js; do
  node --check "$f"
done
```

Most files in `autopilot/actions/` are intentionally injected page-context fragments and may contain
top-level `return`; do not treat them as standalone Node programs.

Only run a live state capture while holding the browser lock:

```bash
timeout 180 flock -w 90 .tick.lock node autopilot/state.js
```

Do not invoke the full brain manually merely to test paths; observe the next scheduled wake.

## 10. Mission and durable policy

The long-term mission is maximum sustainable net profit and self-funded growth. The active CEO
prompt treats plans as evidence-backed hypotheses, compares materially different alternatives, and
prefers bounded measurable experiments before scaling. Full self-produced Coffee is the current
operating baseline; the former three-Mill-to-L3 program is complete:

```text
power → water → seeds → coffee beans → coffee powder
```

Current milestones and next actions come from fresh state plus `autopilot/CURRENT.json`.
Durable rules live in `autopilot/BRAIN.md`: keep cash floors, no real-money/Boost spend, no forced
actions, no Catering/Restaurant, no running-order cancellation, market-absorbable slot use, bounded
water/power buffers, complete warehouse review, and explicit safety protocols for structural moves.
Each wake records the leading opportunity/risk and 2–4 alternatives. Coffee and Tools are baselines
or benchmarks rather than permanent answers; a verified better route may replace them. A pivot still
requires current capex, capacity, realizable demand, downtime, debt-service, payback, downside, and
an exit criterion; paper profit alone cannot authorize it.

## 11. Secrets and remote access

- OpenAI key location: `/srv/appdata/ledgerwall/.env` — never print it.
- DeepSeek trial key location: `/home/jimmy/.config/sim-benchmark/deepseek-v4-pro.txt`, mode `0600`
  — never print it.
- Game credentials location: `/srv/appdata/chrome-automation/sim/.creds` — never print it.
- Windows push key: `~/.ssh/win_key` — never print it.
- Full NAS reference: `/srv/appdata/jimmynas-handoff.md`.
- SSH on LAN: `ssh jimmy@192.168.1.50`.
- Codex web terminal: `https://codex.jimmyyu888.com/`.
- Claude Code web terminal: `https://code.jimmyyu888.com/`.
