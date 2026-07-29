# Shared runtime and measured data

This directory contains components used by the active LLM autopilot and supporting collectors.

- `cdp.js` — persistent-Chrome CDP client.
- `config.json` — current company/runtime configuration.
- `price-tracker/` — price and rotating order-book volume collectors plus the dashboard server.
- `facts/` — measured encyclopedia/bundle inputs and the nightly `game-facts.json` builder.

Compatibility symlinks remain at the Sim root for older utilities and the existing systemd unit.
Canonical active code imports from `shared/`.
