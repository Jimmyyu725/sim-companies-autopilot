#!/bin/bash
# Strategic layer of the autonomous operation.
#
# run-tick.sh keeps the buildings busy every 2 minutes; that loop is deterministic and needs
# no model. This one wakes Claude a few times a day to do what a script cannot: re-rank the
# industries against live prices, decide whether to switch production or build, answer other
# players, and repair the fast loop when it makes a bad call.
#
# Shares the tick lock — one browser tab, and a strategist navigating mid-tick would corrupt
# both. Waits rather than skipping, since a missed strategic run costs more than a delayed one.
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/home/jimmy/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOG=/srv/appdata/chrome-automation/sim/strategist.log
LOCK=/srv/appdata/chrome-automation/sim/.strategist.lock

# A second lock so two strategist runs never overlap; the tick lock is taken per-command
# inside the session instead of held for the whole run, which would starve the fast loop.
exec 8>"$LOCK"
if ! flock -n 8; then
  echo "$(date "+%F %T %Z") SKIP — previous strategist run still active" >> "$LOG"
  exit 0
fi

{
  echo "════════════════════════════════════════════════════════"
  echo "$(date "+%F %T %Z") strategist waking"
} >> "$LOG"

PROMPT="Read STRATEGIST.md and DOCTRINE.md in the current directory, then carry out the run
they describe, end to end, for the Sim Companies account they govern.

You have full authority and there is nobody to ask — this is an unattended cron invocation.
Do not end by proposing options or requesting approval; make the calls and execute them.
Every CDP/browser command must be wrapped in 'flock -w 300 .tick.lock ...' because the
2-minute fast loop shares the same browser tab.

Finish by appending your dated entry to JOURNAL.md."

# A stuck fast loop is the most urgent thing there is — it means production has been failing
# the same way repeatedly and the deterministic loop can't reason out. Diagnose and fix the
# root cause (config value, page script, a genuinely-needed input buy), then delete the flag.
if [ -f fastloop-stuck.flag ]; then
  PROMPT="URGENT: fastloop-stuck.flag exists — the fast loop is repeating a failure it cannot resolve on its own ($(cat fastloop-stuck.flag)). Read bot.log's recent PLAN/FARM/STORE/produce lines, find the ROOT CAUSE (is an input genuinely missing and worth buying? is a page selector broken? is a config number wrong?), FIX it (buy the input under flock, correct config.json, or repair the page script), verify the fix on a live 'flock -w 300 .tick.lock node tick.js' run, then delete fastloop-stuck.flag. Apply the skeptic rule: verify the actual failure before assuming its cause. Do this BEFORE the normal run. $PROMPT"
fi

# A finished good piling up is frozen cash, and the fast loop is deliberately not allowed to
# sell (retail beats the exchange per unit, so dumping is a real cost, not a free release).
if [ -f surplus-alert.flag ]; then
  PROMPT="SURPLUS: surplus-alert.flag exists — a finished good has piled past its limit ($(cat surplus-alert.flag | tr '\n' '; ')). The store runs ONE sales order at a time, so production above its share of that queue turns into inventory. Decide per STRATEGIST.md 6a: is the store simply behind (leave it, retail pays more per unit) or is the pile structural (sell the excess on the exchange with 'node sell-exchange-ui.js <imgname> <qty> <price>' — dry-run without --submit first, and read the dialog's own printed profit line before committing). $PROMPT"
fi

# A free construction slot with nothing armed is idle capacity the fast loop may not fill on
# its own — choosing the building is a live-price ranking, i.e. the strategist's job.
if [ -f slot-alert.flag ]; then
  PROMPT="SLOT: slot-alert.flag exists — $(cat slot-alert.flag | tr '\n' '; '). Rank the affordable buildings against a FRESH capture (node industry-report.js defs.json <capture>.json), cost the working capital as well as the sticker (DOCTRINE Rule 3b), respect the owner's no-Catering/no-Restaurant constraint, then either arm config.buildPlan (next/maxCost/effectiveCost/minCashToBuild/minCashAfter, with a dated _armed note) or write down why the slot is deliberately staying empty. $PROMPT"
fi

# An unread-chat flag makes the wait worthwhile even if a strategist run just finished.
if [ -f chat-pending.flag ]; then
  PROMPT="PRIORITY: chat-pending.flag exists — unread in-game messages are waiting. Handle chat first (STRATEGIST.md step 5), then the normal run. $PROMPT"
fi

timeout 2700 /home/jimmy/.local/bin/claude -p "$PROMPT" --model claude-opus-4-8 --effort max \
  --permission-mode bypassPermissions \
  --add-dir /srv/appdata/chrome-automation/sim \
  >> "$LOG" 2>&1

rc=$?
# The flag is consumed by this run (chat was step one); clearing it here also stops the
# heartbeat from re-spawning us if the model forgot to delete it.
rm -f chat-pending.flag price-alert.flag finance-pending.flag fastloop-stuck.flag surplus-alert.flag slot-alert.flag
echo "$(date "+%F %T %Z") strategist finished rc=$rc" >> "$LOG"

# Keep the log bounded — this runs for weeks unattended.
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 10485760 ]; then
  mv "$LOG" "$LOG.1"
fi
exit 0
