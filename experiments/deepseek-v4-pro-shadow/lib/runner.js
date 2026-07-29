'use strict';

const { buildWakeMessage } = require('./snapshot.js');
const {
  ShadowToolRuntime,
  buildDeepSeekTools,
  buildOpenAIResponsesTools,
} = require('./tool-runtime.js');

const SHADOW_APPENDIX = `

## Shadow-evaluation boundary

This wake evaluates your decisions without touching the game. The business prompt, current
memory, owner directive, state snapshot, and tool parameters are real copies. Browser/API reads
outside that snapshot are intentionally UNKNOWN. Mutation tools validate the exact parameters and
return a simulated receipt, but never click or alter live state. Treat a successful simulated
receipt as the verified outcome for this evaluation and do not repeat it merely because the frozen
core state does not change. Continue through the normal close sequence. Clearly distinguish
snapshot facts from unmeasured live evidence.
`.trimEnd();

function assistantMessageForHistory(message) {
  const result = {
    role: 'assistant',
    content: message.content ?? null,
  };
  if (Object.hasOwn(message, 'reasoning_content')) {
    result.reasoning_content = message.reasoning_content ?? null;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    result.tool_calls = message.tool_calls;
  }
  return result;
}

function parseToolArguments(toolCall) {
  try {
    const parsed = JSON.parse(toolCall?.function?.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function aggregateUsage(calls) {
  return calls.reduce((total, call) => ({
    promptTokens: total.promptTokens + (call.cost?.promptTokens || 0),
    cacheHitTokens: total.cacheHitTokens + (call.cost?.cacheHitTokens || 0),
    cacheMissTokens: total.cacheMissTokens + (call.cost?.cacheMissTokens || 0),
    outputTokens: total.outputTokens + (call.cost?.outputTokens || 0),
    cacheWriteTokens: total.cacheWriteTokens + (call.cost?.cacheWriteTokens || 0),
    minUsd: call.cost?.minUsd == null || total.minUsd == null
      ? null
      : Number((total.minUsd + call.cost.minUsd).toFixed(8)),
    maxUsd: call.cost?.maxUsd == null || total.maxUsd == null
      ? null
      : Number((total.maxUsd + call.cost.maxUsd).toFixed(8)),
    estimatedUsd: call.cost?.estimatedUsd == null || total.estimatedUsd == null
      ? null
      : Number((total.estimatedUsd + call.cost.estimatedUsd).toFixed(8)),
    durationMs: total.durationMs + (call.durationMs || 0),
  }), {
    promptTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    minUsd: 0,
    maxUsd: 0,
    estimatedUsd: 0,
    durationMs: 0,
  });
}

function responsesText(output) {
  return (output || [])
    .filter(item => item?.type === 'message')
    .flatMap(item => item.content || [])
    .map(content => content?.text || '')
    .filter(Boolean)
    .join('\n');
}

function responsesReasoningSummary(output) {
  return (output || [])
    .filter(item => item?.type === 'reasoning')
    .flatMap(item => item.summary || [])
    .map(summary => summary?.text || '')
    .filter(Boolean)
    .join('\n');
}

function responsesCalls(output) {
  return (output || []).filter(item => item?.type === 'function_call');
}

async function runShadowWake({
  snapshot,
  complete,
  environment = process.env,
  maxRounds = 30,
  onEvent = () => {},
}) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot is required');
  if (typeof complete !== 'function') throw new Error('complete must be a function');
  const tools = buildDeepSeekTools(environment);
  const runtime = new ShadowToolRuntime(snapshot);
  const messages = [
    { role: 'system', content: `${snapshot.systemPrompt}\n\n${SHADOW_APPENDIX}` },
    { role: 'user', content: buildWakeMessage(snapshot) },
  ];
  const transcript = [];
  const usageCalls = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const response = await complete(messages, tools);
    usageCalls.push({
      round,
      id: response.id || null,
      model: response.model || null,
      finishReason: response.finishReason || null,
      usage: response.usage || {},
      cost: response.cost || {},
      durationMs: response.durationMs || null,
    });
    const assistant = assistantMessageForHistory(response.message || {});
    messages.push(assistant);
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    transcript.push({
      type: 'assistant',
      round,
      content: assistant.content,
      reasoningCharacters: String(assistant.reasoning_content || '').length,
      toolCalls,
      finishReason: response.finishReason || null,
    });
    onEvent({
      type: 'assistant',
      round,
      toolNames: toolCalls.map(call => call?.function?.name || '(unknown)'),
      reasoningCharacters: String(assistant.reasoning_content || '').length,
      contentCharacters: String(assistant.content || '').length,
    });

    if (!toolCalls.length) {
      messages.push({
        role: 'user',
        content: 'Use the tools now. If the shadow wake is complete, follow refresh_state → set_alarm → journal → master → finish.',
      });
      continue;
    }

    for (const toolCall of toolCalls) {
      const name = String(toolCall?.function?.name || '');
      const args = parseToolArguments(toolCall);
      const result = await runtime.execute(name, args);
      transcript.push({
        type: 'tool',
        round,
        toolCallId: toolCall?.id || null,
        name,
        arguments: args,
        result,
      });
      onEvent({
        type: 'tool',
        round,
        name,
        ok: result?.ok === true || (
          name === 'refresh_state'
            && result?.guard !== true
            && typeof result?.t === 'string'
        ),
        result,
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall?.id,
        content: JSON.stringify(result),
      });
      if (runtime.finished) break;
    }
    if (runtime.finished) {
      return {
        ok: true,
        rounds: round,
        tools,
        transcript,
        runtime,
        usageCalls,
        usageTotal: aggregateUsage(usageCalls),
      };
    }
  }

  return {
    ok: false,
    rounds: maxRounds,
    reason: `shadow tool loop exhausted ${maxRounds} rounds without a successful finish`,
    tools,
    transcript,
    runtime,
    usageCalls,
    usageTotal: aggregateUsage(usageCalls),
  };
}

async function runOpenAIShadowWake({
  snapshot,
  client,
  environment = process.env,
  maxRounds = 30,
  onEvent = () => {},
}) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot is required');
  if (!client || typeof client.start !== 'function' || typeof client.continue !== 'function') {
    throw new Error('an OpenAI Responses client is required');
  }
  const tools = buildOpenAIResponsesTools(environment);
  const runtime = new ShadowToolRuntime(snapshot);
  const instructions = `${snapshot.systemPrompt}\n\n${SHADOW_APPENDIX}`;
  const initialInput = [{
    role: 'user',
    content: buildWakeMessage(snapshot),
  }];
  const transcript = [];
  const usageCalls = [];
  let response = await client.start({ instructions, input: initialInput, tools });

  for (let round = 1; round <= maxRounds; round += 1) {
    const calls = responsesCalls(response.output);
    const content = responsesText(response.output);
    const reasoningSummary = responsesReasoningSummary(response.output);
    usageCalls.push({
      round,
      id: response.id || null,
      model: response.model || null,
      status: response.status || null,
      serviceTier: response.serviceTier || null,
      usage: response.usage || {},
      cost: response.cost || {},
      durationMs: response.durationMs || null,
    });
    transcript.push({
      type: 'assistant',
      round,
      content,
      reasoningSummary,
      toolCalls: calls,
      status: response.status || null,
    });
    onEvent({
      type: 'assistant',
      round,
      toolNames: calls.map(call => call.name || '(unknown)'),
      reasoningCharacters: reasoningSummary.length,
      contentCharacters: content.length,
    });

    const outputs = [];
    for (const call of calls) {
      let args = {};
      try {
        const parsed = JSON.parse(call.arguments || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      } catch (_) {
        // The shared runtime returns the same validation guard as production.
      }
      const result = await runtime.execute(String(call.name || ''), args);
      transcript.push({
        type: 'tool',
        round,
        toolCallId: call.call_id || null,
        name: String(call.name || ''),
        arguments: args,
        result,
      });
      onEvent({
        type: 'tool',
        round,
        name: String(call.name || ''),
        ok: result?.ok === true || (
          call.name === 'refresh_state'
            && result?.guard !== true
            && typeof result?.t === 'string'
        ),
        result,
      });
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
      if (runtime.finished) break;
    }
    if (runtime.finished) {
      return {
        ok: true,
        rounds: round,
        tools,
        transcript,
        runtime,
        usageCalls,
        usageTotal: aggregateUsage(usageCalls),
      };
    }
    const nextInput = outputs.length
      ? outputs
      : [{
          role: 'user',
          content: 'Use the tools now. If the shadow wake is complete, follow refresh_state → set_alarm → journal → master → finish.',
        }];
    response = await client.continue({
      previousResponseId: response.id,
      instructions,
      input: nextInput,
      tools,
    });
  }

  return {
    ok: false,
    rounds: maxRounds,
    reason: `shadow Responses tool loop exhausted ${maxRounds} rounds without a successful finish`,
    tools,
    transcript,
    runtime,
    usageCalls,
    usageTotal: aggregateUsage(usageCalls),
  };
}

module.exports = {
  SHADOW_APPENDIX,
  aggregateUsage,
  assistantMessageForHistory,
  parseToolArguments,
  responsesCalls,
  responsesReasoningSummary,
  responsesText,
  runOpenAIShadowWake,
  runShadowWake,
};
