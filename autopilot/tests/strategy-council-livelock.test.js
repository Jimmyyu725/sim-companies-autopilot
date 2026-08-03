'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WakeRuntimeGuard } = require('../runtime-guard.js');

// Live 2026-08-03, first wake on a three-building company: every building was busy, so the Farm
// upgrade preview was refused with "building busy — cannot upgrade". Only SUCCESSFUL previews were
// recorded, so the missing-preview guard could not tell "never previewed" from "previewed and
// refused" and answered both with "preview it again, then call strategy_council again". The model
// obeyed. Six councils — eighteen reasoning-model calls — ran in seventeen minutes before the wake
// was stopped by hand.

const BUSY_STATE = {
  t: new Date().toISOString(),
  sources: { buildings: { status: 'ok' } },
  buildings: [{ id: 900001, name: 'Farm', size: 1, busy: { type: 'production' } }],
};

function guardWithRefusedUpgradePreview() {
  const guard = new WakeRuntimeGuard();
  guard.configureStrategyCouncil({ required: true, reasons: ['first-deployment'] });
  // The game refuses the preview because the building is busy.
  guard.afterAction('upgrade', { buildingId: 900001, confirm: false },
    { ok: false, reason: 'building busy — cannot upgrade' });
  return guard;
}

test('a preview the game refused is remembered, not silently forgotten', () => {
  const guard = guardWithRefusedUpgradePreview();
  assert.equal(guard.strategyPreviewFailures.size, 1,
    'a refused preview must leave evidence, or the guard cannot tell why a candidate is missing');
});

test('the guard tells the model to drop a refused option instead of re-previewing it', () => {
  const guard = guardWithRefusedUpgradePreview();
  // A separate rule refuses an option set that stays entirely inside the Coffee baseline, so the
  // set needs a successfully previewed outsider to reach the missing-preview check at all.
  guard.afterAction('build', { building: 'Bakery', confirm: false },
    { ok: true, dry: true, preview: true, building: 'Bakery', quoted: 42485, money: 9056, cashAfter: -33429 });
  const verdict = guard.prepareStrategyCouncil({
    options: [
      { id: 'farm-upgrade', action: 'upgrade', buildingId: 900001 },
      { id: 'build-bakery', action: 'build', target: 'bakery' },
      { id: 'hold', action: 'hold' },
    ],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.requiredNextStep, /remove option\(s\) farm-upgrade/,
    'the instruction must be to drop it — telling the model to preview it again is the loop');
  assert.doesNotMatch(verdict.requiredNextStep, /run farm-upgrade with confirm:false/);
});

// The ceiling is the backstop: even if the model ignores every instruction, the wake terminates.
test('strategy council stops after a bounded number of attempts', () => {
  const guard = new WakeRuntimeGuard();
  guard.configureStrategyCouncil({ required: true, reasons: ['first-deployment'] });

  let refusedAt = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const before = guard.beforeStrategyCouncil();
    if (before && before.ok === false) { refusedAt = attempt; break; }
    guard.noteStrategyCouncil({ ok: false }, { options: [] });
  }

  assert.ok(refusedAt !== null, 'the council must eventually refuse, or a wake can never terminate');
  assert.ok(refusedAt <= 5, `refused only at attempt ${refusedAt}; the ceiling is meant to be tight`);
});

test('the ceiling satisfies the checkpoint as a hold, and authorizes nothing', () => {
  const guard = new WakeRuntimeGuard();
  guard.configureStrategyCouncil({ required: true, reasons: ['first-deployment'] });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const before = guard.beforeStrategyCouncil();
    if (before && before.ok === false && /ceiling/.test(before.reason || '')) break;
    guard.noteStrategyCouncil({ ok: false }, { options: [] });
  }

  // Satisfied, so the journal is not deadlocked behind an impossible checkpoint...
  assert.equal(guard.strategyCouncilCompleted, true);
  // ...but it is a hold, so no structural direction is authorized.
  assert.equal(guard.strategyCouncilDecision.method, 'safety_hold');
  assert.equal(guard.strategyCouncilDecision.optionId, 'hold');
  assert.equal(guard.strategyCouncilDecision.action, 'hold');
});

test('a fresh checkpoint clears the attempt count and the refusal memory', () => {
  const guard = guardWithRefusedUpgradePreview();
  guard.noteStrategyCouncil({ ok: false }, { options: [] });
  guard.configureStrategyCouncil({ required: true, reasons: ['next-wake'] });
  assert.equal(guard.strategyCouncilAttempts, 0, 'a stale count would refuse a healthy council');
  assert.equal(guard.strategyPreviewFailures.size, 0,
    'a stale refusal would drop an option that is executable again');
});
