'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPageActivityInspection,
  classifyPageActivity,
  readBuildingPageActivity,
  validatePageActivityInspection,
} = require('../building-page-activity.js');

function control(text = '') {
  return {
    innerText: text,
    offsetParent: {},
    disabled: false,
    className: '',
    name: '',
    placeholder: '',
    getAttribute() { return null; },
  };
}

function withFakeRetailDom(t, bodyText) {
  const quantity = control();
  quantity.name = 'quantity';
  quantity.placeholder = 'Quantity';
  const price = control();
  price.name = 'price';
  price.placeholder = 'Price';
  const all = control('ALL');
  const average = control('AVG PRICE');
  const image = { ...control(), alt: 'Coffee powder' };
  const form = {
    innerText: 'QUANTITY ALL PRICE AVG PRICE',
    offsetParent: {},
    parentElement: null,
    querySelectorAll(selector) {
      if (selector === 'input') return [quantity, price];
      if (selector === 'button') return [all, average];
      if (selector === 'img') return [];
      return [];
    },
  };
  const card = {
    innerText: bodyText,
    offsetParent: {},
    parentElement: null,
    querySelectorAll(selector) {
      if (selector === 'input') return [quantity, price];
      if (selector === 'button') return [all, average];
      if (selector === 'img') return [image];
      return [];
    },
  };
  form.parentElement = card;
  const originals = {
    document: global.document,
    location: global.location,
    getComputedStyle: global.getComputedStyle,
  };
  global.document = {
    body: { innerText: bodyText },
    querySelectorAll(selector) {
      if (selector === 'form') return [form];
      if (selector === 'button') return [all, average];
      return [];
    },
  };
  global.location = { pathname: '/b/54959779/' };
  global.getComputedStyle = () => ({ pointerEvents: 'auto' });
  t.after(() => {
    global.document = originals.document;
    global.location = originals.location;
    global.getComputedStyle = originals.getComputedStyle;
  });
}

test('enabled quantity and price inputs bind an exact Grocery idle card', t => {
  withFakeRetailDom(t,
    'COFFEE POWDER Stock: 176 Profit per unit: $13.89 QUANTITY ALL PRICE AVG PRICE');
  const evidence = readBuildingPageActivity({ expectedPath: '/b/54959779/' });
  assert.equal(evidence.pathMatches, true);
  assert.equal(evidence.retailOrderAvailable, true);
  assert.equal(evidence.productionOrderAvailable, false);
  assert.equal(evidence.retailCards.length, 1);
  assert.equal(evidence.retailCards[0].name, 'Coffee powder');
  assert.deepEqual(classifyPageActivity(evidence), {
    status: 'page-derived', busy: false, type: 'idle',
  });
});

test('retail sale and construction markers outrank an available form', t => {
  withFakeRetailDom(t,
    'STORE IS SELLING COFFEE POWDER QUANTITY ALL PRICE AVG PRICE');
  const sale = readBuildingPageActivity({ expectedPath: '/b/54959779/' });
  assert.equal(classifyPageActivity(sale).type, 'sale');
  assert.equal(classifyPageActivity({ ...sale, construction: true }).type, 'construction');
  assert.deepEqual(classifyPageActivity({
    ...sale,
    retailSale: false,
    orderBusy: true,
    retailOrderAvailable: false,
  }), { status: 'page-derived', busy: true, type: 'unknown' });
});

test('inspection validation rejects route, level, freshness, and evidence mismatches', () => {
  const now = Date.parse('2026-07-27T10:20:00.000Z');
  const pageEvidence = {
    path: '/b/54959779/', pathMatches: true,
    construction: false, retailSale: true, orderBusy: false, collectible: false,
    productionOrderAvailable: false, retailOrderAvailable: false, retailCards: [],
  };
  const inspection = buildPageActivityInspection({
    buildingId: 54959779,
    level: 2,
    observedAt: new Date(now).toISOString(),
    pageEvidence,
  });
  const building = { id: 54959779, size: 2, category: 'sales' };
  assert.equal(validatePageActivityInspection(building, inspection, now).type, 'sale');
  assert.equal(validatePageActivityInspection({ ...building, size: 3 }, inspection, now), null);
  assert.equal(validatePageActivityInspection(building, {
    ...inspection, source: '/b/1/',
  }, now), null);
  assert.equal(validatePageActivityInspection(building, inspection, now + 301_000), null);
  assert.equal(validatePageActivityInspection(building, {
    ...inspection,
    type: 'idle',
    busy: false,
  }, now), null);
});
