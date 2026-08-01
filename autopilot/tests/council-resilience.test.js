'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatToolOutput } = require('../tool-output.js');
const {
  DEEPSEEK_STRATEGY_JSON_INSTRUCTION,
  aggregateStrategyDecision,
  attachAuthorizationPreviewEvidence,
  attachStrategyCandidateEvidence,
  buildAuthoritativeCitationMenu,
  buildCouncilRequest,
  failClosedRoleVote,
  normalizeDeepSeekCouncilVote,
  prepareEvidenceView,
  reviewCouncilRole,
  runCouncil,
  runStrategyCouncil,
  strategyRepairInstruction,
  strategyCouncilToolParameters,
  validateStrategyCouncilArgs,
  writeCouncilAudit,
} = require('../council.js');
const {
  validateCouncilAuthorization,
  validateStrategyCouncilCompletion,
} = require('../runtime-guard.js');

const AS_OF = '2026-07-27T10:00:00.000Z';
const CFO_EVIDENCE = {
  meta: { collectedAt: AS_OF, stateFreshness: 'FRESH' },
  sourceStatus: { auth: { status: 'ok', asOf: AS_OF } },
  company: { cash: 41032 },
};
const ROLE_ARGS = {
  role: 'CFO',
  system: 'Review finance evidence.',
  evidence: { meta: { status: 'OK' }, roles: { CFO: CFO_EVIDENCE } },
  args: { proposal: 'Review the exact structural proposal.', context: '' },
  apiKey: 'test-only',
  brainDir: '/not-used',
};

function timeoutFailure() {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

function approvedVote() {
  return {
    verdict: 'APPROVE',
    summary: 'Verified cash evidence supports proceeding.',
    metrics: [{ pointer: '/company/cash', value: 41032 }],
    unknowns: [],
    conditions: [],
  };
}

function responseFor(vote, overrides = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(vote) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ...overrides,
    }),
  };
}

function dependencies(overrides = {}) {
  return {
    writeUsage: () => {},
    writeAudit: () => {},
    ...overrides,
  };
}

test('DeepSeek council request uses Max thinking plus JSON object mode', () => {
  const request = buildCouncilRequest({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'Return JSON.' }],
    effort: 'max',
    maxTokens: 16384,
  });
  assert.equal(request.model, 'deepseek-v4-pro');
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.reasoning_effort, 'max');
  assert.equal(request.max_tokens, 16384);
});

test('DeepSeek strategy contract explicitly requires arrays, citations, and digit-free prose', () => {
  assert.match(DEEPSEEK_STRATEGY_JSON_INSTRUCTION, /unknowns and conditions MUST each be a JSON array/);
  assert.match(DEEPSEEK_STRATEGY_JSON_INSTRUCTION, /one to eight objects/);
  assert.match(DEEPSEEK_STRATEGY_JSON_INSTRUCTION, /no digit characters/);
  assert.match(DEEPSEEK_STRATEGY_JSON_INSTRUCTION, /RECOMMEND the exact hold option/);
  assert.match(strategyRepairInstruction('unknowns has invalid type'), /Set unknowns to a JSON array/);
  assert.match(strategyRepairInstruction(
    'unknowns must not contain numeric claims; cite them through metrics',
  ), /Remove every digit character/);
});

test('authorization citation menu exposes verified result fields and exact role evidence only', () => {
  const evidence = {
    meta: {
      collectedAt: AS_OF,
      stateFreshness: 'FRESH',
      authorizationPreview: 'VERIFIED',
      portfolioInspection: 'OK',
    },
    sourceStatus: {
      auth: { status: 'ok', asOf: AS_OF },
    },
    company: { cash: 41032, minCash: 5000 },
    authorizationPreview: {
      action: 'build',
      terms: { building: 'farm', maxCost: 20000, minCashAfter: 5000 },
      preview: {
        ok: true,
        dry: true,
        preview: true,
        quoted: 7794,
        cashAfter: 33238,
        affordability: {
          withinMaxCost: true,
          reserveSatisfied: true,
          maxCost: 20000,
          minCashAfter: 5000,
        },
      },
      source: 'runtime-verified-structural-preview',
      previewedAt: AS_OF,
      previewAgeSeconds: 0,
      previewVersion: 4,
    },
  };
  const menu = buildAuthoritativeCitationMenu('CFO', evidence, 'authorization');
  assert(menu.preview.some(row =>
    row.pointer === '/authorizationPreview/preview/quoted' && row.value === 7794));
  assert(menu.preview.some(row =>
    row.pointer === '/authorizationPreview/preview/affordability/withinMaxCost' &&
    row.value === true));
  assert(menu.roleSpecific.some(row =>
    row.pointer === '/company/cash' && row.value === 41032));
  assert.equal(menu.preview.some(row => row.pointer.startsWith('/authorizationPreview/terms')), false);
  assert.match(menu.rule, /Never cite \/authorizationPreview\/terms/);
});

test('CMO citation menu publishes the actual nested Grocery evidence path', () => {
  const candidateComparison = Array.from({ length: 5 }, (_, index) => ({
    optionId: `candidate_${index}`,
    evidenceStatus: 'MEASURED_BASELINE',
    profitPerHour: 1000 + index,
    paybackHours: 20 + index,
    sustainableUnitsPerHour: 30 + index,
    downtimeHours: index,
  }));
  const evidence = {
    meta: {
      collectedAt: AS_OF,
      stateFreshness: 'FRESH',
      portfolioInspection: 'OK',
    },
    groceryRetailEvidence: {
      status: 'ACTIVE_ORDER',
      activeOrder: { profitPerHour: 6374.1, profitPerUnit: 14.2 },
    },
    decisionModel: {
      status: 'COMPLETE',
      coffeeChain: {
        retailEvidence: {
          status: 'ACTIVE_ORDER',
          activeOrder: { profitPerHour: 6374.1 },
        },
        current: {
          retail: { evidenceStatus: 'ACTIVE_ORDER', profitPerHour: 6374.1 },
        },
      },
      candidateComparison,
    },
  };
  const menu = buildAuthoritativeCitationMenu('CMO', evidence, 'authorization');
  assert(menu.roleSpecific.some(row =>
    row.pointer === '/groceryRetailEvidence/activeOrder/profitPerHour' &&
    row.value === 6374.1));
  assert(menu.roleSpecific.some(row =>
    row.pointer === '/decisionModel/coffeeChain/retailEvidence/status' &&
    row.value === 'ACTIVE_ORDER'));
  assert.equal(menu.roleSpecific.some(row =>
    row.pointer === '/decisionModel/retailEvidence/status'), false);
});

test('DeepSeek council adapter repairs only qualitative shape and leaves evidence metrics intact', () => {
  const vote = normalizeDeepSeekCouncilVote({
    verdict: 'RECOMMEND',
    optionId: 'hold',
    summary: 'Cash 41032 supports holding for 1 wake.',
    metrics: [{ pointer: '/company/cash', value: 41032 }],
    unknowns: 'Building 71 is still busy.',
    conditions: null,
  });
  assert.equal(/\d/u.test(vote.summary), false);
  assert.equal(/\d/u.test(vote.unknowns[0]), false);
  assert.deepEqual(vote.conditions, []);
  assert.deepEqual(vote.metrics, [{ pointer: '/company/cash', value: 41032 }]);
  assert.equal(vote.verdict, 'RECOMMEND');
  assert.equal(vote.optionId, 'hold');
});

test('DeepSeek council role normalizes qualitative format before deterministic validation', async () => {
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    provider: 'deepseek',
    fetch: async () => responseFor({
      ...approvedVote(),
      summary: 'Cash 41032 supports the proposal.',
      unknowns: 'No material issue 1 remains.',
      conditions: null,
    }),
  }));
  assert.equal(vote.status, 'VALIDATED');
  assert.equal(vote.verdict, 'APPROVE');
  assert.equal(/\d/u.test(vote.summary), false);
  assert.equal(/\d/u.test(vote.unknowns[0]), false);
  assert.deepEqual(vote.conditions, []);
  assert.deepEqual(vote.metrics, [{ pointer: '/company/cash', value: 41032 }]);
});

test('strategy council tool schema stays compatible with the OpenAI Responses API', () => {
  const serialized = JSON.stringify(strategyCouncilToolParameters);
  assert.equal(serialized.includes('"uniqueItems"'), false);
});

test('council failures redact provider credentials before returning or auditing them', () => {
  const syntheticSecret = `sk-${'sensitive-test-value'.repeat(2)}`;
  const vote = failClosedRoleVote('CFO', new Error(`provider rejected ${syntheticSecret}`));
  assert.equal(JSON.stringify(vote).includes(syntheticSecret), false);
  assert.match(vote.unknowns[0], /\[REDACTED\]/u);
});

test('DeepSeek council role uses provider endpoint and retains deterministic vote validation', async () => {
  let requestedUrl;
  let requestedBody;
  let usageProvider;
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    provider: 'deepseek',
    fetch: async (url, request) => {
      requestedUrl = url;
      requestedBody = JSON.parse(request.body);
      return responseFor(approvedVote());
    },
    writeUsage: (_brainDir, _role, _model, _json, provider) => {
      usageProvider = provider;
    },
  }));
  assert.equal(requestedUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(requestedBody.model, 'deepseek-v4-pro');
  assert.deepEqual(requestedBody.response_format, { type: 'json_object' });
  assert.match(requestedBody.messages[0].content, /Return only one valid JSON object/);
  assert.equal(usageProvider, 'deepseek');
  assert.equal(vote.status, 'VALIDATED');
  assert.equal(vote.verdict, 'APPROVE');
});

test('council audit stores bounded diagnostics without vote prose or raw evidence', () => {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-audit-'));
  try {
    writeCouncilAudit(auditDir, 'CMO', {
      role: 'CMO',
      status: 'INVALID_EVIDENCE',
      verdict: 'UNKNOWN',
      summary: 'RAW_PROMPT_MARKER',
      metrics: [{ pointer: '/marketBooks/0/price', value: 'RAW_METRIC_MARKER' }],
      unknowns: ['RAW_EVIDENCE_MARKER'],
      conditions: [],
    }, {
      attempts: 2,
      errorKind: 'VALIDATION',
      repairAttempted: true,
      validationError: 'metric value does not match evidence at /marketBooks/0/price',
    });
    const record = JSON.parse(fs.readFileSync(path.join(auditDir, 'council-audit.jsonl'), 'utf8'));
    const serialized = JSON.stringify(record);

    assert.equal(record.role, 'CMO');
    assert.equal(record.status, 'INVALID_EVIDENCE');
    assert.equal(record.verdict, 'UNKNOWN');
    assert.equal(record.repairAttempted, true);
    assert.match(record.validationError, /does not match evidence/);
    assert.equal(serialized.includes('RAW_PROMPT_MARKER'), false);
    assert.equal(serialized.includes('RAW_EVIDENCE_MARKER'), false);
    assert.equal(serialized.includes('RAW_METRIC_MARKER'), false);
  } finally {
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
});

test('two successful roles survive when one role times out and UNKNOWN cannot authorize', async () => {
  const approved = role => ({
    role,
    status: 'VALIDATED',
    verdict: 'APPROVE',
    summary: 'Evidence supports proceeding.',
    metrics: [],
    unknowns: [],
    conditions: [],
  });
  const result = await runCouncil({
    args: { proposal: 'Review building 1.', context: '', buildingId: 1, marketKinds: [] },
    apiKey: 'test-only',
    brainDir: '/not-used',
    simDir: '/not-used',
  }, {
    collectEvidence: () => ({
      ok: true,
      meta: { stateFreshness: 'FRESH', financePage: 200, buildingInspection: 'OK' },
      roles: {},
    }),
    reviewRole: async ({ role }) => {
      if (role === 'CFO') throw timeoutFailure();
      return approved(role);
    },
  });

  assert.deepEqual(result.council.map(vote => vote.role), ['CFO', 'COO', 'CMO']);
  assert.equal(result.council[0].status, 'API_ERROR');
  assert.equal(result.council[0].verdict, 'UNKNOWN');
  assert.equal(result.council[1].status, 'VALIDATED');
  assert.equal(result.council[2].status, 'VALIDATED');
  assert.equal(validateCouncilAuthorization(result, { buildingInspectionRequired: true }).ok, false);
});

test('stale state blocks authorization advisors before any model call', async () => {
  let roleCalls = 0;
  const result = await runCouncil({
    args: { proposal: 'Review building 1.', context: '', buildingId: 1, marketKinds: [] },
    apiKey: 'test-only',
    brainDir: '/not-used',
    simDir: '/not-used',
  }, {
    collectEvidence: () => ({
      ok: true,
      meta: { stateFreshness: 'STALE', financePage: 200, buildingInspection: 'OK' },
      roles: {},
    }),
    reviewRole: async () => {
      roleCalls += 1;
      throw new Error('must not run');
    },
  });

  assert.equal(roleCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.requiredTool, 'refresh_state');
  assert.deepEqual(result.council, []);
});

test('an initial timeout retries once and preserves the successful role vote and usage', async () => {
  let calls = 0;
  let usageWrites = 0;
  let audit;
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw timeoutFailure();
      return responseFor(approvedVote());
    },
    writeUsage: () => { usageWrites += 1; },
    writeAudit: (_brainDir, _role, _vote, details) => { audit = details; },
  }));

  assert.equal(calls, 2);
  assert.equal(usageWrites, 1);
  assert.equal(vote.status, 'VALIDATED');
  assert.equal(vote.verdict, 'APPROVE');
  assert.equal(audit.attempts, 2);
  assert.equal(audit.errorKind, null);
  assert.equal(audit.repairAttempted, false);
  assert.equal(audit.validationError, null);
});

test('provider-reported timeouts retry once without a client-side request deadline', async () => {
  let calls = 0;
  const requestSignals = [];
  let audit;
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    fetch: async (_url, request) => {
      calls += 1;
      requestSignals.push(Object.prototype.hasOwnProperty.call(request, 'signal')
        ? request.signal
        : 'absent');
      throw timeoutFailure();
    },
    writeAudit: (_brainDir, _role, _vote, details) => { audit = details; },
  }));

  assert.equal(calls, 2);
  assert.deepEqual(requestSignals, ['absent', 'absent']);
  assert.equal(vote.status, 'API_ERROR');
  assert.equal(vote.verdict, 'UNKNOWN');
  assert.deepEqual(audit, {
    attempts: 2,
    errorKind: 'TIMEOUT',
    repairAttempted: false,
    validationError: null,
    reviewType: 'authorization',
  });
});

test('a deterministic validation failure gets one feedback-bound repair attempt', async () => {
  let calls = 0;
  let usageWrites = 0;
  let secondRequest;
  let audit;
  const invalid = { ...approvedVote(), metrics: [{ pointer: '/company/cash', value: 99999 }] };
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    fetch: async (_url, request) => {
      calls += 1;
      if (calls === 2) secondRequest = JSON.parse(request.body);
      return responseFor(calls === 1 ? invalid : approvedVote());
    },
    writeUsage: () => { usageWrites += 1; },
    writeAudit: (_brainDir, _role, _vote, details) => { audit = details; },
  }));

  assert.equal(calls, 2);
  assert.equal(usageWrites, 2);
  assert.equal(vote.status, 'VALIDATED');
  assert.equal(vote.verdict, 'APPROVE');
  assert.match(secondRequest.messages[1].content, /REPAIR REQUIRED/);
  assert.match(secondRequest.messages[1].content, /does not match evidence/);
  assert.equal(audit.repairAttempted, true);
  assert.match(audit.validationError, /does not match evidence/);
  assert.equal(JSON.stringify(audit).includes('test-only'), false);
  assert.equal(JSON.stringify(audit).includes('AUTOMATIC CFO EVIDENCE'), false);
});

test('authorization repair gives DeepSeek an exact preview and role citation menu', async () => {
  let calls = 0;
  let secondRequest;
  const baseEvidence = {
    ok: true,
    meta: { collectedAt: AS_OF, stateFreshness: 'FRESH' },
    roles: { CFO: CFO_EVIDENCE },
  };
  const evidence = attachAuthorizationPreviewEvidence(baseEvidence, {
    action: 'build',
    terms: { building: 'farm', maxCost: 20000, minCashAfter: 5000 },
    preview: {
      ok: true,
      dry: true,
      preview: true,
      quoted: 7794,
      cashAfter: 33238,
      affordability: { withinMaxCost: true, reserveSatisfied: true },
    },
    source: 'runtime-verified-structural-preview',
    previewedAt: AS_OF,
    previewVersion: 4,
  });
  const invalid = {
    ...approvedVote(),
    metrics: [
      { pointer: '/authorizationPreview/terms/maxCost', value: 20000 },
      { pointer: '/company/cash', value: 41032 },
    ],
  };
  const repaired = {
    ...approvedVote(),
    metrics: [
      { pointer: '/authorizationPreview/preview/quoted', value: 7794 },
      { pointer: '/company/cash', value: 41032 },
    ],
  };
  const vote = await reviewCouncilRole({
    ...ROLE_ARGS,
    evidence,
  }, dependencies({
    provider: 'deepseek',
    fetch: async (_url, request) => {
      calls += 1;
      if (calls === 2) secondRequest = JSON.parse(request.body);
      return responseFor(calls === 1 ? invalid : repaired);
    },
  }));

  assert.equal(calls, 2);
  assert.equal(vote.status, 'VALIDATED');
  assert.equal(vote.verdict, 'APPROVE');
  assert.match(secondRequest.messages[0].content, /Never cite \/authorizationPreview\/terms/);
  assert.match(secondRequest.messages[1].content, /AUTHORITATIVE CITATION MENU/);
  assert.match(secondRequest.messages[1].content, /\/authorizationPreview\/preview\/quoted/);
  assert.match(secondRequest.messages[1].content, /\/company\/cash/);
  assert.match(secondRequest.messages[1].content, /Those are requested limits, not measured results/);
});

test('two invalid votes remain INVALID_EVIDENCE and are never promoted to approval', async () => {
  let calls = 0;
  const invalid = { ...approvedVote(), metrics: [{ pointer: '/company/cash', value: 99999 }] };
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    fetch: async () => {
      calls += 1;
      return responseFor(invalid);
    },
  }));

  assert.equal(calls, 2);
  assert.equal(vote.status, 'INVALID_EVIDENCE');
  assert.equal(vote.verdict, 'UNKNOWN');
});

test('API and response JSON errors fail closed without an unbounded retry', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'unavailable' } }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
  ]) {
    let calls = 0;
    const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
      fetch: async (...args) => { calls += 1; return fetchImpl(...args); },
    }));
    assert.equal(calls, 1);
    assert.equal(vote.status, 'API_ERROR');
    assert.equal(vote.verdict, 'UNKNOWN');
  }
});

const STRATEGY_OPTIONS = [
  {
    id: 'hold',
    label: 'Keep the current portfolio and preserve optionality.',
    action: 'hold',
    buildingId: null,
    target: null,
  },
  {
    id: 'upgrade_mill',
    label: 'Upgrade the measured Mill bottleneck.',
    action: 'upgrade',
    buildingId: 71,
    target: 'mill',
  },
  {
    id: 'build_farm',
    label: 'Build another Farm to expand upstream capacity.',
    action: 'build',
    buildingId: null,
    target: 'farm',
  },
];

test('strategy council arguments require a canonical hold option and bound targets', () => {
  const valid = validateStrategyCouncilArgs({
    question: 'Which capital direction best advances sustainable profit?',
    context: '',
    focusBuildingId: 71,
    marketKinds: [66, 118],
    options: STRATEGY_OPTIONS,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.options[1].buildingId, 71);

  const unnamedPivot = validateStrategyCouncilArgs({
    question: 'Choose a direction.',
    context: '',
    focusBuildingId: null,
    marketKinds: [66],
    options: [
      STRATEGY_OPTIONS[0],
      {
        id: 'new_line',
        label: 'Explore a different industry.',
        action: 'pivot',
        buildingId: null,
        target: null,
      },
    ],
  });
  assert.equal(unnamedPivot.ok, false);
  assert.match(unnamedPivot.reason, /concrete target/u);

  const missingHold = validateStrategyCouncilArgs({
    question: 'Choose a direction.',
    context: '',
    focusBuildingId: null,
    marketKinds: [66],
    options: STRATEGY_OPTIONS.slice(1),
  });
  assert.equal(missingHold.ok, false);
  assert.match(missingHold.reason, /hold option/);

  const duplicateTarget = validateStrategyCouncilArgs({
    question: 'Choose a direction.',
    context: '',
    focusBuildingId: 71,
    marketKinds: [66],
    options: [
      STRATEGY_OPTIONS[0],
      STRATEGY_OPTIONS[1],
      { ...STRATEGY_OPTIONS[1], id: 'upgrade_mill_faster' },
    ],
  });
  assert.equal(duplicateTarget.ok, false);
  assert.match(duplicateTarget.reason, /duplicate one executable action target/);
});

test('strategy council runtime rejects duplicate market kinds without schema-only enforcement', () => {
  const checked = validateStrategyCouncilArgs({
    question: 'Which capital direction best advances sustainable profit?',
    context: '',
    focusBuildingId: null,
    marketKinds: [1, 1],
    options: [
      {
        id: 'hold',
        label: 'Keep the current portfolio.',
        action: 'hold',
        buildingId: null,
        target: null,
      },
      {
        id: 'build_farm',
        label: 'Build a Farm.',
        action: 'build',
        buildingId: null,
        target: 'farm',
      },
    ],
  });
  assert.equal(checked.ok, false);
  assert.match(checked.reason, /duplicate/u);
});

test('strategy role chooses independently from the supplied options', async () => {
  let requestedBody;
  const vote = await reviewCouncilRole({
    ...ROLE_ARGS,
    args: {
      reviewType: 'strategy',
      question: 'Which direction best advances sustainable profit?',
      context: '',
      options: STRATEGY_OPTIONS,
    },
  }, dependencies({
    provider: 'deepseek',
    fetch: async (_url, request) => {
      requestedBody = JSON.parse(request.body);
      return responseFor({
        verdict: 'RECOMMEND',
        optionId: 'upgrade_mill',
        summary: 'Verified financing evidence supports this direction.',
        metrics: [{ pointer: '/company/cash', value: 41032 }],
        unknowns: [],
        conditions: [],
      });
    },
  }));
  assert.equal(vote.status, 'VALIDATED');
  assert.equal(vote.verdict, 'RECOMMEND');
  assert.equal(vote.optionId, 'upgrade_mill');
  assert.match(requestedBody.messages[0].content, /CEO has not selected an option/);
  assert.doesNotMatch(requestedBody.messages[0].content, /owner-approved strategy/);
  assert.match(requestedBody.messages[1].content, /upgrade_mill/);
});

test('strategy council majority decides and a valid three-way tie holds', () => {
  const vote = (role, optionId) => ({
    role,
    status: 'VALIDATED',
    verdict: 'RECOMMEND',
    optionId,
  });
  const majority = aggregateStrategyDecision([
    vote('CFO', 'upgrade_mill'),
    vote('COO', 'upgrade_mill'),
    vote('CMO', 'hold'),
  ], STRATEGY_OPTIONS);
  assert.equal(majority.status, 'DECIDED');
  assert.equal(majority.optionId, 'upgrade_mill');
  assert.equal(majority.method, 'majority');

  const tie = aggregateStrategyDecision([
    vote('CFO', 'upgrade_mill'),
    vote('COO', 'build_farm'),
    vote('CMO', 'hold'),
  ], STRATEGY_OPTIONS);
  assert.equal(tie.status, 'DECIDED');
  assert.equal(tie.optionId, 'hold');
  assert.equal(tie.method, 'hold_tiebreak');
});

test('strategy council safely holds when any role is unavailable', () => {
  const decision = aggregateStrategyDecision([
    { role: 'CFO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'upgrade_mill' },
    { role: 'COO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'upgrade_mill' },
    { role: 'CMO', status: 'API_ERROR', verdict: 'UNKNOWN', optionId: null },
  ], STRATEGY_OPTIONS);
  assert.equal(decision.status, 'DECIDED');
  assert.equal(decision.optionId, 'hold');
  assert.equal(decision.method, 'safety_hold');
  assert.deepEqual(decision.unavailableRoles, ['CMO']);
  assert.deepEqual(decision.tally, { upgrade_mill: 2 });
  assert.equal(validateStrategyCouncilCompletion({
    evidence: {
      stateFreshness: 'FRESH',
      financePage: 200,
      buildingInspection: 'NOT_REQUESTED',
    },
    council: [
      { role: 'CFO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'upgrade_mill' },
      { role: 'COO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'upgrade_mill' },
      { role: 'CMO', status: 'API_ERROR', verdict: 'UNKNOWN', optionId: null },
    ],
    decision,
  }).ok, true);
});

test('strategy council collects once, reviews all roles, and returns a validated decision', async () => {
  let evidenceCalls = 0;
  const result = await runStrategyCouncil({
    args: {
      question: 'Which capital direction best advances sustainable profit?',
      context: 'Compare the measured operating alternatives.',
      focusBuildingId: null,
      marketKinds: [66, 118],
      options: STRATEGY_OPTIONS,
    },
    apiKey: 'test-only',
    brainDir: '/not-used',
    simDir: '/not-used',
  }, {
    collectEvidence: args => {
      evidenceCalls += 1;
      assert.equal(args.buildingId, null);
      return {
        ok: true,
        meta: {
          stateFreshness: 'FRESH',
          financePage: 200,
          buildingInspection: 'NOT_REQUESTED',
        },
        roles: {},
      };
    },
    reviewRole: async ({ role, args }) => {
      assert.equal(args.reviewType, 'strategy');
      return {
        role,
        status: 'VALIDATED',
        verdict: 'RECOMMEND',
        optionId: role === 'CMO' ? 'hold' : 'upgrade_mill',
        summary: 'Verified evidence supports this direction.',
        metrics: [],
        unknowns: [],
        conditions: [],
      };
    },
  });
  assert.equal(evidenceCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.decision.optionId, 'upgrade_mill');
  assert.equal(validateStrategyCouncilCompletion(result).ok, true);
});

test('verified strategy candidates are injected ahead of each bounded role evidence pack', async () => {
  const candidate = {
    optionId: 'upgrade_mill',
    action: 'upgrade',
    terms: { buildingId: 71, maxCost: 20000, minCashAfter: 5000 },
    preview: {
      ok: true,
      dry: true,
      preview: true,
      cashCost: 12500,
      downtime: '04:00h',
    },
    source: 'runtime-verified-structural-preview',
    previewedAt: AS_OF,
    previewVersion: 3,
  };
  const baseEvidence = {
    ok: true,
    meta: {
      collectedAt: AS_OF,
      stateFreshness: 'FRESH',
      financePage: 200,
      buildingInspection: 'NOT_REQUESTED',
    },
    roles: Object.fromEntries(['CFO', 'COO', 'CMO'].map(role => [role, {
      meta: { collectedAt: AS_OF, stateFreshness: 'FRESH' },
      company: { cash: 41032 },
    }])),
  };
  const attached = attachStrategyCandidateEvidence(baseEvidence, [candidate]);
  assert.equal(attached.meta.strategyCandidates, 'VERIFIED');
  assert.equal(attached.roles.CFO.strategyCandidates[0].preview.cashCost, 12500);
  assert.deepEqual(Object.keys(attached.roles.CFO).slice(0, 2), [
    'meta',
    'strategyCandidates',
  ]);
  const bounded = prepareEvidenceView({
    ...attached.roles.COO,
    warehouse: 'x'.repeat(25000),
  });
  assert.equal(bounded.strategyCandidates[0].preview.cashCost, 12500);
  assert(bounded._transport.omittedTopLevelFields.includes('warehouse'));

  const seen = [];
  const result = await runStrategyCouncil({
    args: {
      question: 'Which capital direction best advances sustainable profit?',
      context: 'Compare the measured operating alternatives.',
      focusBuildingId: null,
      marketKinds: [66, 118],
      options: STRATEGY_OPTIONS,
    },
    apiKey: 'test-only',
    brainDir: '/not-used',
    simDir: '/not-used',
    strategyCandidates: [candidate],
  }, {
    collectEvidence: collectorArgs => {
      assert.equal(collectorArgs.reviewType, 'strategy');
      assert.equal(collectorArgs.strategyCandidates[0].preview.cashCost, 12500);
      return baseEvidence;
    },
    reviewRole: async ({ role, evidence }) => {
      seen.push(evidence.roles[role].strategyCandidates[0].optionId);
      return {
        role,
        status: 'VALIDATED',
        verdict: 'RECOMMEND',
        optionId: 'upgrade_mill',
        summary: 'Verified evidence supports this direction.',
        metrics: [],
        unknowns: [],
        conditions: [],
      };
    },
  });
  assert.deepEqual(seen.sort(), ['upgrade_mill', 'upgrade_mill', 'upgrade_mill']);
  assert.equal(result.ok, true);
  assert.equal(result.evidence.strategyCandidateCount, 1);
});

test('runtime authorization preview is injected as bounded automatic evidence', () => {
  const baseEvidence = {
    ok: true,
    meta: {
      collectedAt: AS_OF,
      stateFreshness: 'FRESH',
      financePage: 200,
      buildingInspection: 'NOT_REQUESTED',
    },
    roles: {
      CFO: {
        meta: { collectedAt: AS_OF, stateFreshness: 'FRESH' },
        company: { cash: 41032 },
      },
    },
  };
  const attached = attachAuthorizationPreviewEvidence(baseEvidence, {
    action: 'build',
    terms: { building: 'farm', maxCost: 20000, minCashAfter: 5000 },
    preview: {
      ok: true,
      dry: true,
      preview: true,
      quoted: 7794,
      cashAfter: 33238,
    },
    source: 'runtime-verified-structural-preview',
    previewedAt: AS_OF,
    previewVersion: 4,
  });

  assert.equal(attached.meta.authorizationPreview, 'VERIFIED');
  assert.equal(attached.roles.CFO.authorizationPreview.preview.quoted, 7794);
  assert.deepEqual(Object.keys(attached.roles.CFO).slice(0, 2), [
    'meta',
    'authorizationPreview',
  ]);
});

test('stale state blocks strategy advisors before any model call', async () => {
  let roleCalls = 0;
  const result = await runStrategyCouncil({
    args: {
      question: 'Which direction should the company take?',
      context: '',
      focusBuildingId: null,
      marketKinds: [66],
      options: STRATEGY_OPTIONS,
    },
    apiKey: 'test-only',
    brainDir: '/not-used',
    simDir: '/not-used',
  }, {
    collectEvidence: () => ({
      ok: true,
      meta: {
        stateFreshness: 'STALE',
        financePage: 200,
        buildingInspection: 'NOT_REQUESTED',
      },
      roles: {},
    }),
    reviewRole: async () => {
      roleCalls += 1;
      throw new Error('must not run');
    },
  });

  assert.equal(roleCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.requiredTool, 'refresh_state');
  assert.equal(result.decision.status, 'INCOMPLETE');
});

// Regression (2026-08-01 wake 04:23): a council result larger than the tool-output budget is
// bounded by whole fields, so `council: [votes]` collapsed to an item count and the brain never saw
// WHY authorization failed. It reissued the same Farm-upgrade proposal six times while the COO
// returned VALIDATED/UNKNOWN. The blocker summary must survive that bounding.
test('council blocker summary names the refusing role and survives tool-output bounding', () => {
  const { summarizeCouncilBlockers } = require('../council.js');
  const approving = {
    council: [
      { role: 'CFO', verdict: 'APPROVE', summary: 'Cash covers the upgrade.', unknowns: [] },
      { role: 'COO', verdict: 'APPROVE', summary: 'Capacity supports it.', unknowns: [] },
    ],
  };
  assert.equal(summarizeCouncilBlockers(approving), null);

  const blocked = {
    structuralAuthorization: { ok: false, reason: 'COO did not provide a validated non-rejecting verdict' },
    council: [
      { role: 'CFO', verdict: 'APPROVE', summary: 'Cash covers the upgrade.', unknowns: [] },
      { role: 'CMO', verdict: 'APPROVE', summary: 'Retail absorbs the output.', unknowns: [] },
      {
        role: 'COO',
        verdict: 'UNKNOWN',
        summary: 'Portfolio activity could not be confirmed.',
        unknowns: ['Portfolio inspection did not confirm the idle activity of every building.'],
      },
    ],
    evidence: { padding: 'x'.repeat(9000) },
  };
  const summary = summarizeCouncilBlockers(blocked);
  assert.match(summary, /^COO UNKNOWN: Portfolio inspection/);
  assert.ok(summary.length <= 250);

  // The realistic payload exceeds the budget, so the council array is dropped; the scalar summary
  // must still reach the brain.
  const bounded = formatToolOutput('council', { authorizationBlockedBy: summary, ...blocked });
  assert.ok(bounded.length < JSON.stringify(blocked).length);
  assert.match(bounded, /COO UNKNOWN: Portfolio inspection/);
});


// Regression (2026-08-01 audit): 72 of 134 UNKNOWN council votes were mechanical — 33 transport
// failures and 39 citation-validation failures — not judgement about the proposal. The brain could
// not tell them apart from a considered UNKNOWN, so it rewrote the same Farm-upgrade proposal six
// times when re-running the council was the correct move. The blocker summary must name the kind.
test('blocker summary distinguishes mechanical failures from judgement', () => {
  const { summarizeCouncilBlockers } = require('../council.js');

  const transport = summarizeCouncilBlockers({
    council: [{
      role: 'COO', verdict: 'UNKNOWN', status: 'API_ERROR',
      summary: 'Required evidence is unavailable.', unknowns: ['Required evidence is unavailable.'],
    }],
  });
  assert.match(transport, /^COO UNKNOWN \[API_ERROR — transport failure, not judgement/);
  assert.match(transport, /re-run council with the same proposal/);

  const citation = summarizeCouncilBlockers({
    council: [{
      role: 'CFO', verdict: 'UNKNOWN', status: 'INVALID_EVIDENCE',
      unknowns: ['metric value does not match evidence'],
    }],
  });
  assert.match(citation, /INVALID_EVIDENCE — the role's citation failed validation/);

  // A considered UNKNOWN carries no mechanical label: the gap is real and the proposal must change.
  const judgement = summarizeCouncilBlockers({
    council: [{
      role: 'CMO', verdict: 'UNKNOWN', status: 'VALIDATED',
      unknowns: ['Retail absorption for the added output is unproven.'],
    }],
  });
  assert.equal(judgement, 'CMO UNKNOWN: Retail absorption for the added output is unproven.');

  assert.equal(summarizeCouncilBlockers({
    council: [{ role: 'COO', verdict: 'APPROVE', status: 'VALIDATED', unknowns: [] }],
  }), null);
});
