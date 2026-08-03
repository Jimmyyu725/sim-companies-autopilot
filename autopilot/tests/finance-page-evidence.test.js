'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { summarizeBondOfferForm } = require('../council-evidence-helpers.js');

const SIM = path.join(__dirname, '..', '..');

// Live 2026-08-03: every strategy council on a level-3 company failed with "strategy council
// finance evidence is not verified". validateStrategyCouncilCompletion requires financePage === 200,
// and the page detector set 200 only when the text contained "Adjust issued bonds" — the bond OFFER
// form, which the game does not render until company level 10. The page itself loaded fine and
// carried Bonds Payable, Interest expense and Rating. So the check was not "did the CFO read the
// finance page" but "does this company have bonds", and it blocked every council permanently.

test('a finance page without the level-gated offer form still counts as read', () => {
  const summary = summarizeBondOfferForm({
    source: '/headquarters/finance/',
    status: 200,
    offerFormAvailable: false,
    rating: 'C',
    offerAmountField: 'UNKNOWN',
    offerInterestField: 'UNKNOWN',
  });
  assert.equal(Number(summary.status), 200, 'a rendered page is verified evidence');
  assert.equal(summary.offerFormAvailable, false);
  assert.equal(summary.rating, 'C');
  // The offer fields are legitimately unknown, and that must not be mistaken for a gap.
  assert.equal(summary.unsoldOfferAmountDollars, 'UNKNOWN');
  assert.equal(summary.offerInterestPctPerDay, 'UNKNOWN');
});

test('the offer form is reported when the company does have one', () => {
  const summary = summarizeBondOfferForm({
    source: '/headquarters/finance/',
    status: 200,
    offerFormAvailable: true,
    rating: 'B',
    offerAmountField: '6',
    offerInterestField: '0.5',
  });
  assert.equal(summary.offerFormAvailable, true);
  assert.equal(summary.unsoldOfferAmountDollars, 6);
  assert.equal(summary.offerInterestPctPerDay, 0.5);
});

test('a page that did not render is still UNKNOWN, not silently verified', () => {
  const summary = summarizeBondOfferForm({ source: '/headquarters/finance/', status: 'UNKNOWN' });
  assert.notEqual(Number(summary.status), 200);
});

// The detector runs in the browser, so this asserts the shipped source rather than importing it.
test('the page detector keys on figures present at every level, not on the offer form', () => {
  const source = fs.readFileSync(path.join(SIM, 'autopilot', 'council-evidence.js'), 'utf8');
  assert.match(source, /const rendered = \/Bonds\\s\*Payable\/i\.test\(text\) \|\| \/Interest\\s\*expense\/i\.test\(text\)/,
    'status must come from figures the page shows at any company level');
  assert.match(source, /status: rendered \? 200 : 'UNKNOWN'/,
    'the rendered check, not the offer form, must decide the status');
  assert.doesNotMatch(source, /status: \/Adjust issued bonds\/i\.test\(text\) \? 200 : 'UNKNOWN'/,
    'keying status on the level-gated offer form is the bug this test exists for');
});
