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
  const brainStart = runner.indexOf('timeout 900 node');
  const failureBranch = runner.slice(failureStart, brainStart);

  assert.ok(diaryInitialization >= 0 && diaryInitialization < stateCapture);
  assert.ok(failureStart >= 0 && brainStart > failureStart);
  assert.match(failureBranch, /STATE CAPTURE FAILED/);
  assert.match(failureBranch, /record_company_value/);
  assert.match(failureBranch, /--diary=\$DIARY_FILE/);
  assert.match(failureBranch, /sync-windows-logs\.sh/);
  assert.match(failureBranch, /no model call and no game action were attempted/);
});

test('the closing company-value record uses a final locked state capture before Windows sync', () => {
  const runner = read('autopilot/run-brain.sh');
  const brainStart = runner.indexOf('timeout 900 node');
  const finalCapture = runner.indexOf('final company-value state capture');
  const recorder = runner.lastIndexOf('record_company_value');
  const windowsSync = runner.lastIndexOf('sync-windows-logs.sh');

  assert.ok(brainStart >= 0 && finalCapture > brainStart);
  assert.ok(recorder > finalCapture);
  assert.ok(windowsSync > recorder);
  assert.match(runner, /flock -w 90 \.tick\.lock node "\$AUTOPILOT\/state\.js"/);
});
