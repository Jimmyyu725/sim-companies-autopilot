#!/bin/bash
# Poll a production building until its order finishes, collect, then queue the next order.
# Args: <buildingId> <RESOURCE NAME> <preset:5h|MAX> [max_polls]
cd /srv/appdata/chrome-automation/sim
BID="$1"; NAME="$2"; PRESET="${3:-5h}"; MAX="${4:-60}"
LOG=/srv/appdata/chrome-automation/sim/bot.log

for i in $(seq 1 "$MAX"); do
  node cdp.js goto "https://www.simcompanies.com/b/$BID/" >/dev/null 2>&1
  BUSY=$(node cdp.js eval "return document.body.innerText.includes('currently busy')?'BUSY':'FREE'" 2>&1)
  echo "$(date -u +%H:%M:%S) [$NAME] poll $i -> $BUSY" >> "$LOG"
  if [ "$BUSY" = "FREE" ]; then
    node cdp.js js pages/collect.js >> "$LOG" 2>&1
    node cdp.js goto "https://www.simcompanies.com/b/$BID/" >/dev/null 2>&1
    node cdp.js eval "window.__produce={name:'$NAME',preset:'$PRESET'}; return 1" >/dev/null 2>&1
    node cdp.js js pages/produce.js >> "$LOG" 2>&1
    echo "$(date -u +%H:%M:%S) [$NAME] PRODUCE ATTEMPTED ($PRESET)" >> "$LOG"
    exit 0
  fi
  sleep 25
done
echo "$(date -u +%H:%M:%S) [$NAME] gave up waiting" >> "$LOG"
exit 1
