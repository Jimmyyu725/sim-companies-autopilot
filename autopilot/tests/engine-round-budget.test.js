'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AUTOPILOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(AUTOPILOT, name), 'utf8');

// Live 2026-08-03 23:35, the first wake to fail after the provider switch to OpenAI: it finished
// its work, was refused a journal because a completed job still needed collecting, obeyed the
// refusal, and then ran out of rounds mid-close. run-brain.sh exports BRAIN_MAX_ROUNDS=40 for both
// engines now, but it used to export it in the deepseek branch only, and brain56.js hard-coded 30
// in three places and ignored the variable anyway — two independent faults that hid each other, so
// every wake on that engine ran ten rounds shorter than the operator had configured.
//
// The closing sequence is nine rounds when the journal is refused once — refresh_state, set_alarm,
// journal (refused), collect, refresh_state, set_alarm, journal, master, finish — and
// CLOSING_BUDGET_ROUNDS only reserves four, so the shortfall lands exactly there.

// The variable was exported in the deepseek branch only, so the OpenAI path silently fell back to
// the engine's hard-coded 30 — the omission was invisible while the engine ignored the variable
// anyway. Assert per branch, not once for the file.
test('every provider branch in run-brain.sh exports a round budget', () => {
  const runner = read('run-brain.sh');
  const branches = runner.match(/^ {2}(deepseek|openai>?)\)$[\s\S]*?^ {4};;$/gmu) || [];
  assert.equal(branches.length, 2, 'expected a deepseek and an openai branch');
  for (const branch of branches) {
    const name = branch.match(/^ {2}(\w+)\)/mu)[1];
    assert.match(branch, /export BRAIN_MAX_ROUNDS=\S+/,
      `the ${name} branch must export the budget its engine reads`);
    // Stronger than matching a shape: resolve the exported value with the engine's own parser, so a
    // typo that silently falls back to the default cannot pass. Owner directive 2026-08-05 sets it
    // to 'unlimited', which must land on Infinity rather than on the fallback.
    const exported = branch.match(/export BRAIN_MAX_ROUNDS=(\S+)/u)[1];
    const resolved = require('../brain56.js').resolveMaxRounds(exported);
    assert.notEqual(resolved, 30,
      `the ${name} branch exports ${exported}, which the engine silently reads as the default 30`);
    assert.ok(resolved === Number.POSITIVE_INFINITY || Number.isSafeInteger(resolved));
  }
});

test('both engines read the round budget from the same environment variable', () => {
  for (const engine of ['brain.js', 'brain56.js']) {
    assert.match(read(engine), /process\.env\.BRAIN_MAX_ROUNDS/,
      `${engine} must honour the budget the runner exports`);
  }
});

test('neither engine hard-codes its round count', () => {
  for (const engine of ['brain.js', 'brain56.js']) {
    const source = read(engine);
    assert.doesNotMatch(source, /for \(let i = 0; i < \d+; i\+\+\)/,
      `${engine} must not hard-code the loop bound`);
    assert.doesNotMatch(source, /exhausted \d+ rounds/,
      `${engine} must report the configured budget, not a literal`);
  }
});

test('both engines resolve the round budget identically', () => {
  // The two engines used to hold separate copies of the bound, and they drifted: brain56 hard-coded
  // 30 and ignored the variable entirely. They now share one resolver, so compare behaviour rather
  // than source text, across the values the runner can actually export.
  const engines = ['brain.js', 'brain56.js'].map(name => require(`../${name}`));
  for (const raw of ['unlimited', 'infinity', '0', '7', '50', '500', '', 'garbage', '-5', undefined]) {
    const [first, ...rest] = engines.map(engine => engine.resolveMaxRounds(raw));
    for (const other of rest) assert.equal(other, first, `engines disagree on ${JSON.stringify(raw)}`);
  }
});

// A literal here would drift from the loop bound the way the exhaustion message already had.
test('the closing reserve is a named constant, not a literal', () => {
  const guard = read('runtime-guard.js');
  assert.match(guard, /const CLOSING_BUDGET_ROUNDS = \d+;/);
  const reserve = Number(guard.match(/const CLOSING_BUDGET_ROUNDS = (\d+);/)[1]);
  assert.ok(reserve >= 1 && reserve < 30, 'the reserve must leave room for real work');
});
