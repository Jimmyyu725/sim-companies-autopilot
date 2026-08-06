'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readPendingOwnerDirective } = require('../owner-directive.js');

// Regression, 2026-08-06. Farm 55765118 reached level 5 and went idle, and the directive stayed
// pending: it kept reserving the building and blocked three attempts to give it work. The completion
// check read only `building.busy`, and state.js reports idle by *omitting* that key — the game
// returns a busy schedule and an unlisted building simply has no entry. `busy: null` is never
// written, so the branch meant to recognise idle was unreachable, and idle is the only state in
// which an upgrade program is finished.
//
// The activity test is load-bearing, not cosmetic: `size` reports the TARGET level while
// construction runs. Farm 55693034 read size 3 at actual level 1 mid-upgrade on the same day. Any
// change that drops the activity test would complete a program the moment its upgrade started.

let tmp = 0;
function scratch(name, value) {
  const file = path.join(os.tmpdir(), `owner-directive-${process.pid}-${tmp += 1}-${name}`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const NOW = Date.parse('2026-08-06T02:11:00.000Z');
const ISO = new Date(NOW - 30e3).toISOString();

const directive = () => ({
  schemaVersion: 1,
  status: 'pending',
  priority: 'owner',
  id: 'farm-55765118-level-5',
  action: 'fund-and-upgrade-building',
  buildingId: 55765118,
  targetLevel: 5,
  program: { buildingIds: [55765118], targetLevel: 5 },
});

function stateWithFarm(extra) {
  return {
    t: ISO,
    sources: { buildings: { status: 'ok', asOf: ISO } },
    buildings: [{
      id: 55765118, name: 'Farm', kindLetter: 'P', category: 'production', size: 5, ...extra,
    }],
  };
}

function readWith(state) {
  const dFile = scratch('directive.json', directive());
  const sFile = scratch('state.json', state);
  const result = readPendingOwnerDirective(dFile, sFile, NOW);
  return { result, stored: JSON.parse(fs.readFileSync(dFile, 'utf8')) };
}

test('an idle building with no busy key completes the program', () => {
  // This is the exact shape state.js produces for an idle building: no `busy` property at all.
  const { result, stored } = readWith(stateWithFarm({}));
  assert.equal(result, null, 'a completed directive must stop being returned as pending');
  assert.equal(stored.status, 'completed');
  assert.equal(stored.completionEvidence.level, 5);
  assert.equal(stored.completionEvidence.idle, true);
  assert.equal(stored.completionEvidence.activity, 'idle');
});

test('an explicit busy:null also completes', () => {
  const { result } = readWith(stateWithFarm({ busy: null }));
  assert.equal(result, null);
});

test('a building still under construction does NOT complete', () => {
  // The critical property. `size` already reads the target level here, so only the activity test
  // stands between a started upgrade and a directive that retires before the work is done.
  const { result, stored } = readWith(stateWithFarm({
    busy: { type: 'construction', endsAt: new Date(NOW + 3600e3).toISOString() },
  }));
  assert.ok(result, 'the directive must stay pending while the upgrade is still building');
  assert.equal(result.status, 'pending');
  assert.equal(stored.status, 'pending');
});

test('a building running normal work completes', () => {
  for (const type of ['production', 'sale']) {
    const { result } = readWith(stateWithFarm({ busy: { type } }));
    assert.equal(result, null, `${type} is a completed program activity`);
  }
});

test('an unrecognised busy type does not complete', () => {
  const { result } = readWith(stateWithFarm({ busy: { type: 'something-new' } }));
  assert.ok(result, 'an activity this module does not understand must fail closed');
});

test('a level below the target does not complete', () => {
  const state = stateWithFarm({});
  state.buildings[0].size = 4;
  const { result } = readWith(state);
  assert.ok(result, 'size below the target must keep the directive pending');
});

test('a stale state does not complete', () => {
  const old = new Date(NOW - 10 * 60e3).toISOString();
  const state = stateWithFarm({});
  state.t = old;
  state.sources.buildings.asOf = old;
  const { result } = readWith(state);
  assert.ok(result, 'evidence older than the freshness window must not complete a program');
});

test('a non-authoritative building source does not complete', () => {
  const state = stateWithFarm({});
  state.sources.buildings.status = 'stale';
  const { result } = readWith(state);
  assert.ok(result, 'a schedule read that is not authoritative could make every building look idle');
});
