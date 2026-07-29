'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic } = require('../../shared/facts/atomic-json.js');

test('facts JSON writer replaces the destination without leaving temporary files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-facts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'game-facts.json');

  writeJsonAtomic(file, { version: 1, resources: [1, 2] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, resources: [1, 2] });

  writeJsonAtomic(file, { version: 2, resources: [3] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, resources: [3] });
  assert.deepEqual(fs.readdirSync(directory), ['game-facts.json']);
});
