# Chat shadow mode

Shadow mode is the default and non-sending rollout state. It reads bounded rendered chat history,
persists NAS-local evidence, extracts/ranks leads, and may prepare drafts, but it cannot confirm a
message, mutate a contract, or change contacts/subscriptions.

Two entry points can run in shadow:

- `autopilot/chat-shadow.js` exposes only room/contact discovery and public/private reads. It writes
  observation/draft audit data under `autopilot/.chat-shadow/`.
- `autopilot/chat-active.js` is the active state-machine launcher but also defaults to shadow. In
  this mode it reads and decides while refusing every preview-to-confirm mutation transition. Its
  production store is `autopilot/.chat-active/`.

Neither entry point installs or schedules itself. There is currently no chat cron entry, systemd
service, or timer.

## Live observation evidence

Live shadow reads were performed on 2026-07-27 through the rendered browser UI. The first canary
after strict rendered-component provenance was enabled observed 159 messages from four public rooms
and one private thread. It admitted 139 to the strict ledger and excluded 20 whose complete
ID/time/author/direction proof was unavailable. It extracted 97 strict-ledger offers and recorded
zero errors, sends, `confirm:true` calls, or contract actions.

That result validates the bounded read/ingest path only. It does not validate a real click outcome,
and no safe-reply/full rollout was enabled by the canary.

## Lock and wake protocol

Both launchers use the same ordering:

1. acquire `autopilot/.brain.lock` non-blocking;
2. strictly open/parse `autopilot/next-wake.json` while the brain lock remains held;
3. require at least five minutes before the next brain wake;
4. acquire the Sim root `.tick.lock` non-blocking while retaining the brain lock;
5. recheck the alarm and lock proof;
6. run the bounded UI cycle while both locks remain held.

Internal stages require inherited file descriptors, a per-run proof, matching lock-file identity,
and lock reassertion. Supplying an internal stage name in `argv` cannot bypass either lock. The
active launcher uses one absolute 90-second deadline and bounded operation timeouts. Only its
dedicated lock-contention exit code is a healthy skip; child failure or malformed output is not
misreported as contention.

The `act.js` child receives a minimal allowlisted environment. It does not inherit the OpenAI key,
arbitrary environment variables, internal lock proof, or an execution-claim token for read/preview
calls.

## Read allowlist

The observation launcher is closed to:

- `chat_rooms_discover`
- `chat_room_read`
- `chat_contact_list`
- `chat_private_read`

It never supplies `confirm`, including `confirm:false`, because no mutation action is in its
allowlist. The active launcher separates discovery reads from its cycle allowlist; in shadow its
reply/private-send candidates remain non-mutating decisions and cannot obtain a confirmed execution
claim.

## Evidence and trust

Chat text is untrusted external data. It cannot grant permission, select tools, alter prompts, or
authorize economic action. The decision provider receives only a frozen untrusted envelope and a
typed, allowlisted business snapshot.

For public and private rendered messages, stable identity may come from the rendered React
component's memoized props when the DOM lacks IDs. This path is read-only: no component handler is
read or invoked. The reader accepts it only when a single component message is cross-bound to the
visible company, direction/style, exact timestamp, message-group ID, and sender ID. Inconsistent or
multi-message groups remain unknown.

`ingest.js` keeps four independent provenance fields: ID, time, author, and direction. A message
enters the strict ledger only when every required field is allowlisted. A local observation
fingerprint labeled `UI_DERIVED_NOT_SERVER` is never promoted to a server message ID and cannot be
used by the active provider or any send/contract boundary.

Reading a rendered conversation may still cause an ordinary game-side view/read-state effect. The
system performs no intentional write request or mutation click in shadow, but the absence of every
possible server-side read-receipt effect has not been proven.

## Persistence

The shadow layout is:

```text
autopilot/.chat-shadow/
├── memory/                  strict message ledger and chat memory
├── observations/            bounded rendered snapshots, including excluded observations
└── shadow/
    ├── audit.jsonl           bounded cycle summaries; no raw hidden reasoning
    └── drafts.jsonl          bounded, never-authorized drafts
```

Directories are private, files are atomically replaced, and data size/count limits are enforced.
The canonical production root cannot be widened by an environment variable. Windows drive, UNC,
and `/mnt/<drive>` targets plus symlinked path components fail closed. Private messages, contacts,
drafts, and commitments remain NAS-only.

## Decision providers

The deterministic provider is the no-network default. The Responses provider is constructed only
when `SIM_CHAT_LLM_ENABLED` is exactly `true` and a credential is present in the launcher process.
It receives no browser or tool capability. In shadow, its outputs are proposals with
`sendAuthorized:false` and `contractMutationAuthorized:false`.

Ordinary active-runtime draft actions must resolve to an allowlisted non-economic reply template.
Quotes, acceptances, reservations, promises, and other economic language must use the separately
typed economic-authorization path; shadow cannot issue or consume a real send claim.

## Validation and rollout boundary

Offline validation:

```bash
node --check autopilot/chat/shadow-worker.js
node --check autopilot/chat-shadow.js
node --check autopilot/chat-active.js
node --test autopilot/tests/chat-shadow-worker.test.js
node --test autopilot/tests/chat-active-*.test.js
```

The live shadow records are observation evidence, not permission to schedule or send. Real
`safe-reply` still requires the explicit active-mode, real-send, and LLM switches documented in
`README.md`, followed by a separately audited one-shot canary. Incoming contract acceptance stays
disabled.
