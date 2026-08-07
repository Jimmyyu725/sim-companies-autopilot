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
