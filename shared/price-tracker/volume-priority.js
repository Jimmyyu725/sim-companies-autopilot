'use strict';

const DEFAULT_WAKE_GUARD_MS = 5 * 60e3;

function parseWakeAt(alarm) {
  if (!alarm || typeof alarm !== 'object' || Array.isArray(alarm)) return null;
  const at = Number(alarm.at);
  const atIso = Date.parse(alarm.atIso);
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(atIso) ||
      typeof alarm.reason !== 'string' || !alarm.reason.trim()) return null;
  if (at !== 0 && at !== atIso) return null;
  return at;
}

function volumeCollectionPriority(alarm, nowMs = Date.now(), guardMs = DEFAULT_WAKE_GUARD_MS) {
  const now = Number(nowMs);
  const guard = Number(guardMs);
  if (!Number.isFinite(now) || !Number.isFinite(guard) || guard < 0) {
    return { run: false, reason: 'invalid-priority-clock' };
  }
  const wakeAt = parseWakeAt(alarm);
  if (wakeAt == null) {
    // The gate self-heals a missing/corrupt alarm by waking the brain immediately. Preserve the
    // browser and market-rate budget for that recovery instead of starting a low-priority sweep.
    return { run: false, reason: 'brain-alarm-missing-or-invalid' };
  }
  if (wakeAt === 0 || wakeAt <= now + guard) {
    return { run: false, reason: 'brain-wake-imminent', wakeAt };
  }
  return { run: true, reason: 'brain-wake-not-imminent', wakeAt };
}

module.exports = { DEFAULT_WAKE_GUARD_MS, parseWakeAt, volumeCollectionPriority };
