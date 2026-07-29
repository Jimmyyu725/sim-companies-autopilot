'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

for (const filename of ['brain.js', 'brain56.js']) {
  test(`${filename} serializes read_api against browser navigation`, () => {
    const source = fs.readFileSync(path.join(ROOT, filename), 'utf8');
    const start = source.indexOf("if (name === 'read_api')");
    const end = source.indexOf("if (name === 'inspect_building')", start);
    assert.ok(start >= 0 && end > start, 'read_api branch was not found');
    const branch = source.slice(start, end);
    assert.match(branch, /execFileSync\('flock'/);
    assert.match(branch, /path\.join\(SIM, '\.tick\.lock'\)/);
    assert.match(branch, /path\.join\(BRAIN, 'api\.js'\)/);
  });
}

test('volume collector acquires locks in brain-then-browser order', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '..', 'shared', 'price-tracker', 'volume.js'),
    'utf8',
  );
  const brainLock = source.indexOf("path.join(SIM, 'autopilot', '.brain.lock')");
  const tickLock = source.indexOf("path.join(SIM, '.tick.lock')");
  assert.ok(brainLock >= 0, 'brain lock was not found');
  assert.ok(tickLock > brainLock, 'browser lock must be acquired after the brain lock');
  assert.match(source, /SIM_VOLUME_BRAIN_LOCK_HELD/);
  assert.match(source, /SIM_VOLUME_TICK_LOCK_HELD/);
});

test('volume collector yields to an imminent wake before touching the brain lock', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '..', 'shared', 'price-tracker', 'volume.js'),
    'utf8',
  );
  const lockBranch = source.indexOf("if (process.env[LOCK_MARKER] !== '1')");
  const priorityPreflight = source.indexOf('currentCollectionPriority()', lockBranch);
  const brainLock = source.indexOf("path.join(SIM, 'autopilot', '.brain.lock')", lockBranch);
  assert.ok(lockBranch >= 0, 'brain-lock branch was not found');
  assert.ok(priorityPreflight > lockBranch, 'priority preflight was not found');
  assert.ok(priorityPreflight < brainLock, 'wake priority must be checked before brain lock');
});

test('brain runner briefly waits out telemetry lock handoff', () => {
  const source = fs.readFileSync(path.join(ROOT, 'run-brain.sh'), 'utf8');
  assert.match(source, /flock -w 2 7 \|\|/u);
});
