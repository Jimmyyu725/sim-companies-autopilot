#!/bin/bash
# Best-effort delivery of immutable brain diaries, append-only MASTER history, and CURRENT state.
# Successful diary names are recorded locally so an offline PC does not create permanent gaps.
set -uo pipefail

SIM_ROOT=/srv/appdata/chrome-automation/sim
AUTOPILOT="$SIM_ROOT/autopilot"
DIARY_DIR="$AUTOPILOT/diaries"
WIN_KEY=/home/jimmy/.ssh/win_key
WIN_USER=y3264
WIN_LAN_HOST=192.168.1.16
WIN_TAILSCALE_HOST=100.96.116.0
WIN_DIR='C:/Users/y3264/Documents/Sim Companies AI log'
MANIFEST="$AUTOPILOT/.windows-sync-manifest"

exec 8>"$AUTOPILOT/.windows-sync.lock"
flock -n 8 || {
  echo "$(date '+%F %T %Z') Windows log sync skipped: another sync is active"
  exit 0
}

[ -f "$WIN_KEY" ] || {
  echo "$(date '+%F %T %Z') Windows log sync skipped: key file is absent"
  exit 0
}

ssh_opts=(
  -i "$WIN_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=5
  -o ConnectionAttempts=1
)

win_host=
for candidate in "$WIN_LAN_HOST" "$WIN_TAILSCALE_HOST"; do
  if ssh "${ssh_opts[@]}" "$WIN_USER@$candidate" 'cmd /c exit 0' >/dev/null 2>&1; then
    win_host=$candidate
    break
  fi
done

[ -n "$win_host" ] || {
  echo "$(date '+%F %T %Z') Windows log sync deferred: PC is unreachable"
  exit 0
}

touch "$MANIFEST"
synced=0
failed=0

while IFS= read -r diary; do
  base=${diary##*/}
  if grep -Fqx -- "$base" "$MANIFEST"; then
    continue
  fi

  remote_name="大脑思考日志-${base#diary-}"
  if scp "${ssh_opts[@]}" "$diary" "$WIN_USER@$win_host:$WIN_DIR/$remote_name"; then
    if printf '%s\n' "$base" >>"$MANIFEST"; then
      synced=$((synced + 1))
    else
      echo "$(date '+%F %T %Z') Windows log sync warning: uploaded $base but could not update manifest; it will be retried"
      failed=$((failed + 1))
    fi
  else
    failed=$((failed + 1))
  fi
done < <(find "$DIARY_DIR" -maxdepth 1 -type f -name 'diary-*.md' | sort)

if ! scp "${ssh_opts[@]}" "$AUTOPILOT/MASTER.md" \
  "$WIN_USER@$win_host:$WIN_DIR/主日记-MASTER.md"; then
  failed=$((failed + 1))
fi
if ! scp "${ssh_opts[@]}" "$AUTOPILOT/CURRENT.json" \
  "$WIN_USER@$win_host:$WIN_DIR/当前计划-CURRENT.json"; then
  failed=$((failed + 1))
fi

echo "$(date '+%F %T %Z') Windows log sync: host=$win_host diaries=$synced failures=$failed"
exit 0
