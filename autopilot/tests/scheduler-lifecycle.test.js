'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  FAILURE_RETRY_MS,
  capAlarmAfterBrainFailure,
  parseAlarm,
  reconcileAlarm,
  runAlarmCheck,
} = require('../check-alarm.js');
const {
  brainLockHeld,
  classifyBrainLockProbe,
  deferDueAlarm,
  inspectAlarm,
  restoreDeferredAlarm,
} = require('../gate.js');

function alarm(at, reason = 'test alarm') {
  return { at, atIso: new Date(at).toISOString(), reason };
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-scheduler-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('alarm parser rejects syntactically valid JSON with an invalid schedule', () => {
  assert.equal(parseAlarm({ atIso: new Date().toISOString(), reason: 'missing at' }), null);
  assert.equal(parseAlarm({ at: '123', atIso: new Date(123).toISOString(), reason: 'string at' }), null);
  assert.equal(parseAlarm({ at: 123, atIso: new Date(456).toISOString(), reason: 'mismatch' }), null);
});

test('a missing or invalid final alarm retries within five minutes even without completion evidence', () => {
  const now = Date.parse('2026-07-27T03:00:00.000Z');
  const result = reconcileAlarm(null, null, now);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'invalid-alarm');
  assert.equal(result.alarm.at, now + FAILURE_RETRY_MS);
});

test('gate treats missing or corrupt alarms as due and a future alarm as sleeping', t => {
  const directory = tempDirectory(t);
  const file = path.join(directory, 'next-wake.json');
  assert.equal(inspectAlarm(file, 1000).due, true);
  fs.writeFileSync(file, JSON.stringify({ nope: true }));
  assert.equal(inspectAlarm(file, 1000).due, true);
  fs.writeFileSync(file, JSON.stringify(alarm(2000)));
  assert.deepEqual(inspectAlarm(file, 1000), { alarm: alarm(2000), valid: true, due: false });
});

test('an immediate owner alarm remains a valid due request', () => {
  const immediate = { at: 0, atIso: '2026-07-27T02:55:12.000Z', reason: 'Immediate owner request' };
  assert.deepEqual(parseAlarm(immediate), immediate);
  const result = reconcileAlarm(immediate, {
    t: '2026-07-27T02:55:30.000Z',
    buildings: [],
  }, Date.parse('2026-07-27T02:56:00.000Z'));
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'already-due');
});

test('alarm correction includes a completion that elapsed during a long wake', () => {
  const now = Date.parse('2026-07-27T03:00:00.000Z');
  const result = reconcileAlarm(alarm(now + 60 * 60e3), {
    t: new Date(now - 10 * 60e3).toISOString(),
    buildings: [{ busy: { endsAt: new Date(now - 2 * 60e3).toISOString() } }],
  }, now);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'oversleep');
  assert.equal(result.alarm.at, now + 60e3);
});

test('a failed brain wake cannot retain an alarm beyond the five-minute recovery bound', () => {
  const now = Date.parse('2026-07-27T03:00:00.000Z');
  const late = alarm(now + 3 * 3600e3, 'old strategic checkpoint');
  const capped = capAlarmAfterBrainFailure(late, now);
  assert.equal(capped.changed, true);
  assert.equal(capped.alarm.at, now + FAILURE_RETRY_MS);
  assert.match(capped.alarm.reason, /brain exited/i);

  const sooner = alarm(now + 2 * 60e3, 'already safe');
  assert.deepEqual(capAlarmAfterBrainFailure(sooner, now), {
    alarm: sooner,
    changed: false,
    reason: 'already-sooner',
  });
  const immediate = { at: 0, atIso: new Date(now).toISOString(), reason: 'owner wake' };
  assert.equal(capAlarmAfterBrainFailure(immediate, now).alarm.at, 0);
});

test('stale state cannot turn a state-capture retry into a one-minute wake loop', () => {
  const now = Date.parse('2026-07-27T03:00:00.000Z');
  const retry = alarm(now + 15 * 60e3, 'state capture failed, retry');
  const result = reconcileAlarm(retry, {
    t: new Date(now - 60 * 60e3).toISOString(),
    buildings: [{ busy: { endsAt: new Date(now - 30 * 60e3).toISOString() } }],
  }, now);
  assert.equal(result.changed, false);
  assert.equal(result.alarm.at, retry.at);
  assert.equal(result.earliest, null);
});

test('a non-authoritative building source cannot shorten an alarm', () => {
  const now = Date.parse('2026-07-27T03:00:00.000Z');
  const scheduled = alarm(now + 15 * 60e3);
  const result = reconcileAlarm(scheduled, {
    t: new Date(now).toISOString(),
    sources: { buildings: { status: 'fallback', asOf: new Date(now).toISOString() } },
    buildings: [{ busy: { endsAt: new Date(now - 60e3).toISOString() } }],
  }, now);
  assert.equal(result.changed, false);
  assert.equal(result.earliest, null);
});

test('invalid final alarm is repaired atomically and CURRENT follows it', t => {
  const directory = tempDirectory(t);
  const now = Date.parse('2026-07-27T03:00:00.000Z');
  fs.writeFileSync(path.join(directory, 'next-wake.json'), JSON.stringify({ at: 'not-a-time' }));
  fs.writeFileSync(path.join(directory, '.state.json'), JSON.stringify({
    t: new Date(now).toISOString(),
    buildings: [{ busy: { endsAt: new Date(now + 10 * 60e3).toISOString() } }],
  }));
  fs.writeFileSync(path.join(directory, 'CURRENT.json'), JSON.stringify({
    schemaVersion: 2,
    updatedAt: new Date(now).toISOString(),
    stateAsOf: new Date(now).toISOString(),
    cash: null,
    debtPrincipal: null,
    slots: { capacity: null, used: null, free: null },
    done: [],
    blockers: [],
    plan: [],
    reviews: {
      warehouse: 'Unknown.',
      upgradeAndDebt: 'Unknown.',
      utilitySurplus: 'Unknown.',
      longTerm: 'Unknown.',
    },
    nextDecisionAt: 'old',
  }));
  const result = runAlarmCheck({ brainDir: directory, nowMs: now });
  assert.equal(result.changed, true);
  assert.equal(result.alarm.at, now + FAILURE_RETRY_MS);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'next-wake.json'), 'utf8')), result.alarm);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(directory, 'CURRENT.json'), 'utf8')).nextDecisionAt,
    result.alarm.atIso,
  );
});

test('due alarm observed during a lock is deferred and restored ahead of a later alarm', t => {
  const directory = tempDirectory(t);
  const immediate = { at: 0, atIso: '2026-07-27T02:55:12.000Z', reason: 'Immediate owner request' };
  fs.writeFileSync(path.join(directory, 'next-wake.json'), JSON.stringify(immediate));
  assert.equal(deferDueAlarm(directory, Date.parse('2026-07-27T02:56:00.000Z')), true);
  fs.writeFileSync(path.join(directory, 'next-wake.json'), JSON.stringify(alarm(Date.parse('2026-07-27T06:00:00.000Z'))));
  assert.equal(restoreDeferredAlarm(directory), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'next-wake.json'), 'utf8')), immediate);
  assert.equal(fs.existsSync(path.join(directory, '.deferred-wake.json')), false);
});

test('deferred copy of the alarm that started this wake is not replayed', t => {
  const directory = tempDirectory(t);
  const consumed = alarm(Date.parse('2026-07-27T03:00:00.000Z'), 'scheduled wake');
  fs.writeFileSync(path.join(directory, '.last-wake.json'), JSON.stringify(consumed));
  fs.writeFileSync(path.join(directory, '.deferred-wake.json'), JSON.stringify(consumed));
  const future = alarm(Date.parse('2026-07-27T06:00:00.000Z'));
  fs.writeFileSync(path.join(directory, 'next-wake.json'), JSON.stringify(future));
  assert.equal(restoreDeferredAlarm(directory), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'next-wake.json'), 'utf8')), future);
  assert.equal(fs.existsSync(path.join(directory, '.deferred-wake.json')), false);
});

test('brain lock probe distinguishes an active flock owner', async t => {
  const directory = tempDirectory(t);
  const lockFile = path.join(directory, '.brain.lock');
  assert.equal(brainLockHeld(lockFile), false);
  const holder = spawn('flock', ['-x', lockFile, '-c', 'echo locked; read value'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => { try { holder.kill('SIGTERM'); } catch (_) {} });
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve);
    holder.once('error', reject);
    holder.once('exit', code => {
      if (code !== 0) reject(new Error(`lock holder exited early with ${code}`));
    });
  });
  assert.equal(brainLockHeld(lockFile), true);
  holder.stdin.end();
});

test('brain lock probe fails closed when flock cannot report lock state', () => {
  assert.equal(classifyBrainLockProbe({ status: 0 }), false);
  assert.equal(classifyBrainLockProbe({ status: 1 }), true);
  assert.throws(
    () => classifyBrainLockProbe({ error: new Error('flock missing'), status: null }),
    /flock missing/,
  );
  assert.throws(() => classifyBrainLockProbe({ status: 2 }), /status 2/);
  assert.throws(() => classifyBrainLockProbe({ status: null }), /no exit status/);
});
