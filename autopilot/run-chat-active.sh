#!/bin/bash
# Bounded production wrapper for the chat launcher.
#
# Safe defaults perform a shadow cycle with the deterministic decision provider:
#   autopilot/run-chat-active.sh
#
# Shadow evaluation with the bounded LLM planner:
#   SIM_CHAT_LLM_ENABLED=true autopilot/run-chat-active.sh
#
# A mutation-capable rollout requires all three literal controls. Do not put these
# switches in cron until a separately audited live canary has been approved:
#   SIM_CHAT_ACTIVE_MODE=safe-reply \
#   SIM_CHAT_LLM_ENABLED=true \
#   SIM_CHAT_REAL_SEND_ENABLED=true \
#   autopilot/run-chat-active.sh

set +x
set -u -o pipefail
umask 077

readonly SIM_ROOT='/srv/appdata/chrome-automation/sim'
readonly AUTOPILOT_ROOT="$SIM_ROOT/autopilot"
readonly CHAT_ENTRY="$AUTOPILOT_ROOT/chat-active.js"
readonly CREDENTIAL_FILE='/srv/appdata/ledgerwall/.env'
readonly LOG_DIR="$AUTOPILOT_ROOT/chat-logs"
readonly LOG_FILE="$LOG_DIR/chat-active.log"
readonly RUNNER_LOCK="$LOG_DIR/.runner.lock"
readonly LOG_LIMIT_BYTES=5242880
readonly LOG_ARCHIVE_COUNT=5
readonly OUTER_TIMEOUT_SECONDS=270
readonly KILL_GRACE_SECONDS=5

export PATH='/usr/local/bin:/usr/bin:/bin'
export TZ="${TZ:-America/Chicago}"
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
unset SIM_CHAT_EXECUTION_CLAIM_TOKEN SIM_CHAT_SHADOW_LOCK_PROOF
unset SIM_CHAT_ACTIVE_DEADLINE_AT_MS

fail_early() {
  local message="${1:-chat wrapper failed}"
  if [[ -d "$LOG_DIR" && ! -L "$LOG_DIR"
      && ! -L "$LOG_FILE" && ( ! -e "$LOG_FILE" || -f "$LOG_FILE" ) ]]; then
    /usr/bin/printf '%s ERROR %s\n' "$(/usr/bin/date '+%F %T %Z')" "$message" \
      >> "$LOG_FILE" 2>/dev/null || true
  else
    /usr/bin/printf '%s\n' "$message" >&2
  fi
  exit 1
}

is_owner_private() {
  local path="$1"
  local owner mode
  owner="$(/usr/bin/stat -c '%u' -- "$path")" || return 1
  mode="$(/usr/bin/stat -c '%a' -- "$path")" || return 1
  [[ "$owner" == "$EUID" ]] || return 1
  (( (8#$mode & 8#077) == 0 ))
}

ensure_private_log_directory() {
  if [[ ! -e "$LOG_DIR" && ! -L "$LOG_DIR" ]]; then
    /usr/bin/install -d -m 0700 -- "$LOG_DIR" || return 1
  fi
  [[ -d "$LOG_DIR" && ! -L "$LOG_DIR" ]] || return 1
  is_owner_private "$LOG_DIR"
}

ensure_private_regular_file() {
  local path="$1"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    /usr/bin/install -m 0600 /dev/null "$path" || return 1
  fi
  [[ -f "$path" && ! -L "$path" ]] || return 1
  is_owner_private "$path"
}

rotate_log_if_needed() {
  [[ -f "$LOG_FILE" && ! -L "$LOG_FILE" ]] || return 0
  local size index
  size="$(/usr/bin/stat -c '%s' -- "$LOG_FILE")" || return 1
  (( size >= LOG_LIMIT_BYTES )) || return 0
  for ((index=LOG_ARCHIVE_COUNT - 1; index >= 1; index -= 1)); do
    if [[ -e "$LOG_FILE.$index" || -L "$LOG_FILE.$index" ]]; then
      /usr/bin/mv -f -- "$LOG_FILE.$index" "$LOG_FILE.$((index + 1))" || return 1
    fi
  done
  /usr/bin/mv -f -- "$LOG_FILE" "$LOG_FILE.1" || return 1
}

load_openai_key() {
  /usr/bin/node - "$CREDENTIAL_FILE" <<'NODE'
'use strict';

const fs = require('node:fs');

try {
  const file = process.argv[2];
  const flags = fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
        || stat.size <= 0 || stat.size > 64 * 1024) {
      throw new Error('unsafe credential file');
    }
    const matches = fs.readFileSync(descriptor, 'utf8').split(/\r?\n/u)
      .map(line => line.match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/u))
      .filter(Boolean)
      .map(match => match[1]);
    if (matches.length !== 1) throw new Error('credential entry is not unique');
    let value = matches[0];
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value || value.length > 1024 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('credential value is malformed');
    }
    process.stdout.write(value);
  } finally {
    fs.closeSync(descriptor);
  }
} catch {
  process.stderr.write('OpenAI credential file validation failed\n');
  process.exitCode = 1;
}
NODE
}

cd "$SIM_ROOT" || exit 1
ensure_private_log_directory || fail_early 'chat log directory is not owner-private'

ensure_private_regular_file "$RUNNER_LOCK" || fail_early 'chat runner lock is unsafe'
exec 8<>"$RUNNER_LOCK"
if ! /usr/bin/flock -n 8; then
  # A prior wrapper owns logging and will perform the only cycle. This is a healthy skip.
  exit 0
fi

rotate_log_if_needed || fail_early 'chat log rotation failed'
ensure_private_regular_file "$LOG_FILE" || fail_early 'chat log file is unsafe'

readonly ACTIVE_MODE="${SIM_CHAT_ACTIVE_MODE:-shadow}"
readonly LLM_ENABLED="${SIM_CHAT_LLM_ENABLED:-false}"
readonly REAL_SEND_ENABLED="${SIM_CHAT_REAL_SEND_ENABLED:-false}"

case "$ACTIVE_MODE" in
  off|read-only|shadow|safe-reply|full) ;;
  *) fail_early 'SIM_CHAT_ACTIVE_MODE is invalid' ;;
esac
case "$LLM_ENABLED" in
  true|false) ;;
  *) fail_early 'SIM_CHAT_LLM_ENABLED must be literal true or false' ;;
esac
case "$REAL_SEND_ENABLED" in
  true|false) ;;
  *) fail_early 'SIM_CHAT_REAL_SEND_ENABLED must be literal true or false' ;;
esac

if [[ "$REAL_SEND_ENABLED" == 'true' && "$ACTIVE_MODE" != 'safe-reply'
    && "$ACTIVE_MODE" != 'full' ]]; then
  fail_early 'real-send control is incompatible with the selected mode'
fi
if [[ "$ACTIVE_MODE" == 'safe-reply' || "$ACTIVE_MODE" == 'full' ]]; then
  [[ "$REAL_SEND_ENABLED" == 'true' ]] \
    || fail_early 'mutation-capable mode requires the real-send control'
  [[ "$LLM_ENABLED" == 'true' ]] \
    || fail_early 'mutation-capable mode requires the LLM control'
fi

unset OPENAI_API_KEY
if [[ "$LLM_ENABLED" == 'true' ]]; then
  loaded_key=''
  if ! loaded_key="$(load_openai_key 2>> "$LOG_FILE")"; then
    fail_early 'OpenAI credential could not be loaded safely'
  fi
  export OPENAI_API_KEY="$loaded_key"
  unset loaded_key
fi

export SIM_CHAT_ACTIVE_MODE="$ACTIVE_MODE"
export SIM_CHAT_LLM_ENABLED="$LLM_ENABLED"
export SIM_CHAT_REAL_SEND_ENABLED="$REAL_SEND_ENABLED"

run_output="$(/usr/bin/mktemp "$LOG_DIR/.chat-active-run.XXXXXX")" \
  || fail_early 'could not create private chat run output'
/usr/bin/chmod 0600 "$run_output" || fail_early 'could not protect chat run output'
cleanup() {
  /usr/bin/rm -f -- "$run_output"
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

/usr/bin/printf '%s START mode=%s llm=%s real_send=%s timeout=%ss\n' \
  "$(/usr/bin/date '+%F %T %Z')" "$ACTIVE_MODE" "$LLM_ENABLED" \
  "$REAL_SEND_ENABLED" "$OUTER_TIMEOUT_SECONDS" >> "$LOG_FILE"

/usr/bin/timeout --signal=TERM --kill-after="${KILL_GRACE_SECONDS}s" \
  "${OUTER_TIMEOUT_SECONDS}s" /usr/bin/node "$CHAT_ENTRY" > "$run_output" 2>&1
runner_rc=$?
unset OPENAI_API_KEY

/usr/bin/cat -- "$run_output" >> "$LOG_FILE"

semantic_rc=1
if (( runner_rc == 0 )); then
  /usr/bin/node - "$run_output" <<'NODE'
'use strict';

const fs = require('node:fs');

try {
  const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/u).filter(Boolean);
  let result = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      result = JSON.parse(lines[index]);
      break;
    } catch {}
  }
  process.exitCode = result?.ok === true ? 0 : 1;
} catch {
  process.exitCode = 1;
}
NODE
  semantic_rc=$?
fi

if (( runner_rc == 0 && semantic_rc == 0 )); then
  /usr/bin/printf '%s DONE rc=0 semantic=ok\n' \
    "$(/usr/bin/date '+%F %T %Z')" >> "$LOG_FILE"
  exit 0
fi

/usr/bin/printf '%s FAILED runner_rc=%s semantic_rc=%s\n' \
  "$(/usr/bin/date '+%F %T %Z')" "$runner_rc" "$semantic_rc" >> "$LOG_FILE"
exit 1
