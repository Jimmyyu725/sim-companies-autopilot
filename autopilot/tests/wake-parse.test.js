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
