# Wake Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only web page at `https://jimmyyu888.com/wake/` that shows what the autopilot is doing while a wake runs, and what it last did while idle.

**Architecture:** A pure parser turns `autopilot/brain.log` text into panel state. A small Node service follows that log plus two alarm files, calls the parser, and pushes state to browsers over Server-Sent Events. Caddy reverse-proxies `/wake/*` to it, restricted to LAN and Tailscale. Nothing in `autopilot/` is modified.

**Tech Stack:** Node v22.22.3 built-ins only — `node:http`, `node:fs`, `node:test`, `node:assert`. No package.json, no dependencies, no build step. Plain HTML/CSS/JS in the browser.

## Global Constraints

- Node version floor: **v22.22.3**. Built-in modules only — this repository has no `package.json` and adds no dependencies.
- CommonJS (`require`/`module.exports`), matching every other file under `autopilot/` and `shared/`.
- All code, comments, commit messages and documentation in English.
- **Never modify anything under `autopilot/` except the new test file.** The visualizer reads; it does not write, and it does not change the runtime.
- The service never calls the game API, never takes `.tick.lock`, and never writes to any file the autopilot reads.
- Tests run with `node --test`. Every task ends green before its commit.
- Fixtures come from the real `autopilot/brain.log`, sliced by the commands given in Task 1. Do not hand-write fixture content.

---

### Task 1: Parser — segment the log into wakes and events

**Files:**
- Create: `web/wake/parse.js`
- Create: `autopilot/tests/wake-parse.test.js`
- Create: `autopilot/tests/fixtures/wake-clean.log`
- Create: `autopilot/tests/fixtures/wake-503.log`
- Create: `autopilot/tests/fixtures/wake-running.log`

**Interfaces:**
- Consumes: nothing.
- Produces: `splitWakes(text) -> Wake[]` where
  `Wake = { banner: string, startedAtLocal: string, provider: string|null, model: string|null, events: Event[] }`
  and `Event = { t: string|null, kind: 'tool'|'result'|'think'|'forced'|'retry'|'usage'|'done'|'snapshot'|'unknown', ... }`.
  Task 2 consumes `splitWakes`.

- [ ] **Step 1: Build the fixtures from the real log**

Each fixture is a byte-exact slice of the live log, so the parser is tested against what the runtime actually writes.

```bash
cd /srv/appdata/chrome-automation/sim
mkdir -p autopilot/tests/fixtures web/wake

# A wake that completed cleanly (rc=0).
A=$(grep -n '17:52:01 CDT BRAIN WAKE' autopilot/brain.log | tail -1 | cut -d: -f1)
B=$(grep -n '18:36:01 CDT BRAIN WAKE' autopilot/brain.log | tail -1 | cut -d: -f1)
sed -n "${A},$((B-1))p" autopilot/brain.log > autopilot/tests/fixtures/wake-clean.log

# A wake killed by a provider 503 after one call (rc=1).
C=$(grep -n '21:39:01 CDT BRAIN WAKE' autopilot/brain.log | tail -1 | cut -d: -f1)
D=$(grep -n '21:48:01 CDT BRAIN WAKE' autopilot/brain.log | tail -1 | cut -d: -f1)
sed -n "${C},$((D-1))p" autopilot/brain.log > autopilot/tests/fixtures/wake-503.log

# A wake with no completion line: the first 12 lines of the clean one.
head -12 autopilot/tests/fixtures/wake-clean.log > autopilot/tests/fixtures/wake-running.log

wc -l autopilot/tests/fixtures/*.log
```

Expected: three files, each with a non-zero line count. If any is empty the wake markers have scrolled out of the log; pick two other adjacent `BRAIN WAKE` lines and adjust.

- [ ] **Step 2: Write the failing test**

Create `autopilot/tests/wake-parse.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { splitWakes } = require('../../web/wake/parse.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

test('a wake banner starts a wake and carries its provider', () => {
  const wakes = splitWakes(read('wake-clean.log'));
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].banner, /BRAIN WAKE/);
  assert.equal(wakes[0].provider, 'deepseek');
  assert.equal(wakes[0].model, 'deepseek-v4-flash');
});

test('tool calls are captured with their name and raw arguments', () => {
  const [wake] = splitWakes(read('wake-clean.log'));
  const tools = wake.events.filter(e => e.kind === 'tool');
  assert.ok(tools.length >= 2, `expected several tool calls, got ${tools.length}`);
  assert.equal(tools[0].name, 'collect');
  assert.equal(typeof tools[0].args, 'string');
  assert.match(tools[0].t, /^\d{4}-\d{2}-\d{2}T/);
});

// The result line is the timestamp, THREE spaces, then "-> ". Matching on "->" alone
// would also swallow arrows inside a JSON payload on a continuation line.
test('a result line is bound to the tool call above it', () => {
  const [wake] = splitWakes(read('wake-clean.log'));
  const results = wake.events.filter(e => e.kind === 'result');
  assert.ok(results.length >= 1);
  assert.equal(typeof results[0].raw, 'string');
  assert.match(results[0].raw, /^\{/);
});

test('two wakes in one buffer split into two', () => {
  const text = read('wake-clean.log') + read('wake-503.log');
  assert.equal(splitWakes(text).length, 2);
});

test('text with no banner yields no wakes rather than throwing', () => {
  assert.deepEqual(splitWakes('nothing to see here\n'), []);
  assert.deepEqual(splitWakes(''), []);
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd /srv/appdata/chrome-automation/sim && node --test autopilot/tests/wake-parse.test.js`

Expected: FAIL — `Cannot find module '../../web/wake/parse.js'`.

- [ ] **Step 4: Write the parser**

Create `web/wake/parse.js`:

```javascript
'use strict';

// Reads autopilot/brain.log. The log is a human-facing artifact, not a promised interface,
// so every shape below is optional: an unrecognised line becomes an 'unknown' event and is
// counted, never thrown. A visualiser that dies on one odd line is worse than one that
// shows slightly less.

const BANNER = /^═+ (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z]{2,4}) BRAIN WAKE ═+$/;
const PROVIDER = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,4} provider=(\S+) model=(\S+) effort=(\S+)/;
const TOOL = /^(\d{4}-\d{2}-\d{2}T\S+Z) TOOL ([a-z_]+) ?(.*)$/;
const RESULT = /^(\d{4}-\d{2}-\d{2}T\S+Z)\s+-> (.*)$/;
const THINK = /^(\d{4}-\d{2}-\d{2}T\S+Z) THINK: (.*)$/;
const FORCED = /^(\d{4}-\d{2}-\d{2}T\S+Z) DEEPSEEK_NEXT_TOOL_FORCED (\S+)(.*)$/;
const RETRY = /^(\d{4}-\d{2}-\d{2}T\S+Z) MODEL_REQUEST_RETRY (.*)$/;
const USAGE = /^USAGE wake=(\S+) calls=(\d+) tokens=(\d+) cost=(.*)$/;
const DONE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,4} BRAIN done rc=(\d+)/;
const SNAPSHOT = /^\{"ok":true,"money":(\d+),"level":(\d+),"buildings":(\d+)\}$/;

function classify(line) {
  let m;
  if ((m = line.match(TOOL))) return { t: m[1], kind: 'tool', name: m[2], args: m[3] };
  if ((m = line.match(RESULT))) return { t: m[1], kind: 'result', raw: m[2] };
  if ((m = line.match(THINK))) return { t: m[1], kind: 'think', text: m[2] };
  if ((m = line.match(FORCED))) return { t: m[1], kind: 'forced', tool: m[2] };
  if ((m = line.match(RETRY))) return { t: m[1], kind: 'retry', text: m[2] };
  if ((m = line.match(USAGE))) {
    return { t: null, kind: 'usage', calls: Number(m[2]), tokens: Number(m[3]), cost: m[4] };
  }
  if ((m = line.match(DONE))) return { t: null, kind: 'done', rc: Number(m[1]) };
  if ((m = line.match(SNAPSHOT))) {
    return { t: null, kind: 'snapshot', money: Number(m[1]), level: Number(m[2]), buildings: Number(m[3]) };
  }
  return { t: null, kind: 'unknown', text: line };
}

function splitWakes(text) {
  const wakes = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const banner = line.match(BANNER);
    if (banner) {
      current = {
        banner: line,
        startedAtLocal: `${banner[1]} ${banner[2]} ${banner[3]}`,
        provider: null,
        model: null,
        effort: null,
        events: [],
      };
      wakes.push(current);
      continue;
    }
    if (!current || line === '') continue;
    const provider = line.match(PROVIDER);
    if (provider) {
      current.provider = provider[1];
      current.model = provider[2];
      current.effort = provider[3];
      continue;
    }
    current.events.push(classify(line));
  }
  return wakes;
}

module.exports = { splitWakes, classify };
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `cd /srv/appdata/chrome-automation/sim && node --test autopilot/tests/wake-parse.test.js`

Expected: PASS, 5/5.

- [ ] **Step 6: Commit**

```bash
cd /srv/appdata/chrome-automation/sim
git add web/wake/parse.js autopilot/tests/wake-parse.test.js autopilot/tests/fixtures/
git commit -m "Parse brain.log into wakes and events"
```

---

### Task 2: Parser — project a wake into panel state

**Files:**
- Modify: `web/wake/parse.js`
- Modify: `autopilot/tests/wake-parse.test.js`

**Interfaces:**
- Consumes: `splitWakes` from Task 1.
- Produces: `projectPanels({ text, lastWake, nextWake, nowMs }) -> PanelState`.
  `PanelState = { status, wake, money, thinking, council, progress, lastActions, blocked, unparsed, lastLineAtMs }`
  with `status` one of `'running' | 'silent' | 'done' | 'idle'`. Task 3 sends this object over SSE
  unchanged; Task 4 renders exactly these field names.

- [ ] **Step 1: Write the failing tests**

Append to `autopilot/tests/wake-parse.test.js`:

```javascript
const { projectPanels } = require('../../web/wake/parse.js');

// Three minutes without a new line means the wake stopped emitting. Both failure modes seen
// on 2026-08-03 — a manual kill and a 40-round exhaustion — look exactly like this in the log.
const SILENCE_MS = 3 * 60 * 1000;

function atLastLine(text, offsetMs = 0) {
  const stamps = text.match(/\d{4}-\d{2}-\d{2}T\S+Z/g) || [];
  return Date.parse(stamps[stamps.length - 1]) + offsetMs;
}

test('a finished wake reports done with its exit code and cost', () => {
  const text = read('wake-clean.log');
  const panels = projectPanels({ text, nowMs: atLastLine(text, 1000) });
  assert.equal(panels.status, 'done');
  assert.equal(panels.progress.rc, 0);
  assert.equal(panels.progress.calls, 22);
  assert.match(panels.progress.cost, /^\$/);
});

test('a wake still emitting reports running', () => {
  const text = read('wake-running.log');
  const panels = projectPanels({ text, nowMs: atLastLine(text, 5000) });
  assert.equal(panels.status, 'running');
});

test('a wake that stopped emitting reports silent, not running', () => {
  const text = read('wake-running.log');
  const panels = projectPanels({ text, nowMs: atLastLine(text, SILENCE_MS + 1000) });
  assert.equal(panels.status, 'silent');
  assert.ok(panels.silentForMs >= SILENCE_MS);
});

test('the failed 503 wake is done with a non-zero code', () => {
  const text = read('wake-503.log');
  const panels = projectPanels({ text, nowMs: atLastLine(text, 1000) });
  assert.equal(panels.status, 'done');
  assert.equal(panels.progress.rc, 1);
});

test('reasoning keeps the latest line and the one before it', () => {
  const text = read('wake-clean.log');
  const panels = projectPanels({ text, nowMs: atLastLine(text, 1000) });
  assert.equal(typeof panels.thinking.latest, 'string');
  assert.ok(panels.thinking.latest.length > 0);
  assert.ok('previous' in panels.thinking);
});

test('the last three actions are newest first, with an outcome each', () => {
  const text = read('wake-clean.log');
  const panels = projectPanels({ text, nowMs: atLastLine(text, 1000) });
  assert.ok(panels.lastActions.length > 0 && panels.lastActions.length <= 3);
  for (const action of panels.lastActions) {
    assert.equal(typeof action.name, 'string');
    assert.ok(['ok', 'blocked', 'failed', 'pending'].includes(action.outcome));
  }
});

test('a guard block surfaces its reason', () => {
  const guarded = read('wake-clean.log').replace(
    /^(\d{4}-\d{2}-\d{2}T\S+Z)\s+-> \{"ok":true/m,
    '$1   -> {"ok":false,"guard":true,"reason":"building busy — cannot upgrade"');
  const panels = projectPanels({ text: guarded, nowMs: atLastLine(guarded, 1000) });
  assert.ok(panels.blocked);
  assert.match(panels.blocked.reason, /building busy/);
});

test('with no wake in the buffer the state is idle and names the next alarm', () => {
  const panels = projectPanels({
    text: '',
    nextWake: { atIso: '2026-08-04T02:38:30.000Z', reason: 'Mill completes 02:37:13Z' },
    nowMs: Date.parse('2026-08-04T02:25:30.000Z'),
  });
  assert.equal(panels.status, 'idle');
  assert.equal(panels.nextWake.reason, 'Mill completes 02:37:13Z');
  assert.equal(panels.nextWake.inMs, 13 * 60 * 1000);
});

test('the wake reason comes from the consumed alarm, not the log', () => {
  const text = read('wake-clean.log');
  const panels = projectPanels({
    text,
    lastWake: { reason: 'Grocery ground sale completes 01:41:25Z' },
    nowMs: atLastLine(text, 1000),
  });
  assert.equal(panels.wake.reason, 'Grocery ground sale completes 01:41:25Z');
});

// brain.log elides long tool results, so stock is not in the log. It is supplied from
// autopilot/.state.json instead; the parser must pass it through without inventing anything.
test('warehouse is passed through and defaults to empty', () => {
  const text = read('wake-clean.log');
  const rows = [{ name: 'coffee beans', amount: 6628 }];
  assert.deepEqual(projectPanels({ text, warehouse: rows, nowMs: atLastLine(text, 1000) }).warehouse, rows);
  assert.deepEqual(projectPanels({ text, nowMs: atLastLine(text, 1000) }).warehouse, []);
});

test('unparsed lines are counted, not thrown', () => {
  const text = read('wake-clean.log') + '\nthis line means nothing\n';
  const panels = projectPanels({ text, nowMs: atLastLine(text, 1000) });
  assert.ok(panels.unparsed >= 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /srv/appdata/chrome-automation/sim && node --test autopilot/tests/wake-parse.test.js`

Expected: FAIL — `projectPanels is not a function`.

- [ ] **Step 3: Implement the projection**

Append to `web/wake/parse.js`, before `module.exports`, and replace the export line:

```javascript
const SILENCE_MS = 3 * 60 * 1000;
const MAX_ROUNDS = 40;

function safeJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// A result belongs to the tool call above it. Outcome is read from the parsed body when it is
// valid JSON; a truncated body (the log elides long payloads) still counts as a reply, so an
// unreadable result is 'ok' rather than 'failed' — claiming failure we cannot see would be worse.
function pairActions(events) {
  const actions = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind !== 'tool') continue;
    const result = events.slice(i + 1).find(e => e.kind === 'result' || e.kind === 'tool');
    let outcome = 'pending';
    if (result && result.kind === 'result') {
      const body = safeJson(result.raw);
      if (body === null) outcome = 'ok';
      else if (body.guard === true) outcome = 'blocked';
      else if (body.ok === false) outcome = 'failed';
      else outcome = 'ok';
    }
    actions.push({ t: events[i].t, name: events[i].name, outcome, result: result || null });
  }
  return actions;
}

function lastLineMs(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ms = Date.parse(events[i].t);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// lastWake is the CONSUMED alarm (autopilot/.last-wake.json); its `reason` is the only place the
// running wake's purpose is recorded. warehouse comes from autopilot/.state.json because brain.log
// elides long tool results — 6,504 of them carry "[N chars omitted]", so refresh_state bodies are
// not valid JSON and stock cannot be recovered from the log at all.
function projectPanels({ text = '', nextWake = null, lastWake = null, warehouse = null,
                         nowMs = Date.now() } = {}) {
  const wakes = splitWakes(text);
  const wake = wakes[wakes.length - 1] || null;

  if (!wake) {
    const atMs = nextWake ? Date.parse(nextWake.atIso) : NaN;
    return {
      status: 'idle',
      wake: null,
      nextWake: nextWake
        ? { atIso: nextWake.atIso, reason: nextWake.reason || null,
            inMs: Number.isFinite(atMs) ? atMs - nowMs : null }
        : null,
      money: { cash: null, deltaSinceStart: null },
      warehouse: Array.isArray(warehouse) ? warehouse : [],
      thinking: { latest: null, previous: null },
      council: null,
      progress: { step: 0, max: MAX_ROUNDS, elapsedMs: null, cost: null, calls: null, rc: null },
      lastActions: [],
      blocked: null,
      unparsed: 0,
      lastLineAtMs: null,
    };
  }

  const events = wake.events;
  const actions = pairActions(events);
  const thinks = events.filter(e => e.kind === 'think');
  const snapshots = events.filter(e => e.kind === 'snapshot');
  const usage = events.filter(e => e.kind === 'usage').pop() || null;
  const done = events.filter(e => e.kind === 'done').pop() || null;

  const blockedAction = [...actions].reverse().find(a => a.outcome === 'blocked');
  const blockedBody = blockedAction ? safeJson(blockedAction.result.raw) : null;

  const lastMs = lastLineMs(events);
  const silentForMs = lastMs == null ? null : nowMs - lastMs;
  let status = 'running';
  if (done) status = 'done';
  else if (silentForMs != null && silentForMs >= SILENCE_MS) status = 'silent';

  const councilCalls = actions.filter(a => a.name === 'strategy_council' || a.name === 'council');

  return {
    status,
    silentForMs,
    wake: {
      startedAtLocal: wake.startedAtLocal,
      provider: wake.provider,
      model: wake.model,
      reason: lastWake && lastWake.reason ? String(lastWake.reason) : null,
    },
    warehouse: Array.isArray(warehouse) ? warehouse : [],
    nextWake: null,
    money: {
      cash: snapshots.length ? snapshots[snapshots.length - 1].money : null,
      deltaSinceStart: snapshots.length >= 2
        ? snapshots[snapshots.length - 1].money - snapshots[0].money
        : null,
      level: snapshots.length ? snapshots[snapshots.length - 1].level : null,
      buildings: snapshots.length ? snapshots[snapshots.length - 1].buildings : null,
    },
    thinking: {
      latest: thinks.length ? thinks[thinks.length - 1].text : null,
      previous: thinks.length >= 2 ? thinks[thinks.length - 2].text : null,
    },
    council: { calls: councilCalls.length, latest: councilCalls.length ? councilCalls[councilCalls.length - 1].outcome : null },
    progress: {
      step: actions.length,
      max: MAX_ROUNDS,
      elapsedMs: lastMs == null ? null : lastMs - (Date.parse(events.find(e => e.t)?.t) || lastMs),
      cost: usage ? (usage.cost.match(/\$[\d.]+/) || [null])[0] : null,
      calls: usage ? usage.calls : null,
      tokens: usage ? usage.tokens : null,
      rc: done ? done.rc : null,
    },
    lastActions: actions.slice(-3).reverse().map(a => ({ name: a.name, outcome: a.outcome, t: a.t })),
    blocked: blockedBody && blockedBody.reason ? { reason: String(blockedBody.reason) } : null,
    unparsed: events.filter(e => e.kind === 'unknown').length,
    lastLineAtMs: lastMs,
  };
}

module.exports = { splitWakes, classify, projectPanels, SILENCE_MS, MAX_ROUNDS };
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd /srv/appdata/chrome-automation/sim && node --test autopilot/tests/wake-parse.test.js`

Expected: PASS, 16/16.

- [ ] **Step 5: Run the whole suite to prove nothing else broke**

Run: `cd /srv/appdata/chrome-automation/sim && node --test autopilot/tests/*.test.js 2>&1 | grep -E '^# (tests|pass|fail)'`

Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
cd /srv/appdata/chrome-automation/sim
git add web/wake/parse.js autopilot/tests/wake-parse.test.js
git commit -m "Project a parsed wake into panel state"
```

---

### Task 3: The service — follow the log, serve SSE

**Files:**
- Create: `web/wake/server.js`
- Create: `autopilot/tests/wake-server.test.js`

**Interfaces:**
- Consumes: `projectPanels` from Task 2.
- Produces: `readState({ logPath, nextWakePath, tailBytes, nowMs }) -> PanelState`, and an HTTP
  server on `WAKE_PORT` (default 8091) serving `GET /` (the page), `GET /events` (SSE) and
  `GET /state` (one JSON snapshot, used by the tests). Task 4's page consumes `/events`.

- [ ] **Step 1: Write the failing test**

Create `autopilot/tests/wake-server.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readState } = require('../../web/wake/server.js');

const FIXTURES = path.join(__dirname, 'fixtures');

function tempLog(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-server-'));
  const logPath = path.join(dir, 'brain.log');
  fs.copyFileSync(path.join(FIXTURES, fixture), logPath);
  return { dir, logPath };
}

test('state is read from the tail of a log file', () => {
  const { logPath } = tempLog('wake-clean.log');
  const state = readState({ logPath, nowMs: Date.now() });
  assert.equal(state.status, 'done');
  assert.equal(state.progress.rc, 0);
});

// Only the tail is read, so a 3.6 MB log costs the same as a small one. The tail must still
// begin at a line boundary or the first entry after the cut is garbage.
test('reading only the tail never yields a partial first line', () => {
  const { logPath } = tempLog('wake-clean.log');
  const size = fs.statSync(logPath).size;
  const state = readState({ logPath, tailBytes: Math.floor(size / 2), nowMs: Date.now() });
  assert.equal(state.unparsed, 0, 'a mid-line cut must be discarded, not parsed');
});

test('a missing log gives idle rather than throwing', () => {
  const state = readState({ logPath: '/nonexistent/brain.log', nowMs: Date.now() });
  assert.equal(state.status, 'idle');
});

test('the next alarm file feeds the idle countdown', () => {
  const { dir } = tempLog('wake-clean.log');
  const nextWakePath = path.join(dir, 'next-wake.json');
  fs.writeFileSync(nextWakePath, JSON.stringify({
    atIso: '2026-08-04T02:38:30.000Z', reason: 'Mill completes',
  }));
  const state = readState({
    logPath: '/nonexistent/brain.log',
    nextWakePath,
    nowMs: Date.parse('2026-08-04T02:28:30.000Z'),
  });
  assert.equal(state.status, 'idle');
  assert.equal(state.nextWake.inMs, 10 * 60 * 1000);
});

test('a malformed alarm file does not break the read', () => {
  const { dir } = tempLog('wake-clean.log');
  const nextWakePath = path.join(dir, 'next-wake.json');
  fs.writeFileSync(nextWakePath, 'not json at all');
  const state = readState({ logPath: '/nonexistent/brain.log', nextWakePath, nowMs: Date.now() });
  assert.equal(state.status, 'idle');
  assert.equal(state.nextWake, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /srv/appdata/chrome-automation/sim && node --test autopilot/tests/wake-server.test.js`

Expected: FAIL — `Cannot find module '../../web/wake/server.js'`.

- [ ] **Step 3: Write the service**

Create `web/wake/server.js`:

```javascript
'use strict';

// Read-only observer for the Sim Companies autopilot. It follows autopilot/brain.log and the
// alarm files and pushes panel state to browsers over Server-Sent Events.
//
// It never calls the game API, never takes .tick.lock, and writes nothing. If this process dies
// the autopilot does not notice; that is the whole point of keeping the observer outside.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { projectPanels } = require('./parse.js');

const SIM = path.join(__dirname, '..', '..');
const LOG_PATH = path.join(SIM, 'autopilot', 'brain.log');
const NEXT_WAKE_PATH = path.join(SIM, 'autopilot', 'next-wake.json');
const LAST_WAKE_PATH = path.join(SIM, 'autopilot', '.last-wake.json');
const STATE_PATH = path.join(SIM, 'autopilot', '.state.json');
const PAGE_PATH = path.join(__dirname, 'index.html');
const PORT = Number(process.env.WAKE_PORT) || 8091;
const POLL_MS = 1000;

// One wake is a few hundred lines. This is generous enough to hold two of them and small enough
// that re-reading it every second is free.
const TAIL_BYTES = 512 * 1024;

function readTail(logPath, tailBytes) {
  let fd;
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    // A byte offset almost never lands on a line boundary. Drop whatever precedes the first
    // newline: parsing half a line produces a bogus first entry on every read.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// The runtime rewrites .state.json at the open and the close of every wake, so mid-wake this is
// the opening position. That is honest: it is labelled a level, not a delta.
function readWarehouse(statePath) {
  const state = readJsonOrNull(statePath);
  if (!state || !Array.isArray(state.stock)) return [];
  return state.stock
    .filter(row => Number(row && row.amount) > 0)
    .map(row => ({ name: row.name || String(row.kind), amount: Number(row.amount) }));
}

function readState({
  logPath = LOG_PATH,
  nextWakePath = NEXT_WAKE_PATH,
  lastWakePath = LAST_WAKE_PATH,
  statePath = STATE_PATH,
  tailBytes = TAIL_BYTES,
  nowMs = Date.now(),
} = {}) {
  return projectPanels({
    text: readTail(logPath, tailBytes),
    nextWake: readJsonOrNull(nextWakePath),
    lastWake: readJsonOrNull(lastWakePath),
    warehouse: readWarehouse(statePath),
    nowMs,
  });
}

function startServer(port = PORT) {
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(readState()));
      return;
    }

    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(readState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/' || url === '/index.html') {
      fs.readFile(PAGE_PATH, (error, body) => {
        if (error) { res.writeHead(500).end('page missing'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      });
      return;
    }

    res.writeHead(404).end('not found');
  });

  // Push only when the state actually changed. An idle company would otherwise send an identical
  // payload every second to every open tab for hours.
  let previous = '';
  const timer = setInterval(() => {
    if (clients.size === 0) return;
    const payload = JSON.stringify(readState());
    if (payload === previous) return;
    previous = payload;
    for (const client of clients) client.write(`data: ${payload}\n\n`);
  }, POLL_MS);
  timer.unref();

  server.listen(port, '127.0.0.1');
  return server;
}

if (require.main === module) startServer();

module.exports = { readState, readTail, readWarehouse, startServer, TAIL_BYTES, PORT };
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd /srv/appdata/chrome-automation/sim && node --test autopilot/tests/wake-server.test.js`

Expected: PASS, 5/5.

- [ ] **Step 5: Prove it serves live state by hand**

```bash
cd /srv/appdata/chrome-automation/sim
WAKE_PORT=8137 node web/wake/server.js &
sleep 1
curl -s http://127.0.0.1:8137/state | head -c 400
kill %1
```

Expected: a JSON object whose `status` is one of `running`, `done`, `silent` or `idle`, describing the real current company.

- [ ] **Step 6: Commit**

```bash
cd /srv/appdata/chrome-automation/sim
git add web/wake/server.js autopilot/tests/wake-server.test.js
git commit -m "Serve wake panel state over SSE"
```

---

### Task 4: The page

**Files:**
- Create: `web/wake/index.html`

**Interfaces:**
- Consumes: the SSE stream at `/events` and the `PanelState` field names from Task 2.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the page**

Create `web/wake/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>autopilot · wake</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #12141a; color: #e6e8ee;
         font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; }
  header { padding: 14px 18px; border-bottom: 1px solid #262a35; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .reason { margin-top: 3px; color: #9aa1b1; font-size: 13px; }
  main { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; padding: 12px 18px; }
  .card { background: #171a22; border: 1px solid #262a35; border-radius: 8px; padding: 12px 14px; }
  .label { font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: #7b8394; }
  .think { margin-top: 8px; font-size: 15px; line-height: 1.65; white-space: pre-wrap; }
  .think.prev { margin-top: 14px; font-size: 13px; color: #737b8d; }
  .cash { font: 600 26px/1.2 ui-monospace, monospace; margin-top: 6px; }
  .delta { font: 13px/1.4 ui-monospace, monospace; }
  .up { color: #62c07c; } .down { color: #e0736c; } .warn { color: #e0a458; }
  .lines { margin-top: 10px; font: 12px/1.85 ui-monospace, monospace; color: #b9c0cf; }
  .stack { display: grid; gap: 12px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
  .live { background: #62c07c; } .idle { background: #7b8394; }
  .bad { background: #e0736c; } .lost { background: #e0a458; }
  #offline { display: none; padding: 6px 18px; background: #3a2a1a; color: #e0a458; font-size: 13px; }
</style>

<div id="offline">Lost the connection to the wake service — showing the last state received.</div>
<header>
  <h1><span id="dot" class="dot idle"></span><span id="title">connecting…</span></h1>
  <div class="reason" id="reason"></div>
</header>
<main>
  <div class="card">
    <div class="label">Thinking</div>
    <div class="think" id="think">—</div>
    <div class="think prev" id="think-prev"></div>
  </div>
  <div class="stack">
    <div class="card">
      <div class="label">Money</div>
      <div class="cash" id="cash">—</div>
      <div class="delta" id="delta"></div>
    </div>
    <div class="card">
      <div class="label">Status</div>
      <div class="lines" id="lines"></div>
    </div>
  </div>
</main>

<script type="module">
  const $ = id => document.getElementById(id);
  const money = n => n == null ? '—' : '$' + n.toLocaleString('en-US');
  const mins = ms => ms == null ? '—'
    : ms < 60000 ? Math.round(ms / 1000) + 's'
    : Math.floor(ms / 60000) + 'm' + String(Math.round((ms % 60000) / 1000)).padStart(2, '0') + 's';

  function render(s) {
    const dot = { running: 'live', done: 'idle', silent: 'lost', idle: 'idle' }[s.status] || 'idle';
    $('dot').className = 'dot ' + (s.progress?.rc > 0 ? 'bad' : dot);

    if (s.status === 'idle') {
      $('title').textContent = s.nextWake
        ? `idle · next wake in ${mins(s.nextWake.inMs)}`
        : 'idle · no alarm set';
      $('reason').textContent = s.nextWake?.reason || '';
    } else {
      const tail = s.status === 'silent' ? `silent ${mins(s.silentForMs)}`
        : s.status === 'done' ? `finished rc=${s.progress.rc}`
        : `running ${mins(s.progress.elapsedMs)}`;
      $('title').textContent = `wake ${s.wake.startedAtLocal} · ${tail} · ${s.wake.model || '?'}`;
      $('reason').textContent = s.wake.reason || '';
    }

    $('think').textContent = s.thinking.latest || '—';
    $('think-prev').textContent = s.thinking.previous || '';

    $('cash').textContent = money(s.money.cash);
    const d = s.money.deltaSinceStart;
    $('delta').className = 'delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
    $('delta').textContent = d == null ? '' : `${d > 0 ? '+' : ''}${money(d)} this wake`;

    const rows = [];
    if (s.council?.calls) rows.push(`council · ${s.council.calls} call(s) · ${s.council.latest || '—'}`);
    rows.push(`step ${s.progress.step}/${s.progress.max}${s.progress.cost ? ' · ' + s.progress.cost : ''}`);
    if (s.money.level != null) rows.push(`level ${s.money.level} · ${s.money.buildings} buildings`);
    for (const a of s.lastActions) {
      const mark = { ok: '✓', blocked: '⛔', failed: '✗', pending: '⋯' }[a.outcome];
      rows.push(`${mark} ${a.name}`);
    }
    if (s.warehouse?.length) {
      rows.push(s.warehouse.slice(0, 4).map(w => `${w.name} ${w.amount.toLocaleString('en-US')}`).join(' · '));
    }
    if (s.blocked) rows.push(`<span class="warn">blocked: ${s.blocked.reason}</span>`);
    if (s.unparsed) rows.push(`<span class="warn">${s.unparsed} line(s) not understood</span>`);
    $('lines').innerHTML = rows.join('<br>');
  }

  // EventSource reconnects by itself. The banner is the only signal the page cannot fake, so it
  // stays until a message actually arrives — the last known state is left on screen underneath.
  const source = new EventSource('events');
  source.onmessage = event => {
    $('offline').style.display = 'none';
    try { render(JSON.parse(event.data)); } catch (_) {}
  };
  source.onerror = () => { $('offline').style.display = 'block'; };
</script>
```

- [ ] **Step 2: Verify it renders against the live company**

```bash
cd /srv/appdata/chrome-automation/sim
WAKE_PORT=8137 node web/wake/server.js &
sleep 1
curl -s http://127.0.0.1:8137/ | grep -c 'id="think"'
curl -s -N --max-time 3 http://127.0.0.1:8137/events | head -c 200
kill %1
```

Expected: `1` from the first command, and the SSE stream opening with `data: {"status":…`.

- [ ] **Step 3: Commit**

```bash
cd /srv/appdata/chrome-automation/sim
git add web/wake/index.html
git commit -m "Render the wake panels in the browser"
```

---

### Task 5: Deploy — systemd unit and Caddy route

**Files:**
- Create: `deploy/wake-visualizer.service`
- Modify: `/srv/appdata/caddy/Caddyfile` (add one `handle_path /wake/*` block)

**Interfaces:**
- Consumes: `web/wake/server.js` from Task 3.
- Produces: `https://jimmyyu888.com/wake/` for LAN and Tailscale clients.

- [ ] **Step 1: Write the unit**

Create `deploy/wake-visualizer.service`:

```ini
[Unit]
Description=Sim Companies autopilot wake visualizer (read-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jimmy
Group=jimmy
WorkingDirectory=/srv/appdata/chrome-automation/sim
ExecStart=/usr/bin/node /srv/appdata/chrome-automation/sim/web/wake/server.js
Environment=WAKE_PORT=8091
Restart=on-failure
RestartSec=5
# It only ever reads. Nothing it can do should be able to touch the autopilot.
ProtectSystem=strict
ReadOnlyPaths=/srv/appdata/chrome-automation/sim
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Install and start it**

```bash
sudo cp /srv/appdata/chrome-automation/sim/deploy/wake-visualizer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wake-visualizer.service
systemctl is-active wake-visualizer.service
curl -s http://127.0.0.1:8091/state | head -c 120
```

Expected: `active`, then a JSON state object.

- [ ] **Step 3: Add the Caddy route without replacing the file's inode**

`./Caddyfile` is a **single-file** bind mount. Writing it atomically swaps the inode and the
container keeps serving the old contents while `caddy validate` and `caddy reload` both report
success. Rewrite it in place instead.

```bash
python3 - <<'PY'
import re, io
path = '/srv/appdata/caddy/Caddyfile'
block = '''
	redir /wake /wake/ 308
	handle_path /wake/* {
		@wakeAllowed remote_ip 100.64.0.0/10 192.168.0.0/16 127.0.0.1/8
		handle @wakeAllowed {
			header Cache-Control "no-cache"
			reverse_proxy 127.0.0.1:8091
		}
		respond "Forbidden — private endpoint" 403
	}
'''
with io.open(path, 'r+', encoding='utf-8') as fh:
    text = fh.read()
    assert '/wake/*' not in text, 'the wake route is already present'
    anchor = '\tredir /money /money/ 308'
    assert anchor in text, 'anchor line not found; inspect the Caddyfile by hand'
    text = text.replace(anchor, block.lstrip('\n') + anchor, 1)
    fh.seek(0); fh.write(text); fh.truncate()
print('inserted')
PY
stat -c '%i %n' /srv/appdata/caddy/Caddyfile
docker exec caddy grep -c '/wake/\*' /etc/caddy/Caddyfile
```

Expected: `inserted`, an inode number, then `1` — the container sees the new content, which proves
the inode survived.

- [ ] **Step 4: Reload Caddy and verify from the LAN**

```bash
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
curl -s -o /dev/null -w 'local: %{http_code}\n' https://jimmyyu888.com/wake/
curl -s https://jimmyyu888.com/wake/ | grep -c 'id="think"'
```

Expected: `local: 200` and `1`. Other sites must still answer:

```bash
curl -s -o /dev/null -w 'drive: %{http_code}\n' https://jimmyyu888.com/drive/
```

Expected: the same status it returned before the change.

- [ ] **Step 5: Commit**

```bash
cd /srv/appdata/chrome-automation/sim
git add deploy/wake-visualizer.service
git commit -m "Deploy the wake visualizer behind Caddy on the private network"
```

- [ ] **Step 6: Watch one real wake end to end**

The parser tests cannot prove the service is attached to a live log. Open
`https://jimmyyu888.com/wake/` from the Windows machine and leave it open across a wake boundary.

Confirm: the idle countdown reaches zero, the header flips to `running`, the thinking panel changes
as the model reasons, actions appear with their marks, and the header settles on `finished rc=0`.

If the page stays idle while `autopilot/brain.log` is growing, the tail window or the banner regex
is wrong — check `curl -s http://127.0.0.1:8091/state | head -c 300` first to see whether the
service or the page is at fault.
