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
      items: {
        1: { sellable: power },
        2: { sellable: water },
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
    assert.match(block.reason, /complete with status ok/);
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
    const badStatus = stateFixture();
    badStatus.surplusPlan.status = 'unknown';
    let block = engine.utilityJournalGate(
      badStatus, engine.createUtilityExchangeReviews(), null, NOW);
    assert.equal(block.requiredTool, 'inspect_building');

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
