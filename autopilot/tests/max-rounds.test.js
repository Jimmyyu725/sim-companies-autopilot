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
