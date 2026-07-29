#!/bin/bash
set -euo pipefail

EXPERIMENT_DIR="/srv/appdata/chrome-automation/sim/experiments/deepseek-v4-pro-shadow"
OPENAI_ENV_FILE="/srv/appdata/ledgerwall/.env"

cleanup() {
  unset OPENAI_API_KEY DEEPSEEK_API_KEY
}
trap cleanup EXIT HUP INT TERM

if [ -z "${OPENAI_API_KEY:-}" ]; then
  OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' "$OPENAI_ENV_FILE" 2>/dev/null | tr -d '"' | head -1)"
  export OPENAI_API_KEY
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  if [ ! -t 0 ]; then
    echo "A terminal is required for hidden DeepSeek key entry." >&2
    exit 2
  fi
  read -r -s -p "DeepSeek API key (hidden, not saved): " DEEPSEEK_API_KEY
  printf '\n'
  export DEEPSEEK_API_KEY
fi

cd "$EXPERIMENT_DIR"
node benchmark.js --run "$@"
