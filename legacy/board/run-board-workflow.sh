#!/bin/bash
# Board meeting via the Workflow tool — replaces run-board.sh's sequential `timeout 900
# claude -p` calls, which deadlocked when a max-effort Round-2 brief ran past 900s and the
# retry loop kept re-issuing a call that could never finish in time (2026-07-23 9pm).
#
# Owner directive 2026-07-23: "do not timeout-kill the board; run meetings as an ultracode
# workflow." Workflow agents run to completion and retry only on genuine errors. The single
# `timeout` below is NOT a per-agent killer — it is a 2h runaway backstop so a truly hung
# meeting cannot hold .board.lock forever and deadlock every future meeting.
#
# This shell keeps only the deterministic plumbing (lock, live-data refresh, meeting memory,
# minutes assembly, desktop push). The deliberation itself is board/board-workflow.js.
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/home/jimmy/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
LOG=board.log
WD="$(pwd)"

exec 6>.board.lock
flock -n 6 || { echo "$(date '+%F %T %Z') board(wf): another session active" >> "$LOG"; exit 0; }
echo "════════ $(date '+%F %T %Z') BOARD MEETING (workflow) ════════" >> "$LOG"

# Refresh shared data (one browser session for the whole board).
flock -w 300 .tick.lock node board-data.js >> "$LOG" 2>&1
LEVEL=$(node -e 'console.log(require("./board-data.json").level)' 2>/dev/null || echo 0)
CAPS=$(node -e 'const c=require("./board-data.json").capabilities; console.log((c.research?"research ":"")+(c.executives?"executives":""))' 2>/dev/null || echo "")
ROLES="CFO COO CMO"
[[ "$CAPS" == *research* ]] && ROLES="$ROLES CTO"
[[ "$CAPS" == *executives* ]] && ROLES="$ROLES HR"
echo "$(date '+%F %T %Z') board(wf): level $LEVEL, active roles: $ROLES" >> "$LOG"

# Meeting memory: the last board-meeting section of JOURNAL + any tabled agenda files, written
# to a file the agents read (so nothing huge rides in the prompt). Same extraction as before:
# locate the LAST board-meeting heading and take it to EOF, capped at 100 lines.
LASTBM=$(grep -n '^#.*BOARD MEETING\|^#.*董事会' JOURNAL.md 2>/dev/null | tail -1 | cut -d: -f1)
[ -z "$LASTBM" ] && LASTBM=$(grep -n 'BOARD MEETING\|董事会' JOURNAL.md 2>/dev/null | tail -1 | cut -d: -f1)
if [ -n "$LASTBM" ]; then PRIOR="$(sed -n "${LASTBM},\$p" JOURNAL.md | head -100)"; else PRIOR="(No prior board meeting on record — this is the first.)"; fi
{
  echo "PRIOR BOARD MEETING (do NOT re-propose what was already killed; DO follow up on deferred agenda seeds):"
  echo "$PRIOR"
  echo "--- end prior meeting ---"
  AGENDA_FILES=$(ls board-agenda-*.md 2>/dev/null | grep -v special || true)
  if [ -n "$AGENDA_FILES" ]; then
    echo ""
    echo "TABLED AGENDA ITEMS for THIS meeting (address each in your round):"
    cat $AGENDA_FILES
    echo "--- end tabled agenda ---"
  fi
} > board/.meeting-memo.md

# Clear prior round scratch so a role that fails to file leaves an ABSENT file the CEO detects.
rm -f board/.r1-*.md board/.r2-*.md board/.r3-ceo.md

STAMP="$(date '+%Y-%m-%d-%H%M')"
ROLES_JSON=$(node -e "console.log(JSON.stringify(process.argv[1].trim().split(/\s+/)))" "$ROLES")

# Invoke the workflow through a headless claude (verified 2026-07-23 that headless `claude -p`
# can call the Workflow tool). NO killing per agent; the 7200s outer bound is runaway-only.
WF_PROMPT="Use the Workflow tool to convene the apple.co board meeting. Call Workflow with:
  scriptPath: '${WD}/board/board-workflow.js'
  args: {\"wd\": \"${WD}\", \"roles\": ${ROLES_JSON}, \"stamp\": \"${STAMP}\"}
The workflow runs THREE rounds (Round 1 proposals, Round 2 cross-examination, Round 3 CEO ratifies+executes) and takes 20-40 MINUTES. Its agents write board/.r1-*.md, board/.r2-*.md and board/.r3-ceo.md, and the CEO executes approved actions under flock and appends to JOURNAL.md.

CRITICAL: You MUST WAIT for the ENTIRE workflow to finish. Do NOT reply 'it is running in the background', do NOT report the task ID and stop, do NOT end your turn until the Workflow tool call RETURNS the workflow's final result object (with round1/round2/ceo). Waiting the full 20-40 minutes is REQUIRED — the workflow's later rounds do not run if you return early. Do not do the board's work yourself. Only once it has fully returned, reply with the CEO's executive summary. If the Workflow tool reports an error, report it verbatim."

CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 timeout 7200 claude -p "$WF_PROMPT" --model claude-opus-4-8 --permission-mode bypassPermissions --add-dir "$WD" >> "$LOG" 2>&1
echo "$(date '+%F %T %Z') board(wf): workflow returned rc=$?" >> "$LOG"

# COMPLETION GUARD: the CEO agent writes board/.r3-ceo.md as its ruling. If it is missing, the
# workflow did NOT finish Round 3 (the failure mode of 2026-07-24 09:00: only Round 1 ran). Do NOT
# archive tabled agendas in that case — they must stay tabled for a real meeting — and mark the
# minutes INCOMPLETE so it is never mistaken for a real decision.
if [ ! -s board/.r3-ceo.md ]; then
  echo "$(date '+%F %T %Z') board(wf): INCOMPLETE — no board/.r3-ceo.md (CEO round did not run); agendas kept tabled" >> "$LOG"
  BOARD_INCOMPLETE=1
fi

# ---- Assemble minutes from the round files the agents wrote -------------------
mkdir -p minutes
MIN="minutes/board-minutes-$STAMP.md"
{
  echo "# apple.co Corp 董事会会议纪要"
  echo "## $(date '+%Y-%m-%d %H:%M %Z')（Workflow 多 agent · 三轮并行协商制）"
  echo ""
  echo "- 参会：$ROLES  ｜ Lv.$LEVEL"
  echo "- 模型：Claude Opus 4.8 · Workflow 并行 · 无 timeout kill"
  echo ""
  echo "---"; echo ""; echo "# 第一轮：提案"; echo ""
  for r in $ROLES; do
    echo "## $r"; echo ""
    if [ -f "board/.r1-$r.md" ]; then cat "board/.r1-$r.md"; else echo "_[未提交 — 该角色本轮未产出简报]_"; fi
    echo ""
  done
  echo "---"; echo ""; echo "# 第二轮：相互质询"; echo ""
  for r in $ROLES; do
    echo "## $r"; echo ""
    if [ -f "board/.r2-$r.md" ]; then cat "board/.r2-$r.md"; else echo "_[未提交]_"; fi
    echo ""
  done
  echo "---"; echo ""; echo "# 第三轮：CEO 裁决与执行"; echo ""
  if [ -f "board/.r3-ceo.md" ]; then cat "board/.r3-ceo.md"; else echo "_[CEO 未产出裁决 — 见 board.log]_"; fi
} > "$MIN"
echo "$(date '+%F %T %Z') board(wf): minutes written to $MIN ($(wc -c < "$MIN")B)" >> "$LOG"

# Push to the Windows desktop (best-effort; SSH/network failure must not fail the meeting).
WIN_KEY="$HOME/.ssh/win_key"
if [ -f "$WIN_KEY" ]; then
  scp -i "$WIN_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$MIN" \
    "y3264@192.168.1.16:C:/Users/y3264/Desktop/董事会纪要-$STAMP.md" >>"$LOG" 2>&1 \
    && echo "$(date '+%F %T %Z') board(wf): minutes pushed to Windows desktop" >> "$LOG" \
    || echo "$(date '+%F %T %Z') board(wf): desktop push failed (kept local copy at $MIN)" >> "$LOG"
fi

# Keep the last 30 minutes files.
ls -1t minutes/board-minutes-*.md 2>/dev/null | tail -n +31 | xargs -r rm -f
[ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 5242880 ] && mv "$LOG" "$LOG.1"
exit 0
