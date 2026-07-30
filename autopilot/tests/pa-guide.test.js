'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  consultPaGuides,
  matchScore,
  parseMarkdownTable,
} = require('../pa-guide.js');

test('parses guide tables without treating headers as evidence', () => {
  const rows = parseMarkdownTable(`
| Offer cue | Reported favorable choice or result |
|---|---|
| Forklift Olympic | Option B |
`);
  assert.deepEqual(rows, [{ cue: 'Forklift Olympic', outcome: 'Option B' }]);
});

test('matches the current Forklift quest despite plural wording', () => {
  const result = consultPaGuides({
    offerText: 'Warehouse employees organized unofficial Forklift Olympics after hours.',
    communityGuide: `
| Offer cue | Reported favorable choice or result |
|---|---|
| Forklift Olympic | Option B gives 10,000 Transport for $5,000 |
| Triangle consultant | Recommend them to competitors |
`,
    measuredGuide: '',
  });
  assert.equal(result.community.length, 1);
  assert.equal(result.community[0].cue, 'Forklift Olympic');
  assert.equal(result.community[0].score, 1);
  assert.equal(result.measured.length, 0);
});

test('unknown offers do not receive a fabricated guide match', () => {
  assert.equal(matchScore('A meteor landed beside the warehouse.', 'Forklift Olympic'), 0);
  const result = consultPaGuides({
    offerText: 'A meteor landed beside the warehouse.',
    communityGuide: '| Forklift Olympic | Option B |',
    measuredGuide: '| Cinema pricing | Seniors discount |',
  });
  assert.equal(result.matchCount, 0);
});
