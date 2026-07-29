'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHAT_POLICY,
  evaluatePublicSend,
  inspectOutgoingText,
  windowsExportDecision,
} = require('../chat/policy.js');

test('declares autonomous final authority without a human approval path', () => {
  assert.equal(CHAT_POLICY.operatingMode, 'autonomous-company-owner');
  assert.equal(CHAT_POLICY.decisionAuthority.finalDecisionMaker, 'company-brain');
  assert.equal(CHAT_POLICY.decisionAuthority.humanApprovalRequired, false);
});

test('blocks identity disclosure, own-name claims, human impersonation, and human deferral', () => {
  const blocked = [
    'I am an AI assistant.',
    'This company uses AI.',
    "I'm GPT-5.",
    'Our bot team can quote it.',
    'This account is automated.',
    'My name is Trade Boss.',
    "I'm Bob.",
    "I'm Bob, buying water.",
    'This is Bob: checking stock.',
    'Jay here. Still available?',
    '我是小王。',
    'I will forward this to the owner.',
    '需要负责人批准。',
    '我是 Jimmy，合同可以直接发我。',
  ];
  for (const text of blocked) {
    const result = inspectOutgoingText(text, { knownHumanNames: ['Jimmy', 'Jay', '于京田'] });
    assert.equal(result.ok, false, text);
  }
  assert.equal(inspectOutgoingText('I handle company operations and contracts.').ok, true);
  assert.equal(inspectOutgoingText('SELL 2 robots Q1 @MP').ok, true);
});

test('ordinary company language is not mistaken for identity disclosure', () => {
  for (const text of [
    'Still available?',
    'Fair price. Paid already.',
    'SELL 2 Robots Q1 @MP',
    'This is Available',
    'I am Selling 10k Power',
    "I'm Buying Water",
    'I am Ready',
    '我是买家。',
    '我是出售方。',
    '我是购买原料。',
    '我是需要报价。',
  ]) {
    const result = inspectOutgoingText(text, { scope: 'private' });
    assert.equal(result.ok, true, text);
    assert.deepEqual(result.violations, [], text);
  }
});

test('enforces compact one-line public messages using Unicode character counts', () => {
  assert.equal(inspectOutgoingText('SELL 10k water Q0 @0.40', { scope: 'room' }).ok, true);
  assert.match(
    inspectOutgoingText('SELL water\nDM', { scope: 'room' }).violations.join(','),
    /one-line/,
  );
  const long = `SELL ${'水'.repeat(56)}`;
  const result = inspectOutgoingText(long, { scope: 'room' });
  assert.equal(result.characters, 61);
  assert.match(result.violations.join(','), /too-long/);
});

test('requires a concrete reason and prevents duplicates, bursts, and proactive room spam', () => {
  const now = new Date('2026-07-26T20:30:00.000Z');
  const base = {
    text: 'SELL 10k water Q0 @0.40',
    roomId: 'sales',
    reason: 'verified-offer',
    now,
  };
  assert.equal(evaluatePublicSend({ ...base, reason: 'advertising' }).reason, 'concrete-public-reason-required');
  assert.equal(evaluatePublicSend({
    ...base,
    recentPublicMessages: [{ text: ' sell   10K WATER q0 @0.40 ', roomId: 'sales', sentAt: '2026-07-26T19:00:00.000Z' }],
  }).reason, 'duplicate-public-message');
  assert.equal(evaluatePublicSend({
    ...base,
    recentPublicMessages: [{ text: 'SELL 5k power Q0 @0.30', roomId: 'sales', sentAt: '2026-07-26T20:20:00.000Z' }],
  }).reason, 'proactive-room-cooldown');
  assert.equal(evaluatePublicSend({
    ...base,
    reason: 'reply',
    recentPublicMessages: [{ text: 'SELL 5k power Q0 @0.30', roomId: 'sales', sentAt: '2026-07-26T20:20:00.000Z' }],
  }).ok, true);
  assert.equal(evaluatePublicSend({
    ...base,
    recentPublicMessages: [
      { text: 'A', roomId: 'general', sentAt: '2026-07-26T20:01:00.000Z' },
      { text: 'B', roomId: 'aero', sentAt: '2026-07-26T20:02:00.000Z' },
      { text: 'C', roomId: 'help', sentAt: '2026-07-26T20:03:00.000Z' },
    ],
  }).reason, 'public-hourly-limit');
});

test('keeps private messages and summaries off Windows by default', () => {
  assert.deepEqual(
    windowsExportDecision({ recordType: 'message', conversationType: 'private' }),
    { allowed: false, reason: 'private-chat-stays-on-nas-by-default' },
  );
  assert.equal(windowsExportDecision({ recordType: 'summary', conversationType: 'private' }).allowed, false);
  assert.equal(windowsExportDecision({ recordType: 'message', conversationType: 'room' }).allowed, true);
});
