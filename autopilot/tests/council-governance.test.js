'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  evaluateStrategyCouncilRequirement,
  recordStrategyCouncilDecision,
  strategicSnapshot,
} = require('../council-governance.js');

const NOW = Date.parse('2026-07-30T20:00:00.000Z');
const STATE = {
  level: 14,
  slotCapacity: 10,
  usedSlots: 7,
  freeSlots: 3,
  bonds: { principalOutstanding: 345000 },
  buildings: [
    { id: 1, name: 'Farm', size: 3 },
    { id: 2, name: 'Mill', size: 2 },
    { id: 3, name: 'Beach market', size: 1, freeAndLocked: true },
  ],
  modifiers: [{ kind: 66, pct: 6.25, until: '2026-08-02T00:00:00.000Z' }],
};
const CURRENT = {
  blockers: ['Council must decide whether to upgrade building 2.'],
  plan: ['Routine timestamp 2026-07-30T20:00:00.000Z'],
  reviews: {
    upgradeAndDebt: 'Compare debt-funded upgrade cost 12345.',
    longTerm: 'Evaluate Tools pivot after level 15.',
  },
};

function decisionRecord(overrides = {}) {
  return {
    recordType: 'strategy_council_decision',
    status: 'DECIDED',
    wakeId: 'diary-council',
    completedAt: new Date(NOW - 6 * 3600e3).toISOString(),
    snapshot: strategicSnapshot(STATE, CURRENT),
    ...overrides,
  };
}

function successfulWake(index) {
  return {
    record_type: 'wake_usage_summary',
    brain_rc: 0,
    wake_id: `diary-${index}`,
    ended_at: new Date(NOW - (30 - index) * 60e3).toISOString(),
  };
}

test('first deployment requires a strategy council immediately', () => {
  const result = evaluateStrategyCouncilRequirement({
    state: STATE,
    current: CURRENT,
    now: NOW,
  });
  assert.equal(result.required, true);
  assert.deepEqual(result.reasons, ['no-successful-strategy-council']);
  assert.equal(result.currentWakeOrdinal, 1);
});

test('cadence triggers on the twentieth successful wake after the prior council wake', () => {
  const prior = decisionRecord({
    completedAt: new Date(NOW - 12 * 3600e3).toISOString(),
  });
  const councilWakeSummary = {
    record_type: 'wake_usage_summary',
    brain_rc: 0,
    wake_id: prior.wakeId,
    ended_at: new Date(Date.parse(prior.completedAt) + 60e3).toISOString(),
  };
  const nineteen = Array.from({ length: 19 }, (_, index) => successfulWake(index + 1));
  const before = evaluateStrategyCouncilRequirement({
    state: STATE,
    current: CURRENT,
    wakeRecords: [councilWakeSummary, ...nineteen.slice(0, 18)],
    decisionRecords: [prior],
    now: NOW,
  });
  assert.equal(before.required, false);
  assert.equal(before.currentWakeOrdinal, 19);

  const due = evaluateStrategyCouncilRequirement({
    state: STATE,
    current: CURRENT,
    wakeRecords: [councilWakeSummary, ...nineteen],
    decisionRecords: [prior],
    now: NOW,
  });
  assert.equal(due.required, true);
  assert(due.reasons.includes('wake-cadence'));
  assert.equal(due.currentWakeOrdinal, 20);
});

test('daily backstop and material portfolio changes trigger independently', () => {
  const oldDecision = decisionRecord({
    completedAt: new Date(NOW - 25 * 3600e3).toISOString(),
  });
  const daily = evaluateStrategyCouncilRequirement({
    state: STATE,
    current: CURRENT,
    decisionRecords: [oldDecision],
    now: NOW,
  });
  assert(daily.reasons.includes('daily-backstop'));

  const changed = evaluateStrategyCouncilRequirement({
    state: { ...STATE, freeSlots: 2, usedSlots: 8 },
    current: CURRENT,
    decisionRecords: [decisionRecord()],
    now: NOW,
  });
  assert(changed.reasons.includes('material-strategy-change'));
  assert(changed.materialChanges.includes('freeSlots'));
});

test('routine plan timestamps and changing numeric estimates do not create false strategy changes', () => {
  const nextCurrent = {
    ...CURRENT,
    plan: ['Routine timestamp 2026-07-31T01:00:00.000Z'],
    blockers: ['Council must decide whether to upgrade building 9.'],
    reviews: {
      ...CURRENT.reviews,
      upgradeAndDebt: 'Compare debt-funded upgrade cost 67890.',
    },
  };
  const result = evaluateStrategyCouncilRequirement({
    state: STATE,
    current: nextCurrent,
    decisionRecords: [decisionRecord()],
    now: NOW,
  });
  assert.equal(result.required, false);
  assert.deepEqual(result.materialChanges, []);
});

test('decision history is private, durable, and idempotent per wake', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-council-'));
  const filename = path.join(directory, 'history.jsonl');
  try {
    const payload = {
      wakeId: 'diary-one',
      result: {
        decision: {
          status: 'DECIDED',
          optionId: 'hold',
          method: 'majority',
          tally: { hold: 2, upgrade_mill: 1 },
        },
      },
      args: {
        question: 'Which direction should the company take?',
        options: [{ id: 'hold' }, { id: 'upgrade_mill' }],
      },
      snapshot: strategicSnapshot(STATE, CURRENT),
      requirement: { reasons: ['wake-cadence'] },
    };
    const first = recordStrategyCouncilDecision(filename, payload);
    const second = recordStrategyCouncilDecision(filename, payload);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(fs.readFileSync(filename, 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
