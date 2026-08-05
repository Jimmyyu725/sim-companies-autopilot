'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// One bug, five places. calculateCoffeeReservePolicy sets `complete: false` when any single
// warehouse row cannot be priced — on 2026-08-05 three tablets and one quadcopter, four units of
// construction leftovers. Every site that gated a *per-resource* decision on that whole-plan flag
// therefore withheld a fully priced 67,293-unit water surplus because of four units of junk.
//
// PR #67 removed two of them and claimed the job was done. It was not: three more survived, and the
// deepest one kept the sale blocked anyway while pushing the wake into a retry loop. This test
// exists so the sixth site cannot be added quietly.
//
// The rule: a per-resource decision reads the resource's own entry. The whole-plan flag says nothing
// about a resource that priced cleanly, and it costs nothing to drop — every early-bail path in the
// policy marks *every* item unknown with sellable 0, so per-item checks still fail closed.
const GUARDED = [
  'inspect-exchange-sale.js',
  'exchange-sale-helpers.js',
  'exchange-sale-safety.js',
  'production-policy.js',
  'brain.js',
  'brain56.js',
];

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

for (const name of GUARDED) {
  test(`${name} does not gate a resource on the whole-plan completeness flag`, () => {
    const source = read(name);
    const offenders = [];
    source.split('\n').forEach((line, index) => {
      // `warehouse.complete` is a different and legitimate check: if the warehouse capture itself is
      // partial then no item is trustworthy, per item or otherwise.
      if (/\bwarehouse\??\.complete\b/u.test(line)) return;
      // The policy module is allowed to *set* the flag; nobody else may branch on it.
      if (/\b(plan|projection|surplusPlan)\??\.(complete|status)\s*!==/u.test(line) ||
          /\b(plan|projection|surplusPlan)\??\.complete\s*===\s*false/u.test(line)) {
        offenders.push(`${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
    assert.deepEqual(offenders, [],
      `${name} branches on the whole-plan flag; read the resource's own entry instead`);
  });
}

test('the reserve policy still marks every item unknown when it bails early', () => {
  // This is the premise the whole rule rests on. If a bail path ever left an item looking healthy,
  // dropping the whole-plan flag would stop being safe and this test should fail loudly.
  const policy = read('coffee-reserve-policy.js');
  const bail = policy.match(/function unknownItems\([\s\S]*?\n\}/u);
  assert.ok(bail, 'unknownItems must still exist');
  assert.match(bail[0], /status:\s*'unknown'/u, 'every bailed item must be marked unknown');
  assert.match(bail[0], /sellable:\s*0/u, 'every bailed item must be unsellable');
});

test('buildReserveAuthorization accepts a priced item inside an incomplete plan', () => {
  const { buildReserveAuthorization } = require('../inspect-exchange-sale.js');
  const nowMs = Date.parse('2026-08-05T06:00:00.000Z');
  // A plan flagged incomplete by an unrelated row, with water priced and its own status ok.
  const item = { kind: 2, status: 'ok', reserve: 25716, sellable: 63348, stock: 89064 };
  const state = {
    t: new Date(nowMs).toISOString(),
    surplusPlan: {
      complete: false,
      status: 'unknown',
      horizonHours: 24,
      bufferPct: 0.10,
      items: { 2: item, 25: { kind: 25, status: 'unknown', sellable: 0 } },
    },
  };
  const result = buildReserveAuthorization({
    state,
    kind: 2,
    currentPolicy: { ok: true, reserve: 25716, sellable: 63348, stock: { amount: 89064 } },
    facts: {},
    inspectionCache: {},
    nowMs,
  });
  // The projection is recomputed internally, so this may still fail for a real evidence reason —
  // what it must not do is fail with the whole-plan verdict while naming no building to inspect.
  if (result.ok !== true) {
    assert.notEqual(result.failureCode, 'RESERVE_RATE_EVIDENCE_INCOMPLETE',
      `blocked as incomplete rate evidence while naming ${JSON.stringify(result.requiredBuildingIds)}`);
  }
});
