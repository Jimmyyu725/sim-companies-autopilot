'use strict';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const PRICES_PER_MILLION = Object.freeze({
  cacheHitInput: 0.003625,
  cacheMissInput: 0.435,
  output: 0.87,
});

function redactSecrets(value) {
  return String(value || '').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/u, '');
}

function buildRequest({ model = DEFAULT_MODEL, messages, tools, effort = 'high', maxTokens = 32768 }) {
  if (!['high', 'max'].includes(effort)) throw new Error('effort must be high or max');
  return {
    model,
    messages,
    tools,
    thinking: { type: 'enabled' },
    reasoning_effort: effort,
    max_tokens: maxTokens,
  };
}

function estimateCost(usage = {}) {
  const prompt = Number(usage.prompt_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  const hit = Math.max(0, Number(
    usage.prompt_cache_hit_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? 0,
  ) || 0);
  const explicitMiss = usage.prompt_cache_miss_tokens;
  const miss = Math.max(0, Number.isFinite(Number(explicitMiss))
    ? Number(explicitMiss)
    : prompt - hit);
  const costUsd = (
    hit * PRICES_PER_MILLION.cacheHitInput
      + miss * PRICES_PER_MILLION.cacheMissInput
      + output * PRICES_PER_MILLION.output
  ) / 1_000_000;
  return {
    promptTokens: prompt,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    outputTokens: output,
    estimatedUsd: Number(costUsd.toFixed(8)),
    minUsd: Number(costUsd.toFixed(8)),
    maxUsd: Number(costUsd.toFixed(8)),
    pricing: { ...PRICES_PER_MILLION },
  };
}

class DeepSeekClient {
  constructor({
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    effort = 'high',
    maxTokens = 32768,
    timeoutMs = 600000,
    fetchImpl = globalThis.fetch,
  }) {
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for --live');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model;
    this.effort = effort;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async complete(messages, tools) {
    const started = Date.now();
    const request = buildRequest({
      model: this.model,
      messages,
      tools,
      effort: this.effort,
      maxTokens: this.maxTokens,
    });
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`DeepSeek request failed: ${redactSecrets(error.message || error)}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`DeepSeek returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || payload?.error) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`DeepSeek API error: ${redactSecrets(detail)}`);
    }
    const message = payload?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') {
      throw new Error('DeepSeek response did not contain choices[0].message');
    }
    return {
      id: payload.id || null,
      model: payload.model || this.model,
      finishReason: payload?.choices?.[0]?.finish_reason || null,
      message,
      usage: payload.usage || {},
      cost: estimateCost(payload.usage || {}),
      durationMs: Date.now() - started,
    };
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DeepSeekClient,
  PRICES_PER_MILLION,
  buildRequest,
  estimateCost,
  normalizeBaseUrl,
  redactSecrets,
};
