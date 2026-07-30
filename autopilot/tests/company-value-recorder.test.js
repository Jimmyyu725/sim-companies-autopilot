'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordCompanyValue } = require('../company-value-recorder.js');

function fixture() {
  return {
    t: '2026-07-30T04:00:00.000Z',
    companyValue: {
      official: {
        status: 'ok',
        total: 385783,
        asOf: '2026-07-30T01:08:16.893127+00:00',
      },
      realtimeEstimate: {
        status: 'estimated',
        total: 421043,
        asOf: '2026-07-30T04:00:00.000Z',
        deltaFromOfficial: 35260,
        confidence: 'medium',
        components: { cash: 188443 },
        inventory: { coveragePct: 100 },
        limitations: ['Tracked VWAP blends qualities.'],
      },
    },
  };
}

test('persists one idempotent record and appends it to the wake diary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-value-'));
  const historyFile = path.join(directory, 'metrics', 'history.jsonl');
  const currentFile = path.join(directory, 'metrics', 'current.json');
  const diaryFile = path.join(directory, 'diary.md');
  fs.writeFileSync(diaryFile, '# Wake\n');
  const args = {
    state: fixture(),
    wakeId: 'diary-2026-07-29-230000',
    startedAt: '2026-07-30T04:00:00Z',
    brainRc: 0,
    historyFile,
    currentFile,
    diaryFile,
    recordedAt: '2026-07-30T04:01:00Z',
  };
  const first = recordCompanyValue(args);
  const second = recordCompanyValue(args);
  assert.equal(first.record.status, 'estimated');
  assert.equal(first.record.estimate, 421043);
  assert.equal(second.duplicate, true);
  assert.equal(fs.readFileSync(historyFile, 'utf8').trim().split('\n').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(currentFile, 'utf8')).estimate, 421043);
  const diary = fs.readFileSync(diaryFile, 'utf8');
  assert.equal((diary.match(/<!-- company-value:/g) || []).length, 1);
  assert.match(diary, /Real-time estimate: \$421,043/);
  assert.match(diary, /Official daily value: \$385,783/);
});

test('records final-capture failure without presenting stale data as current', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-value-fail-'));
  const historyFile = path.join(directory, 'history.jsonl');
  const currentFile = path.join(directory, 'current.json');
  const diaryFile = path.join(directory, 'diary.md');
  const result = recordCompanyValue({
    state: fixture(),
    wakeId: 'diary-failed-close',
    startedAt: '2026-07-30T04:00:00Z',
    brainRc: 1,
    historyFile,
    currentFile,
    diaryFile,
    unavailableReason: 'Final authoritative state capture failed.',
  });
  assert.equal(result.record.status, 'unavailable');
  assert.equal(result.record.estimate, null);
  assert.match(fs.readFileSync(diaryFile, 'utf8'), /UNAVAILABLE/);
  assert.match(fs.readFileSync(diaryFile, 'utf8'), /no missing component was silently treated as zero/);
});
