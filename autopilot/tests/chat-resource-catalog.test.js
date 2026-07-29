'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadTrustedResourceCatalog,
  projectTrustedResourceCatalog,
  resourcePartMatchesCatalog,
  validateTrustedResourceCatalog,
} = require('../chat/resource-catalog.js');
const { draftPublicTradePost } = require('../chat/negotiation.js');

test('loads all local resource names, including defs-image fallbacks for Tools and Satellite', () => {
  const catalog = loadTrustedResourceCatalog();
  assert.equal(validateTrustedResourceCatalog(catalog), true);
  assert.deepEqual(catalog.entries.find(entry => entry.kind === 110), { kind: 110, name: 'tools' });
  assert.deepEqual(catalog.entries.find(entry => entry.kind === 99), { kind: 99, name: 'satellite' });

  const projected = projectTrustedResourceCatalog(catalog, [99, 110]);
  assert.equal(projected.entries.some(entry => entry.kind === 99), true);
  assert.equal(projected.entries.some(entry => entry.kind === 110), true);
  assert.equal(resourcePartMatchesCatalog(
    { type: 'resource', kind: 110, name: 'Tools' },
    projected,
  ), true);
  assert.equal(resourcePartMatchesCatalog(
    { type: 'resource', kind: 99, name: 'Tools' },
    projected,
  ), false);

  const tools = draftPublicTradePost({
    ourSide: 'sell',
    resourceKind: 110,
    quantity: 125,
    quality: 0,
    price: { status: 'known', type: 'absolute', decimal: '12.5', amount: 12.5 },
    trustedResourceCatalog: catalog,
  });
  assert.deepEqual(tools.parts[1], { type: 'resource', kind: 110, name: 'tools' });
  assert.equal(tools.finalMarkup, 'SELL 125 :re-110: Q0 @12.5');

  const satellite = draftPublicTradePost({
    ourSide: 'buy',
    resourceKind: 99,
    quantity: 2,
    quality: 1,
    price: { status: 'known', type: 'absolute', decimal: '150000', amount: 150000 },
    trustedResourceCatalog: catalog,
  });
  assert.deepEqual(satellite.parts[1], { type: 'resource', kind: 99, name: 'satellite' });
  assert.equal(satellite.finalMarkup, 'BUY 2 :re-99: Q1 @150000');
});
