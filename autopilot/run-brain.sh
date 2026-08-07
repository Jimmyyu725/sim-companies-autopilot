#!/bin/bash
# One brain wake: preflight the selected provider -> gather fresh state -> run its brain loop ->
# ensure the next alarm exists.
# Fired by autopilot/gate.js when next-wake.json is due (or manually). Lock prevents overlapping wakes.
set -uo pipefail
cd /srv/appdata/chrome-automation/sim
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
AUTOPILOT=autopilot
LOG="$AUTOPILOT/brain.log"
DIARY_DIR="$AUTOPILOT/diaries"

exec 7>"$AUTOPILOT/.brain.lock"
# Absorb sub-second contention from optional telemetry that passed its preflight just before the
# alarm changed. A real overlapping brain remains locked far longer and still takes the defer path.
flock -w 2 7 || {
  # Preserve a valid due alarm (especially an immediate owner wake) while the active brain is
  # finishing. The lock owner restores it after its own alarm write, preventing a lost wake.
  node "$AUTOPILOT/gate.js" --defer-due >> "$LOG" 2>&1 || true
  echo "$(date '+%F %T %Z') SKIP — brain already awake" >> "$LOG"
  exit 0
}
echo "════════ $(date '+%F %T %Z') BRAIN WAKE ════════" >> "$LOG"

# Consume the alarm that fired this wake. A stale already-due next-wake.json satisfies BOTH
# "alarm exists" safety nets (brain.js finish handler + the net below) while staying due, so a
# wake ending without set_alarm would refire the FULL brain every minute — browser churn, API
# spend, and REPEATED REAL ACTIONS. Consuming it makes existence mean "a FUTURE alarm exists".
mv -f "$AUTOPILOT/next-wake.json" "$AUTOPILOT/.last-wake.json" 2>/dev/null || true

# Create the immutable per-wake record before any fallible browser work. A failed state capture is
# still a real wake and must be visible in the diary/history instead of existing only in brain.log.
install -d -m 0755 "$DIARY_DIR"
export DIARY_FILE="$DIARY_DIR/diary-$(date '+%Y-%m-%d-%H%M%S').md"
export WAKE_ID="${DIARY_FILE##*/}"
export WAKE_ID="${WAKE_ID%.md}"
WAKE_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
USAGE_FILE="$AUTOPILOT/usage.jsonl"
USAGE_OFFSET="$(stat -c%s "$USAGE_FILE" 2>/dev/null || echo 0)"


fail_before_state() {
  local reason="$1"
  echo "$(date '+%F %T %Z') provider preflight FAILED — $reason" >> "$LOG"
  node -e 'const fs=require("fs"),now=Date.now(),at=now+3e5;fs.writeFileSync("autopilot/next-wake.json",JSON.stringify({at,atIso:new Date(at).toISOString(),reason:"provider preflight failed, retry",set:new Date(now).toISOString()}))'
  {
    printf '\n════ WAKE %s (provider preflight) ════\n' "$WAKE_STARTED_AT"
    printf '⚠ PROVIDER PREFLIGHT FAILED\n'
    printf -- '- Safety result: no browser read, model call, or game action was attempted.\n'
    printf -- '- Recovery: retry scheduled in five minutes; see `brain.log` for the non-secret reason.\n'
  } >> "$DIARY_FILE"
  local usage_end_offset
  usage_end_offset="$(stat -c%s "$USAGE_FILE" 2>/dev/null || echo 0)"
  node "$AUTOPILOT/usage-summary.js" \
    "--usage=$USAGE_FILE" \
    "--offset=$USAGE_OFFSET" \
    "--end-offset=$usage_end_offset" \
    "--diary=$DIARY_FILE" \
    "--wake-log=$AUTOPILOT/wake-usage.jsonl" \
    "--wake-id=$WAKE_ID" \
    "--started-at=$WAKE_STARTED_AT" \
    "--brain-rc=1" >> "$LOG" 2>&1 || true
  "$AUTOPILOT/sync-windows-logs.sh" >>"$LOG" 2>&1 || true
  exit 1
}

ACTIVE_PROVIDER="$(node "$AUTOPILOT/brain-provider.js" current 2>>"$LOG")" ||
  fail_before_state "active provider configuration is invalid"
# Owner directive 2026-08-07: DeepSeek permanently; OpenAI is no longer the intended engine. This
# preflight used to call `switch openai --confirm` on a credential failure, and switchProvider writes
# BOTH .active-brain-provider and .owner-primary-provider (brain-provider.js:95-96). One unreadable
# key file — a copy, a restore, an editor rewrite under umask 022 — would therefore have rewritten
# the owner's standing choice, permanently and with only a line reading "using retained OpenAI
# provider" to show for it. Worse, the half-open recovery at brain-provider.js:175 requires
# `resolved !== ownerPrimary`, so once both files say openai DeepSeek is never retried again.
#
# A credential problem is a credential problem. Fail the wake, let check-alarm schedule the retry,
# and leave the owner's choice alone. Recovering the key is a two-second fix; recovering silently
# rewritten intent needs someone to notice it happened.
if ! node "$AUTOPILOT/brain-provider.js" check "$ACTIVE_PROVIDER" >>"$LOG" 2>&1; then
  fail_before_state "$ACTIVE_PROVIDER credential is unavailable"
fi

unset OPENAI_API_KEY DEEPSEEK_API_KEY
case "$ACTIVE_PROVIDER" in
  deepseek)
    export BRAIN_PROVIDER=deepseek
    # Owner directive 2026-08-02: run the brain on Flash. It prices at about a third of Pro
    # ($0.14/$0.28 per 1M input/output versus $0.435/$0.87) and was verified to return tool calls.
    export BRAIN_MODEL=deepseek-v4-flash
    export BRAIN_JS="$AUTOPILOT/brain.js"
    export BRAIN_EFFORT=max
    export BRAIN_MAX_TOKENS=32768
    export BRAIN_MAX_ROUNDS=unlimited
    export BRAIN_REQUEST_TIMEOUT_MS=180000
    export COUNCIL_PROVIDER=deepseek
    export COUNCIL_MODEL=deepseek-v4-flash
    export COUNCIL_EFFORT=max
    export COUNCIL_MAX_TOKENS=16384
    export DEEPSEEK_API_KEY="$(tr -d '\r\n' < /home/jimmy/.config/sim-benchmark/deepseek-v4-pro.txt)"
    ;;
  openai)
    export BRAIN_PROVIDER=openai
    export BRAIN_MODEL=gpt-5.6-terra
    export BRAIN_JS="$AUTOPILOT/brain56.js"
    export BRAIN_EFFORT=high
    # Same budget the DeepSeek branch sets. This engine used to hard-code 30 and ignore the
    # variable, so the omission here was invisible; both are fixed together. Nine of these rounds
    # can go to closing alone when a journal is refused once and the collect it demands has to be
    # done first — measured 2026-08-03 23:35, where a wake finished its work and then ran out
    # mid-close.
    export BRAIN_MAX_ROUNDS=unlimited
    export COUNCIL_PROVIDER=openai
    export COUNCIL_MODEL=gpt-5.6-luna
    export COUNCIL_EFFORT=high
    # Load only the key entry; never source or print the rest of the environment file.
    export OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' /srv/appdata/ledgerwall/.env 2>/dev/null | tr -d '"' | head -1)"
    ;;
  *)
    fail_before_state "unsupported provider"
    ;;
esac
export BRAIN_VERBOSITY=low
# Chat is off, and this is a cost decision rather than a feature decision. Measured 2026-08-07: the
# chat/contract/auction family is 26 of 41 action tools and 15,271 of 22,992 characters of tool
# payload — two thirds of the menu, carried on every model request. 22 of those 26 have never been
# called in 12,231 tool calls; the 4 that have now fail, because the game added a room-rules overlay
# that only a click dismisses and the read paths are forbidden from clicking. contract_send is
# refused independently by two layers and can never succeed, while still advertising itself to the
# model. Setting this to off drops the payload to 8,074 characters, about 3,800 tokens per request
# and roughly 3.5M tokens a day.
#
# Nothing is deleted. Set SIM_CHAT_MODE=shadow to restore the previous behaviour; the modes are
# off / read-only / shadow / safe-reply / full. The Personal Assistant is a separate system and is
# untouched: pa_read, pa_consult_guide and pa_reply survive here, and they earn their place — 172
# calls, and one accepted offer bought a Grocery level for $2,320 against roughly $11,000 of capex.
export SIM_CHAT_MODE=off
echo "$(date '+%F %T %Z') provider=$BRAIN_PROVIDER model=$BRAIN_MODEL effort=$BRAIN_EFFORT engine=$BRAIN_JS" >> "$LOG"

# Fresh state (timeout-bounded browser read, LESSONS B2). The opening snapshot also reads the
# rendered messages list once so PA unread detection does not depend on the currently-null auth
# field. Later refreshes use the persisted status/pending-offer artifacts and do not navigate chat.
if ! timeout 160 flock -w 90 .tick.lock env SIM_PA_SCAN=1 node "$AUTOPILOT/state.js" >> "$LOG" 2>&1; then
  echo "$(date '+%F %T %Z') state capture FAILED — retry alarm in 15 min" >> "$LOG"
  node -e 'const fs=require("fs"),at=Date.now()+9e5;fs.writeFileSync("autopilot/next-wake.json",JSON.stringify({at,atIso:new Date(at).toISOString(),reason:"state capture failed, retry"}))'
  node "$AUTOPILOT/gate.js" --restore-deferred >> "$LOG" 2>&1 || true
  node "$AUTOPILOT/check-alarm.js" >> "$LOG" 2>&1 || true
  NEXT_WAKE="$(node -e 'try{console.log(require("./autopilot/next-wake.json").atIso)}catch(e){console.log("unknown")}')"
  {
    printf '\n════ WAKE %s (pre-decision state capture) ════\n' "$WAKE_STARTED_AT"
    printf '⚠ STATE CAPTURE FAILED\n'
    printf -- '- Stage: authoritative live state capture before the brain starts.\n'
    printf -- '- Safety result: no model call and no game action were attempted.\n'
    printf -- '- Validation result: the live response was unavailable, incomplete, or malformed; see `brain.log` for the exact runtime error.\n'
    printf -- '- Recovery: retry scheduled for %s.\n' "$NEXT_WAKE"
  } >> "$DIARY_FILE"
  USAGE_END_OFFSET="$(stat -c%s "$USAGE_FILE" 2>/dev/null || echo 0)"
  node "$AUTOPILOT/usage-summary.js" \
    "--usage=$USAGE_FILE" \
    "--offset=$USAGE_OFFSET" \
    "--end-offset=$USAGE_END_OFFSET" \
    "--diary=$DIARY_FILE" \
    "--wake-log=$AUTOPILOT/wake-usage.jsonl" \
    "--wake-id=$WAKE_ID" \
    "--started-at=$WAKE_STARTED_AT" \
    "--brain-rc=1" >> "$LOG" 2>&1 || true
  "$AUTOPILOT/sync-windows-logs.sh" >>"$LOG" 2>&1 || true
  exit 1
fi
# Council deliberation still has no client-side limit, and the full-wake lock prevents overlapping
# brains while a slow provider is thinking. What changed on 2026-08-05 is that BRAIN_MAX_ROUNDS is
# unlimited, and the round ceiling had been the only thing bounding a wake: a runtime loop used to
# end by exhausting rounds. One did on 2026-08-04 22:58 — twelve identical inspections, 53 calls,
# $1.20 — and it ended because it hit 50, not because it resolved.
#
# 45 minutes is a backstop, not a schedule. Wakes run 10-25 minutes, and the longest clean one on
# record is well under this, so reaching it means something is stuck rather than slow. SIGTERM
# first, SIGKILL 30s later if the engine ignores it. rc is then 124, which is non-zero, so the
# conservative recovery below already applies: check-alarm --brain-failed caps the next alarm
# because the persisted state may predate an ambiguous mutation.
timeout -k 30 2700 node "${BRAIN_JS:-autopilot/brain.js}" >> "$LOG" 2>&1
rc=$?
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "$(date '+%F %T %Z') BRAIN killed by the 45-minute wall-clock backstop (rc=$rc)" >> "$LOG"
fi
node "$AUTOPILOT/brain-provider.js" record "$BRAIN_PROVIDER" "$rc" >> "$LOG" 2>&1 || true
# The brain may finish after its last refresh or after an ambiguous failure. Capture once more so
# the persisted state describes the actual closing position, not the opening snapshot.
if ! timeout 160 flock -w 90 .tick.lock node "$AUTOPILOT/state.js" >> "$LOG" 2>&1; then
  echo "$(date '+%F %T %Z') final closing state capture FAILED" >> "$LOG"
fi
USAGE_END_OFFSET="$(stat -c%s "$USAGE_FILE" 2>/dev/null || echo 0)"
# Safety: an alarm must ALWAYS exist or the brain never wakes again. Five minutes is the maximum
# safe delay here: the process may have exited immediately after an ambiguous click and before its
# fresh state capture, so the old one-hour fallback could leave newly completed work idle.
[ -f "$AUTOPILOT/next-wake.json" ] || node -e 'const fs=require("fs"),now=Date.now(),at=now+3e5;fs.writeFileSync("autopilot/next-wake.json",JSON.stringify({at,atIso:new Date(at).toISOString(),reason:"safety retry after incomplete brain close",set:new Date(now).toISOString()}))'
# Merge any valid due alarm observed during this wake before validating the final schedule.
node "$AUTOPILOT/gate.js" --restore-deferred >> "$LOG" 2>&1 || true
# A non-zero brain exit makes any later alarm unsafe unless a sooner request already exists. The
# last .state.json may predate an ambiguous mutation, so cap the recovery before normal reconciliation.
if [ "$rc" -ne 0 ]; then
  node "$AUTOPILOT/check-alarm.js" --brain-failed >> "$LOG" 2>&1 || true
fi
# Ensure the alarm matches reality: never oversleep the earliest real building completion.
node "$AUTOPILOT/check-alarm.js" >> "$LOG" 2>&1 || true
node "$AUTOPILOT/usage-summary.js" \
  "--usage=$USAGE_FILE" \
  "--offset=$USAGE_OFFSET" \
  "--end-offset=$USAGE_END_OFFSET" \
  "--diary=$DIARY_FILE" \
  "--wake-log=$AUTOPILOT/wake-usage.jsonl" \
  "--wake-id=$WAKE_ID" \
  "--started-at=$WAKE_STARTED_AT" \
  "--brain-rc=$rc" >> "$LOG" 2>&1 || true
echo "$(date '+%F %T %Z') BRAIN done rc=$rc, next: $(node -e 'try{console.log(require("./autopilot/next-wake.json").atIso)}catch(e){console.log("?")}')" >> "$LOG"
# Push all previously-unsent diaries plus MASTER history and the structured CURRENT checkpoint. Offline failures remain queued
# in the local manifest and are retried after the Windows PC becomes reachable again.
"$AUTOPILOT/sync-windows-logs.sh" >>"$LOG" 2>&1 || true
[ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ] && mv "$LOG" "$LOG.1"
U="$AUTOPILOT/usage.jsonl"; [ "$(stat -c%s "$U" 2>/dev/null || echo 0)" -gt 1048576 ] && mv "$U" "$U.1"
WU="$AUTOPILOT/wake-usage.jsonl"; [ "$(stat -c%s "$WU" 2>/dev/null || echo 0)" -gt 1048576 ] && mv "$WU" "$WU.$(date '+%Y%m%d-%H%M%S')"
exit 0
