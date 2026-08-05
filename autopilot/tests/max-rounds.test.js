'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENGINES = [
  ['responses engine', require('../brain56.js')],
  ['chat-completions engine', require('../brain.js')],
];

// Owner directive 2026-08-05: the round ceiling is removed. Both engines have to agree on what the
// environment variable means, because run-brain.sh exports the same value to whichever one runs.
for (const [engineName, engine] of ENGINES) {
  test(`${engineName}: unlimited spellings all remove the ceiling`, () => {
    for (const raw of ['unlimited', 'UNLIMITED', ' unlimited ', 'infinity', '0']) {
      assert.equal(engine.resolveMaxRounds(raw), Number.POSITIVE_INFINITY, JSON.stringify(raw));
    }
  });

  test(`${engineName}: an explicit count still pins the ceiling`, () => {
    assert.equal(engine.resolveMaxRounds('7'), 7);
    assert.equal(engine.resolveMaxRounds('50'), 50);
    // No upper bound any more — the old parser silently fell back to 30 above 50, which meant a
    // deliberately large value quietly became a smaller one.
    assert.equal(engine.resolveMaxRounds('500'), 500);
  });

  test(`${engineName}: unusable input falls back rather than running unbounded`, () => {
    for (const raw of [undefined, null, '', '   ', 'garbage', '-5', '1.5e400']) {
      assert.equal(engine.resolveMaxRounds(raw), 30, JSON.stringify(raw));
    }
  });

  test(`${engineName}: Infinity is safe for the closing-budget bookkeeping`, () => {
    const { closingBudgetActive, closingBudgetDirective } = require('../runtime-guard.js');
    const remaining = Number.POSITIVE_INFINITY - 1;
    assert.equal(closingBudgetActive(remaining), false);
    assert.equal(closingBudgetDirective(remaining, { ok: false, missing: ['journal'] }), null);
  });
}

// With the ceiling gone, this is the only thing bounding a wake. It is a shell-level guarantee, so
// nothing else in the suite would notice if it were dropped — which is exactly how brain56 ended up
// ignoring BRAIN_MAX_ROUNDS for weeks without a failing test.
test('run-brain.sh bounds the engine with a wall-clock backstop', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'run-brain.sh'), 'utf8');

  const invocation = runner.match(/^(.*)node "\$\{BRAIN_JS:-autopilot\/brain\.js\}"/mu);
  assert.ok(invocation, 'the engine invocation must still be recognisable');
  assert.match(invocation[1], /timeout -k \d+ \d+ $/u,
    'the engine must run under timeout, with a kill signal after the term signal');

  const seconds = Number(invocation[1].match(/timeout -k \d+ (\d+) $/u)[1]);
  // Clean wakes run 10-25 minutes. The backstop has to sit clear of the slowest honest wake and
  // still be short enough that a stuck one does not hold .brain.lock for hours.
  assert.ok(seconds >= 30 * 60, `backstop ${seconds}s would cut off legitimately slow wakes`);
  assert.ok(seconds <= 90 * 60, `backstop ${seconds}s is too long to protect the wakes behind it`);

  assert.match(runner, /rc" -eq 124/u, 'a timeout kill must be reported, not silently treated as a clean exit');
});
