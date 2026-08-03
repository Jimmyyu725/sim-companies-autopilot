'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildRequest,
  estimateCost,
  redactSecrets,
} = require('../lib/client.js');
const {
  estimateOpenAICost,
  initialRequest,
} = require('../lib/openai-client.js');
const { costText } = require('../lib/artifacts.js');
const {
  SHADOW_APPENDIX,
  assistantMessageForHistory,
  runOpenAIShadowWake,
  runShadowWake,
} = require('../lib/runner.js');
const { scoreShadowResult } = require('../lib/scoring.js');
const { buildProspectorReadyScenario } = require('../lib/scenarios.js');
const { createSnapshot } = require('../lib/snapshot.js');
const {
  ShadowToolRuntime,
  buildDeepSeekTools,
  buildOpenAIResponsesTools,
} = require('../lib/tool-runtime.js');
const { parity, parseArguments } = require('../benchmark.js');

const SIM_DIR = path.resolve(__dirname, '..', '..', '..');

test('captures the live-file snapshot without opening a browser', () => {
  const snapshot = createSnapshot(SIM_DIR, new Date('2026-07-29T21:00:00.000Z'));
  assert.equal(snapshot.mode, 'sim-model-shadow-benchmark');
  assert.equal(typeof snapshot.systemPrompt, 'string');
  assert.equal(typeof snapshot.state, 'object');
  assert.equal(snapshot.sourceManifest.state.path, 'autopilot/.state.json');
  assert.match(snapshot.sourceManifest.state.sha256, /^[0-9a-f]{64}$/u);
});

test('publishes the active action surface without DeepSeek beta strict mode', () => {
  const tools = buildDeepSeekTools({ SIM_CHAT_MODE: 'shadow' });
  const rebuild = tools.find(tool => tool.function?.name === 'rebuild');
  assert.ok(rebuild);
  assert.equal(Object.hasOwn(rebuild.function, 'strict'), false);
  assert.deepEqual(rebuild.function.parameters.required, ['buildingId', 'confirm']);
  assert.ok(tools.find(tool => tool.function?.name === 'finish'));
});

test('simulates action clicks and never executes them', async () => {
  const snapshot = buildProspectorReadyScenario(createSnapshot(SIM_DIR));
  const buildingId = snapshot.fixtures.rebuild.buildingId;
  const runtime = new ShadowToolRuntime(snapshot);
  const result = await runtime.execute('rebuild', { buildingId, confirm: true });
  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.equal(result.wouldClick, true);
  assert.equal(runtime.actions.length, 1);
  assert.equal(runtime.dirtyAfterMutation, true);
  const refreshed = await runtime.execute('refresh_state', {});
  assert.equal(runtime.dirtyAfterMutation, false);
  assert.equal(refreshed._shadow.recordedActions[0].action, 'rebuild');
});

test('blocks a rebuild while the frozen target is constructing', async () => {
  const snapshot = createSnapshot(SIM_DIR);
  const quarry = snapshot.state.buildings.find(building => building.name === 'Quarry');
  assert.equal(quarry.activity.type, 'construction');
  const runtime = new ShadowToolRuntime(snapshot);
  const result = await runtime.execute('rebuild', {
    buildingId: quarry.id,
    confirm: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.guard, true);
  assert.match(result.reason, /not authoritatively idle/u);
  assert.equal(runtime.actions.length, 0);
});

test('controlled Prospector scenario exercises preview, click, refresh, and counter evidence', async () => {
  const base = createSnapshot(SIM_DIR, new Date(), { replayAtStateTime: true });
  const snapshot = buildProspectorReadyScenario(base);
  const runtime = new ShadowToolRuntime(snapshot);
  const buildingId = snapshot.fixtures.rebuild.buildingId;
  const before = await runtime.execute('read_api', {
    path: snapshot.fixtures.prospector.path,
    pointer: '',
    offset: 0,
    limit: 100,
  });
  assert.equal(before.ok, true);
  assert.equal(before.data[0].current, snapshot.fixtures.rebuild.progressBefore);
  const preview = await runtime.execute('rebuild', { buildingId, confirm: false });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  const confirmed = await runtime.execute('rebuild', { buildingId, confirm: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.verified, true);
  assert.equal(confirmed.rebuiltBuildingId, snapshot.fixtures.rebuild.rebuiltBuildingId);
  const refreshed = await runtime.execute('refresh_state', {});
  assert.equal(refreshed.buildings.some(
    building => building.id === snapshot.fixtures.rebuild.rebuiltBuildingId
      && building.activity.type === 'construction',
  ), true);
  const after = await runtime.execute('read_api', {
    path: snapshot.fixtures.prospector.path,
    pointer: '/12',
    offset: 0,
    limit: 1,
  });
  assert.equal(after.data.current, snapshot.fixtures.rebuild.progressAfter);
});

test('does not fabricate building quotes or live exchange books', async () => {
  const snapshot = createSnapshot(SIM_DIR);
  const runtime = new ShadowToolRuntime(snapshot);
  const building = snapshot.state.buildings[0];
  const inspection = await runtime.execute('inspect_building', {
    buildingId: building.id,
    product: 'Coffee powder',
    qty: 100,
  });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.quote.status, 'UNKNOWN');
  const exchange = await runtime.execute('inspect_exchange_sale', { kind: 1, qty: null });
  assert.equal(exchange.ok, false);
  assert.equal(exchange.failClosed, true);
  assert.equal(exchange.uiQuote.mutationAttempted, false);
});

test('preserves reasoning_content across tool-call turns', () => {
  const message = assistantMessageForHistory({
    content: '',
    reasoning_content: 'reasoning that DeepSeek requires on the next request',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'refresh_state', arguments: '{}' } }],
  });
  assert.equal(message.reasoning_content, 'reasoning that DeepSeek requires on the next request');
  assert.equal(message.tool_calls[0].id, 'call_1');
});

test('DeepSeek thinking request omits unsupported routing controls', () => {
  const request = buildRequest({
    messages: [{ role: 'user', content: 'test' }],
    tools: [],
    effort: 'high',
  });
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(request, 'tool_choice'), false);
  assert.equal(Object.hasOwn(request, 'service_tier'), false);
  assert.equal(Object.hasOwn(request, 'temperature'), false);
});

test('DeepSeek request sends the documented maximum reasoning effort', () => {
  const request = buildRequest({
    messages: [{ role: 'user', content: 'test' }],
    tools: [],
    effort: 'max',
  });
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.reasoning_effort, 'max');
});

test('OpenAI request uses Responses high reasoning without priority routing', () => {
  const request = initialRequest({
    instructions: 'system',
    input: [{ role: 'user', content: 'test' }],
    tools: [],
    effort: 'high',
    maxTokens: 32768,
  });
  assert.deepEqual(request.reasoning, { effort: 'high' });
  assert.deepEqual(request.text, { verbosity: 'low' });
  assert.equal(request.max_output_tokens, 32768);
  assert.equal(request.service_tier, 'default');
  assert.equal(request.parallel_tool_calls, false);
});

test('OpenAI cost estimate reports an interval when cache-write allocation is absent', () => {
  const result = estimateOpenAICost({
    input_tokens: 1000,
    output_tokens: 200,
    input_tokens_details: { cached_tokens: 600 },
  });
  assert.equal(result.promptTokens, 1000);
  assert.equal(result.cacheHitTokens, 600);
  assert.equal(result.estimatedUsd, null);
  assert.ok(result.maxUsd >= result.minUsd);
});

test('report formatting tolerates a provider failure with no usage object', () => {
  assert.equal(costText(null), 'UNKNOWN');
});

test('a provider failure before any tool call receives no capability points', () => {
  const snapshot = buildProspectorReadyScenario(
    createSnapshot(SIM_DIR, new Date(), { replayAtStateTime: true }),
  );
  const score = scoreShadowResult(snapshot, {
    ok: false,
    rounds: 0,
    transcript: [],
    runtime: {
      actions: [],
      alarm: null,
      journal: null,
      journalEntry: null,
      master: null,
      finished: false,
      finishSummary: null,
    },
  });
  assert.equal(score.total, 0);
});

test('cost estimate separates cache hits, cache misses, and output', () => {
  const result = estimateCost({
    prompt_tokens: 1000,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400,
    completion_tokens: 200,
  });
  assert.equal(result.cacheHitTokens, 600);
  assert.equal(result.cacheMissTokens, 400);
  assert.equal(result.outputTokens, 200);
  assert.ok(result.estimatedUsd > 0);
});

test('secret redaction never returns an API key', () => {
  const secret = `sk-${'x'.repeat(32)}`;
  const redacted = redactSecrets(`request failed for ${secret}`);
  assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /REDACTED/u);
});

test('a mocked model completes a full shadow close without active writes', async () => {
  const snapshot = createSnapshot(SIM_DIR, new Date());
  const before = fs.statSync(path.join(SIM_DIR, 'autopilot', 'CURRENT.json')).mtimeMs;
  const state = snapshot.state;
  const atIso = new Date(Date.parse(snapshot.capturedAt) + 10 * 60e3).toISOString();
  const responses = [
    ['refresh_state', {}],
    ['set_alarm', { atIso, reason: 'shadow checkpoint' }],
    ['journal', {
      observed: 'Frozen state reviewed.',
      decision: 'No live mutation was made.',
      opportunity: 'Measure the next idle window.',
      alternatives: ['Retain the baseline.', 'Run a bounded pilot.'],
      reasons: ['Live browser evidence is intentionally unavailable.'],
      deferred: ['Capex awaits fresh UI evidence.'],
      warehouseAssessment: 'Every captured stock entry was reviewed as retained input or evidenced defer.',
      longTerm: 'Coffee remains the baseline; Tools remains the benchmark; use the free slot only after measured economics.',
    }],
    ['master', {
      text: 'Shadow wake completed without a live mutation.',
      current: {
        stateAsOf: state.t,
        cash: state.money,
        debtPrincipal: state.bonds?.principalOutstanding ?? null,
        slots: {
          capacity: state.slotCapacity,
          used: state.usedSlots,
          free: state.freeSlots,
        },
        done: ['Shadow state reviewed.'],
        blockers: ['Live browser evidence intentionally unavailable.'],
        plan: ['Run a real wake only after explicit model switch approval.'],
        reviews: {
          warehouse: 'All captured stock reviewed.',
          upgradeAndDebt: 'No live financing action.',
          utilitySurplus: 'Frozen reserve evidence only.',
          longTerm: 'Coffee baseline versus Tools benchmark remains open.',
        },
        nextDecisionAt: atIso,
      },
    }],
    ['finish', { summary: 'Shadow evaluation complete.' }],
  ];
  let call = 0;
  const result = await runShadowWake({
    snapshot,
    maxRounds: 10,
    complete: async messages => {
      if (call > 0) {
        const priorAssistant = messages.findLast(message => message.role === 'assistant');
        assert.equal(priorAssistant.reasoning_content, `reasoning-${call}`);
      }
      const [name, args] = responses[call];
      call += 1;
      return {
        id: `response-${call}`,
        model: 'deepseek-v4-pro',
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: `reasoning-${call}`,
          tool_calls: [{
            id: `call-${call}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        usage: {},
        cost: {},
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.runtime.finished, true);
  assert.equal(result.runtime.actions.length, 0);
  assert.equal(fs.statSync(path.join(SIM_DIR, 'autopilot', 'CURRENT.json')).mtimeMs, before);
  assert.match(SHADOW_APPENDIX, /never click or alter live state/u);
  const score = scoreShadowResult(snapshot, result);
  assert.equal(score.maximum, 100);
  assert.ok(score.total > 50);
});

test('a mocked OpenAI Responses model uses the same runtime and completes', async () => {
  const snapshot = createSnapshot(SIM_DIR, new Date());
  const state = snapshot.state;
  const atIso = new Date(Date.parse(snapshot.capturedAt) + 10 * 60e3).toISOString();
  const calls = [
    ['refresh_state', {}],
    ['set_alarm', { atIso, reason: 'shadow checkpoint' }],
    ['journal', {
      observed: 'Frozen state reviewed.',
      decision: 'No live mutation was made.',
      opportunity: 'Measure Farm contribution before allocating the free slot.',
      alternatives: ['Keep Coffee as the baseline.', 'Measure Tools before expansion.'],
      reasons: ['The game browser is intentionally unavailable.'],
      deferred: ['Wait for authoritative evidence.'],
      warehouseAssessment: 'Power, water, transport, seeds, coffee beans, and coffee ground were reviewed and retained for their current roles.',
      longTerm: 'Coffee remains the baseline, Tools remains the benchmark, the free slot preserves option value, and the next trigger is fresh contribution evidence.',
    }],
    ['master', {
      text: 'Shadow wake completed without a live mutation.',
      current: {
        stateAsOf: state.t,
        cash: state.money,
        debtPrincipal: state.bonds?.principalOutstanding ?? null,
        slots: {
          capacity: state.slotCapacity,
          used: state.usedSlots,
          free: state.freeSlots,
        },
        done: ['Shadow state reviewed.'],
        blockers: ['Live browser evidence intentionally unavailable.'],
        plan: ['Retry at the scheduled checkpoint.'],
        reviews: {
          warehouse: 'All captured stock reviewed.',
          upgradeAndDebt: 'No new financing or upgrade.',
          utilitySurplus: 'No verified sellable surplus.',
          longTerm: 'Coffee baseline versus Tools benchmark remains open with one free slot.',
        },
        nextDecisionAt: atIso,
      },
    }],
    ['finish', { summary: 'Shadow evaluation complete.' }],
  ];
  let index = 0;
  const response = () => {
    const [name, args] = calls[index];
    index += 1;
    return {
      id: `resp-${index}`,
      model: 'gpt-5.6-terra',
      status: 'completed',
      serviceTier: 'default',
      output: [{
        type: 'function_call',
        call_id: `call-${index}`,
        name,
        arguments: JSON.stringify(args),
      }],
      usage: {},
      cost: {},
      durationMs: 1,
    };
  };
  const client = {
    start: async () => response(),
    continue: async () => response(),
  };
  const result = await runOpenAIShadowWake({
    snapshot,
    client,
    maxRounds: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 5);
  assert.equal(result.runtime.finished, true);
  assert.equal(result.runtime.actions.length, 0);
});

test('both providers receive identical semantic tool names', () => {
  const snapshot = createSnapshot(SIM_DIR);
  const result = parity(snapshot, { SIM_CHAT_MODE: 'shadow' });
  assert.equal(result.ok, true);
  assert.equal(result.deepseek.count, result.terra.count);
  assert.deepEqual(
    buildDeepSeekTools({ SIM_CHAT_MODE: 'shadow' }).map(tool => tool.function.name),
    buildOpenAIResponsesTools({ SIM_CHAT_MODE: 'shadow' }).map(tool => tool.name),
  );
});

test('benchmark arguments keep both models at high effort', () => {
  const options = parseArguments(['--run', '--max-rounds', '20']);
  assert.equal(options.mode, 'run');
  assert.equal(options.effort, 'high');
  assert.equal(options.openaiModel, 'gpt-5.6-terra');
  assert.equal(options.deepseekModel, 'deepseek-v4-pro');
});

test('shadow sources contain no game executor imports', () => {
  const files = [
    path.join(__dirname, '..', 'benchmark.js'),
    path.join(__dirname, '..', 'shadow-wake.js'),
    path.join(__dirname, '..', 'lib', 'client.js'),
    path.join(__dirname, '..', 'lib', 'openai-client.js'),
    path.join(__dirname, '..', 'lib', 'runner.js'),
    path.join(__dirname, '..', 'lib', 'snapshot.js'),
    path.join(__dirname, '..', 'lib', 'tool-runtime.js'),
  ];
  const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const forbidden = [
    /require\([^)]*['"][^'"]*\/(?:act|state|cdp)\.js['"]/u,
    /\bexecFileSync\s*\(/u,
    /\bspawnSync\s*\(/u,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `forbidden executor reference: ${pattern}`);
  }
});
