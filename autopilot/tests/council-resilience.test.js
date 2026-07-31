'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  aggregateStrategyDecision,
  buildCouncilRequest,
  failClosedRoleVote,
  reviewCouncilRole,
  runCouncil,
  runStrategyCouncil,
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

  const missingHold = validateStrategyCouncilArgs({
    question: 'Choose a direction.',
    context: '',
    focusBuildingId: null,
    marketKinds: [66],
    options: STRATEGY_OPTIONS.slice(1),
  });
  assert.equal(missingHold.ok, false);
  assert.match(missingHold.reason, /hold option/);
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

test('strategy council stays incomplete when any role is unknown', () => {
  const decision = aggregateStrategyDecision([
    { role: 'CFO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'upgrade_mill' },
    { role: 'COO', status: 'VALIDATED', verdict: 'RECOMMEND', optionId: 'upgrade_mill' },
    { role: 'CMO', status: 'API_ERROR', verdict: 'UNKNOWN', optionId: null },
  ], STRATEGY_OPTIONS);
  assert.equal(decision.status, 'INCOMPLETE');
  assert.equal(decision.optionId, null);
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
