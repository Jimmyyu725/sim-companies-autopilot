#!/bin/bash
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/home/jimmy/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
LOG=board.log; R1=board-special-r1.md; R2=board-special-r2.md; WD="$(pwd)"
AGENDA="$(cat board-special-agenda.md)"

exec 6>.board.lock
flock -n 6 || { echo "$(date '+%F %T %Z') special board: another session active" >> "$LOG"; exit 0; }
echo "════════ $(date '+%F %T %Z') SPECIAL BOARD MEETING (owner motion: build+scrap grocery) ════════" >> "$LOG"

flock -w 300 .tick.lock node board-data.js >> "$LOG" 2>&1
ROLES="CFO COO CMO"

exec_claude () {  local role="$1" prompt="$2" out
  for a in 1 2; do
    out="$(timeout 700 claude -p "$prompt" --permission-mode bypassPermissions --add-dir "$WD" 2>>"$LOG")"
    [ "${#out}" -ge 200 ] && { echo "$out"; return 0; }
    echo "$(date '+%F %T %Z') special: $role attempt $a = ${#out} chars, retry" >> "$LOG"; sleep 5
  done
  echo "**[EXECUTION ERROR — $role did not file]**"
}

: > "$R1"
for ROLE in $ROLES; do
  echo "$(date '+%F %T %Z') special R1: $ROLE" >> "$LOG"
  P="You are the $ROLE of apple.co Corp in Sim Companies. Read board/CHARTER.md and board/$ROLE.md in $WD, then read your data slice from board-data.json. This is a SPECIAL SESSION on one owner motion — evaluate it as the central question:

$AGENDA

Produce your Round-1 brief in the CHARTER shape, focused on the motion, ENDING with a clear position: APPROVE / APPROVE-WITH-AMENDMENTS / REJECT, with the numbers your domain owns. Answer the specific questions the agenda asks of your role. Numbers over narration. Do NOT modify files or touch the game."
  { echo; echo "## R1 — $ROLE"; echo; exec_claude "$ROLE" "$P"; } >> "$R1"
done

: > "$R2"
for ROLE in $ROLES; do
  echo "$(date '+%F %T %Z') special R2: $ROLE" >> "$LOG"
  P="You are the $ROLE of apple.co Corp. Read board/$ROLE.md and board-special-r1.md (all three Round-1 positions on the owner's build+scrap-grocery motion). Respond to the OTHER two executives' positions with support/object/amend, backed by your numbers. Then give your FINAL position on the motion. Do NOT modify files or touch the game."
  { echo; echo "## R2 — $ROLE"; echo; exec_claude "$ROLE" "$P"; } >> "$R2"
done

echo "$(date '+%F %T %Z') special R3: CEO ruling" >> "$LOG"
CEO="You are the CEO of apple.co Corp, chairing a SPECIAL board session on the owner's motion: build a 2nd grocery store now to speed grape sales, then scrap it (recovering materials) to build the Mill. Read board-special-agenda.md, board-special-r1.md, board-special-r2.md, DOCTRINE.md, board/CHARTER.md. Weigh the three executives' final positions. Deliver a RULING: does the board approve, amend, or reject the motion, and WHY, in numbers — is the net present value of speeding grape cash (earlier Mill = earlier coffee line) positive after material loss, quality-0 recovery, downtime, and any saturation effect? Do NOT execute anything in the game this session — this is a decision-only session; just rule and record. Append a dated SPECIAL BOARD entry to JOURNAL.md with the verdict and the deciding numbers."
claude -p "$CEO" --permission-mode bypassPermissions --add-dir "$WD" >> "$LOG" 2>&1
echo "$(date '+%F %T %Z') special board: adjourned rc=$?" >> "$LOG"
