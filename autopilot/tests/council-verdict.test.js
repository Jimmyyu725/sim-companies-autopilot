'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCouncilVote,
  validateStrategyCouncilVote,
} = require('../council-verdict.js');

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

test('accepts a strategy recommendation only for an exact supplied option', () => {
  const result = validateStrategyCouncilVote('CFO', {
    verdict: 'RECOMMEND',
    optionId: 'upgrade_mill',
    summary: 'The financing evidence supports the investment direction.',
    metrics: [{ pointer: '/company/cash', value: 38107 }],
    unknowns: [],
    conditions: ['Preserve the operating reserve.'],
  }, evidence, ['hold', 'upgrade_mill']);
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'VALIDATED');
  assert.equal(result.value.verdict, 'RECOMMEND');
  assert.equal(result.value.optionId, 'upgrade_mill');
});

test('rejects strategy recommendations outside the supplied option set', () => {
  const result = validateStrategyCouncilVote('CFO', {
    verdict: 'RECOMMEND',
    optionId: 'invented_pivot',
    summary: 'The financing evidence supports the investment direction.',
    metrics: [{ pointer: '/company/cash', value: 38107 }],
    unknowns: [],
    conditions: [],
  }, evidence, ['hold', 'upgrade_mill']);
  assert.equal(result.ok, false);
  assert.equal(result.value.verdict, 'UNKNOWN');
  assert.equal(result.value.optionId, null);
});

test('accepts fresh runtime candidate quotes but rejects uncited proposal terms as evidence', () => {
  const candidateEvidence = {
    meta: {
      collectedAt: asOf,
      stateFreshness: 'FRESH',
      strategyCandidates: 'VERIFIED',
    },
    sourceStatus: {
      auth: { status: 'ok', asOf },
    },
    company: { cash: 38107 },
    strategyCandidates: [{
      optionId: 'upgrade_mill',
      action: 'upgrade',
      terms: { buildingId: 71, maxCost: 20000 },
      preview: {
        ok: true,
        dry: true,
        preview: true,
        cashCost: 12500,
      },
      source: 'runtime-verified-structural-preview',
      previewedAt: asOf,
      previewAgeSeconds: 0,
      previewVersion: 2,
    }],
  };
  const accepted = validateStrategyCouncilVote('CFO', {
    verdict: 'RECOMMEND',
    optionId: 'upgrade_mill',
    summary: 'The verified candidate quote supports this direction.',
    metrics: [{
      pointer: '/strategyCandidates/0/preview/cashCost',
      value: 12500,
    }, {
      pointer: '/company/cash',
      value: 38107,
    }],
    unknowns: [],
    conditions: [],
  }, candidateEvidence, ['hold', 'upgrade_mill']);
  assert.equal(accepted.ok, true);

  const rejected = validateStrategyCouncilVote('CFO', {
    verdict: 'RECOMMEND',
    optionId: 'upgrade_mill',
    summary: 'The proposed cap supports this direction.',
    metrics: [{
      pointer: '/strategyCandidates/0/terms/maxCost',
      value: 20000,
    }, {
      pointer: '/company/cash',
      value: 38107,
    }],
    unknowns: [],
    conditions: [],
  }, candidateEvidence, ['hold', 'upgrade_mill']);
  assert.equal(rejected.ok, false);
  assert.match(rejected.value.unknowns[0], /not authoritative/);
});
