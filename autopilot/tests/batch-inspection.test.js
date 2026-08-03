'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SIM = path.join(__dirname, '..', '..');

// This file is what survived cdp-capture.test.js. That file also covered the capture early-return
// and the polling navigation added in #51/#52; both were reverted in the working tree after the
// 2026-08-03 00:12 wake, where collect and produce each failed twice on UI navigation. The batch
// inspector came from the same pair of changes but was kept, so its tests were kept with it.

// The DeepSeek adapter permits exactly one tool call per assistant message, so reading N buildings
// separately costs N full model round trips for reads that do not depend on each other. Writes
// stay single on purpose: a partially applied batch mutation leaves state no evidence describes.
test('both engines expose a read-only batch inspection and no batch mutation', () => {
  for (const engine of ['autopilot/brain.js', 'autopilot/brain56.js']) {
    const source = fs.readFileSync(path.join(SIM, engine), 'utf8');
    assert.match(source, /name: 'inspect_buildings'/, `${engine} must expose inspect_buildings`);
    assert.match(source, /if \(name === 'inspect_buildings'\)/, `${engine} must dispatch it`);
    for (const mutation of ['produce', 'sell', 'build', 'upgrade', 'scrap', 'bonds']) {
      assert.ok(!source.includes(`name: '${mutation}s'`),
        `${engine} must not expose a batch ${mutation}`);
    }
  }
});

test('the batch inspector caps its list so one call cannot monopolise the tick lock', () => {
  const source = fs.readFileSync(path.join(SIM, 'autopilot', 'inspect-building.js'), 'utf8');
  const cap = source.match(/const MAX_BATCH_INSPECTIONS = (\d+);/);
  assert.ok(cap, 'the batch size must be an explicit named cap');
  assert.ok(Number(cap[1]) >= 2 && Number(cap[1]) <= 12, 'the cap must be small and deliberate');
  assert.match(source, /buildingIds must be 1 to/, 'an out-of-range list must be refused, not clamped');
});
