'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveMenuCitation,
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

test('accepts a fresh runtime authorization quote with separate role evidence', () => {
  const authorizationEvidence = {
    ...evidence,
    meta: {
      ...evidence.meta,
      authorizationPreview: 'VERIFIED',
    },
    authorizationPreview: {
      action: 'build',
      terms: { building: 'farm', maxCost: 20000, minCashAfter: 5000 },
      preview: {
        ok: true,
        dry: true,
        preview: true,
        quoted: 7794,
        cashAfter: 30313,
      },
      source: 'runtime-verified-structural-preview',
      previewedAt: asOf,
      previewAgeSeconds: 0,
      previewVersion: 3,
    },
  };
  const accepted = validateCouncilVote('CFO', {
    verdict: 'APPROVE',
    summary: 'The verified quote and available liquidity support proceeding.',
    metrics: [{
      pointer: '/authorizationPreview/preview/quoted',
      value: 7794,
    }, {
      pointer: '/company/cash',
      value: 38107,
    }],
    unknowns: [],
    conditions: [],
  }, authorizationEvidence);
  assert.equal(accepted.ok, true);

  const termsOnly = validateCouncilVote('CFO', {
    verdict: 'APPROVE',
    summary: 'The requested spending cap supports proceeding.',
    metrics: [{
      pointer: '/authorizationPreview/terms/maxCost',
      value: 20000,
    }, {
      pointer: '/company/cash',
      value: 38107,
    }],
    unknowns: [],
    conditions: [],
  }, authorizationEvidence);
  assert.equal(termsOnly.ok, false);
  assert.match(termsOnly.value.unknowns[0], /not authoritative/);
});

test('all roles may cite the complete shared operating model but not a partial projection', () => {
  const modelEvidence = {
    meta: {
      collectedAt: asOf,
      stateFreshness: 'FRESH',
      portfolioInspection: 'OK',
    },
    decisionModel: {
      status: 'COMPLETE',
      coffeeChain: {
        current: { sustainablePowderPerHour: 164.8 },
        retailEvidence: { status: 'ACTIVE_ORDER' },
      },
      candidateComparison: [{
        optionId: 'build_farm',
        evidenceStatus: 'MEASURED_WITH_LINEAR_LEVEL_PROJECTION',
        paybackHours: 13.7,
      }],
    },
  };
  for (const role of ['CFO', 'COO', 'CMO']) {
    const result = validateCouncilVote(role, {
      verdict: 'APPROVE',
      summary: 'The complete automatic operating model supports proceeding.',
      metrics: [{
        pointer: '/decisionModel/candidateComparison/0/paybackHours',
        value: 13.7,
      }],
      unknowns: [],
      conditions: [],
    }, modelEvidence);
    assert.equal(result.ok, true, role);
  }

  const partial = structuredClone(modelEvidence);
  partial.decisionModel.candidateComparison[0].evidenceStatus = 'PARTIAL';
  assert.equal(validateCouncilVote('CFO', {
    verdict: 'APPROVE',
    summary: 'The incomplete projection supports proceeding.',
    metrics: [{
      pointer: '/decisionModel/candidateComparison/0/paybackHours',
      value: 13.7,
    }],
    unknowns: [],
    conditions: [],
  }, partial).ok, false);

  const methodologyOnly = structuredClone(modelEvidence);
  methodologyOnly.decisionModel.projectionMethod = { capacity: 'linear measured rate' };
  assert.equal(validateCouncilVote('CFO', {
    verdict: 'APPROVE',
    summary: 'A methodology label alone supports proceeding.',
    metrics: [{
      pointer: '/decisionModel/projectionMethod/capacity',
      value: 'linear measured rate',
    }],
    unknowns: [],
    conditions: [],
  }, methodologyOnly).ok, false);
});

test('COO and CMO may cite their fresh portfolio and Grocery evidence', () => {
  const roleEvidence = {
    meta: {
      collectedAt: asOf,
      stateFreshness: 'FRESH',
      portfolioInspection: 'OK',
    },
    portfolioInspections: [{ ok: true, fresh: true, name: 'Farm', level: 3 }],
    groceryRetailEvidence: {
      status: 'ACTIVE_ORDER',
      activeOrder: { profitPerHour: 6374.1 },
    },
  };
  assert.equal(validateCouncilVote('COO', {
    verdict: 'APPROVE',
    summary: 'Fresh portfolio capacity evidence supports proceeding.',
    metrics: [{ pointer: '/portfolioInspections/0/level', value: 3 }],
    unknowns: [],
    conditions: [],
  }, roleEvidence).ok, true);
  assert.equal(validateCouncilVote('CMO', {
    verdict: 'APPROVE',
    summary: 'Fresh Grocery economics support proceeding.',
    metrics: [{ pointer: '/groceryRetailEvidence/activeOrder/profitPerHour', value: 6374.1 }],
    unknowns: [],
    conditions: [],
  }, roleEvidence).ok, true);
});

// Regression (2026-08-01 audit): 39 of 134 UNKNOWN council votes were roles failing their OWN
// free-form citations — inventing a pointer such as
// /decisionModel/coffeeChain/current/retailEvidence/status, or mistyping a value — not judgements
// about the proposal. A role can now cite a menu row by index, which the runtime resolves
// deterministically, so that failure mode is unavailable to it.
const citationMenu = [
  { i: 0, pointer: '/company/cash', value: 38107 },
  { i: 1, pointer: '/debt/reconciled', value: true },
];

test('a menu-index citation is resolved from the menu and cannot be mistyped', () => {
  assert.deepEqual(resolveMenuCitation({ pointer: null, value: null, menuIndex: 0 }, citationMenu),
    { pointer: '/company/cash', value: 38107 });
  // A wrong pointer or value alongside a valid index cannot corrupt the citation.
  assert.deepEqual(resolveMenuCitation({ pointer: '/wrong', value: 1, menuIndex: 1 }, citationMenu),
    { pointer: '/debt/reconciled', value: true });
  // Free-form citations are untouched.
  assert.deepEqual(
    resolveMenuCitation({ pointer: '/company/cash', value: 38107, menuIndex: null }, citationMenu),
    { pointer: '/company/cash', value: 38107, menuIndex: null });

  assert.throws(() => resolveMenuCitation({ menuIndex: 9 }, citationMenu), /outside the citation menu/);
  assert.throws(() => resolveMenuCitation({ menuIndex: -1 }, citationMenu), /non-negative integer/);
  assert.throws(() => resolveMenuCitation({ menuIndex: 1.5 }, citationMenu), /non-negative integer/);
});

test('a vote citing only by menu index validates', () => {
  const result = validateCouncilVote('CFO', {
    verdict: 'APPROVE',
    summary: 'Cash covers the measured cost with the reserve intact.',
    metrics: [{ pointer: null, value: null, menuIndex: 0 }],
    unknowns: [],
    conditions: [],
  }, evidence, citationMenu);
  assert.equal(result.ok, true, result.value?.unknowns?.[0]);
  assert.equal(result.value.metrics[0].pointer, '/company/cash');
  assert.equal(result.value.metrics[0].value, 38107);
});

test('an out-of-range menu index is rejected rather than silently ignored', () => {
  const result = validateCouncilVote('CFO', {
    verdict: 'APPROVE',
    summary: 'Cash covers the measured cost.',
    metrics: [{ pointer: null, value: null, menuIndex: 7 }],
    unknowns: [],
    conditions: [],
  }, evidence, citationMenu);
  assert.equal(result.ok, false);
  assert.match(result.value.unknowns[0], /outside the citation menu/);
});
