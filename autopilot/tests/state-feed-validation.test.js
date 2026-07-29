'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildingRowsProblem,
  finiteNumber,
  normalizePositiveRateMap,
  normalizeRetailRows,
  summarizeBuildingActivityEvidence,
  validAuthSnapshot,
  validBuildingRows,
  validTickerRows,
} = require('../state-feed-validation.js');

test('unknown scalar values never become an authoritative zero', () => {
  for (const value of [null, undefined, '', false, true]) assert.equal(finiteNumber(value), null);
  assert.equal(finiteNumber('0'), 0);
  assert.equal(finiteNumber(0), 0);
});

test('ticker source requires a non-empty set of positive known prices', () => {
  assert.equal(validTickerRows([{ kind: 1, price: 0.51 }]), true);
  assert.equal(validTickerRows([]), false);
  assert.equal(validTickerRows([{ kind: 1, price: null }]), false);
  assert.equal(validTickerRows([{ kind: 1, price: '' }]), false);
  assert.equal(validTickerRows([{ kind: 1, price: 0 }]), false);
});

test('auth source requires exact cash, level, base slots, and purchased slots', () => {
  const valid = {
    money: 1000,
    levelInfo: { level: 12, maxBuildings: 6 },
    authCompany: { extraBuildingSlots: 4 },
  };
  assert.equal(validAuthSnapshot(valid), true);
  assert.equal(validAuthSnapshot({}), false);
  for (const field of ['money', 'level', 'maxBuildings', 'extraBuildingSlots']) {
    const candidate = structuredClone(valid);
    if (field === 'money') candidate.money = null;
    else if (field === 'extraBuildingSlots') candidate.authCompany[field] = null;
    else candidate.levelInfo[field] = null;
    assert.equal(validAuthSnapshot(candidate), false, `${field} must not be inferred`);
  }
});

test('building source is non-empty, well shaped, unique, and contains configured core buildings', () => {
  const rows = [
    { id: 10, name: 'Farm', category: 'production', size: 3, busy: null },
    { id: 20, name: 'Grocery Store', category: 'sales', size: 3, busy: { id: 1 } },
  ];
  assert.equal(validBuildingRows(rows, [10, 20]), true);
  assert.equal(validBuildingRows([], [10, 20]), false);
  assert.equal(validBuildingRows(rows, [10, 30]), false);
  assert.equal(validBuildingRows([...rows, { ...rows[0] }], [10, 20]), false);
  assert.equal(validBuildingRows(rows.map(({ busy, ...row }) => row), [10, 20]), true);
  assert.equal(validBuildingRows([{ ...rows[0], size: null }, rows[1]], [10, 20]), false);
  assert.equal(buildingRowsProblem(rows, [10, 20]), null);
  assert.equal(buildingRowsProblem(null, [10, 20]), 'expected an array, received null');
  assert.equal(buildingRowsProblem([], [10, 20]), 'building array is empty');
  assert.equal(buildingRowsProblem(rows, [10, 30]), 'missing configured core building id(s): 30');
  assert.equal(buildingRowsProblem(rows.map(({ busy, ...row }) => row), [10, 20]), null);
  assert.equal(buildingRowsProblem([
    ...rows,
    { id: 30, name: 'Beach market', category: 'seasonal', size: 1, freeAndLocked: true },
  ], [10, 20]), null);
  assert.equal(buildingRowsProblem([
    ...rows,
    { id: 30, name: 'Seasonal market', category: 'seasonal', size: 1 },
  ], [10, 20]), null);
  assert.deepEqual(summarizeBuildingActivityEvidence(rows), {
    status: 'ok', knownRows: 2, unknownRows: 0, unknownBuildingIds: [],
  });
  assert.deepEqual(summarizeBuildingActivityEvidence(rows.map(({ busy, ...row }) => row)), {
    status: 'partial', knownRows: 0, unknownRows: 2, unknownBuildingIds: [10, 20],
  });
});

test('retail source rejects unknown saturation instead of ranking it as zero', () => {
  assert.deepEqual(normalizeRetailRows([{ dbLetter: 7, averagePrice: 40.75, saturation: 1.25 }]), [
    { dbLetter: 7, averagePrice: 40.75, saturation: 1.25 },
  ]);
  assert.equal(normalizeRetailRows([{ dbLetter: 7, averagePrice: 40.75, saturation: null }]), null);
  assert.equal(normalizeRetailRows([{ dbLetter: 7, averagePrice: 40.75, saturation: '' }]), null);
  assert.equal(normalizeRetailRows([{ dbLetter: 7, averagePrice: null, saturation: 1 }]), null);
  assert.equal(normalizeRetailRows([]), null);
});

test('printed-rate cache keeps only positive explicitly known rates', () => {
  assert.deepEqual(normalizePositiveRateMap({
    1: 12.5,
    2: '4.2',
    3: null,
    4: '',
    5: false,
    6: 0,
    _asOf: '2026-07-26T00:00:00.000Z',
  }), { 1: 12.5, 2: 4.2 });
});
