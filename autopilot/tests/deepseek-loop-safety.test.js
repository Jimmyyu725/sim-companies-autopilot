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

test('the forced tool is released after repeated rejection', () => {
  // Without this the recovery is an absorbing state: same prompt, same one-tool menu, same batched
  // reply, no counter, no backoff, no path that restores the full menu.
  assert.match(src, /MAX_FORCED_TOOL_REPEATS/u);
  assert.match(src, /FORCED_TOOL_RELEASED/u);
  const limit = Number(/const MAX_FORCED_TOOL_REPEATS = (\d+);/u.exec(src)[1]);
  assert.ok(limit >= 2 && limit <= 5, `a release limit of ${limit} is not a sane bound`);
  // Every assignment of a real tool name must go through the counter, or one path reopens the trap.
  // Match only statements that assign something other than null, and ignore parameter defaults —
  // an earlier version of this check flagged `forcedToolName = null,` inside two destructured
  // parameter lists and failed for a reason unrelated to what it claims to test.
  // Take the right-hand side and compare it directly. Two earlier versions of this check used a
  // negative lookahead after \s*, which backtracks to zero width and defeats itself, so it flagged
  // the very `= null` lines it was written to ignore.
  const ALLOWED_RHS = new Set(['null', 'name || null']);
  const bypass = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.startsWith('forcedToolName ='))
    .map(row => ({ ...row, rhs: row.line.slice(row.line.indexOf('=') + 1).trim().replace(/[;,]$/u, '') }))
    .filter(({ rhs }) => !ALLOWED_RHS.has(rhs));
  assert.deepEqual(bypass.map(b => `${b.n}: ${b.line}`), [],
    'every forced-tool assignment must go through forceTool so the repeat counter sees it');
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
