# Active LLM autopilot

This is the canonical active runtime for the Sim Companies operator.

## Layout

- `BRAIN.md` — stable owner policy and operating protocol read every wake.
- `CURRENT.json` — authoritative structured current checkpoint, replaced atomically each wake.
- `OWNER-DIRECTIVE.json` and `owner-directive.js` — one durable highest-priority owner instruction.
  Completed programs and repeated-attempt history stay out of the model-facing view; only the active
  subtask, current evidence binding, and stop condition are injected.
- `MASTER.md` — append-only terse audit history; not injected as current truth.
- `JOURNAL.md` and `diaries/diary-*.md` — detailed historical wake records. Per-wake diaries live
  in the dedicated `diaries/` directory, never in the `autopilot/` root.
- `brain.js` — active DeepSeek V4 Pro Chat Completions engine.
- `brain56.js` — retained OpenAI Terra Responses API rollback engine.
- `state.js` and `state-helpers.js` — deterministic live-state capture and normalization.
- `company-value.js` and `company-value-recorder.js` — per-wake estimated company value using the
  game's balance-sheet equation, live assets/liabilities, and the prior UTC day's tracked VWAP at
  the game's 85% inventory liquidation factor. The official daily value remains separately labeled.
- `coffee-reserve-policy.js` and `inspection-rate-cache.js` — fail-closed 24-hour Coffee-chain
  reserves based on fresh, level-matched rates and modifier-expiry evidence for every Mill.
- `inspect-exchange-sale.js`, `exchange-sale-helpers.js`, and `exchange-sale-safety.js` — read-only
  live exchange preflight plus the single-use exact-match confirmation guard. Final submission
  rechecks the exact product opener, selected-lot cost, live available inventory, reserve,
  Transport, profit, and unique enabled button in one browser turn, then proves the authoritative
  available inventory fell by exactly the submitted quantity.
- `action-contracts.js` — strict typed schemas and runtime validation for each action.
- `failure-budget.js` — per-target two-failure circuit breaker for one wake.
- `runtime-guard.js` — refresh/action sequencing and finish requirements.
  Any refreshed evidence invalidates earlier alarm/journal/master authorization; incomplete model
  loops schedule a five-minute safety retry instead of silently exiting.
- `api-result.js`, `tool-output.js`, `current-memory.js`, and `council-verdict.js` — source-aware
  bounded tool output, validated current memory, and evidence-checked advisor verdicts.
- `act.js` — guarded action dispatcher.
- `chat/` — chat trust boundary and NAS-local memory, identity-neutral output policy, dynamic
  public/private UI plans, contact/subscription/message helpers, lead extraction, negotiation, and
  contract gates.
- `chat/llm-decision-provider.js` and `chat/CHAT-BRAIN.md` — optional bounded Responses API planner.
  It returns drafts/evidence requests or a non-mutating contract candidate, never tools, browser
  actions, sends, or contract authorization.
- `chat-shadow.js` — bounded chat observer entry point. It is deliberately unscheduled, acquires
  `.brain.lock` before `.tick.lock`, and never exposes a send or contract mutation to its worker.
- `retail-optimizer.js` — bounded Grocery price-grid generation, UI quote parsing, and
  maximum-positive-profit/hour selection.
- `actions/` — browser/UI primitives.
- `gate.js`, `run-brain.sh`, and `check-alarm.js` — alarm and wake lifecycle.
- `reference/` — material loaded only by a relevant tool, not on every wake.
- `tests/` — deterministic unit tests.

Runtime state and logs also live here: `CURRENT.json`, `.state.json`, `.inspection-rates.json`,
`.exchange-sale-inspections.json` (isolated by resource kind), `next-wake.json`, `.last-wake.json`, `brain.log`, `gate.log`,
per-call `usage.jsonl`, per-wake `wake-usage.jsonl`, `.brain.lock`, and ignored
`metrics/company-value-{current.json,history.jsonl}`.

Each `diaries/diary-*.md` ends with an automatically generated token and estimated API-cost summary. The
summary includes main-brain and council calls and is appended before Windows synchronization. A
closing browser snapshot also appends that wake's real-time company-value estimate, official daily
comparison, confidence, inventory coverage, and limitations to the same diary.
The active runner uses DeepSeek `max` or retained OpenAI `high`, both with low visible verbosity.

## Safety

- `.tick.lock` at the Sim root serializes every browser user of Chrome `127.0.0.1:9222`.
- `.brain.lock` prevents overlapping full wakes.
- Do not invoke `act.js` manually without the tick lock.
- A preview is not confirmation. Dangerous actions require fresh state, a dry preview, council,
  unchanged terms, explicit confirmation, and post-action verification.
- Exchange confirmation additionally requires a matching five-minute read-only inspection, one
  sufficient quality lot, reserve/Transport-safe quantity, and positive game-form estimated profit.
  The authorization holds the maximum projected reserve through its expiry and is consumed before
  the click, including when the post-submit result is ambiguous.
- A compact pending-owner view is injected ahead of `CURRENT.json` on every wake. It remains pending
  across asynchronous financing or construction and closes only when live state proves completion.
- `JOURNAL.md` remains audit history and is not re-injected. `CURRENT.json` is the sole routine
  cross-wake operating memory, preventing stale diary narratives from overriding fresh state.

## Chat rollout

`SIM_CHAT_MODE` recognizes `off`, `read-only`, `shadow`, `safe-reply`, and `full`; the default is
`shadow`. Only `off`, `read-only`, and `shadow` are currently deployment-ready. `safe-reply` and
`full` are deliberately unscheduled activation states for source-bound inbound replies. Proactive
room posts are shadow-preview-only; their confirmed preview/claim/send path is not exposed. The
default is a guardrail, not an active process: no chat cron/service is installed, no live shadow
observer is running, and sends or persistent chat changes are not enabled.

Chat reads and mutations are implemented through the rendered browser UI rather than direct chat
write APIs. Public posts are one line, at most 60 characters, and use structured resource parts that
select the game's native `:` icon suggestions. Private-chat actions bind the exact company pane to
avoid the two-composer layout. Inbound content is always untrusted data; outbound content is
identity-neutral; private chat memory and drafts remain NAS-only. UI-derived observation fingerprints
are never treated as server message IDs.

The lead/negotiation path may prepare a draft only from explicit structured terms and current
business evidence. Contracts remain behind a separate economic, exact-terms, counterparty,
idempotency, and UI gate. Existing warehouse contract sending is reused; incoming-contract acceptance
is a zero-click refusal until the UI exposes a stable exact ID and verifiable postcondition.

The optional LLM chat provider accepts only a frozen untrusted-message envelope plus a fresh trusted
business snapshot. Strict structured output is revalidated by deterministic identity, public-length,
no-spam, lead-economics, and `confirm:false` contract-preview gates. It has no tools or action
dispatcher, uses `store:false`, and never authorizes a send or contract mutation. Its default
transport reads `OPENAI_API_KEY` from the process environment only at request time; it does not load
an env file. Launchers must follow the existing NAS env-source rule (`/srv/appdata/ledgerwall/.env`)
without copying secret values into chat files or logs. The shadow CLI does not select this provider
unless trusted host code explicitly injects it.

Contact, subscription, translation, and retraction primitives are browser-UI scoped and retain the
same preview/mode gates. Legacy `chat_scan`/`chat_post` callers remain compatible, but default-shadow
mode rejects `confirm:true` before Chrome is connected.

Offline validation:

```bash
node --check autopilot/chat-shadow.js
for f in autopilot/chat/*.js; do node --check "$f"; done
node --test autopilot/tests/chat-*.test.js
```

Future activation must proceed deliberately from audited `shadow` observation, to canary
`safe-reply`, and only then to `full`. Do not install a schedule until the bounded shadow results,
durable stores, economic evidence, and lock timing have been reviewed. Confirmed proactive posting
remains unavailable independently. See `chat/README.md`, `chat/SHADOW-MODE.md`, and
`chat/CONTRACT-UI-EVIDENCE.md`.

The root `brain` and `pages` paths are compatibility symlinks only. New code and cron entries must
use `autopilot/` and `autopilot/actions/`.
