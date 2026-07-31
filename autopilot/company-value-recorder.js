#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  atomicWriteFile,
} = require('../shared/price-tracker/data-quality.js');

const HISTORY_LIMIT = 5000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cleanText(value, fallback) {
  const text = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  return text ? text.slice(0, 240) : fallback;
}

function formatMoney(value) {
  return finiteNumber(value) == null
    ? 'UNAVAILABLE'
    : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function formatAge(seconds) {
  const value = finiteNumber(seconds);
  if (value == null || value < 0) return 'unknown age';
  if (value < 120) return `${Math.round(value)} seconds old`;
  if (value < 7200) return `${Math.round(value / 60)} minutes old`;
  return `${Math.round(value / 3600 * 10) / 10} hours old`;
}

function parseHistory(text) {
  return String(text || '').split('\n').filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line);
      return row && typeof row === 'object' && typeof row.wakeId === 'string' ? [row] : [];
    } catch (_) {
      return [];
    }
  });
}

function diarySection(record) {
  const marker = `<!-- company-value:${record.wakeId} -->`;
  if (record.status !== 'estimated') {
    return [
      '',
      marker,
      '## Company value',
      `- Real-time estimate: UNAVAILABLE (${record.reason})`,
      `- Official daily value: ${formatMoney(record.official?.total)}`
        + (record.official?.asOf ? ` as of ${record.official.asOf}` : ''),
      '- Safety note: no missing component was silently treated as zero.',
      '',
    ].join('\n');
  }
  const direction = record.deltaFromOfficial > 0 ? '+' : '';
  const snapshotAge = formatAge(record.officialSnapshotAgeSeconds);
  const inventoryMethod = record.methodVersion >= 3
    ? 'quality-specific live market proxies × 85%; WIP uses live production unit cost'
    : 'the prior UTC day tracked VWAP × 85%';
  return [
    '',
    marker,
    '## Company value',
    `- Real-time estimate: ${formatMoney(record.estimate)} as of ${record.estimateAsOf}.`,
    `- Official daily value: ${formatMoney(record.official?.total)}`
      + (record.official?.asOf ? ` as of ${record.official.asOf}.` : '.'),
    `- Estimated difference versus the older official snapshot: ${direction}${formatMoney(record.deltaFromOfficial)}`
      + ` (official snapshot is ${snapshotAge}; this includes real activity after that timestamp and remaining estimation error).`,
    `- Confidence: ${record.confidence}; inventory coverage: ${record.inventoryCoveragePct}%.`,
    `- Method: current assets + non-current assets - liabilities; inventory uses ${inventoryMethod}.`,
    record.limitations.length
      ? `- Limitations: ${record.limitations.join(' ')}`
      : '- Limitations: none reported by the estimator.',
    '',
  ].join('\n');
}

function recordCompanyValue({
  state,
  wakeId,
  startedAt,
  brainRc,
  historyFile,
  currentFile,
  diaryFile,
  unavailableReason,
  recordedAt = new Date().toISOString(),
}) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(String(wakeId || ''))) {
    throw new Error('wakeId is missing or invalid');
  }
  const official = state?.companyValue?.official || {
    status: 'unavailable',
    asOf: null,
    total: null,
  };
  const estimate = state?.companyValue?.realtimeEstimate;
  const estimateValue = finiteNumber(estimate?.total);
  const forcedUnavailable = cleanText(unavailableReason, '');
  const available = !forcedUnavailable
    && estimate?.status === 'estimated'
    && estimateValue != null;
  const record = {
    schemaVersion: 2,
    methodVersion: Number.isSafeInteger(Number(state?.companyValue?.methodVersion))
      ? Number(state.companyValue.methodVersion)
      : null,
    wakeId,
    startedAt: cleanText(startedAt, null),
    recordedAt,
    brainRc: Number.isSafeInteger(Number(brainRc)) ? Number(brainRc) : null,
    stateCapturedAt: state?.t || null,
    status: available ? 'estimated' : 'unavailable',
    estimate: available ? estimateValue : null,
    estimateAsOf: available ? estimate.asOf || state?.t || null : null,
    official: {
      status: official.status || 'unavailable',
      total: finiteNumber(official.total),
      asOf: official.asOf || null,
    },
    deltaFromOfficial: available ? finiteNumber(estimate.deltaFromOfficial) : null,
    officialSnapshotAgeSeconds: available
      ? finiteNumber(estimate.comparisonToOfficialSnapshot?.snapshotAgeSeconds)
      : null,
    comparisonToOfficialSnapshot: available
      ? estimate.comparisonToOfficialSnapshot || null
      : null,
    confidence: available ? estimate.confidence || 'unknown' : null,
    inventoryCoveragePct: available
      ? finiteNumber(estimate.inventory?.coveragePct)
      : null,
    components: available ? estimate.components || null : null,
    inventoryValueByBasis: available ? estimate.inventory?.valueByBasis || null : null,
    limitations: available && Array.isArray(estimate.limitations)
      ? estimate.limitations.map(value => cleanText(value, '')).filter(Boolean).slice(0, 20)
      : [],
    reason: available
      ? null
      : (forcedUnavailable
        || cleanText(estimate?.reason, 'Company value was not available at wake close.')),
  };

  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  let historyText = '';
  try {
    historyText = fs.readFileSync(historyFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const history = parseHistory(historyText);
  const existing = history.find(row => row.wakeId === record.wakeId);
  const duplicate = Boolean(existing);
  if (!duplicate) {
    const bounded = history.concat(record).slice(-HISTORY_LIMIT);
    atomicWriteFile(historyFile, bounded.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  const persistedRecord = existing || record;
  atomicWriteFile(currentFile, `${JSON.stringify(persistedRecord, null, 2)}\n`);

  if (diaryFile) {
    let diary = '';
    try {
      diary = fs.readFileSync(diaryFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const marker = `<!-- company-value:${persistedRecord.wakeId} -->`;
    if (!diary.includes(marker)) fs.appendFileSync(diaryFile, diarySection(persistedRecord), 'utf8');
  }
  return { record: persistedRecord, duplicate };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.slice(2).map(argument => {
    const match = String(argument).match(/^--([^=]+)=(.*)$/s);
    if (!match) throw new Error(`invalid argument: ${argument}`);
    return [match[1], match[2]];
  }));
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv);
    const state = args.state ? readJson(args.state) : null;
    const result = recordCompanyValue({
      state,
      wakeId: args['wake-id'],
      startedAt: args['started-at'],
      brainRc: args['brain-rc'],
      historyFile: args.history,
      currentFile: args.current,
      diaryFile: args.diary,
      unavailableReason: args['unavailable-reason'],
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      wakeId: result.record.wakeId,
      status: result.record.status,
      estimate: result.record.estimate,
      duplicate: result.duplicate,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: String(error.message || error).slice(0, 300),
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  diarySection,
  parseHistory,
  recordCompanyValue,
};
