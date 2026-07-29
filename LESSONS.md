# LESSONS — mistakes made building & operating this system, so future-me stops repeating them

This is the engineering/operations post-mortem log. DOCTRINE.md holds the GAME rules and the
skeptic rule; this file holds the TOOLING / SHELL / WORKFLOW / process mistakes. Every entry is a
real mistake that cost time or money, with the fix. Read this before touching the workflow runners,
before any `pkill`, and before "just deploying" a change. Add a row whenever you burn yourself.

---

## A. Workflow orchestration (the 2026-07-24 saga — three failed tries to run the board)

**A1 — `claude -p` kills background tasks after 600s. THE root cause.**
A workflow run from `claude -p "... use Workflow ..."` runs in the background. Headless print mode
has a **600-second background-task limit**: after 600s it prints `Background tasks still running
after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT` and KILLS the workflow. A board takes
~40 min ≫ 600s, so it died after Round 1 every time. **FIX: set
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (milliseconds; 0 = wait indefinitely) on the `claude -p`
line — the outer `timeout` is the real runaway bound.** WARNING — the FULL name matters: the first
log line TRUNCATES it to `CLAUDE_CODE_PRINT_BG_WAIT`, and I lost an entire attempt setting that
(non-existent) name to a seconds value. A later, untruncated log line gave the real name
`..._CEILING_MS=0`. **Lesson-in-a-lesson: read the full, untruncated log message; do not deploy a
value guessed from a truncated one.**

**A2 — a soft "launch and wait" prompt makes the model bail early.**
With the prompt "just launch the workflow and wait", the headless model called Workflow, got
"launched in background", and replied "it is running in the background" — ENDING its turn, which
killed the orchestrator after Round 1. A 2-phase probe proved the model CAN wait; it just needs to
be told firmly. **FIX: "You MUST WAIT for the ENTIRE workflow to finish. Do NOT reply 'running in
the background', do NOT end your turn until the Workflow tool RETURNS its final result."**

**A3 — a runner must NEVER clobber flags / assemble minutes when the executing phase did not run.**
The first workflow runners did `rm -f *.flag` and assembled minutes unconditionally. When only the
Assess/R1 phase ran, this WIPED chat-pending / surplus / slot flags that were never handled — chat
went unanswered and a $10k bean pile grew silently. **FIX: the executing agent writes a completion
SENTINEL (board/.r3-ceo.md for the CEO; board/.strat-decide-done for the strategist); the runner
clears flags / trusts the minutes ONLY if the sentinel exists, else logs INCOMPLETE and PRESERVES
the flags for the next run.** Never silently discard an unhandled signal.

**A4 — do NOT deploy several unverified changes at once ("盲上"). Change one, watch a FULL cycle.**
The worst mistake of the night: converting board AND strategist to workflows in one go without
watching a single meeting run end-to-end. Both silently only ran their first phase for hours —
board produced no decisions, strategist cleared flags without acting. **RULE: after any change to an
unattended layer, WATCH one complete cycle (all rounds / the JOURNAL write / the flag clear) before
trusting it or enabling more. A workflow that returns rc=0 is NOT proof it finished — check the
sentinel/output, not the exit code.** Keep the previous working version (bash runners) as an instant
rollback.

---

## B. Shell / process hazards

**B1 — `pkill -f "pattern"` matches THIS command's own line and kills the shell (exit 144).**
Burned 3× in one night: `pkill -f "run-board.sh"` / `pkill -f "board/.r3-ceo.md"` matched the very
command running them, killing my own shell mid-script. **FIX: kill by exact PID (`kill 12345`), or
use the `[p]attern` self-exclusion trick, or `pgrep`+filter out `$$`. Never `pkill -f` a string that
appears in the command you are typing.**

**B2 — a background, flock-wrapped BROWSER probe that hangs holds `.tick.lock` and idles the farm.**
An ad-hoc `flock -w 300 .tick.lock node <cdp-probe>.js` launched in the background hung inside
`cdp.capture` for 26 min, holding the shared browser lock → the fast loop SKIPped every tick → the
farm sat idle after finishing its order (~$60 of lost production). **FIX: (a) don't run ad-hoc CDP
probes while the board/strategist are active; (b) always bound a browser read with `timeout N flock
-w M ...`; (c) direct in-page `fetch()` of some endpoints 403s under Cloudflare — use `cdp.capture`
+ read the captured response (like board-data.js), not a raw fetch.** Same reason `run-strategist*.sh`
timeout-bounds every gather step.

**B4 — editing a docker single-FILE bind-mount replaces the inode; the container keeps the OLD
content until you restart it.** Edited `/srv/appdata/caddy/Caddyfile` (bind-mounted to the caddy
container's `/etc/caddy/Caddyfile`); the host file was correct but `caddy reload` + in-container grep
still showed the OLD file — because atomic-write tools (the Edit tool) replace the file's inode, and
a single-file bind mount is pinned to the original inode. `caddy validate/reload` "succeeded" on the
stale content. **FIX: `docker restart <container>` re-binds to the current inode; then reload.** (Or
mount the DIRECTORY, not the file, so edits are always visible.) Verify a proxy edit landed by
grepping the file *inside* the container, not just on the host.

**B3 — orphaned monitor loops poll forever for a marker that will never appear.**
A `until grep -q "adjourned"` monitor kept running because the WORKFLOW runner logs "workflow
returned", not "adjourned" (that was the OLD bash runner's word). **FIX: monitor for the marker the
CURRENT runner actually writes; give every poll a bounded iteration count.**

**B9 — `pgrep -f` in a monitor can match the monitor shell's own command line.**
On 2026-07-26, a wait loop searched for the literal full command of `run-brain.sh|brain56.js`; that
pattern was also present in the waiting shell's own arguments, so the loop could never end even
after the brain finished. It was stopped manually and did not touch the game. **FIX: monitor by
exact process name with `ps -C <name> -o pid=` or an exact PID, always add a bounded deadline, and
verify completion from the actual output file rather than process absence alone.**

**B5 — a multi-step browser sequence split across SEPARATE `flock` commands loses the tab in the gap.**
Ran `flock -w 300 .tick.lock node cdp.js goto /messages/` then, as a *second* command,
`flock ... node cdp.js js pages/pa-reply.js`. Each flock releases the lock on process exit, and in
the ~1s gap the 2-min fast loop grabbed the lock and navigated the shared tab to a `/b/<id>/`
building page — so the reply ran with no PA anchors on screen and returned `before:[]` (2026-07-24,
cost two failed PA-reply attempts). **FIX: chain the WHOLE navigate→act sequence under ONE flock:
`flock -w 300 .tick.lock sh -c 'node cdp.js goto <url> && node cdp.js js <action>.js'` — the tab
cannot move between navigate and act.** Secondary: `pages/pa-reply.js` blindly re-clicks the sidebar
PA link and reads anchors after only 3s, which races the React remount even inside one lock;
`strat-pa-reply-robust.js` clicks the already-rendered `a.pa-reply` directly (re-opens the convo only
if anchors are absent, 5s wait) and is the more reliable clicker. Same root cause as B2: bound the
browser work, and here also keep a navigate+act pair atomic under a single lock.

**B6 — two browser cron jobs must not fire on the SAME minute, or the faster one starves the slower.**
Added the price-tracker collector at `* * * * *` (every minute). It grabs `.tick.lock` at :00 and
holds ~15s; the fast loop fires at :01 of every EVEN minute — INSIDE that hold — so `flock -n`
failed every even tick and the fast loop chronically SKIPped, starving the farm's keep-alive
(2026-07-24: farm looked "idle for a while"). **FIX: offset the schedules so they never share a
minute — collector to ODD minutes (`1-59/2`), fast loop stays on EVEN (`*/2`).** Whenever you add a
new browser-touching cron, check its minutes against every existing one; the shared `.tick.lock`
makes "every minute" a hidden tax on the loop that keeps production alive.

**B8 — `/api/v3/market/0/<kind>/` is rate-limited: ~10-request bucket, ~1-min refill, and 429s
punish you.** Measured 2026-07-25 while building the volume collector: after 2 min of quiet,
exactly 10 sequential requests return 200 and the 11th 429s (no Retry-After); ~1 min after a 429
storm only ~1 request succeeds, so hammering into 429s resets/penalizes the refill. A burst of all
142 kinds (the volume design's original plan) died after ~14. **FIX: budget ~10 order-book GETs per
~2 min, pace them ~500 ms apart, and STOP the run at the first 429 instead of retrying.**
`volume.js` sweeps all kinds with a persisted rotating cursor. board-data.js's 7-book loop fits the
budget, but don't add more per-kind book fetches to any burst without checking this bucket.

**B7 — cron-line editing: ALWAYS include the `cd`, and NEVER put `&` in a sed replacement.**
Two recurring self-inflicted edits: (a) I appended a collector cron line WITHOUT `cd
/srv/appdata/chrome-automation/sim &&` FOUR times in a row — so `flock .tick.lock` and the relative
`node price-tracker/...` path resolved in `$HOME`, not the app dir (the lock wouldn't even coordinate
with the fast loop). (b) A `sed 's#…#cd … && timeout#'` mangled the line because unescaped `&` in a
sed REPLACEMENT means "the whole matched text". **FIX: build the crontab in a file with `printf` and
a `CD="cd <dir> &&"` VARIABLE spliced into the line (so the cd cannot be forgotten), and never rely
on `sed` with `&` for cron; verify the final line with `grep`. Match the working lines' pattern
(execute-plan already had `cd … &&`).**

---

## C. Decision / metric mistakes (cross-ref DOCTRINE Rule 4d, CMO.md)

**C1 — paper `$/h = margin × rate` is a MIRAGE.** It ranked flight computers top while the realm
buys ~0.057/h. Fixed in code: `realizable.js` + DOCTRINE Rule 4d. Rank by `realizablePerHour`, never
paper.

**C2 — `resources[k].consumption` is UNRELIABLE for B2B demand.** Crude oil and dough read
consumption=0 / unitsSoldAnHour=0 EXACTLY like dead aerospace parts, yet the first two sell deeply.
Nearly shipped a fix that would have killed crude/dough. **FIX: derive B2B demand from the RECIPE
GRAPH (realizable.js), not the consumption field.** A single field that "obviously" measures demand
did not.

**C3 — verify the SYMPTOM is real before fixing it (grapes vs beans).** Spent a whole workflow
"fixing" a grape surplus that was ALREADY draining (fruitBufferHours cap). The real frozen pile was
BEANS ($10k, unwatched) — and the proposed grape→bean diversion would have grown it faster. An
adversarial verifier caught the wrong premise. **RULE: confirm the measured symptom still exists and
points where you think, before writing the fix. Prefer an adversarial second agent for anything that
touches money.**

---

## How to use this
- Before editing a workflow runner: re-read section A.
- Before any `pkill` or background browser command: re-read section B.
- Before ranking industries or "fixing" a surplus: re-read section C + DOCTRINE Rule 4d.
- When a new mistake costs time or money: add a row here the same session, with the fix.
