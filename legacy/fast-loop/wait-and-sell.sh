#!/bin/bash
# Poll the grocery store until its current order finishes, then place the retail order.
# Args: <RESOURCE NAME> <qty> <price> [max_polls]
cd /srv/appdata/chrome-automation/sim
NAME="$1"; QTY="$2"; PRICE="$3"; MAX="${4:-40}"
LOG=/srv/appdata/chrome-automation/sim/sell.log

for i in $(seq 1 "$MAX"); do
  node cdp.js goto "https://www.simcompanies.com/b/54959779/" >/dev/null 2>&1
  BUSY=$(node cdp.js eval "return document.body.innerText.includes('currently busy')?'BUSY':'FREE'" 2>&1)
  echo "$(date -u +%H:%M:%S) poll $i -> $BUSY" >> "$LOG"
  if [ "$BUSY" = "FREE" ]; then
    node cdp.js eval "window.__sell={name:'$NAME',qty:$QTY,price:$PRICE}; return 1" >/dev/null 2>&1
    node cdp.js js sell.js >> "$LOG" 2>&1
    echo "$(date -u +%H:%M:%S) SELL ATTEMPTED: $NAME $QTY @ $PRICE" >> "$LOG"
    exit 0
  fi
  sleep 25
done
echo "$(date -u +%H:%M:%S) gave up waiting for free store" >> "$LOG"
exit 1
