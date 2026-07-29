'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  bindProductModifiers,
  emptyCache,
  freshBuildingRateEvidence,
  readInspectionRateCache,
  summarizeProductModifiers,
  upsertInspectionRate,
} = require('../inspection-rate-cache.js');

const INSPECTED_AT = '2026-07-26T20:00:00.000Z';
const ACTIVE_UNTIL = '2026-07-27T00:00:00.000Z';

function resultFixture({
  buildingId = 123,
  level = 2,
  inspectedAt = INSPECTED_AT,
  products = [{
    kind: 119,
    name: 'COFFEE POWDER',
    slug: 'coffee-ground',
    productionPerHour: 36.08,
    modifier: { status: 'none' },
  }],
} = {}) {
  return {
    pageOk: true,
    buildingId,
    level,
    inspectedAt,
    source: `/b/${buildingId}/`,
    products,
  };
}

test('a multi-product page binds Flour modifier only to Flour', () => {
  const banner = 'Production speed temporarily increased by 21% until 11:00 PM 7/26/2026';
  const fixture = {
    pageText: `COFFEE POWDER Production: 36.08/h FLOUR Production: 24/h ${banner}`,
    products: [
      {
        kind: 119,
        name: 'COFFEE POWDER',
        slug: 'coffee-ground',
        productionPerHour: 36.08,
        modifierScopeStatus: 'scoped',
        modifierScopeText: 'COFFEE POWDER Production: 36.08/h',
      },
      {
        kind: 133,
        name: 'FLOUR',
        slug: 'flour',
        productionPerHour: 24,
        modifierScopeStatus: 'scoped',
        modifierScopeText: `FLOUR Production: 24/h ${banner}`,
      },
    ],
  };

  const products = bindProductModifiers(fixture.products, fixture.pageText);
  assert.deepEqual(products[0].modifier, { status: 'none' });
  assert.equal(products[1].modifier.status, 'active');
  assert.equal(products[1].modifier.direction, 'increased');
  assert.equal(products[1].modifier.percent, 21);
  assert.equal(summarizeProductModifiers(products).status, 'unknown');

  const inserted = upsertInspectionRate(emptyCache(), resultFixture({ products }));
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.authorizingProductKinds, [119, 133]);
  const powder = freshBuildingRateEvidence(
    inserted.cache,
    { id: 123, size: 2 },
    119,
    Date.parse(INSPECTED_AT) + 10 * 60 * 1000,
  );
  assert.equal(powder.status, 'fresh');
  assert.equal(powder.ratePerHour, 36.08);
  assert.deepEqual(powder.modifier, { status: 'none' });
});

test('an unbound page modifier makes otherwise-none product evidence unknown', () => {
  const banner = 'Production speed temporarily decreased by 23% until 11:00 PM 7/26/2026';
  const products = bindProductModifiers([
    {
      kind: 119,
      productionPerHour: 36.08,
      modifierScopeStatus: 'scoped',
      modifierScopeText: 'COFFEE POWDER Production: 36.08/h',
    },
    {
      kind: 133,
      productionPerHour: 24,
      modifierScopeStatus: 'scoped',
      modifierScopeText: 'FLOUR Production: 24/h',
    },
  ], `COFFEE POWDER Production: 36.08/h FLOUR Production: 24/h ${banner}`);

  assert.ok(products.every(product => product.modifier.status === 'unknown'));
  const inserted = upsertInspectionRate(emptyCache(), resultFixture({ products }));
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.authorizingProductKinds, []);
  const powder = freshBuildingRateEvidence(
    inserted.cache,
    { id: 123, size: 2 },
    119,
    Date.parse(INSPECTED_AT) + 60 * 1000,
  );
  assert.equal(powder.status, 'modifier-unknown');
  assert.equal(powder.ratePerHour, null);
});

test('conflicting modifiers inside one product card remain unknown', () => {
  const first = 'Production speed temporarily increased by 21% until 11:00 PM 7/26/2026';
  const second = 'Production speed temporarily decreased by 23% until 10:00 PM 7/26/2026';
  const products = bindProductModifiers([{
    kind: 119,
    productionPerHour: 36.08,
    modifierScopeStatus: 'scoped',
    modifierScopeText: `COFFEE POWDER Production: 36.08/h ${first} ${second}`,
  }], `COFFEE POWDER Production: 36.08/h ${first} ${second}`);
  assert.equal(products[0].modifier.status, 'unknown');
});

test('an unknown unrelated product does not revoke known Powder evidence', () => {
  const inserted = upsertInspectionRate(emptyCache(), resultFixture({
    products: [
      { kind: 119, productionPerHour: 36.08, modifier: { status: 'none' } },
      { kind: 133, productionPerHour: 24, modifier: { status: 'unknown', reason: 'unscoped' } },
    ],
  }));
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.authorizingProductKinds, [119]);
  assert.equal(inserted.entry.modifier.status, 'unknown');
  assert.equal(freshBuildingRateEvidence(
    inserted.cache, { id: 123, size: 2 }, 119, Date.parse(INSPECTED_AT) + 60_000,
  ).status, 'fresh');
  assert.equal(freshBuildingRateEvidence(
    inserted.cache, { id: 123, size: 2 }, 133, Date.parse(INSPECTED_AT) + 60_000,
  ).status, 'modifier-unknown');
});

test('active modifier carry-forward is isolated per product', () => {
  const previous = upsertInspectionRate(emptyCache(), resultFixture({
    buildingId: 124,
    level: 1,
    products: [
      {
        kind: 119,
        productionPerHour: 18.04,
        modifier: {
          status: 'active',
          direction: 'decreased',
          percent: 23,
          expiresAt: ACTIVE_UNTIL,
        },
      },
      {
        kind: 133,
        productionPerHour: 12,
        modifier: {
          status: 'active',
          direction: 'increased',
          percent: 21,
          expiresAt: ACTIVE_UNTIL,
        },
      },
    ],
  }));
  assert.equal(previous.ok, true);

  const carried = upsertInspectionRate(previous.cache, resultFixture({
    buildingId: 124,
    level: 1,
    inspectedAt: '2026-07-26T20:05:00.000Z',
    products: [
      { kind: 119, productionPerHour: 18.04, modifier: { status: 'none' } },
      { kind: 133, productionPerHour: 12, modifier: { status: 'none' } },
    ],
  }));
  assert.equal(carried.entry.products[0].modifier.direction, 'decreased');
  assert.equal(carried.entry.products[0].modifier.carriedForward, true);
  assert.equal(carried.entry.products[1].modifier.direction, 'increased');
  assert.equal(carried.entry.products[1].modifier.carriedForward, true);

  const changedPowder = upsertInspectionRate(previous.cache, resultFixture({
    buildingId: 124,
    level: 1,
    inspectedAt: '2026-07-26T20:05:00.000Z',
    products: [
      { kind: 119, productionPerHour: 23.43, modifier: { status: 'none' } },
      { kind: 133, productionPerHour: 12, modifier: { status: 'none' } },
    ],
  }));
  assert.equal(changedPowder.ok, true);
  assert.equal(changedPowder.entry.products[0].modifier.status, 'unknown');
  assert.equal(changedPowder.entry.products[1].modifier.status, 'active');
  assert.equal(freshBuildingRateEvidence(
    changedPowder.cache,
    { id: 124, size: 1 },
    119,
    Date.parse('2026-07-26T20:06:00.000Z'),
  ).ratePerHour, null);
});

test('an older inspection cannot replace newer cached building evidence', () => {
  const newer = upsertInspectionRate(emptyCache(), resultFixture({
    inspectedAt: '2026-07-26T20:05:00.000Z',
  }));
  const older = upsertInspectionRate(newer.cache, resultFixture({
    inspectedAt: '2026-07-26T20:04:59.000Z',
    products: [{
      kind: 119,
      productionPerHour: 999,
      modifier: { status: 'none' },
    }],
  }));
  assert.equal(older.ok, false);
  assert.match(older.reason, /older/);
  assert.equal(older.cache.buildings['123'].products[0].productionPerHour, 36.08);
});

test('an impossible local modifier date is not normalized into another day', () => {
  const banner = 'Production speed temporarily increased by 21% until 11:00 PM 2/30/2026';
  const products = bindProductModifiers([{
    kind: 119,
    productionPerHour: 36.08,
    modifierScopeStatus: 'scoped',
    modifierScopeText: `COFFEE POWDER Production: 36.08/h ${banner}`,
  }], `COFFEE POWDER Production: 36.08/h ${banner}`);
  assert.equal(products[0].modifier.status, 'unknown');
});

test('freshness and level matching still fail closed', () => {
  const inserted = upsertInspectionRate(emptyCache(), resultFixture());
  assert.equal(inserted.ok, true);

  const fresh = freshBuildingRateEvidence(
    inserted.cache,
    { id: 123, size: 2 },
    119,
    Date.parse(INSPECTED_AT) + 10 * 60 * 1000,
  );
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.ratePerHour, 36.08);

  const stale = freshBuildingRateEvidence(
    inserted.cache,
    { id: 123, size: 2 },
    119,
    Date.parse(INSPECTED_AT) + 31 * 60 * 1000,
  );
  assert.equal(stale.status, 'stale');
  assert.equal(stale.ratePerHour, null);

  const mismatch = freshBuildingRateEvidence(
    inserted.cache,
    { id: 123, size: 3 },
    119,
    Date.parse(INSPECTED_AT) + 10 * 60 * 1000,
  );
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.ratePerHour, null);

  const future = freshBuildingRateEvidence(
    inserted.cache,
    { id: 123, size: 2 },
    119,
    Date.parse(INSPECTED_AT) - 31 * 1000,
  );
  assert.equal(future.status, 'future');
  assert.equal(future.ratePerHour, null);
});

test('a modifier expired at inspection time cannot authorize the rate', () => {
  const inserted = upsertInspectionRate(emptyCache(), resultFixture({
    products: [{
      kind: 119,
      productionPerHour: 36.08,
      modifier: {
        status: 'active',
        direction: 'decreased',
        percent: 23,
        expiresAt: INSPECTED_AT,
      },
    }],
  }));
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.authorizingProductKinds, []);
  assert.equal(inserted.entry.products[0].modifier.status, 'unknown');
});

test('cache reads require version 3 and re-normalize every stored entry', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-rate-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'cache.json');
  const valid = upsertInspectionRate(emptyCache(), resultFixture()).cache;

  fs.writeFileSync(file, JSON.stringify({ ...valid, version: 2 }));
  assert.deepEqual(readInspectionRateCache(file), emptyCache());

  fs.writeFileSync(file, JSON.stringify({
    ...valid,
    buildings: {
      ...valid.buildings,
      broken: { ok: true, buildingId: -1, level: 2, inspectedAt: INSPECTED_AT, products: [] },
    },
  }));
  const read = readInspectionRateCache(file);
  assert.deepEqual(Object.keys(read.buildings), ['123']);
  assert.deepEqual(read.buildings['123'].products[0].modifier, { status: 'none' });
});

test('legacy building-level modifiers do not authorize a product', () => {
  const inserted = upsertInspectionRate(emptyCache(), {
    ...resultFixture({ products: [{ kind: 119, productionPerHour: 18.04 }] }),
    modifier: { status: 'none' },
  });
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.authorizingProductKinds, []);
  assert.equal(freshBuildingRateEvidence(
    inserted.cache, { id: 123, size: 2 }, 119, Date.parse(INSPECTED_AT) + 60_000,
  ).status, 'modifier-unknown');
});

test('invalid production-rate evidence is rejected without changing the cache', () => {
  const inserted = upsertInspectionRate(emptyCache(), resultFixture());
  const rejected = upsertInspectionRate(inserted.cache, resultFixture({
    buildingId: 456,
    level: 1,
    products: [{ kind: 119, productionPerHour: null, modifier: { status: 'none' } }],
  }));
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.cache, inserted.cache);
});

test('duplicate product kinds and a mismatched building path are rejected', () => {
  const duplicate = upsertInspectionRate(emptyCache(), resultFixture({
    products: [
      { kind: 119, productionPerHour: 18.04, modifier: { status: 'none' } },
      { kind: 119, productionPerHour: 36.08, modifier: { status: 'none' } },
    ],
  }));
  assert.equal(duplicate.ok, false);
  assert.deepEqual(duplicate.cache, emptyCache());

  const duplicateWithInvalidRate = upsertInspectionRate(emptyCache(), resultFixture({
    products: [
      { kind: 119, productionPerHour: 18.04, modifier: { status: 'none' } },
      { kind: 119, productionPerHour: null, modifier: { status: 'none' } },
    ],
  }));
  assert.equal(duplicateWithInvalidRate.ok, false);

  const wrongPath = upsertInspectionRate(emptyCache(), {
    ...resultFixture(),
    source: '/b/999/',
  });
  assert.equal(wrongPath.ok, false);
  assert.deepEqual(wrongPath.cache, emptyCache());
});
