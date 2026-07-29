# Active chat launcher

`autopilot/chat-active.js` is the production-shaped, deliberately unscheduled launcher for the
active chat worker. Importing it has no side effects. This document describes the operator surface;
it does not authorize installing a cron job, enabling real sends, or starting a live canary.

## Modes and rollout switches

The launcher reads only `SIM_CHAT_ACTIVE_MODE`. It never treats the generic `SIM_CHAT_MODE` as an
operator rollout decision. An individual, allowlisted `act.js` child receives a minimal
`SIM_CHAT_MODE` value chosen by the launcher.

```bash
# Defaults to shadow if SIM_CHAT_ACTIVE_MODE is absent.
node autopilot/chat-active.js

SIM_CHAT_ACTIVE_MODE=read-only node autopilot/chat-active.js
```

`safe-reply` and `full` additionally require both literal switches below and an already configured
`OPENAI_API_KEY` in the parent process environment:

```text
SIM_CHAT_REAL_SEND_ENABLED=true
SIM_CHAT_LLM_ENABLED=true
```

The key value is never copied to the action child, state, logs, tests, or this directory. The
launcher does not read an env file. The host remains responsible for loading the existing NAS
credential convention into the launcher process without printing it.

## Locked execution path

Every cycle follows one order:

```text
root process
  -> nonblocking autopilot/.brain.lock
  -> verify next brain wake is at least five minutes away
  -> nonblocking sim/.tick.lock
  -> reverify both lock proofs and next wake
  -> validate all local durable stores
  -> bounded UI discovery and reads
  -> bounded decision, preview, durable claim, and optional one-click confirm
```

Only lock contention and the next-wake safety margin are healthy skips. Missing/corrupt wake data,
invalid lock proof, permission failure, child crash, malformed child output, browser-read failure,
or unknown internal skip is reported with `ok:false`.

The launcher bounds discovery to four public rooms and four private contacts. Its cycle allowlist
contains `chat_room_read`, `chat_private_read`, `chat_room_reply`, and `chat_private_send`.
`chat_room_post` is admitted only so shadow can perform an exact `confirm:false` proactive preview;
the launcher rejects its `confirm:true` form even in `full`. Confirmed proactive posting is not yet
exposed.

## Mutation proof chain

A confirmed source-bound inbound reply requires all of the following:

1. a strict UI observation with stable message ID, exact timestamp, sender identity, and direction;
2. a fresh business snapshot and exact same-wake destination/source binding;
3. an exact `confirm:false` preview;
4. an atomic `ARMED` record in `autopilot/.chat-active/attempts.json`;
5. a one-time random execution claim whose plaintext exists only in memory and in the one action
   child's environment;
6. atomic claim consumption by `act.js`, changing `ARMED` to `CONFIRMING` before Chrome connects;
7. one exact UI click and a source-bound UI postcondition;
8. durable proof that the attempt was `CONFIRMING` before it can become `VERIFIED`.

Wrong, missing, replayed, or action-mismatched execution claims fail before Chrome. `ARMED`,
`CONFIRMING`, `VERIFIED`, and `AMBIGUOUS` records block replay. Only a proven pre-click failure can
be retried as a distinct attempt.

Proactive room posts do not yet enter that mutation proof chain. Outside shadow the worker may
record a proposal, but it performs no preview, claim, confirmation, or send.

Ordinary replies use exact deterministic non-economic templates from `reply-templates.js`. Free
prose, prices, assurances, acceptances, and commitments cannot use the ordinary reply lane. One
catalog-bound non-economic public icon shape, `DM [resource icon] details.`, is allowed. Private
free prose degrades to `request_evidence`; economic communication must use the
typed authorization path.

Only messages newly inserted into the strict ledger reach the provider. Duplicate content in one
conversation is blocked for 24 hours, the default confirmation budget remains one per cycle/window,
and aggregate provider usage stops further decisions at 24,000 reported tokens. Completed cycles
write aggregate owner-only diaries under `autopilot/chat-diaries/`; no message bodies or private
identities are written there.

## Current deployment state and blockers

- No cron, service, timer, or main-brain integration enables this launcher.
- No real-send switch has been enabled by this work.
- Two live shadow canaries completed successfully at 04:51 and 04:52 CDT on 2026-07-27. Each used
  the rendered UI and LLM decision provider with 63 strict inbound messages, four decisions, four
  proposals, zero errors, and zero preview/confirm/send actions.
- The default business-snapshot loader is conservative and state-backed. Economic messages fail
  closed unless complete fresh inventory, market, transport, finance, and opportunity-cost evidence
  is supplied by a trusted loader.
- Any residual `ARMED`, `CONFIRMING`, or `AMBIGUOUS` attempt requires manual evidence review; it must
  never be deleted merely to force a retry.

## Offline validation

```bash
node --check autopilot/chat-active.js
node --check autopilot/act.js
for file in autopilot/chat/*.js; do node --check "$file"; done
node --test autopilot/tests/chat-*.test.js
node --test autopilot/tests/*.test.js
```

These commands do not start the launcher. A live canary remains a separate, explicit rollout
decision after review of the durable stores, complete business evidence, and current game UI.
