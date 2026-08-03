#!/bin/bash
# Convene the board as a genuine three-round deliberation. No executive acts alone: every
# material move (HR hire, CFO debt, CTO research, COO build/upgrade/scrap/pivot) must be
# proposed, cross-examined by the other three, and only then executed by the CEO.
#
#   Round 1  each active executive files a brief ending in explicit PROPOSALS
#   Round 2  each executive reads all four briefs and responds to every peer's proposals
#   Round 3  the CEO reads both rounds, resolves with numbers, executes survivors
#
# Locked roles (CTO<Lv10, HR<Lv15) stand down and are skipped.
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/home/jimmy/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOG=board.log
R1=board-round1-proposals.md
R2=board-round2-deliberation.md
WD="$(pwd)"

exec 6>.board.lock
flock -n 6 || { echo "$(date '+%F %T %Z') board: another session active" >> "$LOG"; exit 0; }
echo "════════ $(date '+%F %T %Z') BOARD MEETING ════════" >> "$LOG"

# Refresh shared data (one browser session for the whole board).
flock -w 300 .tick.lock node board-data.js >> "$LOG" 2>&1
LEVEL=$(node -e 'console.log(require("./board-data.json").level)' 2>/dev/null || echo 0)
CAPS=$(node -e 'const c=require("./board-data.json").capabilities; console.log((c.research?"research ":"")+(c.executives?"executives":""))' 2>/dev/null || echo "")

ROLES="CFO COO CMO"
[[ "$CAPS" == *research* ]] && ROLES="$ROLES CTO"
[[ "$CAPS" == *executives* ]] && ROLES="$ROLES HR"
echo "$(date '+%F %T %Z') board: level $LEVEL, active roles: $ROLES" >> "$LOG"

# Meeting memory: extract the last board-meeting section from the journal so executives do
# not re-litigate settled questions (the reservoir was killed last meeting; the store-upgrade
# re-hearing and ice-cream test are open agenda seeds). Without this the board is amnesiac.
# (Variable expansion is not recursive, so any $ / backticks in the journal text stay literal
# when injected into the prompt — no code-execution risk.)
# Extract from the LAST board-meeting heading to EOF (capped at 100 lines). The old
# 'tail -120 | sed' clipped the section out whenever later journal entries pushed it up —
# that fed the 21:00 2026-07-22 meeting an empty memory, and all three executives filed
# proposals unaware the Mill build was armed at $24,800.
LASTBM=$(grep -n '^#.*BOARD MEETING\|^#.*董事会' JOURNAL.md 2>/dev/null | tail -1 | cut -d: -f1)
[ -z "$LASTBM" ] && LASTBM=$(grep -n 'BOARD MEETING\|董事会' JOURNAL.md 2>/dev/null | tail -1 | cut -d: -f1)
if [ -n "$LASTBM" ]; then PRIOR="$(sed -n "${LASTBM},\$p" JOURNAL.md | head -100)"; else PRIOR=""; fi
[ -z "$PRIOR" ] && PRIOR="(No prior board meeting on record — this is the first.)"
MEMO="PRIOR BOARD MEETING (do NOT re-propose what was already killed; DO follow up on deferred agenda seeds):
$PRIOR
--- end prior meeting ---"

# Standing agenda items: any board-agenda-*.md dropped in this directory is tabled at the
# next meeting (owner or advisor submissions). Injected after the prior-meeting memory;
# the CEO archives handled agendas into minutes/ so they are tabled exactly once.
AGENDA_FILES=$(ls board-agenda-*.md 2>/dev/null | grep -v special || true)
if [ -n "$AGENDA_FILES" ]; then
  MEMO="$MEMO

TABLED AGENDA ITEMS for THIS meeting (address each in your round):
$(cat $AGENDA_FILES)
--- end tabled agenda ---"
fi

# Run an executive's Claude turn. A turn that errors out or returns almost nothing (the
# CFO's Round-2 brief came back as a 73-byte empty file on 2026-07-22 and the CEO had to
# infer it) is retried once, then — if still empty — emitted as an EXPLICIT failure marker
# so the CEO treats that role as "did not deliberate" rather than silently missing it.
# $1=role  $2=prompt  → stdout (brief, or a failure marker)
exec_claude () {
  local role="$1" prompt="$2" out
  for attempt in 1 2 3; do
    # 1800s, not 900: at --effort max a Round-1 brief already burns ~888s (right at the old
    # ceiling), and Round-2 reads the full ~54KB Round-1 file on top of that — reliably tipping
    # past 900s and returning a 15-char timeout stub that the retry loop can never satisfy
    # (2026-07-23 9pm meeting deadlocked this way: CFO R2 hit 900s three times running).
    out="$(timeout 1800 claude -p "$prompt" --model claude-opus-4-8 --effort max --permission-mode bypassPermissions --add-dir "$WD" 2>>"$LOG")"
    # Valid brief = long enough AND not a CLI error page. A safeguard block or API error
    # ("Request was blocked", "safeguards flagged", "API Error") returns >200 chars of ERROR
    # text that would otherwise masquerade as a real brief, so screen for those signatures
    # too. Kept as a general safety net even on Opus (which doesn't hit the Fable filter).
    if [ "${#out}" -ge 200 ] && ! grep -qiE "request was blocked|safeguards flagged|API Error|can't respond to this request" <<<"$out"; then
      echo "$out"; return 0
    fi
    reason=$(grep -qiE "blocked|safeguards" <<<"$out" && echo "safeguard-block" || echo "${#out}chars")
    echo "$(date '+%F %T %Z') board: $role attempt $attempt = $reason — retrying" >> "$LOG"
    sleep 8
  done
  echo "**[EXECUTION ERROR — $role did not file a brief this round. Treat as no input from $role: its Round-1 proposals are UNEXAMINED and must not be executed; other executives' proposals still stand on their own cross-examination.]**"
  echo "$(date '+%F %T %Z') board: $role FAILED after 2 attempts — emitted failure marker" >> "$LOG"
}

# ---- Round 1: proposals -------------------------------------------------------
: > "$R1"
for ROLE in $ROLES; do
  echo "$(date '+%F %T %Z') board R1: $ROLE" >> "$LOG"
  P="You are the $ROLE of apple.co Corp in Sim Companies. Read board/CHARTER.md and board/$ROLE.md in $WD, then read your data slice from board-data.json (the '$(echo $ROLE | tr A-Z a-z)' key plus 'market' and top-level level/capabilities).

$MEMO

Produce ONLY your Round 1 brief in the shape CHARTER.md specifies, ENDING in an explicit PROPOSALS list (the specific actions you want the company to take, each with the number that justifies it — or 'No proposals this round' if none). Do NOT re-propose anything the prior meeting explicitly killed unless you have NEW numbers that change the case; DO address any deferred agenda seed in your domain. Numbers over narration. Do NOT modify files or touch the game."
  { echo; echo "## ROUND 1 — $ROLE"; echo; exec_claude "$ROLE" "$P"; } >> "$R1"
done

# ---- Round 2: deliberation ----------------------------------------------------
: > "$R2"
for ROLE in $ROLES; do
  echo "$(date '+%F %T %Z') board R2: $ROLE" >> "$LOG"
  P="You are the $ROLE of apple.co Corp in Sim Companies. Read board/CHARTER.md and board/$ROLE.md in $WD. The board's Round 1 proposals are in board-round1-proposals.md — read ALL of them. Respond to every OTHER executive's proposals with support / object / amend, each backed by YOUR domain's numbers from board-data.json. Say plainly whether each peer proposal should proceed, and revise your own proposals if a peer's point is valid. This is where a hire, a debt, a research spend, or a build/upgrade/scrap/pivot either survives scrutiny or dies. Do NOT modify files or touch the game."
  { echo; echo "## ROUND 2 — $ROLE responds"; echo; exec_claude "$ROLE" "$P"; } >> "$R2"
done

# ---- Round 3: CEO ratifies and executes --------------------------------------
echo "$(date '+%F %T %Z') board R3: CEO deliberating & executing" >> "$LOG"
CEO="You are the CEO of apple.co Corp in Sim Companies, chairing the board. Read STRATEGIST.md, DOCTRINE.md, board/CHARTER.md, board-round1-proposals.md (proposals) and board-round2-deliberation.md (cross-examination) in $WD. A proposal may be executed ONLY if it survived Round 2 — you cannot approve anything the board demolished, though you may veto or defer a survivor with reason. If either file contains an '[EXECUTION ERROR — <role> did not file a brief]' marker, that role did not deliberate: none of its OWN Round-1 proposals may be executed (they went unexamined), but the other executives' proposals still stand or fall on their own cross-examination. Note the failed role in the journal. Resolve remaining conflicts with numbers. Before you APPROVE or REJECT anything, run the skeptic check from CHARTER: is the deciding number MEASURED (read from the game/API this meeting) or ASSUMED? Do not execute a spend on an ASSUMED number without first verifying it in-game; do not kill a proposal on an ASSUMED objection — verify or downgrade to "deferred pending test". End your journal entry with a VERIFICATION ledger (MEASURED / ASSUMED / UNKNOWN) for the decisions you made. Then EXECUTE the approved decisions: wrap every browser command in 'flock -w 300 .tick.lock ...', obey all DOCTRINE constraints (no scrap, no real money, no Sim Boosts, keep the Beach market, cash reserve \$500). Finish by appending a dated BOARD MEETING entry to JOURNAL.md: each executive's headline proposal, what the board approved / amended / killed and why, what you executed, and what was deferred. Clear any *-pending.flag you acted on. If tabled agenda items (board-agenda-*.md) were addressed this meeting, move each handled file into minutes/ (e.g. mv board-agenda-fastloop.md minutes/agenda-fastloop-handled-<date>.md) so it is not re-tabled next meeting."
claude -p "$CEO" --model claude-opus-4-8 --effort max --permission-mode bypassPermissions --add-dir "$WD" >> "$LOG" 2>&1
echo "$(date '+%F %T %Z') board: adjourned rc=$?" >> "$LOG"

# ---- Auto-minutes: assemble full record, archive, and push to the Windows desktop --------
mkdir -p minutes
STAMP="$(date '+%Y-%m-%d-%H%M')"
MIN="minutes/board-minutes-$STAMP.md"
{
  echo "# apple.co Corp 董事会会议纪要"
  echo "## $(date '+%Y-%m-%d %H:%M %Z')（三轮协商制）"
  echo ""
  echo "- 参会：$ROLES  ｜ Lv.$LEVEL"
  echo "- 模型：Claude Opus 4.8 · reasoning max"
  echo ""
  echo "---"
  echo ""
  echo "# 第一轮：提案"
  cat "$R1"
  echo ""
  echo "---"
  echo ""
  echo "# 第二轮：相互质询"
  cat "$R2"
  echo ""
  echo "---"
  echo ""
  echo "# 第三轮：CEO 裁决与执行"
  echo ""
  sed -n '/board R3: CEO/,/board: adjourned/p' "$LOG" | grep -v "CDT board:"
} > "$MIN"
echo "$(date '+%F %T %Z') board: minutes written to $MIN ($(wc -c < "$MIN")B)" >> "$LOG"

# Push to the Windows desktop (best-effort; a network/SSH failure must not fail the meeting).
WIN_KEY="$HOME/.ssh/win_key"
if [ -f "$WIN_KEY" ]; then
  scp -i "$WIN_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$MIN" \
    "y3264@192.168.1.16:C:/Users/y3264/Desktop/董事会纪要-$STAMP.md" >>"$LOG" 2>&1 \
    && echo "$(date '+%F %T %Z') board: minutes pushed to Windows desktop" >> "$LOG" \
    || echo "$(date '+%F %T %Z') board: desktop push failed (kept local copy at $MIN)" >> "$LOG"
fi

# Keep the last 30 minutes files; older ones age out.
ls -1t minutes/board-minutes-*.md 2>/dev/null | tail -n +31 | xargs -r rm -f

for f in "$LOG" "$R1" "$R2"; do
  [ -f "$f" ] && [ "$(stat -c%s "$f")" -gt 5242880 ] && mv "$f" "$f.1"
done
exit 0
