'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The two engines are not interchangeable, and a change validated on one was applied to both.
// brain56.js chains server-side with previous_response_id, so its request payload is roughly
// constant and removing the round ceiling is harmless there. brain.js re-sends the entire messages
// array every round: measured across the twelve most recent DeepSeek wakes the prompt grew 1,918 to
// 2,760 tokens per request, from ~24,000 to 130,692 by request 40 on 2026-08-04 22:13, against a
// 131,072 window. All twelve were stopped by the old 40-round ceiling — 380 tokens short of the wall
// — and #70 removed that ceiling.
//
// A context overflow is not a soft failure: HTTP 400 is not retryable, chat() throws, and main()
// has no catch, so the wake exits 1 without writing its safety-retry alarm, journal or master.

const brainSource = () => fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8');

test('brain.js bounds itself by prompt size, not only by round count', () => {
  const src = brainSource();
  assert.match(src, /CONTEXT_TOKEN_CEILING/u,
    'the engine that re-sends its whole conversation must have a context bound');
  assert.match(src, /lastPromptTokens\s*=\s*Number\(normalizedUsage\.prompt_tokens\)/u,
    'the bound must be driven by what the provider actually reported, not an estimate');
  assert.match(src, /lastPromptTokens >= CONTEXT_TOKEN_CEILING/u,
    'the loop must consult the observed prompt size before issuing the next request');
});

test('the ceiling leaves room for the whole closing sequence', () => {
  // Read the exported constant rather than grepping the source. The first version of this test
  // matched /\? parsed : (\d+);/ and captured 30 from resolveMaxRounds instead of the ceiling — it
  // then failed for a reason that had nothing to do with what it claimed to check, and a slightly
  // looser assertion would have made it pass while testing nothing at all.
  const { CONTEXT_TOKEN_CEILING: ceiling } = require('../brain.js');
  const WINDOW = 131072;          // deepseek-v4-flash, from the model spec
  const WORST_GROWTH = 2760;      // measured, diary-2026-08-04-221301
  const CLOSING_ROUNDS = 9;       // run-brain.sh, measured 2026-08-03 23:35
  const LARGEST_OPENING = 25725;  // measured, diary-2026-08-04-223401 request 1

  assert.equal(typeof ceiling, 'number');
  assert.ok(ceiling < WINDOW, 'a ceiling at or above the window bounds nothing');
  assert.ok(WINDOW - ceiling >= CLOSING_ROUNDS * WORST_GROWTH,
    `headroom ${WINDOW - ceiling} must cover ${CLOSING_ROUNDS} closing rounds at ${WORST_GROWTH} each`);
  // It is expected and intended that long wakes reach this and are told to close — the observed
  // wakes peaked between 98,912 and 130,692. What it must not do is fire before real work happens,
  // so require room for at least ten full requests beyond the opening prompt.
  assert.ok(ceiling > LARGEST_OPENING + 10 * WORST_GROWTH,
    `ceiling ${ceiling} would cut a wake off before it has done anything`);
});

test('brain56.js needs no such bound, and the reason is in the source', () => {
  const other = fs.readFileSync(path.join(__dirname, '..', 'brain56.js'), 'utf8');
  assert.match(other, /previous_response_id/u,
    'brain56 chains server-side; if that ever changes it needs the same bound as brain.js');
});

test('the ceiling is overridable and rejects unusable values', () => {
  const src = brainSource();
  assert.match(src, /BRAIN_CONTEXT_CEILING/u, 'an operator must be able to override it');
  assert.match(src, /parsed >= 10000/u, 'an absurdly small override must fall back to the default');
});
