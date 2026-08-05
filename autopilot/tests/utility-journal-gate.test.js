'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ENGINES = [
  ['responses engine', require('../brain56.js')],
  ['chat-completions engine', require('../brain.js')],
];

const NOW = Date.parse('2026-07-26T21:00:00.000Z');

function stateFixture({ power = 100, water = 100, complete = true } = {}) {
  return {
    t: new Date(NOW).toISOString(),
    buildings: [
      { id: 101, name: 'Mill', kindLetter: 'i', size: 2 },
      { id: 102, name: 'Mill', kindLetter: 'i', size: 1 },
    ],
    surplusPlan: {
      complete,
      status: complete ? 'ok' : 'unknown',
      millCapacity: {
        expectedBuildingIds: [101, 102],
        missingBuildingIds: complete ? [] : [102],
        rates: complete ? [{ buildingId: 101 }, { buildingId: 102 }] : [{ buildingId: 101 }],
      },
      items: complete
        ? {
          1: { sellable: power, status: 'ok', transportPerUnit: 0 },
          2: { sellable: water, status: 'ok', transportPerUnit: 0 },
        }
        // A missing Mill rate sends calculateCoffeeReservePolicy down its early-bail path, and that
        // path marks every item unknown with sellable 0. Modelling anything else here would test a
        // state the policy cannot produce.
        : {
          1: { sellable: 0, status: 'unknown', transportPerUnit: null },
          2: { sellable: 0, status: 'unknown', transportPerUnit: null },
        },
    },
  };
}

function successfulInspection(profit = 10) {
  return {
    ok: true,
    book: { live: { status: 200 } },
    uiQuote: { ok: true, economics: { estimatedProfit: profit } },
  };
}

function retryAlarm(kinds, { setAt = NOW, retryAt = NOW + 5 * 60e3 } = {}) {
  return {
    at: retryAt,
    atIso: new Date(retryAt).toISOString(),
    set: new Date(setAt).toISOString(),
    reason: `retry utility kind(s) ${kinds.join(', ')}`,
    utilityRetryKinds: kinds,
  };
}

for (const [engineName, engine] of ENGINES) {
  test(`${engineName}: incomplete reserve plan fails closed with missing Mill IDs`, () => {
    const state = stateFixture({ complete: false });
    const reviews = engine.createUtilityExchangeReviews();
    const block = engine.utilityJournalGate(state, reviews, null, NOW);

    assert.equal(block.guard, true);
    assert.equal(block.requiredTool, 'inspect_building');
    assert.deepEqual(block.missingBuildingIds, [102]);
    assert.match(block.reason, /unverified for kind\(s\) 1, 2/);
    assert.match(block.reason, /does not require a sale/);
  });

  test(`${engineName}: an absent reserve plan requests every current Mill inspection`, () => {
    const state = stateFixture();
    delete state.surplusPlan;
    const block = engine.utilityJournalGate(
      state, engine.createUtilityExchangeReviews(), null, NOW);

    assert.equal(block.requiredTool, 'inspect_building');
    assert.deepEqual(block.missingBuildingIds, [101, 102]);
  });

  test(`${engineName}: each utility requires its own successful inspection`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();

    engine.noteUtilityInspection(reviews, 1, successfulInspection());
    let block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.deepEqual(block.pendingKinds, [2]);

    engine.noteUtilityInspection(reviews, 2, { ok: false, book: { live: { status: 500 } } });
    block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.deepEqual(block.pendingKinds, [2]);

    engine.noteUtilityInspection(reviews, 2, successfulInspection(-1));
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null);
  });

  test(`${engineName}: reserve plan status and both sellable values fail closed`, () => {
    // The plan-level status is no longer evidence about any particular utility, and the policy cannot
    // produce this combination anyway: it only reports 'unknown' when some item is itself unknown.
    // Both utilities are priced here, so the gate moves them on to their sale review.
    const badStatus = stateFixture();
    badStatus.surplusPlan.status = 'unknown';
    let block = engine.utilityJournalGate(
      badStatus, engine.createUtilityExchangeReviews(), null, NOW);
    assert.equal(block.requiredTool, 'inspect_exchange_sale');

    const invalidSellable = stateFixture();
    invalidSellable.surplusPlan.items[1].sellable = -1;
    delete invalidSellable.surplusPlan.items[2].sellable;
    block = engine.utilityJournalGate(
      invalidSellable, engine.createUtilityExchangeReviews(), null, NOW);
    assert.equal(block.requiredTool, 'refresh_state');
    assert.deepEqual(block.invalidKinds, [1, 2]);

    const infiniteSellable = stateFixture();
    infiniteSellable.surplusPlan.items[1].sellable = Infinity;
    block = engine.utilityJournalGate(
      infiniteSellable, engine.createUtilityExchangeReviews(), null, NOW);
    assert.deepEqual(block.invalidKinds, [1]);
  });

  test(`${engineName}: inspection success requires live 200 and an ok UI quote`, () => {
    const state = stateFixture({ water: 0 });
    const reviews = engine.createUtilityExchangeReviews();

    engine.noteUtilityInspection(reviews, 1, {
      ok: true,
      book: { live: { status: 500 } },
      uiQuote: { ok: true, economics: { estimatedProfit: 10 } },
    }, NOW);
    assert.equal(reviews['1'].status, 'failed');
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW).requiredTool, 'inspect_exchange_sale');

    engine.noteUtilityInspection(reviews, 1, {
      ok: true,
      book: { live: { status: 200 } },
      uiQuote: { ok: false, economics: { estimatedProfit: 10 } },
    }, NOW);
    assert.equal(reviews['1'].status, 'failed');

    engine.noteUtilityInspection(reviews, 1, successfulInspection(), NOW);
    assert.equal(reviews['1'].status, 'inspected');
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null);
  });

  test(`${engineName}: an explicit read-only UI refusal authorizes holding, never selling`, () => {
    const state = stateFixture({ power: 500, water: 0 });
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 1, {
      ok: false,
      failClosed: true,
      readOnly: true,
      submitted: false,
      reason: 'UI product or lot could not be bound safely',
      book: { live: { status: 200 } },
      uiQuote: { mutationAttempted: false },
    });
    assert.equal(reviews['1'].status, 'held');
    assert.equal(reviews['1'].sold, false);
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null);
  });

  test(`${engineName}: expiring reserve-rate evidence routes to exact Mill inspections`, () => {
    const state = stateFixture({ power: 0, water: 500 });
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 2, {
      ok: false,
      failClosed: true,
      failureCode: 'RESERVE_RATE_EVIDENCE_EXPIRES',
      requiredBuildingIds: [102, 101, 102],
      readOnly: true,
      submitted: false,
      book: { live: null },
      uiQuote: { mutationAttempted: false },
    }, NOW);

    const block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.equal(reviews['2'].status, 'needs_rate_refresh');
    assert.equal(block.requiredTool, 'inspect_building');
    assert.deepEqual(block.missingBuildingIds, [101, 102]);
    assert.deepEqual(block.pendingKinds, [2]);
  });

  test(`${engineName}: malformed reserve-rate failures remain unresolved`, () => {
    const state = stateFixture({ power: 0, water: 500 });
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 2, {
      ok: false,
      failClosed: true,
      failureCode: 'RESERVE_RATE_EVIDENCE_EXPIRES',
      requiredBuildingIds: [],
      readOnly: true,
      submitted: false,
      uiQuote: { mutationAttempted: false },
    }, NOW);

    const block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.equal(reviews['2'].status, 'failed');
    assert.equal(block.requiredTool, 'inspect_exchange_sale');
  });

  test(`${engineName}: a profitable inspection does not force an exchange sale`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 1, successfulInspection(500));
    engine.noteUtilityInspection(reviews, 2, successfulInspection(250));

    assert.equal(reviews['1'].profitable, true);
    assert.equal(reviews['2'].profitable, true);
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null);
  });

  test(`${engineName}: a confirmed utility exchange sale counts only for its own kind`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityExchangeSale(reviews, 1, { ok: true, armed: true, submitted: 'SELL' });

    let block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.equal(reviews['1'].status, 'sold');
    assert.deepEqual(block.pendingKinds, [2]);

    engine.noteUtilityExchangeSale(reviews, 2, { ok: false, armed: true, submitted: null });
    block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.deepEqual(block.pendingKinds, [2]);

    engine.noteUtilityInspection(reviews, 2, successfulInspection());
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null);
  });

  test(`${engineName}: exchange action names map to their utility kind`, () => {
    assert.equal(engine.utilityKindFromExchangeIdentifier('power'), 1);
    assert.equal(engine.utilityKindFromExchangeIdentifier('water'), 2);
    assert.equal(engine.utilityKindFromExchangeIdentifier('coffee-ground'), null);

    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityExchangeSale(reviews, 'power', { ok: true, armed: true, submitted: 'SELL' });
    const block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.equal(reviews['1'].status, 'sold');
    assert.deepEqual(block.pendingKinds, [2]);
  });

  test(`${engineName}: every rate-limited utility needs an explicit near retry alarm`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    const rateLimit = { ok: false, book: { live: { status: 429 } } };
    engine.noteUtilityInspection(reviews, 1, rateLimit, NOW);
    engine.noteUtilityInspection(reviews, 2, rateLimit, NOW);

    let block = engine.utilityJournalGate(state, reviews, retryAlarm([1, 2], { retryAt: NOW + 11 * 60e3 }), NOW);
    assert.equal(block.requiredTool, 'set_alarm');
    assert.deepEqual(block.pendingKinds, [1, 2]);

    block = engine.utilityJournalGate(state, reviews, retryAlarm([1, 2], { retryAt: NOW - 1 }), NOW);
    assert.equal(block.requiredTool, 'set_alarm');

    block = engine.utilityJournalGate(state, reviews, retryAlarm([1, 2], { retryAt: NOW + 10 * 60e3 }), NOW);
    assert.equal(block, null);
  });

  test(`${engineName}: rate-limit retry alarm must be set after review and bind every kind`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    const reviewedAt = NOW + 1000;
    const rateLimit = { ok: false, book: { live: { status: 429 } } };
    engine.noteUtilityInspection(reviews, 1, rateLimit, reviewedAt);
    engine.noteUtilityInspection(reviews, 2, rateLimit, reviewedAt);

    let block = engine.utilityJournalGate(
      state, reviews, retryAlarm([1, 2], { setAt: NOW, retryAt: NOW + 5 * 60e3 }), NOW);
    assert.equal(block.requiredTool, 'set_alarm');

    block = engine.utilityJournalGate(
      state, reviews, retryAlarm([1], { setAt: reviewedAt, retryAt: NOW + 5 * 60e3 }), NOW);
    assert.equal(block.requiredTool, 'set_alarm');

    block = engine.utilityJournalGate(
      state, reviews, retryAlarm([1, 2], { setAt: reviewedAt, retryAt: NOW + 5 * 60e3 }), NOW);
    assert.equal(block, null);
  });

  test(`${engineName}: one rate limit cannot clear an unreviewed peer utility`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 1, { ok: false, book: { live: { status: 429 } } }, NOW);

    const block = engine.utilityJournalGate(state, reviews, retryAlarm([1]), NOW);
    assert.equal(block.requiredTool, 'inspect_exchange_sale');
    assert.deepEqual(block.pendingKinds, [2]);
  });

  test(`${engineName}: utilities without verified sellable stock do not require review`, () => {
    const state = stateFixture({ power: 0, water: 0 });
    const reviews = engine.createUtilityExchangeReviews();
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null);
  });
}

// Regression, 2026-08-05. Three tablets and one quadcopter — four units of construction leftovers
// whose transport cost falls outside the supported {0, 0.1, 1} — set surplusPlan.complete to false.
// The whole-plan flag then withheld a fully priced 67,293-unit water surplus, and the journal gate
// blamed Mill inspections that were already fresh, so the wake inspected Mills until it ran out of
// rounds. Measured across the log, this guard was the second most frequent rejection of the wake.
for (const [engineName, engine] of ENGINES) {
  function poisonedPlanState() {
    const state = stateFixture();
    state.surplusPlan.complete = false;
    state.surplusPlan.status = 'unknown';
    state.surplusPlan.items[25] = { kind: 25, name: 'tablets', sellable: 0, status: 'unknown', transportPerUnit: null };
    state.surplusPlan.items[98] = { kind: 98, name: 'quadcopter', sellable: 0, status: 'unknown', transportPerUnit: null };
    return state;
  }

  test(`${engineName}: an unpriceable unrelated item does not withhold a priced utility surplus`, () => {
    const state = poisonedPlanState();
    assert.equal(state.surplusPlan.complete, false);
    assert.deepEqual(engine.unverifiedUtilityKinds(state), []);
    assert.deepEqual(engine.pendingUtilitySurplus(state), [1, 2]);
  });

  test(`${engineName}: the gate asks for the sale review, not another Mill inspection`, () => {
    const block = engine.utilityJournalGate(
      poisonedPlanState(), engine.createUtilityExchangeReviews(), null, NOW);

    assert.equal(block.requiredTool, 'inspect_exchange_sale');
    assert.deepEqual(block.pendingKinds, [1, 2]);
  });

  test(`${engineName}: never orders an inspection it cannot name`, () => {
    // Every Mill is inspected fresh, yet a utility is still unverified. The old text answered this
    // with "not enumerated; inspect every current Mill", an order no tool call can carry out.
    const state = stateFixture();
    state.surplusPlan.complete = false;
    state.surplusPlan.status = 'unknown';
    state.surplusPlan.items[2] = { sellable: 0, status: 'unknown', transportPerUnit: null };
    const block = engine.utilityJournalGate(
      state, engine.createUtilityExchangeReviews(), null, NOW);

    assert.equal(block.requiredTool, 'refresh_state');
    assert.deepEqual(block.missingBuildingIds, []);
    assert.deepEqual(block.invalidKinds, [2]);
    assert.doesNotMatch(block.reason, /not enumerated/);
    assert.match(block.reason, /already inspected fresh/);
  });

  test(`${engineName}: a utility with no plan entry still fails closed`, () => {
    const state = stateFixture();
    delete state.surplusPlan.items[2];
    const block = engine.utilityJournalGate(
      state, engine.createUtilityExchangeReviews(), null, NOW);

    assert.equal(block.guard, true);
    assert.deepEqual(engine.pendingUtilitySurplus(state), []);
  });

  test(`${engineName}: an explicitly held or blocked utility is not treated as verified`, () => {
    for (const item of [{ sellable: 5, status: 'hold' }, { sellable: 5, blocked: true },
      { sellable: 5, allowedToSell: false }, { sellable: 5, eligible: false },
      { sellable: Number.NaN, status: 'ok' }, { sellable: -1, status: 'ok' }]) {
      const state = stateFixture();
      state.surplusPlan.items[2] = item;
      assert.deepEqual(engine.unverifiedUtilityKinds(state), [2], JSON.stringify(item));
    }
  });
}

// Regression, 2026-08-05 04:04Z. A review whose inspection keeps failing never left 'failed', and
// 'failed' was not in the set the journal gate accepts, so the wake re-inspected and re-journalled
// until it ran out of rounds — ten attempts in three minutes, live. The loop only became reachable
// once the surplus stopped being withheld by an unrelated warehouse row, which is why it had never
// been seen before.
for (const [engineName, engine] of ENGINES) {
  // Reproduces the observed result: read-only, live book fine, UI quote refused, and no failClosed
  // flag, so it is neither 'inspected' nor 'held'.
  const failedInspection = () => ({
    ok: false,
    readOnly: true,
    submitted: false,
    book: { live: { status: 200 } },
    uiQuote: { ok: false, mutationAttempted: false },
  });

  test(`${engineName}: one failed review is retried, the second closes the wake`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 1, successfulInspection());

    engine.noteUtilityInspection(reviews, 2, failedInspection());
    assert.equal(reviews['2'].status, 'failed');
    assert.equal(reviews['2'].attempts, 1);
    let block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.deepEqual(block.pendingKinds, [2], 'the first failure must still be retried');

    engine.noteUtilityInspection(reviews, 2, failedInspection());
    assert.equal(reviews['2'].attempts, 2);
    block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.equal(block, null, 'the second failure must not trap the wake');
  });

  test(`${engineName}: a late success still resolves normally`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 1, successfulInspection());
    engine.noteUtilityInspection(reviews, 2, failedInspection());
    engine.noteUtilityInspection(reviews, 2, successfulInspection());

    assert.equal(reviews['2'].status, 'inspected');
    assert.equal(reviews['2'].attempts, 2);
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null);
  });

  test(`${engineName}: the cap is per kind, not shared`, () => {
    const state = stateFixture();
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 2, failedInspection());
    engine.noteUtilityInspection(reviews, 2, failedInspection());

    // Kind 2 is spent, kind 1 has not been looked at once.
    const block = engine.utilityJournalGate(state, reviews, null, NOW);
    assert.deepEqual(block.pendingKinds, [1]);
    assert.equal(reviews['1'].attempts, 0);
  });

  test(`${engineName}: a rate-limited review is never counted against the cap`, () => {
    const reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 2, { ok: false, book: { live: { status: 429 } } });
    assert.equal(reviews['2'].status, 'rate_limited');
  });
}

// Regression, 2026-08-05 00:31. The failed-review cap worked but could be reset out from under
// itself: refresh_state and inspect_building both rebuild the reviews, which zeroed the attempt
// tally. The live wake spent four attempts instead of two because an inspect_buildings landed
// between them. Fresh evidence should invalidate a review's result; it should not make the wake
// forget that it has already tried. With the round ceiling removed, a refresh-driven loop is
// otherwise bounded only by the 45-minute wall clock.
for (const [engineName, engine] of ENGINES) {
  const failedInspection = () => ({
    ok: false,
    readOnly: true,
    submitted: false,
    book: { live: { status: 200 } },
    uiQuote: { ok: false, mutationAttempted: false },
  });

  test(`${engineName}: the attempt tally survives a review reset`, () => {
    const state = stateFixture();
    let reviews = engine.createUtilityExchangeReviews();
    engine.noteUtilityInspection(reviews, 1, successfulInspection());
    engine.noteUtilityInspection(reviews, 2, failedInspection());
    assert.equal(reviews['2'].attempts, 1);

    // What refresh_state and inspect_building do.
    reviews = engine.createUtilityExchangeReviews(reviews);
    assert.equal(reviews['2'].attempts, 1, 'the tally must carry across the reset');
    assert.equal(reviews['2'].status, 'pending', 'the result itself must still be discarded');
    assert.equal(reviews['1'].status, 'pending', 'a passing review is re-reviewed on fresh evidence');

    engine.noteUtilityInspection(reviews, 1, successfulInspection());
    engine.noteUtilityInspection(reviews, 2, failedInspection());
    assert.equal(reviews['2'].attempts, 2);
    assert.equal(engine.utilityJournalGate(state, reviews, null, NOW), null,
      'the second attempt overall must close the wake, not the second since the last reset');
  });

  test(`${engineName}: a fresh wake starts the tally at zero`, () => {
    const reviews = engine.createUtilityExchangeReviews();
    for (const kind of ['1', '2']) assert.equal(reviews[kind].attempts, 0);
  });
}
