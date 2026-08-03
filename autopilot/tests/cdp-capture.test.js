'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { captureComplete } = require('../../shared/cdp.js');

const SIM = path.join(__dirname, '..', '..');
const AUTH = 'https://www.simcompanies.com/api/v3/companies/auth-data/';
const BUILDINGS = 'https://www.simcompanies.com/api/v2/companies/me/buildings/';
const REQUIRED = ['/api/v3/companies/auth-data/', '/api/v2/companies/me/buildings/'];

test('a capture is complete only when every required path has finished loading', () => {
  const wanted = new Map([['1', AUTH], ['2', BUILDINGS]]);
  assert.equal(captureComplete(wanted, new Set(['1', '2']), REQUIRED), true);
});

// responseReceived fires on headers. Stopping there and calling getResponseBody against a still
// streaming request returns a truncated body, which is far worse than waiting.
test('a response whose headers arrived but whose body has not is not complete', () => {
  const wanted = new Map([['1', AUTH], ['2', BUILDINGS]]);
  assert.equal(captureComplete(wanted, new Set(['1']), REQUIRED), false);
  assert.equal(captureComplete(wanted, new Set(), REQUIRED), false);
});

test('a required path that was never requested is not complete', () => {
  const wanted = new Map([['1', AUTH]]);
  assert.equal(captureComplete(wanted, new Set(['1']), REQUIRED), false);
});

// No required list means the caller did not opt in, and the original fixed wait must run in full.
test('an empty or absent required list never short-circuits the wait', () => {
  const wanted = new Map([['1', AUTH], ['2', BUILDINGS]]);
  const finished = new Set(['1', '2']);
  assert.equal(captureComplete(wanted, finished, []), false);
  assert.equal(captureComplete(wanted, finished, null), false);
  assert.equal(captureComplete(wanted, finished, undefined), false);
});

test('unrelated finished traffic cannot satisfy a required path', () => {
  const wanted = new Map([
    ['1', AUTH],
    ['9', 'https://www.simcompanies.com/api/v2/companies/me/administration-overhead/'],
  ]);
  assert.equal(captureComplete(wanted, new Set(['1', '9']), REQUIRED), false);
});

test('the same path requested twice is satisfied by whichever attempt finished', () => {
  const wanted = new Map([['1', BUILDINGS], ['2', BUILDINGS], ['3', AUTH]]);
  assert.equal(captureComplete(wanted, new Set(['2', '3']), REQUIRED), true);
});

// Guards the actual reason this change is safe: state.js must not wait on the market ticker,
// because the store page frequently never requests it and the price-tracker fallback exists
// precisely for that. Listing it would forfeit the early return on every capture.
test('state.js waits for its five real endpoints and never for the ticker', () => {
  const source = fs.readFileSync(path.join(SIM, 'autopilot', 'state.js'), 'utf8');
  const call = source.match(/cdp\.capture\([^;]*?\]\s*\);/s);
  assert.ok(call, 'state.js must pass an explicit required-endpoint list');
  for (const endpoint of [
    '/api/v3/companies/auth-data/',
    '/api/v2/companies/me/buildings/',
    '/api/v3/resources/',
    '/api/v4/0/resources-retail-info/',
    '/api/v2/production-modifiers/0/',
  ]) {
    assert.ok(call[0].includes(endpoint), `state.js must wait for ${endpoint}`);
  }
  assert.ok(!call[0].includes('market-ticker'),
    'waiting for the ticker would forfeit the early return; the tracker fallback covers it');
});

test('every live capture caller declares what it reads', () => {
  for (const file of ['autopilot/state.js', 'autopilot/act.js', 'shared/price-tracker/collect.js']) {
    const source = fs.readFileSync(path.join(SIM, file), 'utf8');
    for (const call of source.match(/cdp\.capture\([^;]*?\);/gs) || []) {
      assert.match(call, /\[/, `${file} has a capture() with no required-endpoint list: ${call.slice(0, 80)}`);
    }
  }
});
