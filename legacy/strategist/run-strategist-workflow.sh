#!/bin/bash
# Strategist via the Workflow tool (owner directive 2026-07-24: "战略层 decision-making 用 workflow").
# Replaces run-strategist.sh's single serial claude -p. This shell does only the deterministic
# plumbing: take the strategist lock, gather browser-heavy state ONCE into scratch files, then hand
# strategist-workflow.js the assessment inputs. The assess agents read the files (no browser, safe to
# parallelise); only the decide-execute agent touches the game, under flock.
#
# The `timeout` on the workflow is a runaway backstop (a hung run must not hold .strategist.lock
# forever), NOT a per-agent killer — same policy as the board.
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/home/jimmy/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
LOG=strategist.log
WD="$(pwd)"

exec 8>.strategist.lock
if ! flock -n 8; then echo "$(date '+%F %T %Z') SKIP — previous strategist run still active" >> "$LOG"; exit 0; fi
echo "════════ $(date '+%F %T %Z') strategist(workflow) waking ════════" >> "$LOG"

# --- Gather browser-heavy state ONCE. Each step is timeout-bounded so a hung read can't stall the
#     whole run or hold .tick.lock indefinitely (the lesson from the 2026-07-23 probe lock-jam). ---
timeout 150 flock -w 300 .tick.lock node tick.js --dry > .strat-state.txt 2>>"$LOG" || echo "$(date '+%F %T %Z') strat(wf): state dry failed/timeout" >> "$LOG"
timeout 150 flock -w 300 .tick.lock node printed-rates.js --write >> "$LOG" 2>&1 || echo "$(date '+%F %T %Z') strat(wf): printed-rates failed" >> "$LOG"
timeout 150 flock -w 300 .tick.lock node accounting.js > .strat-books.txt 2>>"$LOG" || echo "$(date '+%F %T %Z') strat(wf): accounting failed" >> "$LOG"
timeout 200 flock -w 300 .tick.lock node board-data.js >> "$LOG" 2>&1 || echo "$(date '+%F %T %Z') strat(wf): board-data refresh failed" >> "$LOG"
node realizable.js >/dev/null 2>>"$LOG" || echo "$(date '+%F %T %Z') strat(wf): realizable failed" >> "$LOG"   # no browser
node -e 'const d=require("./board-data.json");const t=(d.market&&d.market.ticker)||[];require("fs").writeFileSync(".strat-ticker.json",JSON.stringify({"/api/v3/market-ticker/0/":t}))' 2>>"$LOG" || true
node industry-report.js defs.json .strat-ticker.json > .strat-rank.txt 2>>"$LOG" || echo "$(date '+%F %T %Z') strat(wf): rank failed" >> "$LOG"

# --- Collect raised flags + their bodies for the alert-triage agent ---
: > .strat-flags.txt
raised=()
for f in fastloop-stuck chat-pending price-alert surplus-alert slot-alert finance-pending; do
  if [ -f "$f.flag" ]; then raised+=("$f"); { echo "### $f.flag"; cat "$f.flag"; echo; } >> .strat-flags.txt; fi
done
FLAGS_JSON="[]"
if [ ${#raised[@]} -gt 0 ]; then FLAGS_JSON=$(printf '%s ' "${raised[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split(/\s+/))))'); fi
echo "$(date '+%F %T %Z') strategist(wf): flags=${raised[*]:-none}" >> "$LOG"

STAMP="$(date '+%Y-%m-%d-%H%M')"
rm -f board/.strat-decide-done   # completion sentinel; the decide-execute agent touches it when it finishes
WF_PROMPT="Use the Workflow tool to run the strategist. Call Workflow with:
  scriptPath: '${WD}/strategist-workflow.js'
  args: {\"wd\": \"${WD}\", \"flags\": ${FLAGS_JSON}, \"stamp\": \"${STAMP}\"}
The workflow has TWO phases (Assess: 3 parallel agents; then Decide: one agent that EXECUTES under flock, journals, and clears handled flags) and takes ~15-30 MINUTES.

CRITICAL: You MUST WAIT for the ENTIRE workflow to finish. Do NOT reply 'it is running in the background', do NOT report the task ID and stop, do NOT end your turn until the Workflow tool call RETURNS its final result. Waiting the full time is REQUIRED — the Decide phase (the whole point: it executes and answers chat) does NOT run if you return early. Do not do the strategist's work yourself. Only once it has fully returned, reply with the decision agent's executive summary. If the Workflow tool errors, report it verbatim."

# CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0: headless `claude -p` KILLS background tasks after 600s by
# default ("Background tasks still running after 600s; terminating. Set
# CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely"). A workflow takes far longer, so
# without this it dies after the FIRST phase — the 2026-07-24 bug where Decide never ran and flags
# got wiped. =0 means wait indefinitely; the outer `timeout` is the real runaway bound. See LESSONS.md
# A1 — and note the log TRUNCATES the name to CLAUDE_CODE_PRINT_BG_WAIT; the real one ends _CEILING_MS.
CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 timeout 5400 claude -p "$WF_PROMPT" --model claude-opus-4-8 --permission-mode bypassPermissions --add-dir "$WD" >> "$LOG" 2>&1
rc=$?
# FLAG GUARD: clear flags ONLY if the decide-execute phase actually completed (its sentinel exists).
# The 2026-07-24 failure: the headless claude returned after the Assess phase only, and this line
# wiped chat-pending / surplus / slot flags that were NEVER handled — chat went unanswered and a
# $10k bean pile grew unaddressed. Never silently clear an unhandled flag: if Decide did not run,
# leave the flags for the next run (which will re-attempt), and log it loudly.
if [ -f board/.strat-decide-done ]; then
  rm -f fastloop-stuck.flag chat-pending.flag price-alert.flag surplus-alert.flag slot-alert.flag finance-pending.flag
  echo "$(date '+%F %T %Z') strategist(wf) finished rc=$rc — decide completed, flags cleared" >> "$LOG"
else
  echo "$(date '+%F %T %Z') strategist(wf) INCOMPLETE rc=$rc — Decide phase did NOT run (no sentinel); flags PRESERVED for next run" >> "$LOG"
fi

[ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 10485760 ] && mv "$LOG" "$LOG.1"
exit 0
