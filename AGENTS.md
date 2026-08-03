# Sim Companies autopilot — Codex project context

This directory runs Jimmy's Sim Companies company **XaiverCoffee** (id `5742177`, realm 0), founded
2026-08-03. The provider-routed LLM autopilot (`autopilot/`) is the only operator when it is
running: DeepSeek V4 Flash at Max reasoning is the current path and retained OpenAI Terra/Luna is
the automatic rollback.

**The autopilot is currently disabled.** There is no cron entry for it, and the owner is operating
the company by hand. Do not re-enable it without his say-so; the checklist for turning it back on is
in `SIMCOMPANIES-HANDOFF.md`.

**READ FIRST: `SIMCOMPANIES-HANDOFF.md`** — the complete file map, architecture, cron, rollback,
mission, and gotchas. Then `LESSONS.md` for engineering post-mortems that still apply. Use
`autopilot/CURRENT.json` for current memory; `MASTER.md` is append-only audit history.

Rules: Chinese replies, English code/docs, verify before asserting, never fabricate.

Long-term mission = maximum sustainable net profit and self-funded growth. The owner's chosen
direction is the Coffee chain (`Power → Water → Seeds → Coffee Beans → Coffee Powder`), but the
company owns no Mill yet, so it produces no Coffee Powder. The measured economics, the slot ceiling
by company level, and the reason bulk crop exports are not a viable income route are all in
`autopilot/BRAIN.md` section 7 — edit that file to change behaviour.

The previous company was retired on 2026-08-03. Its records, `legacy/` tree, analyses, diaries and
runtime state were deleted on the owner's instruction and survive only in git history. Nothing in
this repository should describe it as current.
