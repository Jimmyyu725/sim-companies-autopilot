# Sim Companies autopilot — Codex project context

This directory runs Jimmy's Sim Companies company 24/7. **The provider-routed LLM autopilot
(`autopilot/`) is the sole operator**: DeepSeek V4 Flash at Max reasoning is the current path and
retained OpenAI Terra/Luna is the automatic rollback. The old three-layer system is historical
under `legacy/`.
Do not disturb it blindly; it wakes on the game's event schedule and holds `.tick.lock` while acting.

**READ FIRST: `SIMCOMPANIES-HANDOFF.md`** — the complete file map, architecture, cron, rollback,
mission, and gotchas. Also `legacy/board/DOCTRINE.md` and `LESSONS.md` for historical engineering
context. Use `autopilot/CURRENT.json` for current memory; `MASTER.md` is append-only audit history.

Rules: Chinese replies, English code/docs, never print secrets (OpenAI key in
/srv/appdata/ledgerwall/.env), verify before asserting, never fabricate. Long-term mission = maximum
sustainable net profit and self-funded growth; self-produced Coffee is the current operating
baseline. The Prospector achievement campaign was retired on 2026-08-02 — the brain skips Quarries,
Mines and Oil rigs entirely. The next strategy trigger comes from current state and
`autopilot/CURRENT.json` (see `autopilot/BRAIN.md`; edit it to change behavior).
