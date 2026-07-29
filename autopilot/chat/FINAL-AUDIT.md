# Chat rollout audit snapshot — 2026-07-27

## Verdict

The chat subsystem is safe in its current default `shadow` state and now has an implemented,
fail-closed active reply path. Live rendered-UI reading has been demonstrated. Real public/private
reply behavior has **not** been canaried, deployed, or scheduled, so this document is not evidence
that `safe-reply` is running.

Incoming contract acceptance remains intentionally disabled. The current active launcher also does
not provide complete human UI parity or autonomous proactive solicitation merely by selecting
`full`.

## Evidence reviewed

The audit scope includes:

- public/private rendered readers and public reply/private send UI fragments;
- provenance ingestion and strict-ledger admission;
- `chat-shadow.js`, `chat-active.js`, and their workers;
- mode, lock, alarm, deadline, minimal-environment, and action allowlists;
- `ActiveChatStore`, execution claims, private outbox, and public history;
- deterministic reply templates and typed economic communication authorization;
- runtime action contracts and the `act.js` pre-CDP boundary;
- offline chat tests and the recorded live shadow canary.

No real message or contract mutation was performed for this audit. No scheduler, cron entry, unit,
timer, or persistent process was installed.

## Live shadow result

The first live canary with strict rendered-component provenance observed 159 messages across four
public rooms and one private thread:

| Result | Count |
|---|---:|
| Strict-ledger messages | 139 |
| Observation-only exclusions | 20 |
| Strict-ledger offers extracted | 97 |
| Errors | 0 |
| `confirm:true` calls | 0 |
| Message sends | 0 |
| Contract actions | 0 |

The canary records are under `autopilot/.chat-shadow/`. They prove the browser reader, persistence,
and provenance split against the live page. They do not prove any real send postcondition.

## Verified default/shadow invariants

- `SIM_CHAT_ACTIVE_MODE` defaults to `shadow`; confirmed mutations remain disabled without both
  `SIM_CHAT_REAL_SEND_ENABLED=true` and `SIM_CHAT_LLM_ENABLED=true` in an active send mode.
- The shadow launcher exposes only rendered room/contact discovery and public/private read actions.
- Both launchers acquire `.brain.lock` before `.tick.lock`, require inherited lock proof, strictly
  parse the next-wake file, and stay at least five minutes ahead of the brain wake.
- The active launcher has one 90-second absolute deadline. Only its dedicated `flock` contention
  exit is a healthy skip; process failure and malformed child output fail visibly.
- `act.js` children receive a minimal environment. Reads/previews receive no execution token; no
  child receives the API key or parent lock proof.
- Live React component props are read only as rendered identity evidence. Accepted IDs/times are
  cross-checked against visible sender, direction/style, time, message count, and group identity.
- ID, time, author, and direction have independent provenance allowlists. Unknown or local
  `UI_DERIVED_NOT_SERVER` identities stay observation-only and cannot reach active decisions.
- Inbound player text is frozen as untrusted data and carries no instruction or authorization
  power. Identity and public length/format policies are rechecked deterministically.
- Shadow stores are NAS-local, owner-only, bounded, atomically written, and reject Windows/UNC
  paths, path escape, and symlink components.

## Implemented active-send invariants

These invariants are covered by code and deterministic tests but have not yet been proven by a real
send canary:

- The launcher allowlists only public/private reads plus `chat_room_reply` and
  `chat_private_send`; a mode string cannot expose arbitrary `act.js` actions.
- Every reply is bound to an exact source message ID, creation time, author company ID/name, body,
  and destination route/pane. The source is re-read immediately before the UI action.
- An exact `confirm:false` preview must match the planned source/destination/content before any
  attempt is armed.
- `ActiveChatStore` atomically writes the complete action-parameter binding as `ARMED` and returns a
  one-use execution-claim token. The confirmed child is the only child that receives that token.
- `act.js` atomically consumes the token and moves the attempt to `CONFIRMING` before
  `cdp.connect()`. Missing, changed, reused, or unreadable claims fail before Chrome.
- `VERIFIED` requires the UI's exact postcondition plus durable proof that the execution claim was
  consumed. An `ARMED` record cannot be promoted directly to `VERIFIED`.
- Ambiguous, armed, confirming, and verified outcomes block replay. Private replies also arm the
  NAS private outbox before the click, replacing the former browser-only replay boundary.
- One public attempt's `ARMED` and terminal rows are folded before duplicate/rate accounting.
  Proven pre-click failures are retryable; unknown outcomes remain replay-blocking.
- Only newly inserted strict-ledger messages are decided. A separate atomic 24-hour
  same-content/same-conversation guard prevents a second source message from causing duplicate
  output, while the global confirmation budget remains one by default.
- Public replies reserve the native mention prefix before applying a room-learned 18-30 character
  body target. The learned profile contains aggregate features only and no player wording.
- Resource parts are bound to the local verified catalog, including definitions-derived names for
  resources missing from the price-name file. The UI still must select and verify one native icon.
- Aggregate provider usage is bounded and written with action/decision counts to a separate private
  chat diary that contains no message bodies or company identities.
- Ordinary reply prose is restricted to deterministic non-economic templates. Trade acceptance,
  quotes, reservations, promises, and agreements require a typed economic authorization built
  from fresh evidence.
- Economic artifacts are durable, integrity-bound, expiring, single-use, and bind the exact
  attempt, counterparty, source, destination, terms, content, evidence snapshot, and required
  postcondition.

## Remaining rollout blockers and limitations

### P1 — before scheduling real replies

1. **Run a one-shot real reply canary.** The final live UI click and postcondition have only offline
   fixtures/tests. Use one non-economic, exact-source reply with both locks and enough wake lead;
   audit the durable claim, UI result, rate history, and no-replay result before adding a schedule.
2. **Keep rollout bounded.** Start with `safe-reply`, one confirm per cycle/rate window, and no
   proactive message. `full` should not be scheduled until its intended additional capabilities
   have their own launcher allowlists and live evidence.
3. **Add operational scheduling only after the canary.** No chat cron/service/timer currently
   exists. Any future schedule must preserve brain-then-tick lock order and avoid main-brain wake
   collisions.

### P1 — intentionally disabled capabilities

1. **Incoming contract acceptance:** rendered rows still lack the stable exact contract identity
   and unambiguous postcondition needed to authorize a click. It remains zero-click disabled.
2. **Proactive solicitation and public posting:** the active launcher's cycle allowlist currently
   reads and replies; selecting `full` does not automatically add human-parity public posting,
   contact/subscription mutation, or cold outreach.
3. **Public economic replies:** the currently enabled public reply lane permits only deterministic
   non-economic templates, including `DM [resource icon] details.`. Quotes, offers, and public
   `BUY/SELL` advertisements remain disabled until a public economic authorization path is wired
   and audited end to end.
4. **Contract closing:** typed economic private chat can authorize a reply, but chat does not bypass the
   separate warehouse contract gate or create a second contract execution path.

### P2 — evidence coverage

1. Multi-message React component groups are intentionally excluded from strict component-ID
   binding until their body-to-DOM index mapping is measured. This conservative rule accounted for
   observation-only exclusions in the live canary.
2. Opening a conversation may produce an ordinary game-side viewed/read state. Shadow performs no
   intentional mutation click or direct write request, but complete absence of server-side view
   effects has not been proven.
3. The first real reply canary must also verify actual public/private rate-history accounting and
   recovery behavior after an intentionally pre-click refusal; do not create an ambiguous click for
   testing.

## Deployment state observed

- Live shadow observation data exists under `autopilot/.chat-shadow/`.
- No new-chat message has been sent by this runtime.
- `autopilot/chat-active.js` exists and defaults to shadow.
- No chat-active or chat-shadow cron entry, systemd service, or timer is installed.
- `safe-reply` and `full` are not deployed or scheduled.
- Incoming contract acceptance is disabled independently of mode.

## Reproducible offline validation

Run after the code is frozen for a rollout candidate:

```bash
for file in autopilot/chat/*.js autopilot/chat-shadow.js autopilot/chat-active.js \
  autopilot/act.js autopilot/action-contracts.js; do
  node --check "$file"
done
node --test autopilot/tests/chat-*.test.js
node --test autopilot/tests/*.test.js
```

Record the exact counts from that frozen run rather than copying historical counts into this file.
Passing offline tests does not enable a runtime mode or authorize deployment.
