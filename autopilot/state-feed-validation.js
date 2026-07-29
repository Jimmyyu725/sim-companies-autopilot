'use strict';

function finiteNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validTickerRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const kind = finiteNumber(row.kind);
    const price = finiteNumber(row.price);
    return Number.isSafeInteger(kind) && kind > 0 && price != null && price > 0;
  });
}

function validAuthSnapshot(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return false;
  const money = finiteNumber(auth.money ?? auth.authCompany?.money);
  const level = finiteNumber(auth.levelInfo?.level);
  const baseSlots = finiteNumber(auth.levelInfo?.maxBuildings);
  const extraSlots = finiteNumber(auth.authCompany?.extraBuildingSlots);
  return money != null && Number.isSafeInteger(level) && level >= 0 &&
    Number.isSafeInteger(baseSlots) && baseSlots >= 0 &&
    Number.isSafeInteger(extraSlots) && extraSlots >= 0;
}

function buildingRowsProblem(rows, requiredBuildingIds = []) {
  if (!Array.isArray(rows)) return `expected an array, received ${rows === null ? 'null' : typeof rows}`;
  if (rows.length === 0) return 'building array is empty';
  const ids = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return `row ${index} is not an object`;
    const id = finiteNumber(row.id);
    const size = finiteNumber(row.size);
    if (!Number.isSafeInteger(id) || id <= 0) return `row ${index} has an invalid building id`;
    if (!Number.isSafeInteger(size) || size < 0) return `building ${id} has an invalid size`;
    if (typeof row.name !== 'string' || !row.name.trim()) return `building ${id} has no valid name`;
    if (typeof row.category !== 'string' || !row.category.trim()) return `building ${id} has no valid category`;
    // The live buildings endpoint omits `busy` when some jobs finish (verified on a Water
    // reservoir at 2026-07-27T07:07Z). Absence is activity UNKNOWN, not structural corruption and
    // never proof of idle. `parseBuilding()` preserves that distinction for downstream guards.
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return 'building ids are duplicated';
  const requiredIds = [];
  for (const value of requiredBuildingIds) {
    const id = finiteNumber(value);
    if (!Number.isSafeInteger(id) || id <= 0) return 'a configured core building id is invalid';
    requiredIds.push(id);
  }
  const missing = requiredIds.filter(id => !ids.includes(id));
  if (missing.length > 0) return `missing configured core building id(s): ${missing.join(', ')}`;
  return null;
}

function summarizeBuildingActivityEvidence(rows) {
  if (!Array.isArray(rows)) {
    return { status: 'unknown', knownRows: 0, unknownRows: 0, unknownBuildingIds: [] };
  }
  const unknownBuildingIds = [];
  let knownRows = 0;
  for (const row of rows) {
    const id = finiteNumber(row?.id);
    const hasBusy = Object.prototype.hasOwnProperty.call(row || {}, 'busy');
    const busyKnown = hasBusy && (row.busy === null ||
      (row.busy && typeof row.busy === 'object' && !Array.isArray(row.busy)));
    if (busyKnown) knownRows += 1;
    else if (Number.isSafeInteger(id) && id > 0) unknownBuildingIds.push(id);
  }
  return {
    status: unknownBuildingIds.length > 0 ? 'partial' : 'ok',
    knownRows,
    unknownRows: unknownBuildingIds.length,
    unknownBuildingIds,
  };
}

function validBuildingRows(rows, requiredBuildingIds = []) {
  return buildingRowsProblem(rows, requiredBuildingIds) === null;
}

function normalizeRetailRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalized = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const dbLetter = finiteNumber(row.dbLetter);
    const averagePrice = finiteNumber(row.averagePrice);
    const saturation = finiteNumber(row.saturation);
    if (!Number.isSafeInteger(dbLetter) || dbLetter < 0 || averagePrice == null || averagePrice <= 0 ||
        saturation == null || saturation < 0) return null;
    normalized.push({ dbLetter, averagePrice, saturation });
  }
  return normalized;
}

function normalizePositiveRateMap(configuredRates) {
  if (!configuredRates || typeof configuredRates !== 'object' || Array.isArray(configuredRates)) return {};
  return Object.fromEntries(Object.entries(configuredRates)
    .filter(([key, value]) => /^\d+$/.test(key) && finiteNumber(value) > 0)
    .map(([key, value]) => [key, Number(value)]));
}

module.exports = {
  buildingRowsProblem,
  finiteNumber,
  normalizePositiveRateMap,
  normalizeRetailRows,
  summarizeBuildingActivityEvidence,
  validAuthSnapshot,
  validBuildingRows,
  validTickerRows,
};
