'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { calculateCoffeeReservePolicy } = require('../coffee-reserve-policy.js');

const SIM = path.join(__dirname, '..', '..');

// Regression: a company that owns no Mill could never close a wake.
//
// calculateCoffeeReservePolicy reports complete:false / status:'unknown' when there is no Mill,
// which is correct — there is no chain to reserve against. But utilityJournalGate treated any
// non-ok plan as "go inspect the Mills", and millCapacity.missingBuildingIds is empty in that
// state, so the model was told to inspect "every current Mill" while none existed. The journal
// gate could never pass, so every wake burned its whole budget and closed as a safety retry.

const noMillState = {
  t: new Date().toISOString(),
  buildings: [
    { id: 900001, name: 'Farm', size: 1, busy: {} },
    { id: 900002, name: 'Farm', size: 1, busy: {} },
    { id: 900003, name: 'Grocery store', size: 1, busy: {} },
  ],
  inventory: [
    { kind: 1, amount: 10000, availableAmount: 10000 },
    { kind: 2, amount: 8589, availableAmount: 8589 },
  ],
};

test('the reserve policy reports UNKNOWN with no Mill, and names no building to inspect', () => {
  const plan = calculateCoffeeReservePolicy({ state: noMillState, rates: {}, nowMs: Date.now() });
  assert.equal(plan.complete, false);
  assert.equal(plan.status, 'unknown');
  // This emptiness is the trap: the gate's error message has no building to point at.
  assert.deepEqual(plan.millCapacity.missingBuildingIds, []);
});

// The gate lives inside each engine's module scope, so this asserts the guard exists in both
// rather than importing it. A regex is the honest tool here: the alternative is exporting internals
// purely for the test, which widens the engines' surface for no runtime benefit.
test('both engines short-circuit the utility gate when no Mill is owned', () => {
  for (const engine of ['autopilot/brain.js', 'autopilot/brain56.js']) {
    const source = fs.readFileSync(path.join(SIM, engine), 'utf8');
    assert.match(source, /function ownsAMill\(state\)/,
      `${engine} must be able to tell whether a Mill is owned`);
    assert.match(source, /if \(!ownsAMill\(state\)\) return null;/,
      `${engine} must pass the utility gate when there is no Mill`);

    // The short circuit has to come before the block it defuses, or it changes nothing.
    const shortCircuit = source.indexOf('if (!ownsAMill(state)) return null;');
    const millDemand = source.indexOf('inspect every current Mill');
    assert.ok(shortCircuit > 0 && millDemand > 0, `${engine} must contain both sites`);
    assert.ok(shortCircuit < millDemand,
      `${engine} must short-circuit before demanding a Mill inspection`);
  }
});

test('a Mill in state still reaches the ordinary unverified-surplus block', () => {
  for (const engine of ['autopilot/brain.js', 'autopilot/brain56.js']) {
    const source = fs.readFileSync(path.join(SIM, engine), 'utf8');
    // The guard must key on ownership, not on the plan, or a real Mill whose rate is stale would
    // also skip the review that protects the Coffee reserve.
    assert.match(source, /String\(building\?\.name \|\| ''\)\.toLowerCase\(\) === 'mill' \|\| building\?\.kindLetter === 'i'/,
      `${engine} must detect a Mill by name or kind letter`);
  }
});
