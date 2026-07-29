# Terra High versus DeepSeek V4 Pro High

This experiment compares `gpt-5.6-terra` High and `deepseek-v4-pro` High on one immutable
Sim Companies wake. It does not change `autopilot/run-brain.sh`, the production model, the browser,
or the game.

The default single-scenario benchmark derives a controlled `prospector-ready-v1` replay from the latest captured
state: it advances only the recorded Quarry construction to its known completion, marks that exact
replacement authoritatively idle, and provides deterministic authenticated-counter and simulated
rebuild receipts. The scenario is labeled synthetic in every artifact and exercises the real
owner-priority workflow: refresh, authenticate, dry-preview, confirm one UI intent, refresh,
re-authenticate, schedule, journal, memory, and finish. `--scenario current` replays the untouched
frozen state instead.

Both providers
receive the same `BRAIN.md`, `CURRENT.json`, pending owner directive, wake reason, recent journal,
state object, maximum output-token limit, and 49 semantic tool names. Provider-specific wire
formats differ only where their official APIs require it:

- Terra uses the OpenAI Responses API with `reasoning.effort=high`, low text verbosity, standard
  service tier, chained `previous_response_id`, and parallel tool calls disabled.
- DeepSeek uses Chat Completions thinking mode with `reasoning_effort=high`. The runner preserves
  `reasoning_content` in provider history as required, but never writes that hidden reasoning to
  artifacts.

Every game mutation is intercepted after schema and frozen-state validation. Successful intents are
recorded as shadow clicks with `executed:false`; browser reads unavailable in the frozen snapshot
return `UNKNOWN`. This directory imports no game executor, CDP client, or child-process launcher.

## Offline verification

```bash
cd /srv/appdata/chrome-automation/sim
node experiments/deepseek-v4-pro-shadow/benchmark.js --check
node --test experiments/deepseek-v4-pro-shadow/test/shadow-wake.test.js
```

These commands need no API key and make no network request.

## Paired benchmark

The production OpenAI key is read without printing from `/srv/appdata/ledgerwall/.env`. The
DeepSeek key is requested once through a hidden terminal prompt, exported only to the child
process, and unset on exit:

```bash
experiments/deepseek-v4-pro-shadow/run-benchmark-interactive.sh
```

Do not place either key in a command argument, source file, transcript, or Git.

Both providers start concurrently from the same frozen input. Owner-only run artifacts are written
under ignored `runs/benchmark-*/` directories:

- `snapshot.json`: the immutable common input;
- `terra/` and `deepseek/`: observable transcript, usage, result, and score;
- `comparison.json`: machine-readable fairness metadata and leaderboard;
- `report.md`: compact human-readable comparison.

The deterministic 100-point rubric is provider-neutral. It scores observable completion, close
protocol, tool safety, scenario objectives, CEO analysis, state fidelity, and action economy.
It deliberately does not score hidden chain-of-thought. One paired wake is a preliminary
operational test; repeated representative wakes are needed for a stable model ranking.

## Multi-scenario suite

The suite uses one immutable base snapshot and five paired controlled scenarios:

- `all-busy-v1` — simple restraint and checkpoint selection;
- `idle-mill-v1` — simple idle-production recovery;
- `utility-surplus-v1` — medium reserve-safe exchange monetization;
- `prospector-ready-v1` — medium owner-priority structural execution;
- `multi-pressure-v1` — complex owner priority, two idle buildings, market sale, and repeated refreshes.

Run all five with one hidden DeepSeek credential entry:

```bash
experiments/deepseek-v4-pro-shadow/run-suite-interactive.sh
```

Provider pairs run concurrently, while scenarios run sequentially to bound rate pressure. All
scenario outcomes remain deterministic in-memory fixtures with `executed:false`; the suite never
opens Chrome or mutates the game.

Provider/API failures are also saved without inventing token or cost values. An unavailable account,
quota, balance, or model is reported as an infrastructure failure and must not be interpreted as a
model-capability score.
