'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { actionable, stateAgeMs } = require('../auto-upgrade.js');

const FARM = { buildingId: 55648404, building: 'Farm', targetLevel: 2, maxCostPerStep: 40000, status: 'pending' };
const stateWith = building => ({
  t: new Date().toISOString(),
  sources: { buildings: { status: 'ok' } },
  buildings: [building],
});

test('an idle building below its target is actionable', () => {
  const blocker = actionable(FARM, stateWith({ id: 55648404, name: 'Farm', size: 1, busy: null }));
  assert.equal(blocker, null);
});

// The whole point of the one-minute poll is the gap between jobs. Acting on a busy building would
// either fail at the game or, worse, race a running order.
test('a busy building is refused and reports what is holding it', () => {
  const blocker = actionable(FARM, stateWith({
    id: 55648404, name: 'Farm', size: 1,
    busy: { type: 'construction', endsAt: '2026-08-03T04:09:05.893Z' },
  }));
  assert.match(blocker, /busy \(construction until 2026-08-03T04:09:05\.893Z\)/);
});

test('reaching the target level completes the goal instead of upgrading again', () => {
  assert.equal(actionable(FARM, stateWith({ id: 55648404, name: 'Farm', size: 2, busy: null })), 'REACHED');
  assert.equal(actionable(FARM, stateWith({ id: 55648404, name: 'Farm', size: 5, busy: null })), 'REACHED');
});

// A scrapped slot can be rebuilt as something else under a new id, and ids are reused across a
// company's lifetime. An upgrade budget aimed at a Farm must never be spent on whatever now
// answers to that number.
test('a building whose name no longer matches the plan is refused', () => {
  const blocker = actionable(FARM, stateWith({ id: 55648404, name: 'Mill', size: 1, busy: null }));
  assert.match(blocker, /is a Mill, not the planned Farm/);
});

test('a missing or duplicated building is refused rather than guessed', () => {
  assert.match(actionable(FARM, stateWith({ id: 999, name: 'Farm', size: 1, busy: null })),
    /missing or duplicated/);
  assert.match(actionable(FARM, {
    t: new Date().toISOString(),
    sources: { buildings: { status: 'ok' } },
    buildings: [
      { id: 55648404, name: 'Farm', size: 1, busy: null },
      { id: 55648404, name: 'Farm', size: 3, busy: null },
    ],
  }), /missing or duplicated/);
});

test('an unreadable level is refused, never treated as level zero', () => {
  assert.match(actionable(FARM, stateWith({ id: 55648404, name: 'Farm', size: null, busy: null })),
    /unreadable level/);
  assert.match(actionable(FARM, stateWith({ id: 55648404, name: 'Farm', size: 'three', busy: null })),
    /unreadable level/);
});

// Regression (2026-08-03, live): 'complete' returned null, and null is the go-ahead signal, so a
// finished target skipped every guard below it and the loop re-confirmed an upgrade on it once a
// minute. The first version of this test asserted null and therefore certified the bug — a
// completed target must return a value that is NOT the go-ahead.
test('a completed target reports DONE and never the go-ahead signal', () => {
  const done = { ...FARM, status: 'complete' };
  const verdict = actionable(done, stateWith({ id: 55648404, name: 'Farm', size: 1, busy: null }));
  assert.notEqual(verdict, null, 'null would send a finished target straight to an upgrade confirm');
  assert.equal(verdict, 'DONE');
});

// The same bypass also skipped the busy check, so it would have confirmed against a building that
// was mid-construction from its own previous upgrade.
test('a completed target stays DONE even when it looks otherwise actionable', () => {
  const done = { ...FARM, status: 'complete' };
  for (const building of [
    { id: 55648404, name: 'Farm', size: 2, busy: null },
    { id: 55648404, name: 'Farm', size: 1, busy: { type: 'construction', endsAt: '2026-08-03T05:10:10.195Z' } },
    { id: 55648404, name: 'Mill', size: 1, busy: null },
  ]) {
    assert.equal(actionable(done, stateWith(building)), 'DONE');
  }
});

// Only null may reach the upgrade confirm. Anything else is a blocker or an outcome.
test('the go-ahead signal is reserved for a live, idle, under-target, name-matched building', () => {
  assert.equal(actionable(FARM, stateWith({ id: 55648404, name: 'Farm', size: 1, busy: null })), null);
  for (const building of [
    { id: 55648404, name: 'Farm', size: 2, busy: null },
    { id: 55648404, name: 'Farm', size: 1, busy: { type: 'production', endsAt: 'x' } },
    { id: 55648404, name: 'Mill', size: 1, busy: null },
    { id: 999, name: 'Farm', size: 1, busy: null },
  ]) {
    assert.notEqual(actionable(FARM, stateWith(building)), null);
  }
});

// A capture older than the poll interval cannot prove a building is idle right now.
test('state age is measured from the capture stamp and unknown stamps read as infinite', () => {
  assert.ok(stateAgeMs({ t: new Date(Date.now() - 60000).toISOString() }) >= 59000);
  assert.equal(stateAgeMs({ t: 'not a date' }), Infinity);
  assert.equal(stateAgeMs(null), Infinity);
});

test('the shipped plan targets exactly the two buildings the owner placed by hand', () => {
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'UPGRADE-PLAN.json'), 'utf8'));
  assert.equal(plan.schemaVersion, 1);
  const byId = Object.fromEntries(plan.targets.map(target => [target.buildingId, target]));
  assert.equal(byId[55648404].building, 'Farm');
  assert.equal(byId[55648404].targetLevel, 2);
  assert.equal(byId[55648396].building, 'Mill');
  assert.equal(byId[55648396].targetLevel, 3);
  assert.ok(plan.minCashAfter > 0, 'the plan must keep a cash floor');
  for (const target of plan.targets) {
    assert.ok(target.maxCostPerStep > 0, `${target.building} needs a per-step spend cap`);
  }
});
