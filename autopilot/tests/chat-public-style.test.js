'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPublicStyleProfile,
  validatePublicStyleProfile,
} = require('../chat/public-style.js');

function message(text, resourceKinds = [], room = 'Sales') {
  return {
    conversationType: 'room',
    conversationId: room,
    direction: 'inbound',
    content: {
      text,
      resourceMentions: resourceKinds.map(kind => ({ kind, name: null })),
    },
  };
}

test('learns a bounded short public style without retaining player text', () => {
  const messages = [
    message('Buying 10k :re-2: Q0 @0.37', [2]),
    message('WTB 500k :re-1: Q0', [1]),
    message('SELL 2k :re-110: Q1 @12', [110]),
    message('Need 4 :re-99:', [99]),
  ];
  const profile = buildPublicStyleProfile(messages, {
    roomId: 'Sales',
    observedAt: '2026-07-27T10:00:00.000Z',
  });
  assert.equal(profile.status, 'learned');
  assert.equal(profile.sampleSize, 4);
  assert.equal(profile.rawExamplesIncluded, false);
  assert.ok(profile.recommendedBodyMaxCharacters >= 18);
  assert.ok(profile.recommendedBodyMaxCharacters <= 30);
  assert.equal(profile.featureRates.resourceIcon, 1);
  assert.equal(JSON.stringify(profile).includes('Buying 10k'), false);
  assert.equal(validatePublicStyleProfile(profile, { roomId: 'Sales' }), true);
  assert.equal(validatePublicStyleProfile(profile, { roomId: 'Game' }), false);
});

test('insufficient room samples use a safe short default and ignore private/other-room text', () => {
  const profile = buildPublicStyleProfile([
    message('BUY 5 :re-2:', [2]),
    { ...message('private text'), conversationType: 'private' },
    message('other room', [], 'Game'),
  ], { roomId: 'Sales', observedAt: '2026-07-27T10:00:00.000Z' });
  assert.equal(profile.status, 'insufficient-samples');
  assert.equal(profile.sampleSize, 1);
  assert.equal(profile.recommendedBodyMaxCharacters, 45);
});
