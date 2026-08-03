#!/usr/bin/env node
'use strict';

// Zero-LLM upgrade scheduler. Cron runs this every minute: any building named in UPGRADE-PLAN.json
// that is idle and below its target level is upgraded one step through the same guarded `act.js`
// path the brain uses.
//
// Why it exists: a building the owner wants raised is only upgradable in the gap between finishing
// its current job and starting the next one. The brain wakes on game events, roughly twice an
// hour, and a wake that lands outside that gap cannot take it — meanwhile the no-voluntary-idle
// rule hands the building a fresh multi-hour order and the window closes for good. Polling every
// minute is what makes the window reliably catchable. Owner directive 2026-08-02: the hand-placed
// Farm goes to level 2 and the hand-placed Mill to level 3 once construction ends.
//
// Safety: it never invents a click. Every step goes through `act.js upgrade`, which keeps the
// spend guard, the exact-building page read, and the post-click level verification. A step runs
// only when the plan, the authoritative state, and a fresh dry preview all agree; anything else
// leaves the target untouched for the next minute. One step per run, so a bad quote costs one
// upgrade rather than the whole plan. The caller holds .tick.lock for the entire run.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AUTOPILOT = __dirname;
const SIM = path.join(AUTOPILOT, '..');
const PLAN = path.join(AUTOPILOT, 'UPGRADE-PLAN.json');
const STATE = path.join(AUTOPILOT, '.state.json');
const LOG = path.join(AUTOPILOT, 'auto-upgrade.log');

// The brain writes the capture roughly twice an hour. Reading it blindly would make a one-minute
// loop behave like a thirty-minute one: a building that just finished stays invisible until the
// next wake. Refresh it here when it is too old to prove idleness.
const MAX_STATE_AGE_MS = 4 * 60 * 1000;

// cron redirects stdout into the same file, so writing to both duplicated every line.
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  if (process.stdout.isTTY) process.stdout.write(line);
  else { try { fs.appendFileSync(LOG, line); } catch (_) {} }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function writePlanAtomic(plan) {
  const temporary = `${PLAN}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`);
  fs.renameSync(temporary, PLAN);
}

function stateAgeMs(state) {
  const capturedMs = Date.parse(state?.t);
  return Number.isFinite(capturedMs) ? Date.now() - capturedMs : Infinity;
}

function refreshState() {
  try {
    execFileSync('/usr/bin/node', [path.join(AUTOPILOT, 'state.js')],
      { cwd: SIM, encoding: 'utf8', timeout: 150000, stdio: 'ignore' });
    return readJson(STATE);
  } catch (_) { return null; }
}

// act.js prints progress lines and ends with one JSON result.
function act(action, params) {
  try {
    const out = execFileSync('/usr/bin/node', [path.join(AUTOPILOT, 'act.js'), action, JSON.stringify(params)],
      { cwd: SIM, encoding: 'utf8', timeout: 240000 });
    const last = out.trim().split('\n').pop();
    try { return JSON.parse(last); }
    catch (_) { return { ok: false, reason: `act returned non-JSON: ${String(last).slice(0, 200)}` }; }
  } catch (error) {
    return { ok: false, reason: String(error.message || error).slice(0, 200) };
  }
}

// A target is actionable only when the authoritative capture proves the exact building exists,
// still carries the expected name, is idle, and has not yet reached its target level. A rebuilt or
// re-numbered slot must never inherit an upgrade budget aimed at something else.
function actionable(target, state) {
  if (target.status === 'complete') return null;
  const rows = (Array.isArray(state?.buildings) ? state.buildings : [])
    .filter(building => Number(building?.id) === Number(target.buildingId));
  if (rows.length !== 1) return `building ${target.buildingId} is missing or duplicated`;
  const building = rows[0];
  const name = String(building.name || '').trim().toLowerCase();
  if (name !== String(target.building || '').trim().toLowerCase()) {
    return `building ${target.buildingId} is a ${building.name}, not the planned ${target.building}`;
  }
  const level = Number(building.size);
  if (!Number.isSafeInteger(level) || level < 1) return `building ${target.buildingId} has an unreadable level`;
  if (level >= Number(target.targetLevel)) return 'REACHED';
  if (building.busy) return `busy (${building.busy.type || 'unknown'} until ${building.busy.endsAt || '?'})`;
  return null;
}

// Required as a module by the tests, which exercise the decision logic without a browser.
if (require.main !== module) {
  module.exports = { actionable, stateAgeMs };
  return;
}

(async () => {
  const plan = readJson(PLAN);
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.targets)) {
    log('no usable upgrade plan — nothing to do');
    return;
  }
  if (plan.targets.every(target => target.status === 'complete')) return;

  let state = readJson(STATE);
  if (stateAgeMs(state) > MAX_STATE_AGE_MS) state = refreshState();
  if (!state) { log('state unavailable — skipping this minute'); return; }
  if (state?.sources?.buildings?.status !== 'ok') {
    log('building source is not authoritative — skipping this minute');
    return;
  }

  const minCashAfter = Number(plan.minCashAfter) || 20000;
  let planChanged = false;
  const waiting = [];

  for (const target of plan.targets) {
    const blocker = actionable(target, state);
    if (blocker === 'REACHED') {
      target.status = 'complete';
      target.completedAt = new Date().toISOString();
      planChanged = true;
      log(`${target.building} ${target.buildingId} reached level ${target.targetLevel} — target complete`);
      continue;
    }
    if (blocker) { waiting.push(`${target.buildingId} ${blocker}`); continue; }

    // A dry preview is the only quote allowed to authorize the confirm below, and it is re-read
    // every run so a stale price can never fund a click.
    const maxCost = Number(target.maxCostPerStep);
    const preview = act('upgrade', { buildingId: target.buildingId, maxCost, minCashAfter, confirm: false });
    if (!preview?.ok) {
      log(`${target.building} ${target.buildingId} preview refused: ${String(preview?.reason || preview?.err || 'unknown').slice(0, 140)}`);
      break;
    }
    const quoted = Number(preview.quoted ?? preview.cashCost);
    if (Number.isFinite(quoted) && quoted > maxCost) {
      log(`${target.building} ${target.buildingId} quote $${quoted} exceeds the plan cap $${maxCost} — leaving it alone`);
      break;
    }

    const result = act('upgrade', { buildingId: target.buildingId, maxCost, minCashAfter, confirm: true });
    if (result?.ok && result?.verified) {
      log(`${target.building} ${target.buildingId} upgrade started ${result.fromLevel} -> ${result.toLevel}${Number.isFinite(quoted) ? ` for $${quoted}` : ''}`);
    } else {
      log(`${target.building} ${target.buildingId} upgrade did not verify: ${String(result?.reason || result?.err || 'unknown').slice(0, 160)}`);
    }
    // One step per run either way: the state capture above is now stale, and a second confirm
    // against it could spend twice on evidence that no longer describes the company.
    break;
  }

  if (planChanged) writePlanAtomic(plan);
  if (waiting.length) log(`waiting: ${waiting.join('; ')}`);
  if (plan.targets.every(target => target.status === 'complete')) {
    log('every planned upgrade is complete — this loop is now idle');
  }
})().catch(error => {
  log('FAILED', String(error.message || error).slice(0, 200));
  process.exitCode = 1;
});
