#!/usr/bin/env node
'use strict';

// Deterministic alarm sanity check, run after every wake. It repairs corrupt alarms and prevents
// the brain from sleeping more than three minutes past the earliest known building completion.
// A valid alarm that is already due is deliberately preserved: it may be a durable immediate-wake
// request written while the current wake was still finishing.

const fs = require('fs');
const path = require('path');
const { readCurrentMemory, writeCurrentMemory } = require('./current-memory.js');

const BRAIN = __dirname;
const FALLBACK_MS = 5 * 60e3;
const COMPLETION_GRACE_MS = 3 * 60e3;
const WAKE_AFTER_COMPLETION_MS = 60e3;
const MAX_STATE_AGE_MS = 20 * 60e3;
const FAILURE_RETRY_MS = FALLBACK_MS;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

function parseAlarm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const at = value.at;
  const atIsoMs = Date.parse(value.atIso);
  if (typeof value.atIso !== 'string' || !Number.isSafeInteger(at) || at < 0 || !Number.isFinite(atIsoMs) ||
      typeof value.reason !== 'string' || !value.reason.trim()) return null;
  // at:0 is the established durable representation for an immediate owner wake. Its atIso records
  // when the request was made rather than 1970-01-01, so it is the sole allowed mismatch.
  if (at !== 0 && atIsoMs !== at) return null;
  return { ...value, at, atIso: value.atIso, reason: value.reason.trim() };
}

function earliestCompletionMs(state, nowMs = Date.now()) {
  const stateAsOfMs = Date.parse(state?.t);
  const stateAgeMs = nowMs - stateAsOfMs;
  if (!Number.isFinite(stateAsOfMs) || stateAgeMs < -60e3 || stateAgeMs > MAX_STATE_AGE_MS) return null;
  const buildingSource = state?.sources?.buildings;
  if (buildingSource && (buildingSource.status !== 'ok' ||
      (buildingSource.asOf && buildingSource.asOf !== state.t))) return null;
  const completions = (Array.isArray(state?.buildings) ? state.buildings : [])
    .map(building => Date.parse(building?.busy?.endsAt))
    .filter(Number.isFinite);
  return completions.length ? Math.min(...completions) : null;
}

function makeAlarm(at, reason, nowMs) {
  return {
    at,
    atIso: new Date(at).toISOString(),
    reason,
    set: new Date(nowMs).toISOString(),
  };
}

function capAlarmAfterBrainFailure(rawAlarm, nowMs = Date.now()) {
  const now = Number(nowMs);
  if (!Number.isFinite(now)) throw new TypeError('nowMs must be finite');
  const alarm = parseAlarm(rawAlarm);
  // Preserve an immediate/due request and any already-earlier recovery. Only a missing, corrupt,
  // or later alarm is replaced: state may still predate the last ambiguous browser mutation.
  if (alarm && alarm.at <= now + FAILURE_RETRY_MS) {
    return { alarm, changed: false, reason: alarm.at <= now ? 'already-due' : 'already-sooner' };
  }
  return {
    alarm: makeAlarm(
      now + FAILURE_RETRY_MS,
      'RECOVERY: brain exited before a verified close; refresh live state and reconcile actions',
      now,
    ),
    changed: true,
    reason: alarm ? 'failure-alarm-capped' : 'failure-alarm-missing-or-invalid',
  };
}

function reconcileAlarm(rawAlarm, state, nowMs = Date.now()) {
  const alarm = parseAlarm(rawAlarm);
  const earliest = earliestCompletionMs(state, nowMs);
  if (alarm && alarm.at <= nowMs) {
    return { alarm, changed: false, reason: 'already-due', earliest };
  }

  let candidate = alarm;
  let changed = false;
  let reason = 'unchanged';
  if (!candidate) {
    candidate = makeAlarm(
      nowMs + FALLBACK_MS,
      'CORRECTED by check-alarm: missing or invalid next alarm; safety retry',
      nowMs,
    );
    changed = true;
    reason = 'invalid-alarm';
  }

  if (Number.isFinite(earliest) && candidate.at > earliest + COMPLETION_GRACE_MS) {
    const correctedAt = Math.max(nowMs + WAKE_AFTER_COMPLETION_MS, earliest + WAKE_AFTER_COMPLETION_MS);
    candidate = makeAlarm(
      correctedAt,
      `CORRECTED by check-alarm: alarm ${candidate.atIso} overslept earliest completion ${new Date(earliest).toISOString()}`,
      nowMs,
    );
    changed = true;
    reason = 'oversleep';
  }
  return { alarm: candidate, changed, reason, earliest };
}

function syncCurrentAlarm(brainDir, alarm, nowMs = Date.now()) {
  const file = path.join(brainDir, 'CURRENT.json');
  const current = readCurrentMemory(file);
  if (!current || !alarm?.atIso || current.nextDecisionAt === alarm.atIso) return false;
  writeCurrentMemory(file, {
    ...current,
    updatedAt: new Date(nowMs).toISOString(),
    nextDecisionAt: alarm.atIso,
  });
  return true;
}

function runAlarmCheck({ brainDir = BRAIN, nowMs = Date.now() } = {}) {
  const alarmFile = path.join(brainDir, 'next-wake.json');
  const rawAlarm = readJson(alarmFile);
  const state = readJson(path.join(brainDir, '.state.json'));
  const result = reconcileAlarm(rawAlarm, state, nowMs);
  if (result.changed) writeJsonAtomic(alarmFile, result.alarm);
  syncCurrentAlarm(brainDir, result.alarm, nowMs);
  return result;
}

function runFailureAlarmCheck({ brainDir = BRAIN, nowMs = Date.now() } = {}) {
  const alarmFile = path.join(brainDir, 'next-wake.json');
  const result = capAlarmAfterBrainFailure(readJson(alarmFile), nowMs);
  if (result.changed) writeJsonAtomic(alarmFile, result.alarm);
  syncCurrentAlarm(brainDir, result.alarm, nowMs);
  return result;
}

if (require.main === module) {
  try {
    const result = process.argv.includes('--brain-failed')
      ? runFailureAlarmCheck()
      : runAlarmCheck();
    if (result.changed) console.log('alarm corrected to', result.alarm.atIso, `(${result.reason})`);
  } catch (error) {
    console.error('alarm check failed:', error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  FAILURE_RETRY_MS,
  capAlarmAfterBrainFailure,
  earliestCompletionMs,
  parseAlarm,
  reconcileAlarm,
  runAlarmCheck,
  runFailureAlarmCheck,
  syncCurrentAlarm,
};
