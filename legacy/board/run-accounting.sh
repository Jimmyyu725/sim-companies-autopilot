#!/bin/bash
# Daily financial physical: read the game's books, log findings, wake the strategist to act.
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/home/jimmy/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Shares the browser tab; wait for the fast loop rather than colliding.
exec 7>.accounting.lock
flock -w 300 7 || { echo "$(date '+%F %T %Z') accounting: could not get lock" >> finance-physical.log; exit 0; }

echo "════ $(date '+%F %T %Z') ════" >> finance-physical.log
node accounting.js >> finance-physical.log 2>&1
rc=$?
if [ $rc -eq 0 ]; then
  touch finance-pending.flag        # strategist will read finance-log.jsonl and act on HIGH recs
  ./run-strategist.sh >/dev/null 2>&1 &
fi
exit 0
