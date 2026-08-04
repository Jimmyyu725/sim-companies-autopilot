# Wake visualizer — design

A web page that shows what the autopilot is doing, live, while a wake runs.

## Why

Two reasons, both the owner's:

1. **Intervene.** A wake runs 10–25 minutes. If it is about to do something wrong — spend badly,
   sell the wrong thing — he wants to see it in time to act.
2. **Watch.** Seeing it reason, act and earn is worth building for on its own.

Both need live updates. Neither needs the page to control anything: when he wants to intervene he
acts in the game or the terminal himself.

## What it shows

All seven categories the runtime already emits: wake reason, company state, warehouse, strategy
council, tool calls with results, reasoning, and guard blocks.

Layout is a dashboard sized by importance, not a scrolling log:

```
┌─────────────────────────────────────────────────────────┐
│ wake 20:43 · running 4m12s · deepseek-v4-flash          │
│ "Grocery ground sale completes 01:41:25Z"               │
├──────────────────────────────┬──────────────────────────┤
│ THINKING                     │ $11,262                  │
│                              │   −$1,078 this wake      │
│ latest reasoning, full text  ├──────────────────────────┤
│                              │ council · CFO✓ COO⋯      │
│ previous reasoning, dimmed   │ step 14/40 · $0.041      │
│                              │ pa_reply✓ build⚠         │
│                              │ blocked: building busy   │
│                              │ beans 6,628 water 12,162 │
└──────────────────────────────┴──────────────────────────┘
```

The warehouse line shows **levels, not per-wake deltas**. `brain.log` elides long tool results —
6,504 of them carry `[N chars omitted]` — so a `refresh_state` body is not valid JSON and stock
cannot be recovered from the log at all. Levels come from `autopilot/.state.json`, which the runtime
rewrites at the open and close of every wake; mid-wake that is the opening position, and it is
labelled as a level so it does not read as a change it cannot prove.

Reasoning gets the space because it is the only part worth reading word by word. Everything else is
a status line. The dimmed previous reasoning line is the one concession to narrative — cheap, and it
stops each new thought from arriving without context.

### The idle view is not optional

Wakes last 10–25 minutes and land 30–90 minutes apart, so **most of the time nothing is running**.
A page that only handles the live case looks broken whenever it is opened. Idle shows the next
alarm with a countdown, its stated reason, and the previous wake's outcome — exit code, action
count, council count, cost, and the closing decision brief.

The page switches itself when a new wake begins. No reload.

## Architecture

```
browser  ──EventSource──►  Caddy  /wake/*   (LAN + Tailscale source IPs only)
                             │
                             └── reverse_proxy 127.0.0.1:8091
                                        │
                                  wake-server.js          (systemd, host)
                                        │ follows
                                  autopilot/brain.log
                                  autopilot/next-wake.json
```

A small Node service on 127.0.0.1:8091 follows the log, parses it, and pushes state to the browser
over Server-Sent Events. Caddy reverse-proxies `/wake/*` to it.

Verified before choosing this shape:

- Caddy runs with `network_mode: host`, so `127.0.0.1:8091` inside the container is the host. A live
  probe from inside the container reached an existing host service and got real content back.
- Port 8091 is free.
- **Reverse proxying needs no bind mount.** The Caddy container mounts only `./site` and cannot see
  `/srv/appdata/chrome-automation/sim` at all, which is what ruled out having Caddy serve the log
  file directly.

### Why a service rather than static files

The first draft had Caddy serve `brain.log` directly with HTTP Range requests and no new process.
Two premises under it turned out to be false: Caddy cannot see the sim directory without a new bind
mount and a container restart, and the "no background process" instruction was about the price
collectors — which hold the browser lock and spend rate-limited game API budget — not about a
service that reads a local file.

This service is a different animal from those collectors: it makes no game API calls, never takes
`.tick.lock`, and writes nothing. When nobody has the page open it does nothing at all.

It also removes real client-side complexity. Range fetching would have made the browser handle byte
offsets, partial first lines, 416 responses and truncation. Parsing server-side deletes all of that.

### Why the runtime is not touched

Five runtime bugs were found and fixed on 2026-08-03, and the engine has only just strung together
four consecutive clean wakes. An observer must not be able to break the thing it observes. The
service only reads files; `brain.js` does not know anyone is watching.

The cost is honest: the service owns a copy of the log format. If that format changes the page
degrades; the autopilot does not.

### Access

Caddy restricts `/wake/*` to LAN and Tailscale source ranges — `192.168.1.0/24` and
`100.64.0.0/10`. The reasoning and the full game position are readable inside that boundary. There
are no credentials in the log by design, but this does not go on the public site.

### Editing the Caddyfile without a restart

`./Caddyfile` is a **single-file** bind mount. Any tool that writes atomically replaces the inode,
and the container keeps serving the old file — `caddy validate` and `caddy reload` will both report
success against content Caddy is not using. This already cost time once on this box.

Edit it in place instead: open `r+`, rewrite, truncate. The inode survives, and `caddy reload`
picks the change up with no restart and no downtime for the other sites.

## Components

| File | Responsibility |
|---|---|
| `web/wake/parse.js` | Pure. Log text in, panel state out. No I/O. |
| `web/wake/server.js` | Follows the two files, calls the parser, serves `index.html` and an SSE stream. |
| `web/wake/index.html` | Subscribes to SSE and renders the panels. No parsing. |
| `deploy/wake-visualizer.service` | systemd unit, `Restart=on-failure`. |
| `autopilot/tests/wake-parse.test.js` | Parser tests against real captured excerpts. |

The parser is separate from the server so it can be tested without sockets, and so a format change
has exactly one place to fix.

### What the parser recognises

| Shape | Meaning |
|---|---|
| `════════ <date> <time> CDT BRAIN WAKE ════════` | wake boundary |
| `<iso> TOOL <name> {json}` | action |
| `   -> {json}` | its result; `"guard":true` marks a block |
| `<iso> THINK: …` | reasoning |
| `<iso> DEEPSEEK_NEXT_TOOL_FORCED <tool>` | forced next step |
| `<iso> MODEL_REQUEST_RETRY …` | provider retry |
| `USAGE wake=… calls=N tokens=N cost=$X` | cost |
| `BRAIN done rc=N` | finished |

## Error handling

| Case | Behaviour |
|---|---|
| Log grows while a browser is connected | Push only the delta. The service holds parsed state; it does not re-read the file. |
| Log truncated or rotated | `run-brain.sh` renames `brain.log` to `brain.log.1` at the end of any wake where it exceeds 5 MB, so this is routine, not exceptional. Size shrank below the read offset: reset and re-read the tail. A read that lands across the rename returns fewer bytes than requested, so decode only what was actually read — a pre-allocated buffer would otherwise turn unwritten zero bytes into text and flicker the state to idle for one poll. |
| No browser connected | Do no work. State is rebuilt from the tail on the first connection. |
| Browser loses the connection | `EventSource` reconnects on its own. The page keeps the last known state visible and shows a disconnected marker rather than blanking. |
| Unparseable line | Skip it, count it, surface the count quietly. Never blank the page over one bad line — the format is not a promised interface. |
| Wake stops emitting without `BRAIN done` | After three minutes with no new lines, show "silent for N minutes" instead of implying it is still thinking. Both failure modes seen on 2026-08-03 — a manual kill and a 40-round exhaustion — look exactly like this from the log. |
| Service dead | The page shows that it cannot reach the service. This is the one failure the page cannot hide, and it is why the unit sets `Restart=on-failure`. |

## Testing

`parse.js` is a pure function, so the tests need no browser and no sockets. Fixtures are real
excerpts, each one a failure that actually happened:

| Fixture | Source | Asserts |
|---|---|---|
| Clean wake | 17:52, `rc=0` | the ordinary path |
| Exhausted 40 rounds | 17:26, `rc=1` | a failed wake renders as failed |
| Livelock | the six-council wake | repeated guard blocks stay visible |
| Provider 503 | 21:39, `rc=1` | a wake that dies after one call |
| Wake in progress | no `BRAIN done` | the running state |
| Two wakes back to back | 20:43 then 21:39 | the boundary resets state |

Manual acceptance: open the page during a real wake and watch the panels move. The parser tests
cannot prove the service is attached to a live log; only watching it can.

## Not doing

- **No controls.** No kill switch, no pause. A stop button is a plausible second step, deliberately
  deferred until there is experience of watching wakes.
- **No per-action approval.** It would block an unattended runtime: the wake holds the browser lock,
  has a 40-round budget, and must land its next alarm before exiting. A human who walked away would
  hang the wake with the lock held, stalling the next one.
- **No runtime changes.**
- **No history drawer.** The dashboard keeps the last few actions as status lines; the full
  transcript already exists in `autopilot/diaries/`.

## Risks

- **Log format drift.** The parser reads a format nobody promised to keep stable. Mitigated by
  degrading rather than failing, and by fixtures that break loudly in tests if the shapes move.
- **One more thing that can die quietly.** A stopped cron cost 15.5 hours of autopilot downtime on
  2026-08-03 with no alarm. This service is far less consequential — nothing depends on it — but it
  gets `Restart=on-failure` and the page states plainly when it cannot reach it.
- **Most sessions are idle.** If the idle view is weak the page feels dead, because that is the
  state it will usually be found in.
