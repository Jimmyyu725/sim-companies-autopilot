'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCouncilRequest,
  failClosedRoleVote,
  reviewCouncilRole,
  runCouncil,
  writeCouncilAudit,
} = require('../council.js');
const { validateCouncilAuthorization } = require('../runtime-guard.js');

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
    makeSignal: timeoutMs => ({ timeoutMs }),
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

test('two timeouts stop after the bounded retry and consume no more than the hard total budget', async () => {
  let calls = 0;
  let elapsedMs = 0;
  const requestedTimeouts = [];
  let audit;
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    fetch: async () => {
      calls += 1;
      elapsedMs += 45_000;
      throw timeoutFailure();
    },
    now: () => elapsedMs,
    makeSignal: timeoutMs => {
      requestedTimeouts.push(timeoutMs);
      return { timeoutMs };
    },
    writeAudit: (_brainDir, _role, _vote, details) => { audit = details; },
  }));

  assert.equal(calls, 2);
  assert.deepEqual(requestedTimeouts, [45_000, 45_000]);
  assert.equal(requestedTimeouts.reduce((sum, value) => sum + value, 0), 90_000);
  assert.equal(vote.status, 'API_ERROR');
  assert.equal(vote.verdict, 'UNKNOWN');
  assert.deepEqual(audit, {
    attempts: 2,
    errorKind: 'TIMEOUT',
    repairAttempted: false,
    validationError: null,
  });
});

test('a request that ignores AbortSignal still stops after two hard-bounded attempts', async () => {
  let calls = 0;
  const startedAt = Date.now();
  const vote = await reviewCouncilRole(ROLE_ARGS, dependencies({
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
    attemptTimeoutMs: 10,
    totalTimeoutMs: 25,
  }));

  assert.equal(calls, 2);
  assert.equal(vote.status, 'API_ERROR');
  assert.equal(vote.verdict, 'UNKNOWN');
  assert.ok(Date.now() - startedAt < 1000);
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
