'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cachedStateFreshness,
  persistPageActivityInspection,
  resolveBuildingActivity,
} = require('../inspect-building.js');
const { buildPageActivityInspection } = require('../building-page-activity.js');

const NOW = Date.parse('2026-07-26T20:10:00.000Z');

test('cached state freshness permits bounded clock skew but rejects farther future timestamps', () => {
  assert.equal(cachedStateFreshness('2026-07-26T20:10:30.000Z', NOW).ok, true);

  const future = cachedStateFreshness('2026-07-26T20:10:31.000Z', NOW);
  assert.equal(future.ok, false);
  assert.equal(future.ageSeconds, -31);
  assert.match(future.reason, /future/);
});

test('cached state freshness rejects stale and invalid timestamps', () => {
  const stale = cachedStateFreshness('2026-07-26T20:04:59.000Z', NOW);
  assert.equal(stale.ok, false);
  assert.equal(stale.ageSeconds, 301);
  assert.match(stale.reason, /older/);

  const invalid = cachedStateFreshness('not-a-time', NOW);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ageSeconds, null);
});

test('building inspection distinguishes construction, production, sale, and idle from fresh state', () => {
  const state = {
    t: new Date(NOW).toISOString(),
    buildings: [
      { id: 1, busy: { type: 'construction', expanding: true, endsAt: '2026-07-26T21:00:00.000Z' } },
      { id: 2, busy: { type: 'production', makingKind: 1, makingName: 'Power' } },
      { id: 3, busy: { type: 'sale', makingKind: 5, makingName: 'Grapes' } },
      { id: 4, busy: null },
    ],
  };
  assert.equal(resolveBuildingActivity(state, 1, {}, NOW).type, 'construction');
  assert.equal(resolveBuildingActivity(state, 2, {}, NOW).type, 'production');
  assert.equal(resolveBuildingActivity(state, 3, {}, NOW).type, 'sale');
  assert.deepEqual(resolveBuildingActivity(state, 4, {}, NOW), {
    status: 'authoritative-state',
    busy: false,
    type: 'idle',
    endsAt: null,
    stateAsOf: state.t,
    stateAgeSeconds: 0,
  });
});

test('building inspection never treats missing page text as authoritative idle', () => {
  assert.deepEqual(resolveBuildingActivity(null, 1, {}, NOW), {
    status: 'unknown', busy: null, type: 'unknown', endsAt: null,
  });
  const exact = overrides => ({ path: '/b/1/', pathMatches: true, ...overrides });
  assert.equal(resolveBuildingActivity(null, 1, exact({ construction: true }), NOW).type,
    'construction');
  assert.equal(resolveBuildingActivity(null, 1, exact({ orderBusy: true }), NOW).busy, true);
  assert.equal(resolveBuildingActivity(null, 1, exact({ collectible: true }), NOW).busy, true);
  assert.deepEqual(resolveBuildingActivity(null, 1, exact({ orderAvailable: true }), NOW), {
    status: 'page-derived', busy: false, type: 'idle', endsAt: null,
  });
  assert.equal(resolveBuildingActivity(null, 1, exact({
    construction: true,
    retailOrderAvailable: true,
  }), NOW).type, 'construction');
  assert.equal(resolveBuildingActivity(null, 1, exact({ retailSale: true }), NOW).type, 'sale');
  assert.equal(resolveBuildingActivity(null, 1, exact({ retailOrderAvailable: true }), NOW).type,
    'idle');
  assert.equal(resolveBuildingActivity(null, 1, {
    path: '/b/2/', pathMatches: false, retailOrderAvailable: true,
  }, NOW).busy, null);
});

test('page-derived retail activity persists with an exact building, level, and route binding', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-building-activity-'));
  const stateFile = path.join(directory, '.state.json');
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      t: new Date(NOW).toISOString(),
      buildings: [{ id: 54959779, name: 'Grocery store', size: 2, category: 'sales' }],
    }));
    const inspection = buildPageActivityInspection({
      buildingId: 54959779,
      level: 2,
      observedAt: new Date(NOW).toISOString(),
      pageEvidence: {
        path: '/b/54959779/', pathMatches: true,
        construction: false, retailSale: false, orderBusy: false, collectible: false,
        productionOrderAvailable: false, retailOrderAvailable: true, retailCards: [{}],
      },
    });
    assert.equal(persistPageActivityInspection(stateFile, inspection).updated, true);
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.buildings[0].activityInspection.type, 'idle');
    assert.equal(persisted.buildings[0].activityInspection.source, '/b/54959779/');

    const wrongRoute = { ...inspection, source: '/b/1/' };
    assert.equal(persistPageActivityInspection(stateFile, wrongRoute).updated, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
