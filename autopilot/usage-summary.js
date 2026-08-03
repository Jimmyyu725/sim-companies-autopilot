'use strict';

const fs = require('fs');

const PRICING_AS_OF = '2026-07-29';
const PRICING_SOURCE = 'https://developers.openai.com/api/docs/models/compare';
const DEEPSEEK_PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
const PRICING_SOURCES = Object.freeze([
  PRICING_SOURCE,
  'https://developers.openai.com/api/docs/guides/latest-model',
  'https://openai.com/api-priority-processing/',
  DEEPSEEK_PRICING_SOURCE,
]);
const PRICES_PER_MILLION = Object.freeze({
  default: Object.freeze({
    'gpt-5.6-terra': Object.freeze({ input: 2.5, cached: 0.25, cacheWrite: 3.125, output: 15 }),
    'gpt-5.6-luna': Object.freeze({ input: 1, cached: 0.1, cacheWrite: 1.25, output: 6 }),
  }),
  priority: Object.freeze({
    'gpt-5.6-terra': Object.freeze({ input: 5, cached: 0.5, cacheWrite: 6.25, output: 30 }),
    'gpt-5.6-luna': Object.freeze({ input: 2, cached: 0.2, cacheWrite: 2.5, output: 12 }),
  }),
  deepseek: Object.freeze({
    'deepseek-v4-pro': Object.freeze({
      input: 0.435,
      cached: 0.003625,
      cacheWrite: 0.435,
      output: 0.87,
    }),
    // Flash is the owner's brain model as of 2026-08-02. It prices at roughly a third of Pro on
    // both input and output, and the cache-hit discount keeps the same ratio.
    'deepseek-v4-flash': Object.freeze({
      input: 0.14,
      cached: 0.0028,
      cacheWrite: 0.14,
      output: 0.28,
    }),
  }),
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstPresent(sources) {
  for (const [object, key] of sources) {
    if (hasOwn(object, key)) return { present: true, value: object[key] };
  }
  return { present: false, value: null };
}

function normalizeModel(model) {
  const value = String(model || '');
  for (const known of ['gpt-5.6-terra', 'gpt-5.6-luna', 'deepseek-v4-pro', 'deepseek-v4-flash']) {
    if (value === known || value.startsWith(`${known}-`)) return known;
  }
  return null;
}

function normalizeProvider(provider, model) {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'openai' || value === 'deepseek') return value;
  return String(model || '').startsWith('deepseek-') ? 'deepseek' : 'openai';
}

function normalizeTier(tier) {
  if (tier === undefined || tier === null || tier === '') return null;
  if (tier === 'default' || tier === 'standard') return 'default';
  return String(tier);
}

function normalizeUsageRow(row) {
  const inputDetails = row?.input_tokens_details || row?.prompt_tokens_details || {};
  const inputField = firstPresent([[row, 'input_tokens'], [row, 'prompt_tokens']]);
  const outputField = firstPresent([[row, 'output_tokens'], [row, 'completion_tokens']]);
  const cachedField = firstPresent([[row, 'cached'], [row, 'cached_tokens'], [inputDetails, 'cached_tokens']]);
  const writeField = firstPresent([[row, 'cache_write'], [row, 'cache_write_tokens'], [inputDetails, 'cache_write_tokens']]);
  const totalField = firstPresent([[row, 'total_tokens']]);
  const input = nonNegativeInteger(inputField.value);
  const output = nonNegativeInteger(outputField.value);
  const cached = nonNegativeInteger(cachedField.value);
  const cacheWrite = nonNegativeInteger(writeField.value);
  const total = nonNegativeInteger(totalField.value);
  const issues = [];

  if (input === null) issues.push('invalid-or-missing-input-tokens');
  if (output === null) issues.push('invalid-or-missing-output-tokens');
  if (cachedField.present && cachedField.value !== null && cached === null) issues.push('invalid-cached-tokens');
  if (writeField.present && writeField.value !== null && cacheWrite === null) issues.push('invalid-cache-write-tokens');
  if (totalField.present && totalField.value !== null && total === null) issues.push('invalid-total-tokens');
  if (total !== null && input !== null && output !== null && total !== input + output) issues.push('total-token-mismatch');
  if (input !== null && cached !== null && cached > input) issues.push('cached-exceeds-input');
  if (input !== null && cacheWrite !== null && cacheWrite > input) issues.push('cache-write-exceeds-input');
  if (input !== null && cached !== null && cacheWrite !== null && cached + cacheWrite > input) {
    issues.push('cached-plus-write-exceeds-input');
  }

  const model = String(row?.billing_model || (row?.model === 'council' ? '' : row?.model) || '');
  return {
    row,
    input,
    output,
    cached: cachedField.present && cached !== null ? cached : null,
    cacheWrite: writeField.present && cacheWrite !== null ? cacheWrite : null,
    total: totalField.present && total !== null ? total : null,
    model,
    provider: normalizeProvider(row?.billing_provider, model),
    role: row?.role ? String(row.role) : null,
    tier: normalizeTier(row?.service_tier),
    issues,
  };
}

function tokenBounds(call) {
  if (call.input === null || call.output === null || call.issues.length) return null;
  const input = call.input;
  const cachedBounds = call.cached === null
    ? [0, input - (call.cacheWrite ?? 0)]
    : [call.cached, call.cached];
  const writeBounds = call.cacheWrite === null
    ? [0, input - (call.cached ?? 0)]
    : [call.cacheWrite, call.cacheWrite];
  return { cachedBounds, writeBounds };
}

function costBounds(call) {
  const bounds = tokenBounds(call);
  const model = normalizeModel(call.model);
  const prices = call.provider === 'deepseek'
    ? PRICES_PER_MILLION.deepseek?.[model]
    : PRICES_PER_MILLION[call.tier]?.[model];
  if (!bounds || !prices) return null;
  // Above 272K input, GPT-5.6 has a separate long-context surcharge. Refuse to guess how it
  // allocates to cache reads/writes; routine Sim calls are far below this threshold.
  if (call.provider === 'openai' && call.input > 272000) return null;

  const candidates = [];
  if (call.cached !== null && call.cacheWrite !== null) {
    candidates.push([call.cached, call.cacheWrite]);
  } else if (call.cached !== null) {
    candidates.push([call.cached, 0], [call.cached, call.input - call.cached]);
  } else if (call.cacheWrite !== null) {
    candidates.push([0, call.cacheWrite], [call.input - call.cacheWrite, call.cacheWrite]);
  } else {
    candidates.push([0, 0], [call.input, 0], [0, call.input]);
  }

  const costs = candidates.map(([cached, write]) => {
    const ordinary = call.input - cached - write;
    return (
      ordinary * prices.input
      + cached * prices.cached
      + write * prices.cacheWrite
      + call.output * prices.output
    ) / 1_000_000;
  });
  return { min: Math.min(...costs), max: Math.max(...costs) };
}

function summarizeUsage(rows, meta = {}) {
  const calls = rows.map(normalizeUsageRow);
  let input = 0;
  let output = 0;
  let cachedMin = 0;
  let cachedMax = 0;
  let writeMin = 0;
  let writeMax = 0;
  let costMin = 0;
  let costMax = 0;
  let brainCalls = 0;
  let councilCalls = 0;
  let invalidCalls = Number(meta.invalidLines || 0);
  const foreignCalls = Number(meta.foreignRows || 0);
  let unpricedCalls = 0;
  const byModel = {};

  for (const call of calls) {
    if (call.role || call.row?.model === 'council') councilCalls += 1;
    else brainCalls += 1;
    if (call.input !== null) input += call.input;
    if (call.output !== null) output += call.output;
    const bounds = tokenBounds(call);
    if (!bounds) {
      invalidCalls += 1;
    } else {
      cachedMin += bounds.cachedBounds[0];
      cachedMax += bounds.cachedBounds[1];
      writeMin += bounds.writeBounds[0];
      writeMax += bounds.writeBounds[1];
    }

    if (bounds) {
      const price = costBounds(call);
      if (!price) unpricedCalls += 1;
      else {
        costMin += price.min;
        costMax += price.max;
      }
    }

    const model = call.model || 'unknown';
    byModel[model] ||= { calls: 0, input: 0, output: 0 };
    byModel[model].calls += 1;
    if (call.input !== null) byModel[model].input += call.input;
    if (call.output !== null) byModel[model].output += call.output;
  }

  let cachedStatus = calls.length > 0 && calls.every(call => call.cached !== null && !call.issues.length)
    ? 'reported'
    : (cachedMin === cachedMax ? 'unreported' : 'interval');
  let writeStatus = calls.length > 0 && calls.every(call => call.cacheWrite !== null && !call.issues.length)
    ? 'reported'
    : (writeMin === writeMax ? 'unreported' : 'interval');
  const rcIncomplete = Number.isInteger(meta.brainRc) && meta.brainRc !== 0;
  const incomplete = invalidCalls > 0 || foreignCalls > 0 || rcIncomplete;
  if (incomplete) {
    cachedStatus = 'partial';
    writeStatus = 'partial';
  }
  let costStatus = Math.abs(costMax - costMin) < 1e-12 ? 'exact' : 'interval';
  if (unpricedCalls > 0) costStatus = 'unknown-price';
  else if (incomplete) costStatus = 'incomplete';
  const hasTotalCost = costStatus === 'exact' || costStatus === 'interval';

  const startedAt = meta.startedAt || null;
  const endedAt = meta.endedAt || new Date().toISOString();
  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const endMs = new Date(endedAt).getTime();

  return {
    schema_version: 1,
    record_type: 'wake_usage_summary',
    wake_id: meta.wakeId || null,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, Math.round((endMs - startMs) / 1000))
      : null,
    brain_rc: Number.isInteger(meta.brainRc) ? meta.brainRc : null,
    calls: {
      total: calls.length,
      brain: brainCalls,
      council: councilCalls,
      invalid: invalidCalls,
      foreign: foreignCalls,
      unpriced: unpricedCalls,
    },
    tokens: {
      input,
      output,
      total: input + output,
      status: incomplete ? 'partial' : 'reported',
      cached: { min: cachedMin, max: cachedMax, status: cachedStatus },
      cache_write: { min: writeMin, max: writeMax, status: writeStatus },
      joint_constraint: 'For each call, cached + cache_write <= input.',
    },
    cost_usd: {
      min: hasTotalCost ? Number(costMin.toFixed(8)) : null,
      max: hasTotalCost ? Number(costMax.toFixed(8)) : null,
      status: costStatus,
      known_priced_subtotal_min: Number(costMin.toFixed(8)),
      known_priced_subtotal_max: Number(costMax.toFixed(8)),
      pricing_as_of: PRICING_AS_OF,
      pricing_source: PRICING_SOURCE,
      pricing_sources: PRICING_SOURCES,
    },
    models: byModel,
  };
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatRange(range) {
  return range.min === range.max
    ? formatInteger(range.min)
    : `${formatInteger(range.min)}–${formatInteger(range.max)}`;
}

function formatCost(cost) {
  if (cost.min === null || cost.max === null) {
    const subtotalMin = `$${cost.known_priced_subtotal_min.toFixed(4)}`;
    const subtotalMax = `$${cost.known_priced_subtotal_max.toFixed(4)}`;
    const subtotal = cost.known_priced_subtotal_min === cost.known_priced_subtotal_max
      ? subtotalMin
      : `${subtotalMin}–${subtotalMax}`;
    return `${cost.status}; observed priced subtotal ${subtotal}`;
  }
  const min = `$${cost.min.toFixed(4)}`;
  const max = `$${cost.max.toFixed(4)}`;
  if (cost.status === 'exact' && cost.min === cost.max) return min;
  return `${min}–${max}`;
}

function formatDiarySummary(summary) {
  const cacheNote = summary.tokens.cached.status === 'reported' ? 'reported' : 'not fully reported';
  const writeNote = summary.tokens.cache_write.status === 'reported' ? 'reported' : 'not fully reported';
  const tokenLabel = summary.tokens.status === 'reported' ? 'Tokens' : 'Observed tokens';
  return [
    `<!-- wake-usage:${summary.wake_id} -->`,
    '## Token usage and estimated API list-price cost',
    `- Calls: ${summary.calls.total} (brain ${summary.calls.brain}, council ${summary.calls.council}; invalid ${summary.calls.invalid}; foreign ${summary.calls.foreign}).`,
    `- ${tokenLabel}: input ${formatInteger(summary.tokens.input)}; cached ${formatRange(summary.tokens.cached)} (${cacheNote}); cache-write ${formatRange(summary.tokens.cache_write)} (${writeNote}); output ${formatInteger(summary.tokens.output)}; total ${formatInteger(summary.tokens.total)}.`,
    `- Estimated list-price cost: ${formatCost(summary.cost_usd)} using published provider rates as of ${summary.cost_usd.pricing_as_of}. A range means the API did not fully report cache-write/read allocation.`,
  ].join('\n');
}

function readUsageSlice(filePath, offset, requestedEnd = null) {
  if (!fs.existsSync(filePath)) return { rows: [], invalidLines: 0 };
  const size = fs.statSync(filePath).size;
  const end = requestedEnd === null ? size : requestedEnd;
  if (!Number.isInteger(offset) || !Number.isInteger(end) || offset < 0 || end < offset || end > size) {
    return { rows: [], invalidLines: 1 };
  }
  const length = end - offset;
  if (length === 0) return { rows: [], invalidLines: 0 };
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buffer, 0, length, offset); } finally { fs.closeSync(fd); }
  const rows = [];
  let invalidLines = 0;
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (error) { invalidLines += 1; }
  }
  return { rows, invalidLines };
}

function appendSummary({ summary, diaryPath, wakeUsagePath }) {
  const marker = `<!-- wake-usage:${summary.wake_id} -->`;
  const existingDiary = fs.existsSync(diaryPath) ? fs.readFileSync(diaryPath, 'utf8') : '';
  if (!existingDiary.includes(marker)) {
    const prefix = existingDiary ? '\n' : `════ WAKE ${summary.started_at || summary.ended_at} (usage-only) ════\n`;
    fs.appendFileSync(diaryPath, `${prefix}${formatDiarySummary(summary)}\n`);
  }

  let alreadyLogged = false;
  if (fs.existsSync(wakeUsagePath)) {
    for (const line of fs.readFileSync(wakeUsagePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).wake_id === summary.wake_id) { alreadyLogged = true; break; }
      } catch (error) { /* Preserve malformed history; do not hide the current summary. */ }
    }
  }
  if (!alreadyLogged) fs.appendFileSync(wakeUsagePath, `${JSON.stringify(summary)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(item);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function partitionWakeRows(rows, wakeId) {
  const wakeRows = [];
  let foreignRows = 0;
  for (const row of rows) {
    if (row?.wake_id === wakeId) wakeRows.push(row);
    else foreignRows += 1;
  }
  return { wakeRows, foreignRows };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['usage', 'offset', 'end-offset', 'diary', 'wake-log', 'wake-id', 'started-at', 'brain-rc'];
  const missing = required.filter(key => !hasOwn(args, key));
  if (missing.length) throw new Error(`missing arguments: ${missing.join(', ')}`);
  const wakeId = args['wake-id'];
  const slice = readUsageSlice(args.usage, Number(args.offset), Number(args['end-offset']));
  const { wakeRows, foreignRows } = partitionWakeRows(slice.rows, wakeId);
  const summary = summarizeUsage(wakeRows, {
    wakeId,
    startedAt: args['started-at'],
    endedAt: new Date().toISOString(),
    brainRc: Number(args['brain-rc']),
    invalidLines: slice.invalidLines,
    foreignRows,
  });
  appendSummary({ summary, diaryPath: args.diary, wakeUsagePath: args['wake-log'] });
  console.log(`USAGE wake=${summary.wake_id} calls=${summary.calls.total} tokens=${summary.tokens.total} cost=${formatCost(summary.cost_usd)}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`USAGE SUMMARY ERR ${String(error.message || error)}`); process.exitCode = 1; }
}

module.exports = {
  DEEPSEEK_PRICING_SOURCE,
  PRICES_PER_MILLION,
  appendSummary,
  costBounds,
  formatDiarySummary,
  normalizeProvider,
  normalizeUsageRow,
  partitionWakeRows,
  readUsageSlice,
  summarizeUsage,
};
