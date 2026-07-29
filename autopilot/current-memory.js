'use strict';

const fs = require('fs');

function isKnownNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sameNumber(left, right) {
  return isKnownNumber(left) && isKnownNumber(right)
    && Math.abs(Number(left) - Number(right)) <= 0.01;
}

function normalizeStringArray(value, field, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) {
    throw new Error(`${field} must be an array of at most ${maxItems} non-empty strings (500 chars each)`);
  }
  return value.map(item => item.trim());
}

function normalizeShortString(value, field, maxLength = 500) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${field} must contain 1..${maxLength} characters`);
  }
  return value.trim();
}

function validateCopiedNumber(value, expected, field) {
  if (isKnownNumber(expected) && !sameNumber(value, expected)) {
    throw new Error(`${field} must exactly match current state (${expected})`);
  }
  if (!isKnownNumber(expected) && value !== null) throw new Error(`${field} must be null when state is unknown`);
  return isKnownNumber(expected) ? Number(expected) : null;
}

function validateCurrentMemory(input, state, alarm, now = new Date()) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('current must be an object');
    if (!state || typeof state !== 'object' || !state.t) throw new Error('fresh .state.json is required');
    if (!alarm || typeof alarm !== 'object' || !alarm.atIso) throw new Error('set_alarm must succeed before master');
    if (input.stateAsOf !== state.t) throw new Error(`stateAsOf must exactly match current state.t (${state.t})`);
    if (isKnownNumber(state.money) && !sameNumber(input.cash, state.money)) {
      throw new Error(`cash must exactly match current state.money (${state.money})`);
    }
    if (!isKnownNumber(state.money) && input.cash !== null) throw new Error('cash must be null when state.money is unknown');
    const debt = state.bonds?.principalOutstanding;
    if (isKnownNumber(debt) && !sameNumber(input.debtPrincipal, debt)) {
      throw new Error(`debtPrincipal must exactly match current state.bonds.principalOutstanding (${debt})`);
    }
    if (!isKnownNumber(debt) && input.debtPrincipal !== null) throw new Error('debtPrincipal must be null when debt is unknown');
    if (input.nextDecisionAt !== alarm.atIso) {
      throw new Error(`nextDecisionAt must exactly match the current alarm (${alarm.atIso})`);
    }
    if (!input.slots || typeof input.slots !== 'object' || Array.isArray(input.slots)) {
      throw new Error('slots must be an object copied from current state');
    }
    if (!input.reviews || typeof input.reviews !== 'object' || Array.isArray(input.reviews)) {
      throw new Error('reviews must be an object');
    }
    const normalized = {
      schemaVersion: 2,
      updatedAt: now.toISOString(),
      stateAsOf: state.t,
      cash: isKnownNumber(state.money) ? Number(state.money) : null,
      debtPrincipal: isKnownNumber(debt) ? Number(debt) : null,
      slots: {
        capacity: validateCopiedNumber(input.slots.capacity, state.slotCapacity, 'slots.capacity'),
        used: validateCopiedNumber(input.slots.used, state.usedSlots, 'slots.used'),
        free: validateCopiedNumber(input.slots.free, state.freeSlots, 'slots.free'),
      },
      done: normalizeStringArray(input.done, 'done', 12),
      blockers: normalizeStringArray(input.blockers, 'blockers', 8),
      plan: normalizeStringArray(input.plan, 'plan', 8),
      reviews: {
        warehouse: normalizeShortString(input.reviews.warehouse, 'reviews.warehouse'),
        upgradeAndDebt: normalizeShortString(input.reviews.upgradeAndDebt, 'reviews.upgradeAndDebt'),
        utilitySurplus: normalizeShortString(input.reviews.utilitySurplus, 'reviews.utilitySurplus'),
        longTerm: normalizeShortString(input.reviews.longTerm, 'reviews.longTerm'),
      },
      nextDecisionAt: alarm.atIso,
    };
    return { ok: true, value: normalized };
  } catch (error) {
    return { ok: false, guard: true, reason: String(error.message || error) };
  }
}

function writeCurrentMemory(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function validStoredNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validStoredStrings(value, maxItems, maxLength = 500) {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === 'string' && item.trim() && item.length <= maxLength);
}

function validV2Memory(value) {
  if (!value || value.schemaVersion !== 2) return false;
  for (const field of ['updatedAt', 'stateAsOf']) {
    if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field]))) return false;
  }
  // check-alarm.js deliberately repairs an invalid/stale nextDecisionAt in an otherwise valid
  // checkpoint, so preserve that recovery path while validating every authoritative state field.
  if (typeof value.nextDecisionAt !== 'string' || !value.nextDecisionAt.trim()) return false;
  if (!validStoredNumber(value.cash) || !validStoredNumber(value.debtPrincipal)) return false;
  if (!value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots)
    || !['capacity', 'used', 'free'].every(field => validStoredNumber(value.slots[field]))) return false;
  if (!validStoredStrings(value.done, 12) || !validStoredStrings(value.blockers, 8)
    || !validStoredStrings(value.plan, 8)) return false;
  if (!value.reviews || typeof value.reviews !== 'object' || Array.isArray(value.reviews)
    || !['warehouse', 'upgradeAndDebt', 'utilitySurplus', 'longTerm']
      .every(field => typeof value.reviews[field] === 'string' && value.reviews[field].trim()
        && value.reviews[field].length <= 500)) return false;
  return true;
}

function readCurrentMemory(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schemaVersion === 2) return validV2Memory(value) ? value : null;
    // Schema 1 remains readable for the one-time upgrade path; every newly written checkpoint is
    // schema 2 and receives the strict validation above.
    return value?.schemaVersion === 1 ? value : null;
  } catch (_) {
    return null;
  }
}

const currentMemorySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stateAsOf: { type: 'string', description: 'Copy current state.t exactly.' },
    cash: { type: ['number', 'null'], description: 'Copy current state.money exactly; null only when source is unknown.' },
    debtPrincipal: { type: ['number', 'null'], description: 'Copy current state.bonds.principalOutstanding exactly; null only when source is unknown.' },
    slots: {
      type: 'object',
      additionalProperties: false,
      properties: {
        capacity: { type: ['number', 'null'], description: 'Copy current state.slotCapacity exactly.' },
        used: { type: ['number', 'null'], description: 'Copy current state.usedSlots exactly.' },
        free: { type: ['number', 'null'], description: 'Copy current state.freeSlots exactly.' },
      },
      required: ['capacity', 'used', 'free'],
    },
    done: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 500 } },
    blockers: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 500 } },
    plan: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 500 } },
    reviews: {
      type: 'object',
      additionalProperties: false,
      properties: {
        warehouse: { type: 'string', minLength: 1, maxLength: 500 },
        upgradeAndDebt: { type: 'string', minLength: 1, maxLength: 500 },
        utilitySurplus: { type: 'string', minLength: 1, maxLength: 500 },
        longTerm: { type: 'string', minLength: 1, maxLength: 500, description: 'Name the operating baseline, leading expansion/pivot benchmark (Tools until verified evidence supports a better candidate), free-slot implication, and next strategy trigger.' },
      },
      required: ['warehouse', 'upgradeAndDebt', 'utilitySurplus', 'longTerm'],
    },
    nextDecisionAt: { type: 'string', description: 'Copy the successful set_alarm wakeAt exactly.' },
  },
  required: ['stateAsOf', 'cash', 'debtPrincipal', 'slots', 'done', 'blockers', 'plan', 'reviews', 'nextDecisionAt'],
};

module.exports = { currentMemorySchema, readCurrentMemory, validateCurrentMemory, writeCurrentMemory };
