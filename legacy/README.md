# Historical automation archive

This directory preserves the pre-LLM three-layer system for research and audit history:

- `fast-loop/` — the former deterministic tick loop, plan executor, learner, and one-shot tools.
- `strategist/` — the former strategist workflow, probes, state, logs, and config snapshots.
- `board/` — the former board workflow, minutes, reports, realizable-demand model, and accounting.

Nothing here is active. Cron entries are commented and labeled `LEGACY`. Files retain their original
relative-path assumptions and are not supported as rollback-ready executables from their new
locations. Do not use historical `board-data.json` or `.realizable.json` as live evidence.

The archive must not be deleted merely because the active autopilot no longer consumes it.
