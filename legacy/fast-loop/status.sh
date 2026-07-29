#!/bin/bash
# Human-readable status panel. Logs are kept in UTC (DST-safe), but this renders everything
# in the machine's local timezone, which is also what the game UI shows.
cd /srv/appdata/chrome-automation/sim

local_of() { date -d "$1" '+%-I:%M %p %Z'; }

echo "════════════════════════════════════════════════"
echo " apple.co Corp — $(date '+%a %b %-d, %-I:%M %p %Z')"
echo "════════════════════════════════════════════════"

# bot.log is already written in local time: "YYYY-MM-DD HH:MM:SS TZ  message"
last_state=$(grep ' STATE ' bot.log 2>/dev/null | tail -1)
if [ -n "$last_state" ]; then
  echo " last tick   $(echo "$last_state" | awk '{print $2, $3}')"
  echo " ${last_state#* STATE }" | sed 's/^/            /'
fi

echo
echo " buildings"
# bot.log carries two timestamp shapes: the current local form "DATE TIME TZ msg" and
# older ISO-UTC lines "2026-07-22T00:44:46.018Z msg". Normalise both to local HH:MM.
grep -E ' (BUSY|IDLE|STORE pick|FARM pick|BUILD|UPGRADE|COLLECT) ' bot.log 2>/dev/null | tail -7 |
while read -r line; do
  case "$line" in
    *T*Z\ *)  ts=${line%% *}; msg=${line#* }
              when=$(date -d "$ts" '+%H:%M' 2>/dev/null) ;;
    *)        when=$(echo "$line" | awk '{print $2}' | cut -d: -f1-2)
              msg=$(echo "$line" | cut -d' ' -f4-) ;;
  esac
  printf '   %-7s %s\n' "$when" "$msg"
done

echo
if [ -s next-due.txt ]; then
  due=$(cat next-due.txt)
  secs=$(( $(date -d "$due" +%s) - $(date +%s) ))
  if [ "$secs" -gt 0 ]; then
    printf ' next action  %s  (in %dh %dm)\n' "$(local_of "$due")" $((secs/3600)) $(((secs%3600)/60))
  else
    echo " next action  due now"
  fi
fi

if [ -f knowledge.json ]; then
  node -e '
    const k = require("./knowledge.json");
    const rates = Object.entries(k.sellRates || {})
      .map(([kind, v]) => `${kind}:${v.sellRate}/h(${v.status})`).join(" ") || "none yet";
    console.log(` learning     ${k.observations} observations | xp model: ${k.xp.model} | rates ${rates}`);
    if (k.accelRegime) {
      const left = (new Date(k.accelRegime.until) - Date.now()) / 3600000;
      console.log(` acceleration x${k.accelRegime.multiplier}` +
        (left > 0 ? ` — ${left.toFixed(1)}h left (ends ${new Date(k.accelRegime.until).toLocaleString()})` : " — EXPIRED"));
    }
  ' 2>/dev/null
fi

echo
echo " cron"
crontab -l 2>/dev/null | grep -E 'run-(tick|strategist)' | sed 's/^/   /'
