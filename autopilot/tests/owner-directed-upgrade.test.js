'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { councilRequiredForStructuralAction } = require('../runtime-guard.js');

// The council decides what to do with money the company has discretion over. An owner directive is
// not that — it is the decision, arriving from outside. Putting one to a vote produced exactly what
// you would expect: on 2026-08-07 the pending directive to take Farm 55692919 to level 4 was
// submitted as an ordinary option and voted down 2-1 (COO for, CFO and CMO against) on a $7,652
// upgrade that doubles output, with $172,630 in the bank and the bean chain running a 652/h
// deficit. The same building had been held the same way the previous day. No reasoning was recorded
// either way; 89.7% of all council verdicts in the log are hold.

const DIRECTIVE = {
  status: 'pending',
  priority: 'owner',
  action: 'fund-and-upgrade-building',
  buildingId: 55692919,
  targetLevel: 4,
};

test('an owner-directed upgrade does not need a vote', () => {
  assert.equal(
    councilRequiredForStructuralAction('upgrade', { buildingId: 55692919 }, DIRECTIVE), false);
});

test('the exemption is confined to the building the directive names', () => {
  assert.equal(
    councilRequiredForStructuralAction('upgrade', { buildingId: 55828520 }, DIRECTIVE), true,
    'a directive on one building must not license spending on another');
});

test('the exemption is confined to upgrade', () => {
  for (const action of ['build', 'scrap', 'rebuild', 'bonds']) {
    assert.equal(
      councilRequiredForStructuralAction(action, { buildingId: 55692919 }, DIRECTIVE), true,
      `${action} on the directed building must still be voted on`);
  }
});

test('no directive, a spent directive, or the wrong kind of directive all still need a vote', () => {
  const cases = [
    ['none', null],
    ['completed', { ...DIRECTIVE, status: 'completed' }],
    ['not owner priority', { ...DIRECTIVE, priority: 'suggested' }],
    ['a different action', { ...DIRECTIVE, action: 'something-else' }],
    ['no buildingId', { ...DIRECTIVE, buildingId: null }],
    ['no targetLevel', { ...DIRECTIVE, targetLevel: null }],
  ];
  for (const [label, directive] of cases) {
    assert.equal(
      councilRequiredForStructuralAction('upgrade', { buildingId: 55692919 }, directive), true,
      `${label} must not exempt anything`);
  }
});

test('called with no directive at all, nothing changes for any structural action', () => {
  // The old signature took only the action. Anything still calling it that way must get the old
  // answer rather than a silent exemption.
  for (const action of ['upgrade', 'build', 'scrap', 'rebuild']) {
    assert.equal(councilRequiredForStructuralAction(action), true);
  }
  assert.equal(councilRequiredForStructuralAction('produce'), false);
});

test('both engines pass the directive through, or the exemption never reaches the guard', () => {
  for (const engine of ['brain.js', 'brain56.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', engine), 'utf8');
    assert.match(src,
      /councilRequiredForStructuralAction\(action, checked\.params, ownerDirectiveForAction\)/u,
      `${engine} must hand the guard the params and the directive`);
  }
});

test('the prompt tells the model what the runtime already permits', () => {
  // #93 exempted the runtime and left the instructions describing the full seven-step ceremony, so
  // the model kept running it: on 2026-08-08 the direction vote passed 3-0 and the wake then spent
  // ten minutes on a re-preview and two council calls, hit the context ceiling, and closed without
  // making the change. A mechanism the model does not know about is not a mechanism.
  const brain = fs.readFileSync(path.join(__dirname, '..', 'BRAIN.md'), 'utf8');
  const section = brain.slice(brain.indexOf('pending owner directive skips'));
  assert.ok(section, 'BRAIN.md must state the exemption');
  assert.match(section.slice(0, 700), /No\s+`strategy_council`, no `council`/u,
    'it must name both votes, since the runtime exempts both');
  assert.match(section.slice(0, 2400), /build.*scrap.*rebuild.*bonds/su,
    'it must also say what is NOT exempt, or the model will generalise');
});

test('the prompt records the retail ceiling that bounds the Mill count', () => {
  // The target portfolio recorded in #78 copied the planner's capacity figures without checking the
  // demand side. Measured 2026-08-08: the Grocery absorbs 261.0 powder/h, and the target's twelve
  // Mill levels produce 278.3/h with the exchange saturated for that product. The brain kept
  // attempting the upgrade — 52 calls and 26 minutes in one wake — because the prompt told it the
  // capacity was the goal and said nothing about where the output would go.
  const brain = fs.readFileSync(path.join(__dirname, '..', 'BRAIN.md'), 'utf8');
  assert.match(brain, /261\.0 units\/h/u, 'the measured absorption must be stated');
  assert.match(brain, /−17\.3\/h|-17\.3\/h/u, 'and the deficit the target implies');
  assert.match(brain, /Grocery above L3|contract sales/u,
    'and what has to happen before more Mill capacity is worth buying');
});
