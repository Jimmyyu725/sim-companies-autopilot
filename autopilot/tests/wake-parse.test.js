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
  // Replace the whole line, not just the "{"ok":true" prefix: the first such line in this
  // fixture is one of brain.log's elided results ("[N chars omitted]"), so a prefix-only
  // swap would leave the truncated tail attached and produce unparseable JSON.
  const guarded = read('wake-clean.log').replace(
    /^(\d{4}-\d{2}-\d{2}T\S+Z)\s+-> \{"ok":true.*$/m,
    '$1   -> {"ok":false,"guard":true,"reason":"building busy — cannot upgrade"}');
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

// A renderer downstream will read s.council.calls and s.progress.step unconditionally, on any
// status. PanelState must therefore carry the same keys — top level and in each nested object —
// whether the wake is idle or running; only the values may differ. Comparing key sets (rather
// than values, which legitimately differ) is what catches a branch that drops or nulls out a
// whole nested object instead of filling it with placeholder values.
test('idle and running PanelState objects expose the same keys', () => {
  const idle = projectPanels({ text: '' });
  const runningText = read('wake-running.log');
  const running = projectPanels({ text: runningText, nowMs: atLastLine(runningText, 5000) });

  // Object.keys(null) throws, which would let a raw TypeError stand in for a real assertion
  // failure. Render non-objects as a distinct sentinel instead so a dropped nested object still
  // shows up as a clean, readable mismatch.
  const keysOf = value => (value === null || typeof value !== 'object')
    ? `<${value}>`
    : Object.keys(value).sort().join(',');

  assert.equal(keysOf(idle), keysOf(running), 'top-level PanelState keys differ');
  assert.equal(keysOf(idle.money), keysOf(running.money), 'money keys differ');
  assert.equal(keysOf(idle.council), keysOf(running.council), 'council keys differ');
  assert.equal(keysOf(idle.progress), keysOf(running.progress), 'progress keys differ');
});

test('appending N unparseable lines raises the unparsed count by exactly N', () => {
  const clean = read('wake-clean.log');
  const baseline = projectPanels({ text: clean, nowMs: atLastLine(clean, 1000) });

  const N = 3;
  const garbage = Array.from({ length: N }, (_, i) => `this line means nothing (${i})`).join('\n');
  const text = clean + '\n' + garbage + '\n';
  const panels = projectPanels({ text, nowMs: atLastLine(text, 1000) });

  assert.equal(panels.unparsed, baseline.unparsed + N);
});
