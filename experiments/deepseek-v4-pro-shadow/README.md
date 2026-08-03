# Terra and DeepSeek V4 Pro shadow benchmark

This experiment compares provider behavior on immutable Sim Companies wakes. It never changes
`autopilot/run-brain.sh`, provider routing, the browser, or the game.

## Preserved result summary

The final 50-wake run on 2026-07-30 used `deepseek-v4-pro` with Max reasoning and the dedicated
execution prompt:

- 50/50 wakes completed across ten scenario families;
- average observable score: 95.776/100;
- readiness gates: 7/7 passed;
- 36 scoring guard failures across 26 wakes, with no unknown tools, forbidden confirmed
  mutations, or duplicate confirmed mutation targets;
- 16,664,872 prompt tokens and 327,572 output tokens;
- exact list-price cost: $0.78487937, or $0.01569759 per wake;
- live browser opens and live game mutations: zero.

On the 26 unchanged fixtures shared with the earlier comparison, Terra High averaged 97.308,
DeepSeek Max with the dedicated prompt averaged 96.019, and DeepSeek High with the shared prompt
averaged 95.654. DeepSeek Max was materially cheaper but slower and more verbose than Terra.
These results supported a reversible DeepSeek production trial only after adding program-level
single-tool enforcement, credential separation, and automatic OpenAI fallback. They do not prove
equal long-horizon live-game performance.

Raw run transcripts are intentionally disposable and are not source-controlled. The harness,
fixtures, validators, and this summary are the durable record.

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

## Thirty-wake DeepSeek coverage

The coverage run exercises ten scenario families with three controlled variants each:

- all buildings busy;
- collectible task recovery;
- idle Mill production;
- input shortage and bounded purchasing;
- utility surplus with full, shallow, and unprofitable market depth;
- Prospector rebuild;
- Mill upgrade with both funded approval and debt-constrained rejection;
- slot expansion with verified and unknown opportunity evidence;
- public chat and incoming-contract preview safety;
- multi-pressure owner-priority recovery.

Run the exact 30-case matrix with one hidden DeepSeek credential entry:

```bash
experiments/deepseek-v4-pro-shadow/run-coverage-interactive.sh
```

The default run uses DeepSeek V4 Pro High, three concurrent workers, and one immutable base
snapshot. It makes no OpenAI request, does not open Chrome, records every would-click action as
`executed:false`, and never changes production routing.

After the run, independently recompute every scenario score, exact list-price cost, aggregate,
readiness gate, and zero-mutation guarantee:

```bash
node experiments/deepseek-v4-pro-shadow/validate-coverage.js \
  experiments/deepseek-v4-pro-shadow/runs/coverage-<id>
```

Readiness requires all 30 wakes to complete, all ten families to cover all three variants, an
average observable score of at least 95/100, every complex family to average at least 90/100, and
zero unknown tools, forbidden confirmed mutations, or duplicate confirmed targets. Passing these
shadow gates supports a later low-risk canary; it does not switch the production model by itself.
