'use strict';

// collect.js is a page-context fragment (top-level return/await, helpers injected by
// shared/cdp.js) and cannot be executed directly under plain Node, so these tests read it as
// text and assert on the specific patterns the supporter "Collect All" button integration
// requires. See autopilot/tests/action-mutation-safety.test.js for the established precedent
// for this style of test against files under autopilot/actions/.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const ACTIONS_DIR = path.join(__dirname, '..', 'actions');
const AUTOPILOT_DIR = path.join(__dirname, '..');

function readSource() {
  return fs.readFileSync(path.join(ACTIONS_DIR, 'collect.js'), 'utf8');
}

test('the Collect All button is bound to its aria-label, never to the css- CSS-in-JS class', () => {
  const source = readSource();
  assert.match(
    source,
    /all\('button\[aria-label="Collect resource and cash from buildings"\]'\)/,
    'must select the button via all(\'button[aria-label="..."]\')',
  );
  // No selector call (all(...) or a raw document.querySelector[All](...)) may reference a
  // css-* class. The css-1h3q6hg hash is expected to appear only in explanatory comments.
  assert.doesNotMatch(
    source,
    /(?:\ball\(|document\.querySelector(?:All)?\()\s*['"][^'"]*\bcss-[^'"]*['"]/,
    'no selector call may bind to a css-* CSS-in-JS class',
  );
});

test('the hand-holding-medical icon is cross-checked before the button is trusted', () => {
  const source = readSource();
  const usableStart = source.indexOf('const collectAllUsable');
  assert(usableStart >= 0, 'expected a collectAllUsable gate to exist');
  const usableEnd = source.indexOf(';', source.indexOf('aria-disabled', usableStart));
  assert(usableEnd > usableStart, 'expected the collectAllUsable declaration to terminate');
  const usableBlock = source.slice(usableStart, usableEnd);

  assert.match(usableBlock, /svg\[data-icon="hand-holding-medical"\]/,
    'the usability gate must cross-check the hand-holding-medical icon');
  assert.match(usableBlock, /collectAllButton/,
    'the icon check must be scoped to the aria-label-selected button');
  assert.match(usableBlock, /disabled/i,
    'the usability gate must also check the disabled state');

  // The button must only ever be clicked once, and only inside the collectAllUsable branch.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 2,
    'expected exactly two click sites in the whole file: the Collect All button and the fallback bubble');
  const ifIdx = source.indexOf('if (collectAllUsable)');
  const clickIdx = source.indexOf('collectAllButton.click()');
  const methodTagIdx = source.indexOf("method: 'collect-all-button'");
  assert(ifIdx >= 0 && clickIdx > ifIdx && methodTagIdx > clickIdx,
    'collectAllButton.click() must happen inside the if (collectAllUsable) branch, before it reports method: collect-all-button');
});

test('falls back to the per-bubble click loop when the button is absent, disabled, or unconfirmed', () => {
  const source = readSource();
  assert.match(source, /for \(const buildingId of expectedIds\)/,
    'the per-building fallback loop must still exist');
  assert.match(source, /React can replace the landscape nodes/,
    'the per-click bubble re-resolution safeguard must still exist');
  assert.match(source, /el\.click\(\)/, 'the fallback path must still click individual bubbles');
  assert.match(source, /method: 'collect-all-button'/);
  assert.match(source, /method: 'per-bubble'/);

  // The fallback loop must textually follow the Collect All attempt, i.e. it is really a
  // fallback and not, say, the only path or one that runs before the button is even tried.
  const ifIdx = source.indexOf('if (collectAllUsable)');
  const loopIdx = source.indexOf('for (const buildingId of expectedIds)');
  assert(ifIdx >= 0 && loopIdx > ifIdx,
    'the per-bubble loop must appear after the Collect All attempt');
});

test('both paths report exactly one clicked entry per expected id with the required verification fields', () => {
  const source = readSource();
  // Collect All path: clicked is built 1:1 from expectedIds (not from post-click DOM state,
  // since a single click can remove every bubble at once).
  assert.match(source, /const clicked = expectedIds\.map\(buildingId =>/,
    'the Collect All path must derive clicked directly from expectedIds, one entry per id');
  assert.match(source, /resource: labelByBuildingId\.get\(buildingId\)/,
    'the Collect All path must attach a resource label captured before the click');

  // Per-bubble path: clicked is pushed once per successfully clicked expected id.
  assert.match(source, /clicked\.push\(\{ buildingId, resource: label \}\)/,
    'the fallback path must still push one clicked entry per building it clicks');

  // Both terminal "clicks happened, act.js must verify" returns carry the same contract.
  assert.equal((source.match(/verificationPending: true/g) || []).length, 2,
    'both the Collect All and per-bubble success paths must set verificationPending: true');
  assert.equal((source.match(/verified: false,/g) || []).length, 2);
  assert.match(source, /mutationAttempted: true,\s*\n\s*doNotRetry: true,\s*\n\s*method: 'collect-all-button'/,
    'the Collect All path must report mutationAttempted/doNotRetry: true (a click always happened)');
  assert.match(source, /mutationAttempted: clicked\.length > 0,\s*\n\s*doNotRetry: clicked\.length > 0,\s*\n\s*method: 'per-bubble'/,
    'the per-bubble path must keep its original mutationAttempted/doNotRetry semantics');
});

test('the exactly-one-visible-bubble precondition is a single shared gate in front of both paths', () => {
  const source = readSource();
  const reason = 'collectible building bubble is missing or ambiguous; nothing was clicked';
  assert.equal((source.match(new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
    'the missing-bubble precondition must exist exactly once, shared by both paths, not duplicated per path');
  const preconditionIdx = source.indexOf(reason);
  const buttonDetectionIdx = source.indexOf('collectAllMatches');
  const fallbackLoopIdx = source.indexOf('for (const buildingId of expectedIds)');
  assert(preconditionIdx >= 0 && buttonDetectionIdx > preconditionIdx,
    'the bubble precondition must run before the Collect All button is even looked for');
  assert(preconditionIdx >= 0 && fallbackLoopIdx > preconditionIdx,
    'the bubble precondition must run before the per-bubble fallback loop');
});

test('the original preconditions (landscape check, snapshot requirement, expectedIds computation, empty-collect return) are unchanged', () => {
  const source = readSource();
  assert.match(source, /if \(!location\.pathname\.startsWith\('\/landscape'\)\)/);
  assert.match(source, /window\.__collect\?\.beforeBuildings/);
  assert.match(source, /busy\.canFetch === true/);
  assert.match(source, /resourceAmount != null && Number\(resourceAmount\) > 0/);
  assert.match(source, /retailProfit != null && Number\(retailProfit\) > 0/);
  assert.match(source, /expectedIds\.some\(id => !Number\.isSafeInteger\(id\) \|\| id <= 0\)/);
  assert.match(source, /new Set\(expectedIds\)\.size !== expectedIds\.length/);
  assert.match(source, /note: 'authoritative snapshot shows no collectible building'/);
  assert.match(source, /mutationAttempted: false,\s*\n\s*clicked: \[\], note:/);
});

test('act.js and action-verification.js were not modified by the Collect All change', () => {
  // Pinned to the exact content these files had before this change. Any diff -- even
  // whitespace -- means a file this task explicitly forbids touching was edited. If one of
  // these files is legitimately changed for unrelated reasons later, update these hashes as
  // part of that change and re-confirm act.js's verificationPending handling (~line 1036) and
  // action-verification.js's verifyCollectionResult still match what collect.js relies on.
  const expected = {
    'act.js': '036f3044d2f37c1174fde815b1cbcb0acf2f78044fa4297b56e0bf4c61cdd81a',
    'action-verification.js': 'ee9aba080c810ad6ac5fc47bb159eebeb913e9e04a42e5e8f14c92605652bd0e',
  };
  for (const [file, expectedHash] of Object.entries(expected)) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(AUTOPILOT_DIR, file)))
      .digest('hex');
    assert.equal(actual, expectedHash, `${file} must not be modified by the collect-all-button change`);
  }
});
