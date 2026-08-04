'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { normalizedAcceleration } = require('../state-helpers.js');
const { calculateCoffeeReservePolicy } = require('../coffee-reserve-policy.js');

const SIM = path.join(__dirname, '..', '..');
const FACTS = JSON.parse(fs.readFileSync(path.join(SIM, 'shared', 'facts', 'game-facts.json'), 'utf8'));

// Measured 2026-08-03 on the live company: the Farm page printed 889.63 Seeds/h while the
// encyclopedia printed 2,668.89/h "(3x)" — exactly three times. Building pages print the 1x rate.
// The reserve is computed from those printed rates, so during a founding acceleration it reserved
// a third of what the chain would actually consume, and the "surplus" it freed for sale was
// inventory the Mills were about to eat.

test('an acceleration is only active when it has a multiplier, an expiry, and time left', () => {
  const future = '2126-01-01T00:00:00.000Z';
  assert.equal(normalizedAcceleration({ multiplier: 3, until: future }).active, true);
  assert.equal(normalizedAcceleration({ multiplier: 3, until: '2000-01-01T00:00:00Z' }).active, false);
  assert.equal(normalizedAcceleration({ multiplier: 1, until: future }).active, false);
  assert.equal(normalizedAcceleration(null).active, false);
  assert.equal(normalizedAcceleration(undefined).multiplier, 1);
});

// An unreadable multiplier must never be read as 1: that is precisely the value that silently
// under-reserves everything.
test('a malformed multiplier is UNKNOWN, never 1', () => {
  assert.equal(normalizedAcceleration({ multiplier: 'fast', until: '2126-01-01T00:00:00Z' }).active, 'UNKNOWN');
  assert.equal(normalizedAcceleration({ multiplier: 3, until: 'not a date' }).active, 'UNKNOWN');
  assert.equal(normalizedAcceleration({ multiplier: -2, until: '2126-01-01T00:00:00Z' }).multiplier, null);
});

function planWith(acceleration) {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'accel-state.json'), 'utf8'));
  state.levelingProgress = Object.assign({}, state.levelingProgress, { acceleration });
  return calculateCoffeeReservePolicy({ state, facts: FACTS, nowMs: Date.now() });
}

test('the reserve refuses to answer while a multiplier is running', () => {
  const plan = planWith({ multiplier: 3, until: '2126-01-01T00:00:00.000Z', active: true });
  assert.equal(plan.accelerationUnmodelled, true);
  assert.notEqual(plan.status, 'ok');
  assert.equal(plan.complete, false);
});

test('an expired or absent multiplier does not block the reserve', () => {
  for (const accel of [
    { multiplier: 3, until: '2000-01-01T00:00:00.000Z', active: false },
    { multiplier: 1, until: null, active: false },
  ]) {
    assert.notEqual(planWith(accel).accelerationUnmodelled, true);
  }
});

test('an unreadable multiplier blocks too — it is not evidence of 1x', () => {
  assert.equal(planWith({ multiplier: null, until: null, active: 'UNKNOWN' }).accelerationUnmodelled, true);
});

// Without this the fix would trade a silent under-reserve for a livelock: with a Mill owned, the
// utility gate answers an incomplete plan by demanding Mill inspections, and no number of them can
// complete a plan that is blocked on the multiplier.
test('both engines pass the utility gate on an unmodelled multiplier instead of demanding inspections', () => {
  for (const engine of ['autopilot/brain.js', 'autopilot/brain56.js']) {
    const source = fs.readFileSync(path.join(SIM, engine), 'utf8');
    assert.match(source, /if \(plan\?\.accelerationUnmodelled === true\) return null;/,
      `${engine} must not demand Mill inspections it can never satisfy`);
    const shortCircuit = source.indexOf('if (plan?.accelerationUnmodelled === true) return null;');
    const millDemand = source.indexOf('inspect every current Mill');
    assert.ok(shortCircuit > 0 && shortCircuit < millDemand,
      `${engine} must short-circuit before the Mill demand`);
  }
});
