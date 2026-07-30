'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { personalAssistantJournalGate } = require('../pa-policy.js');

test('journal requires every detected PA stage to finish', () => {
  assert.equal(personalAssistantJournalGate({ pa: { status: 'clear' } }), null);
  assert.equal(personalAssistantJournalGate({
    pa: { status: 'unread' },
  }).requiredTool, 'pa_read');

  const fingerprint = 'a'.repeat(64);
  const state = { pa: { status: 'pending', fingerprint } };
  assert.equal(personalAssistantJournalGate(state).requiredTool, 'pa_read');
  const pending = { fingerprint };
  assert.equal(personalAssistantJournalGate(state, { pending }).requiredTool,
    'pa_consult_guide');
  assert.equal(personalAssistantJournalGate(state, {
    pending,
    review: { fingerprint },
  }).requiredTool, 'pa_reply');
});

test('unknown PA evidence does not invent an unread offer', () => {
  assert.equal(personalAssistantJournalGate({ pa: { status: 'unknown' } }), null);
  assert.equal(personalAssistantJournalGate({}), null);
});
