'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENGINES = [
  ['responses engine', require('../brain56.js')],
  ['chat-completions engine', require('../brain.js')],
];
const NOW = Date.parse('2026-07-26T21:00:00.000Z');

for (const [name, engine] of ENGINES) {
  test(`${name}: incomplete tool loop creates a five-minute safety retry`, () => {
    const alarm = engine.buildIncompleteLoopRetryAlarm(
      'tool loop exhausted without successful finish', NOW, engine.createUtilityExchangeReviews());

    assert.equal(alarm.at, NOW + 5 * 60e3);
    assert.equal(alarm.set, new Date(NOW).toISOString());
    assert.equal(alarm.safetyRetry, true);
    assert.match(alarm.reason, /brain loop incomplete/);
  });

  test(`${name}: incomplete tool loop preserves rate-limited kind binding`, () => {
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(
      reviews, 2, { ok: false, book: { live: { status: 429 } } }, NOW);
    const alarm = engine.buildIncompleteLoopRetryAlarm('no function call', NOW + 1000, reviews);

    assert.deepEqual(alarm.utilityRetryKinds, [2]);
    assert.equal(Date.parse(alarm.set) >= Date.parse(reviews['2'].reviewedAt), true);
  });
}

test('responses engine: every chained turn resends stable instructions', () => {
  const request = ENGINES[0][1].buildChainedResponseRequest(
    'resp_test',
    'stable owner policy',
    [{ type: 'function_call_output', call_id: 'call_test', output: '{}' }],
    [{ type: 'function', name: 'finish', parameters: { type: 'object' } }],
  );
  assert.equal(request.previous_response_id, 'resp_test');
  assert.equal(request.instructions, 'stable owner policy');
  assert.equal(request.input[0].call_id, 'call_test');
});

test('chat engine builds a DeepSeek Max thinking request without relying on prompt-only serialization', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'refresh_state',
      strict: true,
      parameters: { type: 'object', properties: {} },
    },
  }];
  const request = ENGINES[1][1].buildChatCompletionRequest({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'test' }],
    tools,
    effort: 'max',
    maxTokens: 32768,
  });
  assert.equal(request.model, 'deepseek-v4-pro');
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.reasoning_effort, 'max');
  assert.equal(request.max_tokens, 32768);
  assert.equal(Object.hasOwn(request, 'parallel_tool_calls'), false);
  assert.equal(Object.hasOwn(request.tools[0].function, 'strict'), false);
  assert.equal(tools[0].function.strict, true, 'normalization must not mutate shared tools');
});

test('chat engine limits DeepSeek recovery to one published tool without changing OpenAI requests', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'refresh_state',
        strict: true,
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        strict: true,
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
    },
  ];
  const messages = [{ role: 'user', content: 'test' }];
  const deepSeek = ENGINES[1][1].buildChatCompletionRequest({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    messages,
    tools,
    effort: 'max',
    forcedToolName: 'refresh_state',
  });
  assert.equal(deepSeek.tool_choice, 'auto');
  assert.deepEqual(
    deepSeek.tools.map(tool => tool.function.name),
    ['refresh_state'],
  );
  assert.equal(Object.hasOwn(deepSeek, 'parallel_tool_calls'), false);

  const openAi = ENGINES[1][1].buildChatCompletionRequest({
    provider: 'openai',
    model: 'gpt-test',
    messages,
    tools,
    forcedToolName: 'refresh_state',
  });
  assert.equal(openAi.tool_choice, 'auto');
  assert.equal(openAi.parallel_tool_calls, false);
  assert.deepEqual(
    openAi.tools.map(tool => tool.function.name),
    ['refresh_state', 'finish'],
  );
  assert.equal(openAi.tools[0].function.strict, true);
});

test('chat engine normalizes only DeepSeek string nulls allowed by a tool schema', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'inspect_building',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          buildingId: { type: 'integer' },
          product: { type: ['string', 'null'] },
          qty: { type: ['number', 'null'] },
          label: { type: 'string' },
        },
        required: ['buildingId', 'product', 'qty', 'label'],
      },
    },
  }];
  const normalized = ENGINES[1][1].normalizeDeepSeekToolArguments(
    'inspect_building',
    { buildingId: 42, product: ' null ', qty: 'NULL', label: 'null' },
    tools,
  );
  assert.deepEqual(normalized.args, {
    buildingId: 42,
    product: null,
    qty: null,
    label: 'null',
  });
  assert.deepEqual(normalized.normalizedFields, ['product', 'qty']);
});

test('chat engine converts DeepSeek guard hints into a forced next tool', () => {
  const tools = [
    { type: 'function', function: { name: 'refresh_state', parameters: {} } },
    { type: 'function', function: { name: 'set_alarm', parameters: {} } },
  ];
  assert.equal(
    ENGINES[1][1].requiredDeepSeekTool(
      { requiredNextTool: 'refresh_state' }, tools),
    'refresh_state',
  );
  assert.equal(
    ENGINES[1][1].requiredDeepSeekTool(
      { requiredTool: 'set_alarm' }, tools),
    'set_alarm',
  );
  assert.equal(
    ENGINES[1][1].requiredDeepSeekTool(
      { requiredTool: 'unknown_tool' }, tools),
    null,
  );
});

test('chat engine rejects an entire multi-tool turn and returns one result for every call id', () => {
  const calls = [
    { id: 'call-a', function: { name: 'inspect_building' } },
    { id: 'call-b', function: { name: 'collect' } },
  ];
  const results = ENGINES[1][1].buildMultiToolRejections(calls);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(result => result.tool_call_id), ['call-a', 'call-b']);
  for (const result of results) {
    const content = JSON.parse(result.content);
    assert.equal(content.ok, false);
    assert.equal(content.executed, false);
    assert.match(content.reason, /no tool from this message was executed/i);
  }
  assert.equal(ENGINES[1][1].buildMultiToolRejections([calls[0]]), null);
  assert.equal(
    ENGINES[1][1].deepSeekMultiToolRecovery(calls, [
      { type: 'function', function: { name: 'inspect_building' } },
      { type: 'function', function: { name: 'collect' } },
    ]),
    'inspect_building',
  );
});
