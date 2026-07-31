'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WAKE_INTERVAL = 20;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HISTORY_BASENAME = 'strategy-council-history.jsonl';

function finiteInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readJsonLines(filename) {
  try {
    return fs.readFileSync(filename, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function normalizeBuildingPortfolio(buildings) {
  const counts = new Map();
  for (const building of Array.isArray(buildings) ? buildings : []) {
    if (building?.freeAndLocked === true) continue;
    const name = String(building?.name || building?.kindLetter || 'unknown').trim().toLowerCase();
    const level = finiteInteger(building?.size);
    const key = `${name}|${level ?? 'unknown'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}|${count}`);
}

function normalizeModifiers(modifiers) {
  return (Array.isArray(modifiers) ? modifiers : [])
    .map(modifier => ({
      kind: finiteInteger(modifier?.kind),
      pct: Number.isFinite(Number(modifier?.pct)) ? Number(modifier.pct) : null,
      until: typeof modifier?.until === 'string' ? modifier.until : null,
    }))
    .filter(modifier => modifier.kind != null)
    .sort((left, right) => left.kind - right.kind);
}

function strategicQuestions(current) {
  const values = [
    ...(Array.isArray(current?.blockers) ? current.blockers : []),
    current?.reviews?.upgradeAndDebt,
    current?.reviews?.longTerm,
  ].map(value => String(value || '').toLowerCase());
  const categories = [
    ['council', /\bcouncil\b/u],
    ['build', /\bbuild(?:ing)?\b/u],
    ['upgrade', /\bupgrade\b/u],
    ['scrap', /\bscrap\b/u],
    ['rebuild', /\brebuild\b/u],
    ['robots', /\brobots?\b/u],
    ['debt', /\bbonds?\b|\bdebt\b/u],
    ['slots', /\bslots?\b/u],
    ['pivot', /\bpivot\b|\btransition\b/u],
  ];
  return categories
    .filter(([, pattern]) => values.some(value => pattern.test(value)))
    .map(([category]) => category);
}

function strategicSnapshot(state = {}, current = null) {
  return {
    level: finiteInteger(state.level),
    slotCapacity: finiteInteger(state.slotCapacity ?? current?.slots?.capacity),
    usedSlots: finiteInteger(state.usedSlots ?? current?.slots?.used),
    freeSlots: finiteInteger(state.freeSlots ?? current?.slots?.free),
    debtPrincipal: finiteInteger(
      state?.bonds?.principalOutstanding ?? current?.debtPrincipal,
    ),
    buildings: normalizeBuildingPortfolio(state.buildings),
    modifiers: normalizeModifiers(state.modifiers),
    questions: strategicQuestions(current),
  };
}

function stableJson(value) {
  return JSON.stringify(value);
}

function snapshotChanges(previous, current) {
  if (!previous || !current) return ['initial-snapshot'];
  const changes = [];
  for (const field of ['level', 'slotCapacity', 'usedSlots', 'freeSlots', 'debtPrincipal']) {
    if (previous[field] !== current[field]) changes.push(field);
  }
  if (stableJson(previous.buildings) !== stableJson(current.buildings)) {
    changes.push('building-portfolio');
  }
  if (stableJson(previous.modifiers) !== stableJson(current.modifiers)) {
    changes.push('modifiers');
  }
  if (stableJson(previous.questions) !== stableJson(current.questions)) {
    changes.push('strategic-questions');
  }
  return changes;
}

function completedWakesSince(records, afterMs, excludeWakeId = null) {
  const unique = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.record_type !== 'wake_usage_summary' || Number(record?.brain_rc) !== 0) continue;
    const endedAtMs = Date.parse(record?.ended_at);
    const wakeId = String(record?.wake_id || '').trim();
    if (!wakeId || !Number.isFinite(endedAtMs)) continue;
    if (excludeWakeId && wakeId === excludeWakeId) continue;
    if (Number.isFinite(afterMs) && endedAtMs <= afterMs) continue;
    unique.add(wakeId);
  }
  return unique.size;
}

function latestSuccessfulDecision(records) {
  return (Array.isArray(records) ? records : [])
    .filter(record => record?.recordType === 'strategy_council_decision' &&
      record?.status === 'DECIDED' && Number.isFinite(Date.parse(record?.completedAt)))
    .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt))
    .at(-1) || null;
}

function evaluateStrategyCouncilRequirement({
  state,
  current,
  wakeRecords = [],
  decisionRecords = [],
  now = Date.now(),
  wakeInterval = DEFAULT_WAKE_INTERVAL,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const nowMs = Number(now);
  const normalizedWakeInterval = Number.isSafeInteger(Number(wakeInterval)) &&
    Number(wakeInterval) >= 1 ? Number(wakeInterval) : DEFAULT_WAKE_INTERVAL;
  const normalizedMaxAgeMs = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0
    ? Number(maxAgeMs)
    : DEFAULT_MAX_AGE_MS;
  const snapshot = strategicSnapshot(state, current);
  const lastDecision = latestSuccessfulDecision(decisionRecords);
  const lastDecisionAtMs = Date.parse(lastDecision?.completedAt);
  const completedSince = completedWakesSince(
    wakeRecords,
    lastDecisionAtMs,
    lastDecision?.wakeId || null,
  );
  const currentWakeOrdinal = completedSince + 1;
  const reasons = [];
  const changes = lastDecision ? snapshotChanges(lastDecision.snapshot, snapshot) : [];

  if (!lastDecision) {
    reasons.push('no-successful-strategy-council');
  } else {
    if (currentWakeOrdinal >= normalizedWakeInterval) {
      reasons.push('wake-cadence');
    }
    if (!Number.isFinite(lastDecisionAtMs) ||
        (Number.isFinite(nowMs) && nowMs - lastDecisionAtMs >= normalizedMaxAgeMs)) {
      reasons.push('daily-backstop');
    }
    if (changes.length) reasons.push('material-strategy-change');
  }

  return {
    required: reasons.length > 0,
    status: reasons.length ? 'required' : 'not_required',
    reasons,
    materialChanges: changes,
    completedWakesSinceDecision: completedSince,
    currentWakeOrdinal,
    wakeInterval: normalizedWakeInterval,
    maxAgeHours: normalizedMaxAgeMs / 3600000,
    lastDecisionAt: lastDecision?.completedAt || null,
    lastDecisionWakeId: lastDecision?.wakeId || null,
    snapshot,
  };
}

function loadStrategyCouncilRequirement({
  brainDir,
  state,
  current,
  now = Date.now(),
  wakeInterval = DEFAULT_WAKE_INTERVAL,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  return evaluateStrategyCouncilRequirement({
    state,
    current,
    now,
    wakeInterval,
    maxAgeMs,
    wakeRecords: readJsonLines(path.join(brainDir, 'wake-usage.jsonl')),
    decisionRecords: readJsonLines(path.join(brainDir, HISTORY_BASENAME)),
  });
}

function recordStrategyCouncilDecision(filename, {
  wakeId,
  completedAt = new Date().toISOString(),
  result,
  args,
  snapshot,
  requirement,
} = {}) {
  const normalizedWakeId = String(wakeId || '').trim();
  if (!normalizedWakeId) throw new Error('strategy council decision requires a wake ID');
  if (result?.decision?.status !== 'DECIDED' || !String(result?.decision?.optionId || '').trim()) {
    throw new Error('strategy council decision is not complete');
  }
  const existing = readJsonLines(filename).find(record =>
    record?.recordType === 'strategy_council_decision' &&
    record?.wakeId === normalizedWakeId);
  if (existing) return { ok: true, duplicate: true, record: existing };
  const selectedOption = (Array.isArray(args?.options) ? args.options : [])
    .find(option => option?.id === result.decision.optionId);

  const record = {
    schemaVersion: 1,
    recordType: 'strategy_council_decision',
    status: 'DECIDED',
    wakeId: normalizedWakeId,
    completedAt,
    question: String(args?.question || '').trim().slice(0, 1000),
    optionIds: (Array.isArray(args?.options) ? args.options : [])
      .map(option => String(option?.id || '').trim())
      .filter(Boolean),
    decision: {
      optionId: result.decision.optionId,
      method: result.decision.method,
      tally: result.decision.tally,
      action: String(selectedOption?.action || '').trim() || null,
      buildingId: selectedOption?.buildingId == null
        ? null
        : finiteInteger(selectedOption.buildingId),
      target: selectedOption?.target == null
        ? null
        : String(selectedOption.target).trim().slice(0, 120),
    },
    triggers: Array.isArray(requirement?.reasons) ? requirement.reasons : [],
    snapshot,
  };
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o755 });
  fs.appendFileSync(filename, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try { fs.chmodSync(filename, 0o600); } catch (_) {}
  return { ok: true, duplicate: false, record };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_WAKE_INTERVAL,
  HISTORY_BASENAME,
  completedWakesSince,
  evaluateStrategyCouncilRequirement,
  latestSuccessfulDecision,
  loadStrategyCouncilRequirement,
  normalizeBuildingPortfolio,
  readJsonLines,
  recordStrategyCouncilDecision,
  snapshotChanges,
  strategicSnapshot,
};
