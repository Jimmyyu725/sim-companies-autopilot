'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const autopilot = path.resolve(__dirname, '..');
const simRoot = path.resolve(autopilot, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(simRoot, relativePath), 'utf8');
}

test('all per-wake diaries live in the dedicated diaries directory', () => {
  const rootDiaries = fs.readdirSync(autopilot).filter((name) => /^diary-.*\.md$/.test(name));
  const diaryDirectory = path.join(autopilot, 'diaries');
  const nestedDiaries = fs.existsSync(diaryDirectory)
    ? fs.readdirSync(diaryDirectory).filter((name) => /^diary-.*\.md$/.test(name))
    : [];

  assert.deepEqual(rootDiaries, []);
  assert.ok(nestedDiaries.every((name) => /^diary-.*\.md$/.test(name)));
});

test('all diary writers and Windows synchronization use the dedicated directory', () => {
  const runner = read('autopilot/run-brain.sh');
  const brain = read('autopilot/brain.js');
  const brain56 = read('autopilot/brain56.js');
  const sync = read('autopilot/sync-windows-logs.sh');

  assert.match(runner, /DIARY_DIR="\$AUTOPILOT\/diaries"/);
  assert.match(runner, /DIARY_FILE="\$DIARY_DIR\/diary-/);
  assert.match(brain, /path\.join\(BRAIN, 'diaries', 'diary-'/);
  assert.match(brain56, /path\.join\(BRAIN, 'diaries', 'diary-'/);
  assert.match(sync, /DIARY_DIR="\$AUTOPILOT\/diaries"/);
  assert.match(sync, /find "\$DIARY_DIR"[^\n]+diary-\*\.md/);
});

test('a diary is initialized before state capture and failure still gets summarized and synced', () => {
  const runner = read('autopilot/run-brain.sh');
  const diaryInitialization = runner.indexOf('export DIARY_FILE=');
  const stateCapture = runner.indexOf('node "$AUTOPILOT/state.js"');
  const failureStart = runner.indexOf('state capture FAILED');
  const brainStart = runner.indexOf('node "${BRAIN_JS:-autopilot/brain.js}"');
  const failureBranch = runner.slice(failureStart, brainStart);

  assert.ok(diaryInitialization >= 0 && diaryInitialization < stateCapture);
  assert.ok(failureStart >= 0 && brainStart > failureStart);
  assert.match(failureBranch, /STATE CAPTURE FAILED/);
  assert.match(failureBranch, /--diary=\$DIARY_FILE/);
  assert.match(failureBranch, /sync-windows-logs\.sh/);
  assert.match(failureBranch, /no model call and no game action were attempted/);
});

// The company-value estimator was removed on 2026-08-03, but the ordering it depended on still
// matters: the closing state capture must land after the brain and before the Windows sync, or the
// synced diary describes the opening position instead of the closing one.
test('a final locked state capture runs after the brain and before Windows sync', () => {
  const runner = read('autopilot/run-brain.sh');
  const brainStart = runner.indexOf('node "${BRAIN_JS:-autopilot/brain.js}"');
  const finalCapture = runner.indexOf('final closing state capture');
  const windowsSync = runner.lastIndexOf('sync-windows-logs.sh');

  assert.ok(brainStart >= 0 && finalCapture > brainStart);
  assert.ok(windowsSync > finalCapture);
  assert.match(runner, /flock -w 90 \.tick\.lock node "\$AUTOPILOT\/state\.js"/);
  assert.ok(!runner.includes('record_company_value'), 'the recorder must stay gone');
});
