# Shared runtime and measured data

This directory contains components used by the active LLM autopilot and supporting collectors.

- `cdp.js` — persistent-Chrome CDP client.
- `config.json` — minimal company/runtime identifiers, cash floors, and explicitly dated fallback
  values still read by active code.
- `price-tracker/` — price and rotating order-book volume collectors. The dashboard page and its
  server were removed on 2026-08-03; `data-quality.js` and `data/` remain because active code
  imports them.
- `facts/` — measured encyclopedia/bundle inputs and the nightly `game-facts.json` builder.

Compatibility symlinks remain at the Sim root for older utilities.
Canonical active code imports from `shared/`.
