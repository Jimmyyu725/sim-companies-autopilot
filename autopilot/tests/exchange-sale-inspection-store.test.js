'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  consumeInspectionArtifact,
  readInspectionArtifact,
  readInspectionStore,
  writeInspectionArtifact,
} = require('../exchange-sale-inspection-store.js');

function artifact(kind, inspectionId, ok = true) {
  return {
    schemaVersion: 4,
    inspectionId,
    kind,
    ok,
    inspectedAt: `2026-07-26T20:0${kind}:00.000Z`,
  };
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exchange-sale-inspections-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    active: path.join(dir, 'active.json'),
    used: path.join(dir, 'used.json'),
  };
}

test('an inspection failure for one product does not overwrite another product', t => {
  const files = workspace(t);
  const grapes = artifact(5, 'grapes-success', true);
  const oranges = artifact(4, 'oranges-failure', false);

  assert.equal(writeInspectionArtifact(files.active, grapes).ok, true);
  assert.equal(writeInspectionArtifact(files.active, oranges).ok, true);

  assert.deepEqual(readInspectionArtifact(files.active, 5), grapes);
  assert.deepEqual(readInspectionArtifact(files.active, 4), oranges);
});

test('a newer inspection replaces prior evidence only for the same product', t => {
  const files = workspace(t);
  writeInspectionArtifact(files.active, artifact(5, 'grapes-success', true));
  writeInspectionArtifact(files.active, artifact(4, 'oranges-success', true));
  writeInspectionArtifact(files.active, artifact(5, 'grapes-failure', false));

  assert.equal(readInspectionArtifact(files.active, 5).inspectionId, 'grapes-failure');
  assert.equal(readInspectionArtifact(files.active, 4).inspectionId, 'oranges-success');
});

test('an older delayed inspection cannot overwrite newer active evidence', t => {
  const files = workspace(t);
  const newer = { ...artifact(5, 'newer', true), inspectedAt: '2026-07-26T20:05:00.000Z' };
  const older = { ...artifact(5, 'older', false), inspectedAt: '2026-07-26T20:04:59.000Z' };
  assert.equal(writeInspectionArtifact(files.active, newer).ok, true);
  const result = writeInspectionArtifact(files.active, older);
  assert.equal(result.ok, false);
  assert.match(result.reason, /older/);
  assert.equal(readInspectionArtifact(files.active, 5).inspectionId, 'newer');
});

test('legacy single-artifact files migrate without losing the original product', t => {
  const files = workspace(t);
  const legacy = artifact(5, 'legacy-grapes', true);
  fs.writeFileSync(files.active, JSON.stringify(legacy));

  writeInspectionArtifact(files.active, artifact(4, 'new-oranges', false));

  const store = readInspectionStore(files.active);
  assert.equal(store.schemaVersion, 1);
  assert.equal(store.artifactsByKind['5'].inspectionId, 'legacy-grapes');
  assert.equal(store.artifactsByKind['4'].inspectionId, 'new-oranges');
});

test('consuming one product is single-use and preserves other active inspections', t => {
  const files = workspace(t);
  writeInspectionArtifact(files.active, artifact(5, 'grapes-success', true));
  writeInspectionArtifact(files.active, artifact(4, 'oranges-success', true));

  const consumed = consumeInspectionArtifact(
    files.active,
    files.used,
    5,
    'grapes-success',
  );

  assert.equal(consumed.inspectionId, 'grapes-success');
  assert.equal(readInspectionArtifact(files.active, 5), null);
  assert.equal(readInspectionArtifact(files.active, 4).inspectionId, 'oranges-success');
  assert.equal(readInspectionArtifact(files.used, 5).inspectionId, 'grapes-success');
});

test('a mismatched inspection id cannot consume current evidence', t => {
  const files = workspace(t);
  writeInspectionArtifact(files.active, artifact(5, 'grapes-success', true));

  assert.throws(
    () => consumeInspectionArtifact(files.active, files.used, 5, 'stale-inspection-id'),
    /active inspection changed/,
  );
  assert.equal(readInspectionArtifact(files.active, 5).inspectionId, 'grapes-success');
  assert.equal(readInspectionArtifact(files.used, 5), null);
});

test('an inspection with no resource kind cannot alter the store', t => {
  const files = workspace(t);
  writeInspectionArtifact(files.active, artifact(5, 'grapes-success', true));

  const result = writeInspectionArtifact(files.active, { kind: null, ok: false });

  assert.equal(result.ok, false);
  assert.equal(readInspectionArtifact(files.active, 5).inspectionId, 'grapes-success');
});
