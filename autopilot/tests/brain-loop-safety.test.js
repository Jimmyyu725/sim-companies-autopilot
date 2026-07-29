'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENGINES = [
  ['responses engine', require('../brain56.js')],
  ['chat-completions engine', require('../brain.js')],
];
const NOW = Date.parse('2026-07-26T21:00:00.000Z');

for (const [name, engine] of ENGINES) {
  test(`${name}: incomplete tool loop creates a five-minute safety retry`, () => {
    const alarm = engine.buildIncompleteLoopRetryAlarm(
      'tool loop exhausted without successful finish', NOW, engine.createUtilityExchangeReviews());

    assert.equal(alarm.at, NOW + 5 * 60e3);
    assert.equal(alarm.set, new Date(NOW).toISOString());
    assert.equal(alarm.safetyRetry, true);
    assert.match(alarm.reason, /brain loop incomplete/);
  });

  test(`${name}: incomplete tool loop preserves rate-limited kind binding`, () => {
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(
      reviews, 2, { ok: false, book: { live: { status: 429 } } }, NOW);
    const alarm = engine.buildIncompleteLoopRetryAlarm('no function call', NOW + 1000, reviews);

    assert.deepEqual(alarm.utilityRetryKinds, [2]);
    assert.equal(Date.parse(alarm.set) >= Date.parse(reviews['2'].reviewedAt), true);
  });
}

test('responses engine: every chained turn resends stable instructions', () => {
  const request = ENGINES[0][1].buildChainedResponseRequest(
    'resp_test',
    'stable owner policy',
    [{ type: 'function_call_output', call_id: 'call_test', output: '{}' }],
    [{ type: 'function', name: 'finish', parameters: { type: 'object' } }],
  );
  assert.equal(request.previous_response_id, 'resp_test');
  assert.equal(request.instructions, 'stable owner policy');
  assert.equal(request.input[0].call_id, 'call_test');
});
