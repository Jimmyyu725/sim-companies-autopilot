'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildPaReview,
  buildPendingPa,
  derivePaState,
  matchUniqueOption,
  parsePaUnreadRows,
  readPaReview,
  readPaStatus,
  readPendingPa,
  writePaReview,
  writePaStatus,
  writePendingPa,
} = require('../pa-state.js');

const OBSERVED_AT = '2026-07-30T06:30:00.000Z';
const NOW = Date.parse('2026-07-30T06:31:00.000Z');

test('reads the unique rendered Personal Assistant unread count', () => {
  assert.deepEqual(parsePaUnreadRows([
    { text: 'Acme Corp 3' },
    { text: 'Your Personal Assistant 1' },
  ]), {
    status: 'ok',
    unread: 1,
    rowText: 'Your Personal Assistant 1',
    reason: null,
  });
  assert.equal(parsePaUnreadRows([]).status, 'unknown');
  assert.equal(parsePaUnreadRows([
    'Personal Assistant 1',
    'Your Personal Assistant 2',
  ]).status, 'unknown');
});

test('persists an exact offer and derives pending state even after unread clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-pa-state-'));
  const pendingFile = path.join(dir, 'pending.json');
  const statusFile = path.join(dir, 'status.json');
  const pending = buildPendingPa({
    ok: true,
    url: 'https://www.simcompanies.com/messages/pa/',
    options: ['Ban it.', 'Make it official.', 'Use it as training.'],
    tail: `YOUR PERSONAL ASSISTANT Boss, run a Forklift Olympics?
      Ban it. Make it official. Use it as training.`,
  }, OBSERVED_AT);
  writePendingPa(pendingFile, pending);
  writePaStatus(statusFile, { status: 'ok', unread: 0 }, OBSERVED_AT);
  const restored = readPendingPa(pendingFile, { nowMs: NOW });
  const status = readPaStatus(statusFile, { nowMs: NOW });
  assert.equal(restored.offerText, 'Boss, run a Forklift Olympics?');
  assert.equal(fs.statSync(pendingFile).mode & 0o777, 0o600);
  assert.equal(derivePaState({ pending: restored, uiStatus: status }).status, 'pending');
  assert.equal(derivePaState({ pending: restored, uiStatus: status }).unread, 0);
});

test('guide review proves the preliminary choice was recorded before reply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-pa-review-'));
  const reviewFile = path.join(dir, 'review.json');
  const pending = buildPendingPa({
    ok: true,
    options: ['Ban it.', 'Make it official.', 'Use it as training.'],
    tail: 'YOUR PERSONAL ASSISTANT Boss, choose. Ban it. Make it official. Use it as training.',
  }, OBSERVED_AT);
  const review = buildPaReview({
    pending,
    preliminaryChoice: 'Make it official',
    rationale: 'The safety investment appears better than a permanent penalty.',
    guideDigest: 'b'.repeat(64),
    matchCount: 1,
  }, OBSERVED_AT);
  writePaReview(reviewFile, review);
  assert.equal(readPaReview(reviewFile, pending, { nowMs: NOW }).preliminaryChoice,
    'Make it official.');
  assert.equal(matchUniqueOption(pending.options, 'it').ok, false);
});
