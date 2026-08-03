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

// --- navigation ---------------------------------------------------------------------------

const { navigationTargetPath } = require('../../shared/cdp.js');

// goto() compares paths, not full hrefs: the app rewrites and appends query strings while it
// boots, so an href comparison would never match and every navigation would burn its full ceiling.
test('a navigation target reduces to its path, ignoring query and trailing slash', () => {
  assert.equal(navigationTargetPath('https://www.simcompanies.com/b/55042846/'), '/b/55042846');
  assert.equal(navigationTargetPath('https://www.simcompanies.com/b/55042846'), '/b/55042846');
  assert.equal(navigationTargetPath('https://www.simcompanies.com/b/55042846/?x=1'), '/b/55042846');
  assert.equal(navigationTargetPath('https://www.simcompanies.com/landscape/'), '/landscape');
});

// Two different buildings must never compare equal. This tab is shared, and a stale render has
// previously been read as the wrong building.
test('different buildings never reduce to the same path', () => {
  assert.notEqual(
    navigationTargetPath('https://www.simcompanies.com/b/55042846/'),
    navigationTargetPath('https://www.simcompanies.com/b/55644095/'));
});

test('an unparseable target yields null so the wait falls back instead of hanging', () => {
  assert.equal(navigationTargetPath('not a url'), null);
  assert.equal(navigationTargetPath(''), null);
  assert.equal(navigationTargetPath(null), null);
});

// The blind 4s pre-sleep and blind 2.5s post-sleep are what this change removed; a regression that
// reintroduced either would silently cost about 6.5s on every one of goto()'s ~46 call sites.
test('goto polls for readiness instead of sleeping a fixed time', () => {
  const source = fs.readFileSync(path.join(SIM, 'shared', 'cdp.js'), 'utf8');
  const goto = source.slice(source.indexOf('async function goto('));
  const body = goto.slice(0, goto.indexOf('\n}\n'));
  assert.ok(!/setTimeout\(r, 4000\)/.test(body), 'the blind 4s pre-navigation sleep must stay gone');
  assert.match(body, /document\.readyState|navigationProbe/, 'goto must check readiness');
  assert.match(body, /navigationTargetPath/, 'goto must verify which page it landed on');
});

// --- batch inspection ---------------------------------------------------------------------

// The DeepSeek adapter permits exactly one tool call per assistant message, so reading N buildings
// separately costs N full model round trips for reads that do not depend on each other. Writes
// stay single on purpose: a partially applied batch mutation leaves state no evidence describes.
test('both engines expose a read-only batch inspection and no batch mutation', () => {
  for (const engine of ['autopilot/brain.js', 'autopilot/brain56.js']) {
    const source = fs.readFileSync(path.join(SIM, engine), 'utf8');
    assert.match(source, /name: 'inspect_buildings'/, `${engine} must expose inspect_buildings`);
    assert.match(source, /if \(name === 'inspect_buildings'\)/, `${engine} must dispatch it`);
    for (const mutation of ['produce', 'sell', 'build', 'upgrade', 'scrap', 'bonds']) {
      assert.ok(!source.includes(`name: '${mutation}s'`),
        `${engine} must not expose a batch ${mutation}`);
    }
  }
});

test('the batch inspector caps its list so one call cannot monopolise the tick lock', () => {
  const source = fs.readFileSync(path.join(SIM, 'autopilot', 'inspect-building.js'), 'utf8');
  const cap = source.match(/const MAX_BATCH_INSPECTIONS = (\d+);/);
  assert.ok(cap, 'the batch size must be an explicit named cap');
  assert.ok(Number(cap[1]) >= 2 && Number(cap[1]) <= 12, 'the cap must be small and deliberate');
  assert.match(source, /buildingIds must be 1 to/, 'an out-of-range list must be refused, not clamped');
});

// Stability alone let an unpainted page through; the expectation alone released before the wages
// line painted. Both signals are required, and dropping either reintroduces a null-data race.
test('a page settles only when it is both stable and shows what the caller expects', () => {
  const source = fs.readFileSync(path.join(SIM, 'shared', 'cdp.js'), 'utf8');
  assert.match(source, /const stable = length > 0 && length === previousLength;/);
  assert.match(source, /if \(stable && seen\) break;/);
  const inspect = fs.readFileSync(path.join(SIM, 'autopilot', 'inspect-building.js'), 'utf8');
  assert.match(inspect, /expect: \/LEVEL/, 'a building page must prove it rendered its LEVEL line');
});
