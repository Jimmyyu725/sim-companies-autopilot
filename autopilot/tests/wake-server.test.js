'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readState, readTail } = require('../../web/wake/server.js');

const FIXTURES = path.join(__dirname, 'fixtures');

function tempLog(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-server-'));
  const logPath = path.join(dir, 'brain.log');
  fs.copyFileSync(path.join(FIXTURES, fixture), logPath);
  return { dir, logPath };
}

test('state is read from the tail of a log file', () => {
  const { logPath } = tempLog('wake-clean.log');
  const state = readState({ logPath, nowMs: Date.now() });
  assert.equal(state.status, 'done');
  assert.equal(state.progress.rc, 0);
});

// Only the tail is read, so a 3.6 MB log costs the same as a small one. The tail must still
// begin at a line boundary or the first entry after the cut is garbage.
//
// The cut has to land INSIDE the last wake, after its banner, or splitWakes finds no banner,
// returns nothing, and the assertion passes for the wrong reason — proving nothing about the
// partial line at all.
test('reading only the tail never yields a partial first line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-server-'));
  const logPath = path.join(dir, 'brain.log');
  const first = fs.readFileSync(path.join(FIXTURES, 'wake-503.log'), 'utf8');
  const second = fs.readFileSync(path.join(FIXTURES, 'wake-clean.log'), 'utf8');
  fs.writeFileSync(logPath, first + second);

  // Bytes from the end that cover the clean wake plus a slice of the 503 wake above it, so the
  // window starts mid-line and still contains the clean wake's banner.
  const tailBytes = Buffer.byteLength(second, 'utf8') + 200;
  const cut = readTail(logPath, tailBytes);
  assert.ok(!cut.startsWith(first.slice(0, 20)), 'the window must actually start mid-file');

  const state = readState({ logPath, tailBytes, nowMs: Date.now() });
  assert.notEqual(state.status, 'idle', 'the surviving banner must still be found');

  // wake-clean.log's own wake already carries a few lines classify() cannot place (a
  // credentialSource envelope, a FINISH: summary, a second health-check JSON blob, a
  // sync-deferred notice) — wake-parse.test.js's "appending N unparseable lines" test treats
  // unparsed as baseline-relative for the same reason, rather than assuming a clean wake is 0.
  // What this test must show is that the cut does not ADD to that baseline: the discarded
  // partial line and the dangling wake-503 remnant above the surviving banner both belong to
  // `current === null` in splitWakes and are dropped before they can be counted.
  const baselinePath = path.join(dir, 'clean-only.log');
  fs.writeFileSync(baselinePath, second);
  const baseline = readState({ logPath: baselinePath, nowMs: Date.now() });
  assert.equal(state.unparsed, baseline.unparsed, 'a mid-line cut must be discarded, not parsed');
});

test('a missing log gives idle rather than throwing', () => {
  const state = readState({ logPath: '/nonexistent/brain.log', nowMs: Date.now() });
  assert.equal(state.status, 'idle');
});

test('the next alarm file feeds the idle countdown', () => {
  const { dir } = tempLog('wake-clean.log');
  const nextWakePath = path.join(dir, 'next-wake.json');
  fs.writeFileSync(nextWakePath, JSON.stringify({
    atIso: '2026-08-04T02:38:30.000Z', reason: 'Mill completes',
  }));
  const state = readState({
    logPath: '/nonexistent/brain.log',
    nextWakePath,
    nowMs: Date.parse('2026-08-04T02:28:30.000Z'),
  });
  assert.equal(state.status, 'idle');
  assert.equal(state.nextWake.inMs, 10 * 60 * 1000);
});

test('a malformed alarm file does not break the read', () => {
  const { dir } = tempLog('wake-clean.log');
  const nextWakePath = path.join(dir, 'next-wake.json');
  fs.writeFileSync(nextWakePath, 'not json at all');
  const state = readState({ logPath: '/nonexistent/brain.log', nextWakePath, nowMs: Date.now() });
  assert.equal(state.status, 'idle');
  assert.equal(state.nextWake, null);
});
