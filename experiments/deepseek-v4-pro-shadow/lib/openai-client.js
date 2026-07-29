'use strict';

const DEFAULT_MODEL = 'gpt-5.6-terra';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const SHORT_CONTEXT_LIMIT = 272000;
const PRICES_PER_MILLION = Object.freeze({
  short: Object.freeze({
    input: 2.5,
    cached: 0.25,
    cacheWrite: 3.125,
    output: 15,
  }),
  long: Object.freeze({
    input: 5,
    cached: 0.5,
    cacheWrite: 6.25,
    output: 22.5,
  }),
});

function redactSecrets(value) {
  return String(value || '').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/u, '');
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function estimateOpenAICost(usage = {}, serviceTier = 'default') {
  const input = nonNegativeInteger(usage.input_tokens) ?? 0;
  const output = nonNegativeInteger(usage.output_tokens) ?? 0;
  const details = usage.input_tokens_details || {};
  const cached = nonNegativeInteger(details.cached_tokens);
  const cacheWrite = nonNegativeInteger(details.cache_write_tokens);
  const prices = input > SHORT_CONTEXT_LIMIT
    ? PRICES_PER_MILLION.long
    : PRICES_PER_MILLION.short;
  if (!['default', 'standard'].includes(String(serviceTier || ''))) {
    return {
      promptTokens: input,
      cacheHitTokens: cached,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      minUsd: null,
      maxUsd: null,
      estimatedUsd: null,
      status: 'unknown-service-tier',
      serviceTier: serviceTier || null,
    };
  }
  const allocations = [];
  if (cached !== null && cacheWrite !== null && cached + cacheWrite <= input) {
    allocations.push([cached, cacheWrite]);
  } else if (cached !== null && cached <= input) {
    allocations.push([cached, 0], [cached, input - cached]);
  } else if (cacheWrite !== null && cacheWrite <= input) {
    allocations.push([0, cacheWrite], [input - cacheWrite, cacheWrite]);
  } else {
    allocations.push([0, 0], [input, 0], [0, input]);
  }
  const costs = allocations.map(([hit, write]) => (
    (input - hit - write) * prices.input
      + hit * prices.cached
      + write * prices.cacheWrite
      + output * prices.output
  ) / 1_000_000);
  const minUsd = Number(Math.min(...costs).toFixed(8));
  const maxUsd = Number(Math.max(...costs).toFixed(8));
  return {
    promptTokens: input,
    cacheHitTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    minUsd,
    maxUsd,
    estimatedUsd: minUsd === maxUsd ? minUsd : null,
    status: minUsd === maxUsd ? 'exact' : 'interval',
    serviceTier,
    contextBand: input > SHORT_CONTEXT_LIMIT ? 'long' : 'short',
    pricing: prices,
  };
}

function initialRequest({
  model = DEFAULT_MODEL,
  instructions,
  input,
  tools,
  effort = 'high',
  verbosity = 'low',
  maxTokens = 32768,
}) {
  return {
    model,
    instructions,
    input,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort },
    text: { verbosity },
    max_output_tokens: maxTokens,
    service_tier: 'default',
  };
}

function chainedRequest({
  model = DEFAULT_MODEL,
  previousResponseId,
  instructions,
  input,
  tools,
  effort = 'high',
  verbosity = 'low',
  maxTokens = 32768,
}) {
  if (!previousResponseId) throw new Error('previousResponseId is required');
  return {
    ...initialRequest({ model, instructions, input, tools, effort, verbosity, maxTokens }),
    previous_response_id: previousResponseId,
  };
}

class OpenAIResponsesClient {
  constructor({
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    effort = 'high',
    verbosity = 'low',
    maxTokens = 32768,
    timeoutMs = 600000,
    fetchImpl = globalThis.fetch,
  }) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for the Terra benchmark');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model;
    this.effort = effort;
    this.verbosity = verbosity;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(body) {
    const started = Date.now();
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`OpenAI request failed: ${redactSecrets(error.message || error)}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      throw new Error(`OpenAI returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || payload?.error) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`OpenAI API error: ${redactSecrets(detail)}`);
    }
    if (!payload?.id || !Array.isArray(payload.output)) {
      throw new Error('OpenAI response did not contain an id and output array');
    }
    const cost = estimateOpenAICost(payload.usage || {}, payload.service_tier || 'default');
    return {
      id: payload.id,
      model: payload.model || this.model,
      status: payload.status || null,
      output: payload.output,
      usage: payload.usage || {},
      serviceTier: payload.service_tier || null,
      cost,
      durationMs: Date.now() - started,
    };
  }

  start({ instructions, input, tools }) {
    return this.request(initialRequest({
      model: this.model,
      instructions,
      input,
      tools,
      effort: this.effort,
      verbosity: this.verbosity,
      maxTokens: this.maxTokens,
    }));
  }

  continue({ previousResponseId, instructions, input, tools }) {
    return this.request(chainedRequest({
      model: this.model,
      previousResponseId,
      instructions,
      input,
      tools,
      effort: this.effort,
      verbosity: this.verbosity,
      maxTokens: this.maxTokens,
    }));
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  OpenAIResponsesClient,
  PRICES_PER_MILLION,
  SHORT_CONTEXT_LIMIT,
  chainedRequest,
  estimateOpenAICost,
  initialRequest,
  normalizeBaseUrl,
  redactSecrets,
};
