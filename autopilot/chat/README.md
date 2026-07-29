# Chat subsystem

This directory contains the NAS-local memory, policy, evidence, decision, authorization, and
execution layers for Sim Companies chat. Browser interaction remains rendered-UI automation: the
runtime navigates the game pages and uses scoped DOM/component evidence and native UI controls. It
does not use a direct chat write API.

There are two launchers:

- `autopilot/chat-shadow.js` is the bounded observation/draft launcher. It has no send action.
- `autopilot/chat-active.js` is the production-capable read/reply launcher. Its default is still
  `shadow`; real replies require separate explicit rollout switches and are not currently deployed
  or scheduled.

Importing the chat modules installs no cron entry, service, timer, or background process.

## Current rollout evidence

On 2026-07-27, bounded live shadow reads were completed against the rendered game UI. The first
strict-provenance canary observed 159 messages across four public rooms and one private thread:

- 139 messages entered the strict ledger;
- 20 observations were excluded because one or more strict identity fields were not proven;
- 97 strict-ledger offers were extracted;
- errors, `confirm:true` calls, message sends, and contract actions were all zero.

The records are under `autopilot/.chat-shadow/`. This proves bounded reading and ingestion, not
real-send behavior. No public/private message has been sent by the new chat runtime, and
`safe-reply` is not installed in cron or systemd.

Two production-shaped `chat-active.js` shadow canaries also completed successfully at 04:51 and
04:52 CDT on 2026-07-27. Each read one private contact plus the `Sales` and `Aerospace sales`
rooms, admitted 63 strict inbound messages, made four LLM decisions, and produced four proposals
with zero errors, previews, confirmations, outcomes, or sends. This validates the active read and
decision path only; real sending remains disabled and unscheduled.

The active worker now derives a compact room-style profile from strict inbound messages. It keeps
only aggregate length and formatting rates, never player examples or wording. The learned body
limit is bounded to 18-30 characters (45 only when samples are insufficient) and is reduced further by the native `@company` prefix budget;
60 characters remains the absolute rendered-message ceiling. Messages that trigger the prompt-
injection detector are excluded before style aggregation.

The public economic path is now wired for offline/shadow validation. A complete external BUY/SELL
lead can produce a deterministic structured room-reply preview. With no selected room reply, an
explicitly discovered Sales/trade room can receive at most one deterministic proactive BUY/SELL
preview derived from the same fresh business snapshot. Shadow mode performs the exact rendered-UI
`confirm:false` preview and stores only its fingerprint for 24-hour replay suppression. This is
preview evidence only: no authorization is issued, no attempt is claimed, and no send is confirmed.

## Runtime modes and rollout switches

The central dispatcher uses `SIM_CHAT_MODE` with `off`, `read-only`, `shadow`, `safe-reply`, or
`full`. Direct callers default to `shadow` and cannot confirm a mutation there.

`autopilot/chat-active.js` uses the independent launcher setting `SIM_CHAT_ACTIVE_MODE`, which also
defaults to `shadow`. A real reply requires all of the following in the launcher process:

- `SIM_CHAT_ACTIVE_MODE=safe-reply` (or `full`);
- `SIM_CHAT_REAL_SEND_ENABLED=true`;
- `SIM_CHAT_LLM_ENABLED=true`;
- a valid `OPENAI_API_KEY` already present in the process environment.

The key follows the existing NAS environment-source convention at `/srv/appdata/ledgerwall/.env`.
Never copy its value into chat state, logs, tests, or documentation. The launcher rejects active
send modes if either literal rollout switch or the credential is absent. Its child `act.js`
process receives a minimal allowlisted environment and receives neither the API key nor the lock
proof.

`safe-reply` permits only `chat_room_reply` and `chat_private_send`, each bound to a fresh inbound
message. Proactive `chat_room_post` is currently available only as an exact `confirm:false` shadow
preview. Neither `safe-reply` nor `full` enters a proactive post preview/claim/confirm pipeline, and
the active launcher explicitly refuses `confirm:true` room posts. Confirmed proactive posting is
not yet exposed.
The deployed/default mode remains `shadow`; neither public sending nor contract acceptance is
scheduled or enabled by this code change.

## Rendered identity provenance

Visible DOM text alone is not sufficient to authorize a reply. The public/private readers may use
the rendered React component's memoized props as a read-only identity source when the DOM omits
stable IDs. They never call component handlers. An accepted component identity must be
cross-checked against the visible sender, incoming/outgoing style, exact visible timestamp, body
count, and message-group shape.

Strict component provenance is intentionally narrow:

- exactly one React internal key must exist on the rendered message root;
- the bounded Fiber walk must expose `messageGroupId`, `sender`, `body`, and `fromMe`;
- sender ID/name, direction, numeric message ID, and ISO datetime must match visible evidence;
- only a one-message component group is admitted until multi-message index binding is measured;
- ambiguity leaves the ID/time unknown instead of inventing a value.

`ingest.js` independently allowlists ID, time, author, and direction provenance. Only messages with
an explicit allowed ID source, exact time, verified direction, and (for inbound messages) verified
author enter the strict ledger. A local `UI_DERIVED_NOT_SERVER` fingerprint remains
observation-only and cannot reach the active decision provider or authorize any send.

## Exact source binding and send state machine

Every active reply binds immutable source and destination evidence. Public replies bind the room,
conversation route, company name/ID, message ID, exact creation time, and exact normalized body.
Private replies bind the target contact name/ID, source message ID/time/author, exact body, and exact
private pane. `act.js` re-reads and uniquely re-verifies that source immediately before touching the
reply/send UI.

The active execution sequence for source-bound inbound replies is fail-closed:

1. perform an exact `confirm:false` preview;
2. atomically write an `ARMED` attempt to `ActiveChatStore` with the complete action-parameter hash;
3. issue a typed economic authorization when the text carries trade terms or a commitment;
4. pass a one-use execution-claim token only to the confirmed `act.js` child;
5. atomically consume that token and move the attempt to `CONFIRMING` before `cdp.connect()`;
6. use the native rendered UI once;
7. require the exact destination/source/postcondition and durable `CONFIRMING` evidence before
   recording `VERIFIED`.

A missing/wrong/replayed token, changed action parameter, stale source, lost lock, ambiguous click,
or unproven postcondition cannot become `VERIFIED`. `ARMED`, `CONFIRMING`, `VERIFIED`, and
`AMBIGUOUS` records block replay. Private sends additionally use the durable private outbox, so a
browser restart cannot erase the click attempt.

This execution sequence does not currently apply to proactive public posts. They stop at an
aggregate proposal outside shadow, while shadow may perform and durably deduplicate one exact
`confirm:false` preview.

## Lock, wake, and time boundary

Both launchers acquire `autopilot/.brain.lock` before the Sim root `.tick.lock`. Internal stages
must prove the inherited lock descriptors; merely naming an internal stage cannot bypass either
lock. `autopilot/chat-active.js` uses one absolute 90-second cycle deadline, refuses to start unless
the next brain wake is at least five minutes away, and rechecks the wake/locks around operations.
Only the dedicated `flock` contention exit is treated as a healthy skip; crashes, signals, malformed
child output, and alarm parsing failures are errors.

## Decision and economic policy

Inbound player text is frozen as untrusted business data and has no instruction, tool, or
authorization power. Identity-neutral output policy rejects AI/bot/model claims, invented personal
identity or names, and deferral to a human owner.

Ordinary replies are restricted to deterministic, allowlisted non-economic templates such as
requests for product, quantity, quality, price, or a DM. Model-generated prose cannot smuggle a
quote, acceptance, reservation, promise, or other commitment through an ordinary draft. Economic
language must instead use a typed authorization request built from fresh business evidence. The
durable artifact binds the exact attempt, counterparty, source message, destination, terms,
generated content, evidence snapshot, expiry, and required postcondition, and is single-use.

`llm-decision-provider.js` remains a bounded planner. It has no browser, tools, action dispatcher,
filesystem mutation, or contract mutation surface; uses `store:false`; and returns a decision that
the deterministic worker independently validates. A room economic candidate may select only exact
fresh lead terms; host code renders its BUY/SELL text and native resource part. Before every LLM
call the worker reserves a conservative hard upper bound for the complete request plus configured
output ceiling; a production-shaped request is tested to remain within the 24,000-token cycle cap.
In shadow, every draft remains unauthorized.

The default production business snapshot is built lazily from bounded NAS-local runtime artifacts:
current `.state.json`, unconsumed exchange-sale inspections, recent ticker history, and measured
game facts. These sources must reconcile on timestamp, kind, quality, lot quantity, reserve,
transport, fee, and UI selection before a value becomes trusted. A fallback ticker, an unlabeled
lot, a consumed/stale inspection, or a missing cost remains `UNKNOWN`; none is silently interpreted
as Q0, zero cost, or market price.

Incoming contract acceptance remains zero-click disabled. The rendered contract list still lacks
the exact stable contract identity and uniform postcondition required for safe acceptance. Chat
cannot create a second contract-send path around the warehouse contract gate.

The icon planner loads the local verified resource-name catalog and fills missing names from local
resource-definition image slugs. This covers the complete local catalog, including Tools and
Satellite, without trusting player wording. Raw `:re-kind:` text remains forbidden; the UI must
select one exact native suggestion. Public economic text is generated only from typed terms after
fresh economic validation. Ordinary model-authored icon prose remains restricted to the
non-economic `DM [resource icon] details.` shape.

For proactive intent, missing fees, costs, inventory/reserve, market, transport, warehouse, cash,
or use-value evidence yields zero candidates. No absent value is guessed as zero. A product-quality
identity can never advertise both BUY and SELL in one cycle; the higher fully evidenced net
opportunity wins deterministically (stable ID only breaks an exact tie).

## NAS-local persistence

The main stores are:

```text
autopilot/.chat-shadow/                    live shadow observations, strict memory, drafts, audit
autopilot/.chat-active/                    active strict memory, attempts, shadow-preview fingerprints
autopilot/.chat-private-outbox/            private click-attempt replay boundary
autopilot/.chat-communication-authorizations.json
                                            single-use economic authorization records
autopilot/.chat-posts.jsonl                 public-send outcome/rate evidence
autopilot/chat-diaries/                     aggregate cycle diaries without bodies or identities
```

Rows for one public attempt are folded by attempt ID, so `ARMED` plus its final outcome consumes
one rate-limit slot. Proven pre-click failures do not consume duplicate budget. Only exact newly
inserted ledger messages reach the decision provider; a separate 24-hour same-content guard remains
for one conversation and includes successful shadow previews. Each completed launcher cycle records
aggregate public reply/proactive/economic/BUY/SELL/preview counts and token usage in an owner-only
chat diary, without message bodies or identities. Unrecognized runtime error strings collapse to
`UNKNOWN`; even an unhandled cycle exception gets a best-effort fixed-code failure diary. The
default aggregate decision budget is 24,000 tokens per cycle, in addition to the four-call cap.

Production roots are fixed, owner-only, bounded, and symlink-resistant. Contacts, private history,
observations, drafts, commitments, and audit records remain NAS-local; Windows/UNC export paths are
rejected.

The active store is anchored by an owner-only, versioned `layout.json`. Only a path that did not
exist before first initialization may create empty attempt and shadow-preview registries. Once the
marker exists, either registry being absent is a terminal evidence-loss error and is never silently
recreated. A pre-marker store with a valid existing `attempts.json` must be migrated explicitly:

```bash
node autopilot/chat/migrate-active-store-layout.js --confirm
```

The launcher never invokes this migration automatically.

## Validation

Offline validation does not connect to Chrome or send anything:

```bash
node --check autopilot/chat-shadow.js
node --check autopilot/chat-active.js
for file in autopilot/chat/*.js; do node --check "$file"; done
node --test autopilot/tests/chat-*.test.js
```

Do not infer production enablement from passing tests. A future rollout must first run a bounded
`chat-active.js` shadow canary, then a separately approved one-shot `safe-reply` canary, and only
then consider scheduling. Contract acceptance remains disabled independently.
