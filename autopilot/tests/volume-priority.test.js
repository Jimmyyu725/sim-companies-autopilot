'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWakeAt,
  volumeCollectionPriority,
} = require('../../shared/price-tracker/volume-priority.js');

const NOW = Date.parse('2026-07-27T03:00:00.000Z');

function alarm(at) {
  return { at, atIso: new Date(at).toISOString(), reason: 'test wake' };
}

test('volume collection yields to missing, corrupt, due, and imminent brain alarms', () => {
  assert.equal(volumeCollectionPriority(null, NOW).run, false);
  assert.equal(volumeCollectionPriority({ at: 'bad' }, NOW).run, false);
  assert.equal(volumeCollectionPriority(alarm(NOW - 1), NOW).run, false);
  assert.equal(volumeCollectionPriority(alarm(NOW + 5 * 60e3), NOW).run, false);
});

test('volume collection runs only when the next brain wake is safely distant', () => {
  const result = volumeCollectionPriority(alarm(NOW + 5 * 60e3 + 1), NOW);
  assert.equal(result.run, true);
  assert.equal(result.reason, 'brain-wake-not-imminent');
});

test('immediate owner wake remains a valid priority alarm', () => {
  const immediate = { at: 0, atIso: new Date(NOW).toISOString(), reason: 'owner request' };
  assert.equal(parseWakeAt(immediate), 0);
  assert.equal(volumeCollectionPriority(immediate, NOW).run, false);
});
