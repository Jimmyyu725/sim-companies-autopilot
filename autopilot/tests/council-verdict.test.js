'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCouncilVote } = require('../council-verdict.js');

const asOf = '2026-07-26T04:00:00.000Z';
const evidence = {
  meta: { collectedAt: asOf, stateFreshness: 'FRESH' },
  sourceStatus: {
    auth: { status: 'ok', asOf },
    bonds: { status: 'ok', asOf },
  },
  company: { cash: 38107 },
  debt: { reconciled: true },
};

test('accepts exact primitive citations', () => {
  const result = validateCouncilVote('CFO', {
    verdict: 'AMEND',
    summary: 'Funding evidence is usable but the reserve must be protected.',
    metrics: [{ pointer: '/company/cash', value: 38107 }, { pointer: '/debt/reconciled', value: true }],
    unknowns: [],
    conditions: ['Refresh the quote before confirmation.'],
  }, evidence);
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'VALIDATED');
});

test('rejects invented metrics and numbers hidden in prose', () => {
  assert.equal(validateCouncilVote('CFO', {
    verdict: 'APPROVE', summary: 'Cash is 99999.', metrics: [{ pointer: '/company/cash', value: 99999 }], unknowns: [], conditions: [],
  }, evidence).ok, false);
});

test('rejects an exact citation when its underlying source is stale', () => {
  const stale = {
    ...evidence,
    sourceStatus: { ...evidence.sourceStatus, bonds: { status: 'partial', asOf } },
  };
  const result = validateCouncilVote('CFO', {
    verdict: 'APPROVE',
    summary: 'The financing evidence supports proceeding.',
    metrics: [{ pointer: '/debt/reconciled', value: true }],
    unknowns: [],
    conditions: [],
  }, stale);
  assert.equal(result.ok, false);
  assert.equal(result.value.verdict, 'UNKNOWN');
});

test('requires each non-unknown role vote to cite authoritative role evidence', () => {
  const result = validateCouncilVote('COO', {
    verdict: 'APPROVE',
    summary: 'Operations support proceeding.',
    metrics: [{ pointer: '/company/cash', value: 38107 }],
    unknowns: [],
    conditions: [],
  }, evidence);
  assert.equal(result.ok, false);
  assert.match(result.value.unknowns[0], /role-specific metric/);
});
