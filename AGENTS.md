# Sim Companies autopilot — Codex project context

This directory runs Jimmy's Sim Companies company 24/7. **An OpenAI gpt-5.6 autopilot
(`autopilot/`) is the sole operator** — the old three-layer system is historical under `legacy/`.
Do not disturb it blindly; it wakes on the game's event schedule and holds `.tick.lock` while acting.

**READ FIRST: `SIMCOMPANIES-HANDOFF.md`** — the complete file map, architecture, cron, rollback,
mission, and gotchas. Also `legacy/board/DOCTRINE.md` and `LESSONS.md` for historical engineering
context, plus `autopilot/MASTER.md` for the company's live memory.

Rules: Chinese replies, English code/docs, never print secrets (OpenAI key in
/srv/appdata/ledgerwall/.env), verify before asserting, never fabricate. Long-term mission = maximum
sustainable net profit and self-funded growth; FULL SELF-PRODUCED COFFEE is the current operating
baseline and three-L3-Mill milestone (see `autopilot/BRAIN.md`; edit it to change behavior).
