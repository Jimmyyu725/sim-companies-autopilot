#!/bin/bash
# Cron entry point for the Sim Companies autopilot.
#
# flock is not optional: every tick drives the same shared Chrome tab over CDP, so two
# overlapping runs would navigate each other's page mid-action and place garbage orders.
# -n means a tick that arrives while another is still running is skipped, not queued.
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/home/jimmy/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOCK=/srv/appdata/chrome-automation/sim/.tick.lock
LOG=/srv/appdata/chrome-automation/sim/bot.log

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date "+%F %T %Z") SKIP tick — previous run still holding the lock" >> "$LOG"
  exit 0
fi

# Cheap early-out: the last tick recorded when the first building next frees up. Until
# then there is nothing to do, so skip without paying for a browser session. The 45s
# margin covers clock drift and the capture latency. --force ignores this.
DUE_FILE=/srv/appdata/chrome-automation/sim/next-due.txt
HEARTBEAT_S=600    # 10 min: retail revenue piles up as an uncollected bubble between orders,
                   # and uncollected cash cannot fund the next building. Skipping for a whole
                   # 80-minute sales order would leave it sitting there the entire time.
if [ "${1:-}" != "--force" ] && [ -s "$DUE_FILE" ]; then
  due=$(date -d "$(cat "$DUE_FILE")" +%s 2>/dev/null || echo 0)
  now=$(date +%s)
  last=$(stat -c %Y "$DUE_FILE" 2>/dev/null || echo 0)
  wait=$((due - now))
  if [ "$due" -gt 0 ] && [ "$wait" -gt 45 ] && [ $((now - last)) -lt "$HEARTBEAT_S" ]; then
    # Completion lands before the next cron pass: sleep right up to it so the refill
    # starts the moment the building frees, instead of up to 2 minutes later. Waking 20s
    # early is deliberate — navigation and collection eat that before the state read.
    if [ "$wait" -le 150 ]; then
      sleep $((wait - 20))
    else
      exit 0
    fi
  fi
fi

# Running unattended for weeks, so keep the log bounded: rotate past 5 MB, keep one
# generation. Same for the append-only observation ledger the learning layer reads.
for f in "$LOG" /srv/appdata/chrome-automation/sim/observations.jsonl; do
  if [ -f "$f" ] && [ "$(stat -c%s "$f")" -gt 5242880 ]; then
    mv "$f" "$f.1"
    echo "$(date "+%F %T %Z") rotated $(basename "$f")" >> "$LOG"
  fi
done

# tick.js appends to $LOG itself; redirecting stdout here too would duplicate every line.
timeout 600 /usr/bin/node tick.js "$@" >/dev/null 2>>"$LOG"
rc=$?
[ $rc -ne 0 ] && echo "$(date "+%F %T %Z") tick exited rc=$rc" >> "$LOG"
exit 0
