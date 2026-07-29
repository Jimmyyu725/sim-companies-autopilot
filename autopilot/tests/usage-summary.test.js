'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  appendSummary,
  formatDiarySummary,
  normalizeUsageRow,
  partitionWakeRows,
  readUsageSlice,
  summarizeUsage,
} = require('../usage-summary.js');

test('normalizes Responses and Chat Completions token fields', () => {
  const response = normalizeUsageRow({
    billing_model: 'gpt-5.6-terra',
    input_tokens: 100,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 },
  });
  assert.equal(response.input, 100);
  assert.equal(response.output, 10);
  assert.equal(response.cached, 40);
  assert.equal(response.cacheWrite, 20);

  const chat = normalizeUsageRow({
    billing_model: 'gpt-5.6-luna',
    prompt_tokens: 90,
    completion_tokens: 9,
    prompt_tokens_details: { cached_tokens: 30 },
  });
  assert.equal(chat.input, 90);
  assert.equal(chat.output, 9);
  assert.equal(chat.cached, 30);
  assert.equal(chat.cacheWrite, null);
});

test('computes exact mixed-model cost when cache allocation is reported', () => {
  const summary = summarizeUsage([
    {
      billing_model: 'gpt-5.6-terra',
      service_tier: 'default',
      prompt_tokens: 1000,
      completion_tokens: 100,
      cached: 400,
      cache_write: 100,
    },
    {
      model: 'council',
      billing_model: 'gpt-5.6-luna',
      service_tier: 'default',
      role: 'CFO',
      prompt_tokens: 500,
      completion_tokens: 50,
      cached: 200,
      cache_write: 0,
    },
  ], { wakeId: 'wake-test', brainRc: 0 });

  assert.equal(summary.calls.total, 2);
  assert.equal(summary.calls.brain, 1);
  assert.equal(summary.calls.council, 1);
  assert.equal(summary.tokens.input, 1500);
  assert.equal(summary.tokens.output, 150);
  assert.equal(summary.cost_usd.status, 'exact');
  assert.equal(summary.cost_usd.min, 0.0037825);
  assert.equal(summary.cost_usd.max, 0.0037825);
});

test('computes an honest cost interval when cache-write tokens are missing', () => {
  const summary = summarizeUsage([{
    billing_model: 'gpt-5.6-terra',
    service_tier: 'default',
    prompt_tokens: 1000,
    completion_tokens: 100,
    cached: 400,
    cache_write: null,
  }]);

  assert.equal(summary.tokens.cache_write.min, 0);
  assert.equal(summary.tokens.cache_write.max, 600);
  assert.equal(summary.cost_usd.status, 'interval');
  assert.equal(summary.cost_usd.min, 0.0031);
  assert.equal(summary.cost_usd.max, 0.003475);
  assert.match(formatDiarySummary(summary), /\$0\.0031–\$0\.0035/);
});

test('does not combine incompatible unknown cached and write maxima into cost', () => {
  const summary = summarizeUsage([{
    billing_model: 'gpt-5.6-luna',
    service_tier: 'default',
    prompt_tokens: 1000,
    completion_tokens: 0,
    cached: null,
    cache_write: null,
  }]);

  assert.deepEqual(summary.tokens.cached, { min: 0, max: 1000, status: 'interval' });
  assert.deepEqual(summary.tokens.cache_write, { min: 0, max: 1000, status: 'interval' });
  assert.equal(summary.cost_usd.min, 0.0001);
  assert.equal(summary.cost_usd.max, 0.00125);
});

test('marks unknown models as unpriced instead of treating them as free', () => {
  const summary = summarizeUsage([{
    billing_model: 'unknown-model',
    service_tier: 'default',
    prompt_tokens: 100,
    completion_tokens: 10,
    cached: 0,
    cache_write: 0,
  }]);
  assert.equal(summary.calls.unpriced, 1);
  assert.equal(summary.cost_usd.status, 'unknown-price');
  assert.equal(summary.cost_usd.min, null);
  assert.equal(summary.cost_usd.max, null);
});

test('marks impossible cache allocation as partial rather than priced', () => {
  const summary = summarizeUsage([{
    billing_model: 'gpt-5.6-terra',
    service_tier: 'default',
    prompt_tokens: 100,
    completion_tokens: 10,
    cached: 80,
    cache_write: 30,
  }]);
  assert.equal(summary.calls.invalid, 1);
  assert.equal(summary.calls.unpriced, 0);
  assert.equal(summary.cost_usd.status, 'incomplete');
  assert.equal(summary.cost_usd.min, null);
});

test('marks a contradictory API total token count as partial', () => {
  const summary = summarizeUsage([{
    billing_model: 'gpt-5.6-terra',
    service_tier: 'default',
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 999,
    cached: 0,
    cache_write: 0,
  }], { brainRc: 0 });
  assert.equal(summary.calls.invalid, 1);
  assert.equal(summary.tokens.status, 'partial');
  assert.equal(summary.cost_usd.status, 'incomplete');
  assert.equal(summary.cost_usd.min, null);
});

test('does not assume standard pricing when service tier is missing', () => {
  const summary = summarizeUsage([{
    billing_model: 'gpt-5.6-terra',
    prompt_tokens: 100,
    completion_tokens: 10,
    cached: 0,
    cache_write: 0,
  }], { brainRc: 0 });
  assert.equal(summary.calls.unpriced, 1);
  assert.equal(summary.cost_usd.status, 'unknown-price');
  assert.equal(summary.cost_usd.min, null);
});

test('nonzero brain exit reports only an observed subtotal, never exact zero', () => {
  const summary = summarizeUsage([], { brainRc: 124 });
  assert.equal(summary.tokens.status, 'partial');
  assert.equal(summary.cost_usd.status, 'incomplete');
  assert.equal(summary.cost_usd.min, null);
  assert.equal(summary.cost_usd.max, null);
  assert.equal(summary.cost_usd.known_priced_subtotal_min, 0);
});

test('reads from a byte offset rather than a character offset', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-usage-slice-'));
  const usagePath = path.join(directory, 'usage.jsonl');
  const first = `${JSON.stringify({ note: '中文' })}\n`;
  const second = `${JSON.stringify({ prompt_tokens: 1, completion_tokens: 1 })}\n`;
  fs.writeFileSync(usagePath, first + second);
  const slice = readUsageSlice(usagePath, Buffer.byteLength(first));
  assert.equal(slice.invalidLines, 0);
  assert.deepEqual(slice.rows, [{ prompt_tokens: 1, completion_tokens: 1 }]);
  const bounded = readUsageSlice(usagePath, 0, Buffer.byteLength(first));
  assert.deepEqual(bounded.rows, [{ note: '中文' }]);
});

test('partitions usage rows by exact wake id', () => {
  const partition = partitionWakeRows([
    { wake_id: 'wake-a', prompt_tokens: 1 },
    { wake_id: 'wake-b', prompt_tokens: 2 },
    { prompt_tokens: 3 },
  ], 'wake-a');
  assert.deepEqual(partition.wakeRows, [{ wake_id: 'wake-a', prompt_tokens: 1 }]);
  assert.equal(partition.foreignRows, 2);
});

test('appends diary and structured summary idempotently', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-usage-'));
  const diaryPath = path.join(directory, 'diary.md');
  const wakeUsagePath = path.join(directory, 'wake-usage.jsonl');
  const summary = summarizeUsage([], {
    wakeId: 'diary-test',
    startedAt: '2026-07-26T00:00:00Z',
    endedAt: '2026-07-26T00:00:01Z',
    brainRc: 1,
  });

  appendSummary({ summary, diaryPath, wakeUsagePath });
  appendSummary({ summary, diaryPath, wakeUsagePath });
  assert.equal((fs.readFileSync(diaryPath, 'utf8').match(/wake-usage:diary-test/g) || []).length, 1);
  assert.equal(fs.readFileSync(wakeUsagePath, 'utf8').trim().split('\n').length, 1);
});
