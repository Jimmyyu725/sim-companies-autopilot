'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engine = require('../brain.js');
const { buildingUtilizationJournalGate } = require('../building-utilization-policy.js');

// Everything here is DeepSeek-only machinery that brain56.js has no counterpart for, which is why
// brain56's clean record does not transfer. GPT-5.6 can route around a stuck guard by choosing a
// different tool; this engine publishes exactly one tool when a guard demands it, and is
// structurally forbidden from doing so. Under the old round ceiling that merely wasted a doomed
// wake. With BRAIN_MAX_ROUNDS unlimited it runs to the 45-minute wall clock.

const src = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8');

test('a refused finish can name its next step', () => {
  // finishCheck() returns ok/guard/reason/missing/... and never requiredTool or requiredNextTool,
  // so reading only those two made this return null for every refused finish — the one round where
  // the closing order most needs enforcing got none.
  assert.equal(engine.requiredDeepSeekTool({ requiredTool: 'refresh_state' }), 'refresh_state');
  assert.equal(
    engine.requiredDeepSeekTool({ ok: false, missing: ['journal after the latest mutation'] }),
    'journal',
    'the tool must be recoverable from the shape finishCheck actually returns');
  assert.equal(engine.requiredDeepSeekTool({ ok: false, missing: [] }), null);
  assert.equal(engine.requiredDeepSeekTool({ missing: ['not_a_tool something'] }), null,
    'a name that is not a published tool must not be forced');
});

test('forcing a singular tool keeps the batch sibling that makes it answerable', () => {
  // A guard naming four Mills forces inspect_building, whose contract takes one id. With
  // inspect_buildings filtered out the model can only answer with several calls, which are then
  // rejected as a batch — and the same single tool is forced again.
  assert.match(src, /FORCED_TOOL_SIBLINGS/u);
  assert.match(src, /inspect_building:\s*'inspect_buildings'/u);
  assert.match(src, /forcedSibling && tool\?\.function\?\.name === forcedSibling/u);
});

test('the forced tool is released after repeated rounds, driven not grepped', () => {
  // Every earlier version of this check was a regex over brain.js and never drove the logic across
  // rounds — which is how the self-resetting counter survived them. This runs the real tracker.
  const released = [];
  const tracker = engine.createForcedToolTracker((tag, name) => released.push(`${tag}:${name}`));

  // The shape that defeated the previous fix: the closing directive re-pins the same tool every
  // round because finishCheck().missing does not change, and the gate that refuses it names no tool
  // at all, so the request-side counter was cleared each time.
  const published = [];
  let forced = null;
  for (let round = 0; round < 6; round += 1) {
    if (!forced) forced = 'journal';
    forced = tracker.consume(forced);
    published.push(forced);
    forced = null;                       // the guard returned no requiredTool and no missing
  }
  assert.deepEqual(published, ['journal', 'journal', null, 'journal', 'journal', null],
    'the menu must reopen on the third consecutive round, and keep reopening');
  assert.equal(released.length, 2);
  assert.match(released[0], /FORCED_TOOL_RELEASED:journal/u);
});

test('a different tool restarts the count rather than inheriting it', () => {
  const tracker = engine.createForcedToolTracker();
  assert.equal(tracker.consume('journal'), 'journal');
  assert.equal(tracker.consume('journal'), 'journal');
  assert.equal(tracker.consume('set_alarm'), 'set_alarm', 'a new demand is not the old one');
  assert.equal(tracker.consume('set_alarm'), 'set_alarm');
  assert.equal(tracker.consume('set_alarm'), null, 'and it gets its own three rounds');
});

test('no forced tool at all leaves the counter alone', () => {
  const tracker = engine.createForcedToolTracker();
  assert.equal(tracker.consume('journal'), 'journal');
  assert.equal(tracker.consume(null), null, 'a round with no demand publishes the full menu');
  assert.equal(tracker.consume('journal'), 'journal');
  assert.equal(tracker.consume('journal'), null, 'the earlier attempt still counted');
});
test('the closing directive does not overwrite a tool a guard just demanded', () => {
  // closing.requiredTool comes from finishCheck().missing and does not change until that step
  // succeeds, so assigning it unconditionally pins the forced tool to the one being refused.
  assert.match(src, /closing\.requiredTool && !forcedToolName/u);
});

test('the optional utility gate still has an escape when rounds are unlimited', () => {
  // closingBudgetActive(Infinity) is false, so the waiver added for the discarded 2026-08-01 11:57
  // wake went dead the moment the ceiling was removed.
  assert.match(src, /closingBudgetActive\(roundsRemaining\) \|\| \(lastPromptTokens >= CONTEXT_TOKEN_CEILING\)/u);
});

test('an idle production building blocks the close, not only an idle shop', () => {
  const NOW = Date.parse('2026-08-07T08:00:00.000Z');
  const ISO = new Date(NOW).toISOString();
  const state = extra => ({
    t: ISO,
    sources: { buildings: { status: 'ok', asOf: ISO } },
    buildings: [
      { id: 1001, name: 'Mill', kindLetter: 'i', category: 'production', ...extra },
      { id: 1002, name: 'Mill', kindLetter: 'i', category: 'production',
        busy: { type: 'production', endsAt: new Date(NOW + 3600e3).toISOString() } },
    ],
  });
  // This is the shape state.js actually writes for an idle building: no `busy` key at all.
  const idle = buildingUtilizationJournalGate(state({}), NOW, {});
  assert.ok(idle, 'an idle Mill must not let the wake close');
  assert.equal(idle.requiredTool, 'inspect_building');

  const busy = buildingUtilizationJournalGate(
    state({ busy: { type: 'production', endsAt: new Date(NOW + 3600e3).toISOString() } }), NOW, {});
  assert.equal(busy, null, 'a fully busy portfolio must still close');
});

// Third adversarial pass, 2026-08-07. Two blocking defects survived the previous two rounds of
// fixes, both because a nudge was mistaken for a boundary and a fix was placed on the wrong branch.

test('the context limit ends the loop rather than only asking the model to stop', () => {
  // #84 added a soft ceiling that pushes a closing message. `for (let i = 0; i < Infinity; i++)` has
  // no exit but a successful finish, so the whole safety block after the loop —
  // buildAutomaticFinishOnExhaustion and the safetyRetry alarm — was unreachable. A wake that could
  // not close ran until the prompt overflowed, took a non-retryable HTTP 400, threw out of a try
  // with only a finally, and exited 1 leaving a stale far-future alarm that also defeats
  // run-brain.sh's absent-file fallback.
  const soft = engine.CONTEXT_TOKEN_CEILING;
  const hard = engine.CONTEXT_HARD_LIMIT;
  // Measured 2026-08-07 across 57 main-loop requests in the first three post-switch wakes.
  const WINDOW = 131072;
  const MEAN_GROWTH = 2705;
  const MAX_GROWTH = 12376;   // the tail, not the average — this is what the first guess missed
  const CLOSING_ROUNDS = 9;   // a refused journal costs this many
  const HIGHEST_OBSERVED_PEAK = 79309;

  assert.ok(hard > soft, 'the hard limit must sit above the soft one, not replace it');
  assert.ok(hard < WINDOW, 'a limit at or above the window bounds nothing');
  assert.ok(WINDOW - hard >= MAX_GROWTH,
    `${WINDOW - hard} tokens below the window is less than one worst-case request (${MAX_GROWTH}), `
    + 'so a prompt sitting just under the limit overflows on the very next one');
  assert.ok(hard - soft >= CLOSING_ROUNDS * MEAN_GROWTH,
    `${hard - soft} tokens of grace does not cover the ${CLOSING_ROUNDS} rounds a refused journal costs`);
  assert.ok(soft > HIGHEST_OBSERVED_PEAK,
    'the soft ceiling must not fire on a wake that is working normally');

  assert.match(src, /lastPromptTokens >= CONTEXT_HARD_LIMIT/u);
  assert.match(src, /CONTEXT_HARD_LIMIT[\s\S]{0,400}?\n\s*break;/u,
    'crossing the hard limit must break the loop so the safe-failure path runs');
});

test('a state refresh does not discard page activity evidence', () => {
  // The closing order requires a refresh after every mutation, and state.js rebuilt only the store's
  // inspection — so inspect_building's evidence was wiped moments after it was written, leaving the
  // UNKNOWN-activity block unsatisfiable in practice.
  const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'state.js'), 'utf8');
  assert.match(stateSrc, /carried\.has\(Number\(building\.id\)\)/u,
    'a refresh must carry forward evidence it did not rebuild');
  assert.match(stateSrc, /Number\(inspection\?\.level\) === Number\(building\.size\)/u,
    'carried evidence must still match the level it was taken for');
});

// Observed on the first live DeepSeek wake, 2026-08-07 18:17. The counter fired
// FORCED_TOOL_RELEASED after refresh_state was forced three rounds running — but every one of those
// was the runtime's legitimate "refresh after a mutation" rule (after collect, after sell, after
// produce) and every one was obeyed. Counting demands rather than unsatisfied demands released the
// full menu at the exact moment a refresh was still required.
test('a demand the model obeys never counts toward the release limit', () => {
  const released = [];
  const tracker = engine.createForcedToolTracker(tag => released.push(tag));
  for (let round = 0; round < 6; round += 1) {
    const published = tracker.consume('refresh_state');
    assert.equal(published, 'refresh_state', `round ${round + 1} must still force the refresh`);
    tracker.satisfied([{ function: { name: 'refresh_state' } }]);
  }
  assert.deepEqual(released, [], 'obedience is not a livelock');
});

test('an ignored demand still reaches the limit', () => {
  const released = [];
  const tracker = engine.createForcedToolTracker(tag => released.push(tag));
  const published = [];
  let forced = null;
  for (let round = 0; round < 4; round += 1) {
    if (!forced) forced = 'journal';
    forced = tracker.consume(forced);
    published.push(forced);
    tracker.satisfied([{ function: { name: 'something_else' } }]);
    forced = null;
  }
  assert.deepEqual(published, ['journal', 'journal', null, 'journal']);
  assert.equal(released.length, 1);
});

test('obeying resets a count that was already building', () => {
  const tracker = engine.createForcedToolTracker();
  assert.equal(tracker.consume('journal'), 'journal');
  tracker.satisfied([{ function: { name: 'nope' } }]);
  assert.equal(tracker.consume('journal'), 'journal');
  tracker.satisfied([{ function: { name: 'journal' } }]);   // finally obeyed
  assert.equal(tracker.consume('journal'), 'journal', 'the count restarts after compliance');
  tracker.satisfied([{ function: { name: 'nope' } }]);
  assert.equal(tracker.consume('journal'), 'journal', 'not released yet — only two unanswered');
});

test('the loop actually reports compliance to the tracker', () => {
  // The three tests above call tracker.satisfied() themselves, so they verify the tracker and say
  // nothing about whether main() ever calls it. Deleting the call site left all of them passing.
  // This is a source-level check because the loop lives inside main() and cannot be driven from
  // here; it is deliberately narrow — it asserts the wiring exists and sits between the reply and
  // the guard handling, which is the only place the information is available.
  const loop = src.slice(src.indexOf('const msg = await chat(messages'),
    src.indexOf('const multiToolRejections'));
  assert.match(loop, /tracker\.satisfied\(msg\.tool_calls\)/u,
    'main() must tell the tracker when a forced tool was actually called');
});
