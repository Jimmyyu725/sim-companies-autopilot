'use strict';

const DEFAULT_SLOT_SCHEDULE = Object.freeze({
  0: 4,
  5: 5,
  10: 6,
  15: 8,
  20: 10,
  25: 12,
  30: 14,
});

const BOND_FACE_VALUE_FALLBACK = 5000;

function toEpochMs(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function parseBusy(busy) {
  if (busy === null) return null;
  if (!busy || typeof busy !== 'object' || Array.isArray(busy)) return undefined;

  const resource = busy.resource || null;
  const sale = busy.sales_order || null;
  const startedMs = Date.parse(busy.started);
  const durationSeconds = busy.duration == null || busy.duration === ''
    ? null
    : Number(busy.duration);
  const endsMs = Number.isFinite(startedMs) && Number.isFinite(durationSeconds) && durationSeconds >= 0
    ? startedMs + durationSeconds * 1000
    : null;

  let type = 'unknown';
  if (resource) type = 'production';
  else if (sale) type = 'sale';
  else if (busy.expanding || busy.category === 'b') type = 'construction';

  return {
    id: busy.id ?? null,
    type,
    rawCategory: busy.category ?? null,
    makingKind: resource?.kind ?? sale?.kind ?? null,
    makingName: resource?.name ?? sale?.name ?? null,
    amount: resource?.amount ?? sale?.amount ?? null,
    // The production API mutates resource.amount after partial collection. Preserve `amount` for
    // compatibility, but expose its observed meaning so it cannot be mistaken for the original
    // order size or copied into the next produce.qty.
    remainingOrUncollectedAmount: resource?.amount ?? null,
    amountSemantics: resource
      ? 'live-remaining-or-uncollected'
      : (sale ? 'sales-order-remaining' : null),
    amountAvailableNow: resource?.amountAvailableNow ?? null,
    remainingProfit: sale?.remainingProfit ?? null,
    profitAvailableNow: sale?.profitAvailableNow ?? null,
    price: sale?.price ?? null,
    expanding: busy.expanding ?? false,
    canFetch: busy.canFetch ?? null,
    startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
    endsAt: Number.isFinite(endsMs) ? new Date(endsMs).toISOString() : null,
  };
}

function parseBuilding(building) {
  const hasBusyEvidence = Object.prototype.hasOwnProperty.call(building || {}, 'busy');
  const busy = hasBusyEvidence ? parseBusy(building.busy) : undefined;
  const activity = busy === null
    ? { status: 'known', busy: false, type: 'idle' }
    : (busy && typeof busy === 'object'
      ? { status: 'known', busy: true, type: busy.type }
      : { status: 'unknown', busy: null, type: 'unknown' });
  return {
    id: building.id,
    name: building.name,
    kindLetter: building.kind,
    size: building.size,
    category: building.category,
    freeAndLocked: building.freeAndLocked === true,
    // Preserve missing activity evidence as unknown. Only an explicit null means confirmed idle.
    busy,
    activity,
  };
}

function normalizeProductionModifiers(payload, now = Date.now()) {
  const rows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.resourceProductionModifiers)
      ? payload.resourceProductionModifiers
      : null);
  if (!rows) return { ok: false, modifiers: null, reason: 'production modifier payload shape is unknown' };
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return { ok: false, modifiers: null, reason: 'modifier capture time is invalid' };
  const normalized = [];
  for (const row of rows) {
    const realm = row?.realm == null ? 0 : Number(row.realm);
    const kind = Number(row?.kind);
    const pct = Number(row?.speedModifier);
    const sinceMs = Date.parse(row?.since);
    const untilMs = Date.parse(row?.until);
    if (realm !== 0 || !Number.isInteger(kind) || kind <= 0 || !Number.isFinite(pct) || pct === 0 ||
        !Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) {
      return { ok: false, modifiers: null, reason: 'production modifier row is malformed' };
    }
    normalized.push({
      realm,
      kind,
      pct,
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
    });
  }
  return { ok: true, modifiers: normalized };
}


// Leveling is a live constraint, not trivia: building slots and whole capabilities (auctions, buy
// orders, government orders) unlock by level, and only RUNNING buildings earn the 12 XP/h that gets
// there. Surfacing progress every wake lets a decision weigh "this also buys levels" instead of
// discovering the gate later. Owner asked for it 2026-08-02, when a promising building auction
// turned out to need level 20.
function summarizeLevelingProgress(levelInfo) {
  if (!levelInfo || typeof levelInfo !== 'object' || Array.isArray(levelInfo)) return null;
  const experience = Number(levelInfo.experience);
  const toNext = Number(levelInfo.experienceToNextLevel);
  if (!Number.isFinite(experience) || !Number.isFinite(toNext) || toNext <= 0) return null;
  const capabilities = levelInfo.capabilities && typeof levelInfo.capabilities === 'object'
    ? levelInfo.capabilities
    : {};
  return {
    experience,
    experienceToNextLevel: toNext,
    remaining: Math.max(0, toNext - experience),
    percent: Math.round((experience / toNext) * 1000) / 10,
    levelName: typeof levelInfo.levelName === 'string' ? levelInfo.levelName : null,
    ratingCode: typeof levelInfo.ratingCode === 'string' ? levelInfo.ratingCode : null,
    maxBuildings: Number.isSafeInteger(Number(levelInfo.maxBuildings))
      ? Number(levelInfo.maxBuildings)
      : null,
    lockedCapabilities: Object.entries(capabilities)
      .filter(([, enabled]) => enabled === false)
      .map(([name]) => name)
      .sort(),
  };
}

function slotCapacityForLevel(level, schedule = DEFAULT_SLOT_SCHEDULE) {
  if ((typeof level !== 'number' && typeof level !== 'string')
    || (typeof level === 'string' && !level.trim())) return null;
  const numericLevel = Number(level);
  if (!Number.isSafeInteger(numericLevel) || numericLevel < 0) return null;

  const resolvedSchedule = schedule && typeof schedule === 'object' && !Array.isArray(schedule)
    ? schedule
    : DEFAULT_SLOT_SCHEDULE;

  const thresholds = Object.keys(resolvedSchedule)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  let capacity = null;
  for (const threshold of thresholds) {
    if (numericLevel < threshold) break;
    const candidate = Number(resolvedSchedule[threshold]);
    capacity = Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : capacity;
  }
  return Number.isSafeInteger(capacity) ? capacity : null;
}

function calculateSlots(buildings, level, schedule = DEFAULT_SLOT_SCHEDULE, liveCapacity = null, extraCapacity = null) {
  const numericLiveCapacity = Number(liveCapacity);
  const numericExtraCapacity = Number(extraCapacity);
  const baseCapacity = liveCapacity != null && Number.isSafeInteger(numericLiveCapacity) && numericLiveCapacity >= 0
    ? numericLiveCapacity
    : slotCapacityForLevel(level, schedule);
  const purchasedCapacity = extraCapacity != null && Number.isSafeInteger(numericExtraCapacity) && numericExtraCapacity >= 0
    ? numericExtraCapacity
    : 0;
  const capacity = baseCapacity == null ? null : baseCapacity + purchasedCapacity;
  const used = (buildings || [])
    .filter((building) => String(building?.category || '').trim().toLowerCase() !== 'seasonal'
      && building?.freeAndLocked !== true)
    .length;
  return {
    capacity,
    used,
    free: capacity == null ? null : Math.max(0, capacity - used),
  };
}

function aggregateStock(resources, names = {}, prices = {}) {
  const byKind = new Map();
  for (const resource of resources || []) {
    const rawAmount = resource?.amount;
    const amount = (typeof rawAmount === 'number' || (typeof rawAmount === 'string' && rawAmount.trim()))
      ? Number(rawAmount)
      : NaN;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const rawKind = resource?.kind;
    const kind = (typeof rawKind === 'number' || (typeof rawKind === 'string' && rawKind.trim()))
      ? Number(rawKind)
      : NaN;
    if (!Number.isSafeInteger(kind) || kind <= 0) continue;
    const current = byKind.get(kind) || {
      kind,
      amount: 0,
      availableAmount: 0,
      blockedAmount: 0,
      lots: 0,
      availableLots: 0,
      blockedLots: 0,
    };
    current.amount += amount;
    current.lots += 1;
    if (resource.blocked === true) {
      current.blockedAmount += amount;
      current.blockedLots += 1;
    } else {
      current.availableAmount += amount;
      current.availableLots += 1;
    }
    byKind.set(kind, current);
  }

  return [...byKind.values()]
    .map((entry) => ({
      kind: entry.kind,
      name: names[entry.kind] || `k${entry.kind}`,
      amount: Math.round(entry.amount),
      availableAmount: Math.round(entry.availableAmount),
      blockedAmount: Math.round(entry.blockedAmount),
      lots: entry.lots,
      availableLots: entry.availableLots,
      blockedLots: entry.blockedLots,
      exchPrice: prices[entry.kind] ?? null,
    }))
    .filter((entry) => entry.amount >= 1)
    .sort((a, b) => (b.amount * (b.exchPrice || 0)) - (a.amount * (a.exchPrice || 0)));
}

function stockSourceIsComplete(resources) {
  return Array.isArray(resources) && resources.every(resource => {
    const rawKind = resource?.kind;
    const rawAmount = resource?.amount;
    const kind = (typeof rawKind === 'number' || (typeof rawKind === 'string' && rawKind.trim()))
      ? Number(rawKind)
      : NaN;
    const amount = (typeof rawAmount === 'number' || (typeof rawAmount === 'string' && rawAmount.trim()))
      ? Number(rawAmount)
      : NaN;
    return Number.isSafeInteger(kind) && kind > 0 && Number.isFinite(amount) && amount >= 0;
  });
}

function withExplicitStockKinds(stock, kinds, names = {}, prices = {}, sourceKnown = true) {
  if (!sourceKnown) return null;
  const byKind = new Map((stock || []).map((entry) => [Number(entry.kind), { ...entry, known: true }]));
  const required = [];
  for (const kindValue of kinds || []) {
    const kind = (typeof kindValue === 'number' || (typeof kindValue === 'string' && kindValue.trim()))
      ? Number(kindValue)
      : NaN;
    if (!Number.isSafeInteger(kind) || kind <= 0) continue;
    required.push(byKind.get(kind) || {
      kind,
      name: names[kind] || `k${kind}`,
      amount: 0,
      availableAmount: 0,
      blockedAmount: 0,
      lots: 0,
      availableLots: 0,
      blockedLots: 0,
      exchPrice: prices[kind] ?? null,
      known: true,
    });
    byKind.delete(kind);
  }
  return required.concat([...byKind.values()]);
}

function ageSeconds(value, nowMs = Date.now()) {
  const parsed = typeof value === 'number' ? toEpochMs(value) : Date.parse(value);
  const now = Number(nowMs);
  return Number.isFinite(parsed) && Number.isFinite(now)
    ? Math.round((now - parsed) / 1000)
    : null;
}

function summarizeVolumeRows(rows, {
  nowMs = Date.now(),
  windowMs = 3600e3,
  names = {},
  includeKinds = null,
} = {}) {
  const cutoffMs = nowMs - windowMs;
  const include = includeKinds ? new Set([...includeKinds].map(Number)) : null;
  const unitsByKind = {};
  let sourceRows = 0;

  for (const row of rows || []) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row.t0 !== 'number' || typeof row.t1 !== 'number' ||
        !row.u || typeof row.u !== 'object' || Array.isArray(row.u)) continue;
    const startMs = toEpochMs(row.t0);
    const endMs = toEpochMs(row.t1);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const unitEntries = Object.entries(row.u);
    if (unitEntries.some(([kindText, units]) => !/^[1-9]\d*$/.test(kindText) ||
        typeof units !== 'number' || !Number.isFinite(units) || units < 0)) continue;
    let perKindStarts = null;
    if (row.t0ByKind != null) {
      if (!row.t0ByKind || typeof row.t0ByKind !== 'object' || Array.isArray(row.t0ByKind)) continue;
      perKindStarts = {};
      let invalidKindStart = false;
      for (const [kindText, kindStart] of Object.entries(row.t0ByKind)) {
        const kindStartMs = typeof kindStart === 'number' ? toEpochMs(kindStart) : null;
        if (!/^[1-9]\d*$/.test(kindText) || !Number.isFinite(kindStartMs) ||
            kindStartMs < startMs || kindStartMs >= endMs) {
          invalidKindStart = true;
          break;
        }
        perKindStarts[kindText] = kindStartMs;
      }
      if (invalidKindStart || unitEntries.some(([kindText]) =>
        !Object.prototype.hasOwnProperty.call(perKindStarts, kindText))) continue;
    }
    const rowOverlapMs = Math.max(0, Math.min(endMs, nowMs) - Math.max(startMs, cutoffMs));
    if (rowOverlapMs <= 0) continue;
    sourceRows += 1;
    for (const [kindText, units] of unitEntries) {
      const kind = Number(kindText);
      if (include && !include.has(kind)) continue;
      const kindStartMs = perKindStarts?.[kindText] ?? startMs;
      const overlapMs = Math.max(0, Math.min(endMs, nowMs) - Math.max(kindStartMs, cutoffMs));
      if (overlapMs <= 0) continue;
      const share = overlapMs / (endMs - kindStartMs);
      unitsByKind[kind] = (unitsByKind[kind] || 0) + units * share;
    }
  }

  const byName = {};
  for (const [kindText, units] of Object.entries(unitsByKind)) {
    const kind = Number(kindText);
    byName[names[kind] || String(kind)] = Math.round(units * 100) / 100;
  }
  return {
    byName,
    sourceRows,
    from: new Date(cutoffMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    prorated: true,
  };
}

function deriveBondFaceValue(recentCashflow, fallback = BOND_FACE_VALUE_FALLBACK) {
  const rows = Array.isArray(recentCashflow)
    ? recentCashflow
    : (recentCashflow && Array.isArray(recentCashflow.data) ? recentCashflow.data : []);
  for (const row of rows) {
    const units = Number(row?.details?.amount);
    const cash = Number(row?.money);
    const isBondSale = String(row?.descriptionKey || '').includes('bondsales')
      || /sales of bonds/i.test(String(row?.description || ''));
    if (!isBondSale || !(units > 0) || !(cash > 0)) continue;
    const faceValue = cash / units;
    if (Number.isFinite(faceValue) && faceValue > 0) return faceValue;
  }
  return fallback;
}

function summarizeBonds(
  soldRecords,
  recentCashflow,
  balanceSheet = null,
  fallbackFaceValue = BOND_FACE_VALUE_FALLBACK,
) {
  const soldAvailable = Array.isArray(soldRecords);
  const rawBalancePayable = balanceSheet?.bondsPayable;
  const balancePayable = rawBalancePayable === null || rawBalancePayable === undefined || rawBalancePayable === ''
    ? NaN
    : Number(rawBalancePayable);
  const balanceAvailable = Number.isFinite(balancePayable) && balancePayable >= 0;
  const faceValue = deriveBondFaceValue(recentCashflow, fallbackFaceValue);
  const records = [];
  let unitsSold = 0;
  let principalOutstanding = 0;
  let dailyInterest = 0;
  let interestComplete = soldAvailable;

  for (const record of soldAvailable ? soldRecords : []) {
    const units = Number(record.amount);
    const interestPctPerDay = record.interest == null || record.interest === ''
      ? null
      : Number(record.interest);
    if (!Number.isSafeInteger(units) || units <= 0) {
      interestComplete = false;
      continue;
    }
    const principal = units * faceValue;
    unitsSold += units;
    principalOutstanding += principal;
    if (Number.isFinite(interestPctPerDay) && interestPctPerDay >= 0) {
      dailyInterest += principal * interestPctPerDay / 100;
    } else {
      interestComplete = false;
    }
    records.push({
      id: record.id ?? null,
      units,
      principal,
      interestPctPerDay: Number.isFinite(interestPctPerDay) && interestPctPerDay >= 0
        ? interestPctPerDay
        : null,
      purchasedAt: record.purchased_at ?? null,
    });
  }

  const principalFromSoldUnits = soldAvailable ? principalOutstanding : null;
  const consistencyWarning = soldAvailable && balanceAvailable
    && Math.abs(principalFromSoldUnits - balancePayable) > 0.01
    ? `sold-unit principal $${principalFromSoldUnits} differs from balance-sheet bondsPayable $${balancePayable}; check statement dates`
    : null;
  const reconciled = soldAvailable && balanceAvailable && consistencyWarning == null;

  return {
    status: consistencyWarning ? 'conflict'
      : (soldAvailable && balanceAvailable ? 'ok' : (soldAvailable || balanceAvailable ? 'partial' : 'unavailable')),
    reconciled,
    faceValue,
    unitsSold,
    principalOutstanding: soldAvailable ? principalFromSoldUnits : (balanceAvailable ? balancePayable : null),
    principalSource: soldAvailable ? 'sold-units' : (balanceAvailable ? 'balance-sheet' : null),
    balanceSheetPayable: balanceAvailable ? balancePayable : null,
    balanceSheetAsOf: balanceSheet?.date ?? null,
    dailyInterest: interestComplete
      ? Math.round(dailyInterest * 100) / 100
      : (balanceAvailable && balancePayable === 0 ? 0 : null),
    records,
    consistencyWarning,
    offerFormExcluded: true,
    note: `Outstanding principal comes from sold bond units and the balance sheet only. Sold API amount is units, so principal = units × $${faceValue}. The HQ/API bond offer amount is an unsold offer setting, never outstanding debt.`,
  };
}

module.exports = {
  BOND_FACE_VALUE_FALLBACK,
  DEFAULT_SLOT_SCHEDULE,
  ageSeconds,
  aggregateStock,
  calculateSlots,
  deriveBondFaceValue,
  normalizeProductionModifiers,
  parseBuilding,
  parseBusy,
  slotCapacityForLevel,
  summarizeLevelingProgress,
  stockSourceIsComplete,
  summarizeBonds,
  summarizeVolumeRows,
  toEpochMs,
  withExplicitStockKinds,
};
