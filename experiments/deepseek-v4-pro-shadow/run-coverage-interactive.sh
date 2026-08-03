#!/bin/bash
set -euo pipefail

EXPERIMENT_DIR="/srv/appdata/chrome-automation/sim/experiments/deepseek-v4-pro-shadow"

cleanup() {
  unset DEEPSEEK_API_KEY
}
trap cleanup EXIT HUP INT TERM

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
node coverage.js "$@"
