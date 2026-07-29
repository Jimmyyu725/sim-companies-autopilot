#!/usr/bin/env node
'use strict';

// Zero-LLM alarm gate. Cron runs this every minute and starts one detached brain wake when the
// alarm is due. Missing/corrupt alarms self-heal by waking immediately. A due alarm observed while
// another wake owns .brain.lock is deferred durably so a concurrent immediate owner request cannot
// be overwritten by the wake that is already finishing.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parseAlarm } = require('./check-alarm.js');

const BRAIN = __dirname;
const DEFERRED_WAKE = '.deferred-wake.json';

function readAlarm(file) {
  try { return parseAlarm(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (_) { return null; }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

function inspectAlarm(file, nowMs = Date.now()) {
  const alarm = readAlarm(file);
  return { alarm, valid: alarm !== null, due: alarm === null || alarm.at <= nowMs };
}

function classifyBrainLockProbe(result) {
  if (result && result.error) throw result.error;
  if (result && result.status === 0) return false;
  if (result && result.status === 1) return true;
  const status = result && result.status !== null ? `status ${result.status}` : 'no exit status';
  throw new Error(`flock lock probe failed: ${status}`);
}

function brainLockHeld(lockFile) {
  const result = spawnSync('flock', ['-n', lockFile, '-c', 'true'], { stdio: 'ignore' });
  return classifyBrainLockProbe(result);
}

function deferDueAlarm(brainDir = BRAIN, nowMs = Date.now()) {
  const current = inspectAlarm(path.join(brainDir, 'next-wake.json'), nowMs);
  if (!current.valid || !current.due) return false;
  const deferredFile = path.join(brainDir, DEFERRED_WAKE);
  const deferred = readAlarm(deferredFile);
  if (!deferred || current.alarm.at <= deferred.at) writeJsonAtomic(deferredFile, current.alarm);
  return true;
}

function restoreDeferredAlarm(brainDir = BRAIN) {
  const deferredFile = path.join(brainDir, DEFERRED_WAKE);
  const deferred = readAlarm(deferredFile);
  if (!deferred) {
    try { fs.unlinkSync(deferredFile); } catch (_) {}
    return false;
  }
  const lastWake = readAlarm(path.join(brainDir, '.last-wake.json'));
  if (lastWake && deferred.at === lastWake.at && deferred.atIso === lastWake.atIso &&
      deferred.reason === lastWake.reason) {
    // A second gate can observe the due file in the tiny interval after run-brain acquires the
    // lock but before it consumes that file. Do not replay the alarm that started this same wake.
    try { fs.unlinkSync(deferredFile); } catch (_) {}
    return false;
  }
  const alarmFile = path.join(brainDir, 'next-wake.json');
  const current = readAlarm(alarmFile);
  if (!current || deferred.at <= current.at) writeJsonAtomic(alarmFile, deferred);
  try { fs.unlinkSync(deferredFile); } catch (_) {}
  return true;
}

function fireBrain(brainDir = BRAIN) {
  const child = spawn(path.join(brainDir, 'run-brain.sh'), [], {
    detached: true,
    stdio: 'ignore',
  });
  child.once('spawn', () => {
    child.unref();
    console.log(new Date().toISOString(), 'gate: fired brain wake');
  });
  child.once('error', error => {
    console.error(new Date().toISOString(), 'gate: failed to start brain wake:', error.message);
    process.exitCode = 1;
  });
}

function main(args = process.argv.slice(2), nowMs = Date.now()) {
  if (args.includes('--defer-due')) return deferDueAlarm(BRAIN, nowMs);
  if (args.includes('--restore-deferred')) return restoreDeferredAlarm(BRAIN);

  const lockFile = path.join(BRAIN, '.brain.lock');
  if (brainLockHeld(lockFile)) {
    deferDueAlarm(BRAIN, nowMs);
    return false;
  }
  restoreDeferredAlarm(BRAIN);
  if (!inspectAlarm(path.join(BRAIN, 'next-wake.json'), nowMs).due) return false;
  fireBrain(BRAIN);
  return true;
}

if (require.main === module) main();

module.exports = {
  brainLockHeld,
  classifyBrainLockProbe,
  deferDueAlarm,
  inspectAlarm,
  main,
  restoreDeferredAlarm,
};
