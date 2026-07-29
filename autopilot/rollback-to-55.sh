#!/bin/bash
# One-touch rollback: next wake uses the proven gpt-5.5 chat-completions engine.
cd /srv/appdata/chrome-automation/sim
sed -i -e 's/^export BRAIN_MODEL=.*/export BRAIN_MODEL=gpt-5.5/' -e '/^export BRAIN_JS=/d' autopilot/run-brain.sh
grep -E "BRAIN_MODEL|BRAIN_JS" autopilot/run-brain.sh
nohup autopilot/run-brain.sh >/dev/null 2>&1 &   # immediate make-up wake
echo "rolled back to gpt-5.5 + fired a make-up wake"
