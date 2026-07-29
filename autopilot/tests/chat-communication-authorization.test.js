'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  buildAuthorization,
  consumeCommunicationAuthorization,
  inspectCommunicationAuthorization,
  issueCommunicationAuthorization,
  readAuthorizationStore,
  recordCommunicationOutcome,
  requiresEconomicCommunicationAuthorization,
} = require('../chat/communication-authorization.js');
const { contractTermsHash } = require('../chat/contract-gate.js');
const { extractTradeLeads } = require('../chat/lead-engine.js');
const { normalizeMessage } = require('../chat/schemas.js');
const { deriveProactivePublicIntents } = require('../chat/public-economic-intent.js');

const AUTOPILOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-07-27T15:10:00.000Z');
const AS_OF = '2026-07-27T15:09:00.000Z';

function externalMessage(type = 'private') {
  return normalizeMessage({
    messageId: '1001',
    conversationType: type,
    conversationId: type === 'room' ? 'Sales' : 'company-77',
    direction: 'inbound',
    author: { companyId: '77', companyName: 'HEMLOCK ENTERPRISE' },
    createdAt: '2026-07-27T15:08:55.000Z',
    observedAt: AS_OF,
    replyToMessageId: null,
    content: {
      text: 'BUY 10k :re-2: Q0 @0.37',
      language: 'en',
      resourceMentions: [{ kind: 2, name: 'Water' }],
    },
  });
}

function offer(type = 'private') {
  return extractTradeLeads(externalMessage(type)).offers[0];
}

function snapshot(overrides = {}) {
  const value = {
    schemaVersion: 1,
    snapshotId: 'business-snapshot-1001',
    observedAt: AS_OF,
    inventory: [{
      status: 'ok', observedAt: AS_OF, kind: 2, quality: 0,
      onHandAmount: 20_000, blockedAmount: 1_000, reserveAmount: 4_000, unitCost: 0.1,
    }],
    transport: {
      status: 'ok', observedAt: AS_OF, availableAmount: 100,
      entries: [{ kind: 2, unitsPerItem: 0, opportunityCostPerUnit: 0 }],
    },
    markets: [{
      status: 'ok', observedAt: AS_OF, kind: 2, quality: 0,
      marketPrice: 0.4, bestBid: 0.39, bestAsk: 0.41,
    }],
    economics: [{
      status: 'ok', observedAt: AS_OF, kind: 2, quality: 0,
      contractFeeRate: 0, fixedCost: 0, alternativeSellNetPerUnit: 0.35,
      buyUseValuePerUnit: 0.5, buyNeedAmount: 10_000, warehouseFreeAmount: 50_000,
    }],
    finance: {
      status: 'ok', observedAt: AS_OF, cashAvailable: 100_000, cashReserve: 10_000,
    },
  };
  return { ...value, ...overrides };
}

function terms(overrides = {}) {
  return {
    counterpartyCompanyId: '77',
    ourSide: 'sell',
    resourceKind: 2,
    quality: 0,
    quantity: 10_000,
    unitPrice: '0.37',
    ...overrides,
  };
}

function request({
  attemptId = 'economic-attempt-1001',
  delivery = 'private-reply',
  intent = 'supply-promise',
  offerValue = offer(delivery.startsWith('public-') ? 'room' : 'private'),
  snapshotValue = snapshot(),
  sourceOverrides = {},
  destinationOverrides = {},
  termsValue = terms(),
  agreementEvidence = null,
} = {}) {
  const room = delivery.startsWith('public-');
  const source = {
    conversationType: room ? 'room' : 'private',
    conversationId: room ? 'Sales' : 'company-77',
    messageId: offerValue.source.messageId,
    counterpartyCompanyId: '77',
    counterpartyCompanyName: 'HEMLOCK ENTERPRISE',
    createdAt: offerValue.source.createdAt,
    observedAt: AS_OF,
    visibleText: 'BUY 10k Water Q0 @0.37',
    conversationHref: delivery === 'public-reply'
      ? 'https://www.simcompanies.com/messages/HEMLOCK-ENTERPRISE-chatroom_Sales/'
      : null,
    ...sourceOverrides,
  };
  const destination = room ? {
    conversationType: 'room',
    conversationId: 'Sales',
    room: 'Sales',
    ...destinationOverrides,
  } : {
    conversationType: 'private',
    conversationId: 'company-77',
    targetCompany: 'HEMLOCK ENTERPRISE',
    targetCompanyId: 77,
    ...destinationOverrides,
  };
  return {
    attemptId,
    intent,
    delivery,
    source,
    destination,
    terms: termsValue,
    offer: offerValue,
    businessSnapshot: snapshotValue,
    agreementEvidence,
    trustedResourceCatalog: null,
  };
}

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-chat-economic-auth-'));
  return { directory, file: path.join(directory, 'authorizations.json') };
}

test('trusted issuance generates and durably binds a private supply promise without storing plaintext', () => {
  const { directory, file } = temporaryStore();
  try {
    const issued = issueCommunicationAuthorization(file, request(), { now: NOW });
    assert.equal(issued.ok, true);
    assert.equal(issued.actionName, 'chat_private_send');
    assert.equal(issued.actionParams.text, 'Can supply 10k Water Q0 at $0.37. Send contract?');
    assert.equal(issued.actionParams.targetCompanyId, 77);
    assert.equal(issued.artifact.attemptId, 'economic-attempt-1001');
    assert.match(issued.artifact.commitmentId, /^commitment:/u);
    assert.deepEqual(issued.artifact.terms, terms());
    assert.equal(issued.artifact.source.messageId, '1001');
    assert.deepEqual(issued.artifact.destination, {
      conversationType: 'private',
      conversationId: 'company-77',
      targetCompany: 'HEMLOCK ENTERPRISE',
      targetCompanyId: 77,
    });
    assert.equal(issued.artifact.economics.snapshotId, 'business-snapshot-1001');
    assert.equal(issued.artifact.economics.inputs.reserveAmount, 4_000);
    assert.equal(issued.artifact.economics.metrics.opportunityGain, 200);
    assert.equal(issued.artifact.requiredPostcondition.maxClicks, 1);
    assert.equal(issued.artifact.requiredPostcondition.retryAfterConsumption, false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const durableText = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(durableText, /Can supply|BUY 10k Water/u);
    assert.equal(readAuthorizationStore(file).recordsByAttemptId['economic-attempt-1001']
      .lifecycle.status, 'AUTHORIZED');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('public quote is generated as structured UI parts and binds exact reply source and destination', () => {
  const { directory, file } = temporaryStore();
  try {
    const issued = issueCommunicationAuthorization(file, request({
      attemptId: 'public-economic-1001',
      delivery: 'public-reply',
      intent: 'quote',
    }), { now: NOW });
    assert.equal(issued.actionName, 'chat_room_reply');
    assert.equal(issued.actionParams.reason, 'reply');
    assert.equal(issued.actionParams.bodyContains, 'BUY 10k Water Q0 @0.37');
    assert.equal(issued.actionParams.conversationHref,
      'https://www.simcompanies.com/messages/HEMLOCK-ENTERPRISE-chatroom_Sales/');
    assert.deepEqual(issued.actionParams.parts[1], {
      type: 'resource', value: null, kind: 2, name: 'Water',
    });
    const inspected = inspectCommunicationAuthorization(
      file,
      issued.actionName,
      issued.actionParams,
      { now: NOW + 1_000 },
    );
    assert.equal(inspected.ok, true);
    assert.equal(inspected.artifact.counterparty.companyId, '77');
    assert.equal(inspected.artifact.requiredPostcondition.kind, 'public-rendered-reply');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('external SELL can produce only an evidenced structured BUY room reply', () => {
  const sellerMessage = normalizeMessage({
    ...externalMessage('room'),
    content: {
      text: 'SELL 10k :re-2: Q0 @0.37',
      language: 'en',
      resourceMentions: [{ kind: 2, name: 'Water' }],
    },
  });
  const sellerOffer = extractTradeLeads(sellerMessage).offers[0];
  const buyingSnapshot = snapshot({ inventory: [] });
  const { directory, file } = temporaryStore();
  try {
    const issued = issueCommunicationAuthorization(file, request({
      attemptId: 'public-economic-buy-1001',
      delivery: 'public-reply',
      intent: 'quote',
      offerValue: sellerOffer,
      snapshotValue: buyingSnapshot,
      sourceOverrides: { visibleText: 'SELL 10k Water Q0 @0.37' },
      termsValue: terms({ ourSide: 'buy' }),
    }), { now: NOW });
    assert.equal(issued.actionName, 'chat_room_reply');
    assert.equal(issued.actionParams.parts[0].value, 'BUY 10k ');
    assert.deepEqual(issued.actionParams.parts[1], {
      type: 'resource', value: null, kind: 2, name: 'Water',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('proactive public offer is re-derived from the exact snapshot before a structured post', () => {
  const catalog = {
    schemaVersion: 1,
    trust: 'internal-verified',
    entries: [{ kind: 2, name: 'Water' }],
  };
  const [intent] = deriveProactivePublicIntents(snapshot(), {
    roomId: 'Sales', trustedResourceCatalog: catalog, now: NOW,
  });
  assert.ok(intent);
  const proactiveRequest = {
    attemptId: 'proactive-public-1001',
    intent: 'public-offer',
    delivery: 'public-post',
    source: {
      conversationType: 'room',
      conversationId: 'Sales',
      messageId: intent.offer.source.messageId,
      counterpartyCompanyId: intent.offer.source.counterpartyCompanyId,
      counterpartyCompanyName: intent.offer.source.counterpartyCompanyName,
      createdAt: intent.offer.source.createdAt,
      observedAt: intent.offer.source.observedAt,
      visibleText: 'Verified internal business intent',
      conversationHref: null,
    },
    destination: { conversationType: 'room', conversationId: 'Sales', room: 'Sales' },
    terms: intent.terms,
    offer: intent.offer,
    businessSnapshot: snapshot(),
    agreementEvidence: null,
    trustedResourceCatalog: catalog,
  };
  const built = buildAuthorization(proactiveRequest, { now: NOW });
  assert.equal(built.actionName, 'chat_room_post');
  assert.equal(built.actionParams.confirm, true);
  assert.deepEqual(built.actionParams.parts[1], {
    type: 'resource', value: null, kind: 2, name: 'Water',
  });
  assert.equal(built.artifact.economics.evaluator,
    'business-intent-v1+lead-engine-v1+contract-gate-v1');
  assert.throws(() => buildAuthorization({
    ...proactiveRequest,
    terms: { ...proactiveRequest.terms, quantity: proactiveRequest.terms.quantity + 1 },
  }, { now: NOW }), /does not match|terms/u);
});

test('agreement text requires explicit fresh agreement evidence bound to exact terms and source', () => {
  const { directory, file } = temporaryStore();
  try {
    const exactTerms = terms();
    const agreementEvidence = {
      schemaVersion: 1,
      status: 'explicit',
      observedAt: AS_OF,
      sourceMessageId: '2002',
      counterpartyCompanyId: '77',
      termsHash: contractTermsHash(exactTerms),
    };
    const issued = issueCommunicationAuthorization(file, request({
      attemptId: 'agreement-attempt-1001',
      intent: 'agreement',
      sourceOverrides: {
        messageId: '2002',
        visibleText: 'Agreed: 10k Water Q0 at $0.37.',
      },
      termsValue: exactTerms,
      agreementEvidence,
    }), { now: NOW });
    assert.equal(issued.actionParams.text, 'Agreed: 10k Water Q0 at $0.37.');
    assert.equal(issued.artifact.source.messageId, '2002');
    assert.ok(issued.artifact.economics.agreementEvidenceFingerprint);

    assert.throws(() => issueCommunicationAuthorization(
      path.join(directory, 'missing-agreement.json'),
      request({ intent: 'agreement', agreementEvidence: null }),
      { now: NOW },
    ), /explicit exact-term agreement|agreement source/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale, incomplete, reserve-unsafe, and uneconomic evidence fail closed before authorization', () => {
  const { directory, file } = temporaryStore();
  try {
    const staleSnapshot = snapshot({ observedAt: '2026-07-27T14:00:00.000Z' });
    assert.throws(() => issueCommunicationAuthorization(file, request({
      snapshotValue: staleSnapshot,
    }), { now: NOW }), /economic evidence is incomplete|stale/u);

    const incomplete = snapshot();
    delete incomplete.inventory[0].reserveAmount;
    assert.throws(() => issueCommunicationAuthorization(file, request({
      attemptId: 'economic-attempt-1002',
      snapshotValue: incomplete,
    }), { now: NOW }), /reserveAmount is UNKNOWN|incomplete/u);

    const reserveUnsafe = snapshot();
    reserveUnsafe.inventory[0].reserveAmount = 15_000;
    assert.throws(() => issueCommunicationAuthorization(file, request({
      attemptId: 'economic-attempt-1003',
      snapshotValue: reserveUnsafe,
    }), { now: NOW }), /negotiable maximum/u);

    assert.throws(() => issueCommunicationAuthorization(file, request({
      attemptId: 'economic-attempt-1004',
      termsValue: terms({ unitPrice: '0.20' }),
    }), { now: NOW }), /accounting profit|best verified alternative/u);

    assert.throws(() => issueCommunicationAuthorization(file, request({
      attemptId: 'economic-attempt-1005',
      sourceOverrides: { observedAt: '2026-07-27T14:00:00.000Z' },
    }), { now: NOW }), /source message evidence is stale/u);

    const polluted = snapshot();
    polluted.finance.apiKey = 'must-not-enter-evidence';
    assert.throws(() => issueCommunicationAuthorization(file, request({
      attemptId: 'economic-attempt-1006',
      snapshotValue: polluted,
    }), { now: NOW }), /unknown fields/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('exact action, attempt, counterparty, source, destination, content, and expiry are immutable', () => {
  const { directory, file } = temporaryStore();
  try {
    const issued = issueCommunicationAuthorization(file, request(), { now: NOW });
    const changedCases = [
      ['attempt', { ...issued.actionParams, attemptId: 'economic-attempt-9999' }],
      ['counterparty ID', { ...issued.actionParams, targetCompanyId: 78 }],
      ['counterparty name', { ...issued.actionParams, targetCompany: 'OTHER COMPANY' }],
      ['source', { ...issued.actionParams, inReplyToText: 'BUY 9k Water Q0 @0.37' }],
      ['content/terms', { ...issued.actionParams, text: 'Can supply 9k Water Q0 at $0.37. Send contract?' }],
    ];
    for (const [label, params] of changedCases) {
      const inspected = inspectCommunicationAuthorization(file, issued.actionName, params, { now: NOW });
      assert.equal(inspected.ok, false, label);
    }
    const expired = inspectCommunicationAuthorization(
      file,
      issued.actionName,
      issued.actionParams,
      { now: NOW + 5 * 60 * 1000 },
    );
    assert.equal(expired.ok, false);
    assert.match(expired.reason, /expired/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('authorization is atomically single-use and records the exact required postcondition', () => {
  const { directory, file } = temporaryStore();
  try {
    const issued = issueCommunicationAuthorization(file, request(), { now: NOW });
    const first = consumeCommunicationAuthorization(
      file,
      issued.actionName,
      issued.actionParams,
      { now: NOW + 1_000 },
    );
    assert.equal(first.ok, true);
    const second = consumeCommunicationAuthorization(
      file,
      issued.actionName,
      issued.actionParams,
      { now: NOW + 2_000 },
    );
    assert.equal(second.ok, false);
    assert.equal(second.doNotRetry, true);

    const outcome = recordCommunicationOutcome(file, {
      actionName: issued.actionName,
      attemptId: issued.actionParams.attemptId,
      commitmentId: first.commitmentId,
      result: {
        ok: true,
        posted: true,
        mutationAttempted: true,
        attemptId: issued.actionParams.attemptId,
        targetCompany: 'HEMLOCK ENTERPRISE',
        targetCompanyId: 77,
        postcondition: 'unique-added-own-node+cleared-composer+exact-destination',
      },
      now: NOW + 3_000,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 'VERIFIED');
    assert.equal(readAuthorizationStore(file).recordsByAttemptId['economic-attempt-1001']
      .lifecycle.status, 'VERIFIED');
    assert.equal(recordCommunicationOutcome(file, {
      actionName: issued.actionName,
      attemptId: issued.actionParams.attemptId,
      commitmentId: first.commitmentId,
      result: {},
      now: NOW + 4_000,
    }).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('caller-supplied verified-offer reason is never economic evidence at the act boundary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-chat-act-economic-'));
  try {
    const historyFile = path.join(directory, 'history.jsonl');
    const authorizationFile = path.join(directory, 'authorizations.json');
    const result = spawnSync(process.execPath, [
      path.join(AUTOPILOT, 'act.js'),
      'chat_room_post',
      JSON.stringify({
        room: 'Sales',
        parts: [
          { type: 'text', value: 'SELL 10k ', kind: null, name: null },
          { type: 'resource', value: null, kind: 2, name: 'Water' },
          { type: 'text', value: ' Q0 @0.37', kind: null, name: null },
        ],
        reason: 'verified-offer',
        attemptId: 'caller-verified-offer-1001',
        confirm: true,
      }),
    ], {
      cwd: path.dirname(AUTOPILOT),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SIM_CHAT_MODE: 'full',
        SIM_CHAT_HISTORY_FILE: historyFile,
        SIM_CHAT_COMMUNICATION_AUTH_FILE: authorizationFile,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.ok, false);
    assert.equal(output.guard, true);
    assert.match(output.reason, /no durable economic communication authorization/u);
    assert.equal(fs.existsSync(historyFile), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('economic-language detection gates commitments but leaves ordinary operational replies alone', () => {
  assert.equal(requiresEconomicCommunicationAuthorization('chat_private_send', {
    confirm: true,
    text: 'Can supply 10k Water Q0 at $0.37.',
  }), true);
  assert.equal(requiresEconomicCommunicationAuthorization('chat_room_post', {
    confirm: true,
    reason: 'verified-offer',
  }, 'Inventory updated.'), true);
  assert.equal(requiresEconomicCommunicationAuthorization('chat_room_reply', {
    confirm: true,
    reason: 'reply',
    parts: [{ type: 'resource', kind: 2, name: 'Water' }],
  }, 'Available.'), true);
  assert.equal(requiresEconomicCommunicationAuthorization('chat_private_send', {
    confirm: true,
    text: 'Sounds good.',
  }), true);
  assert.equal(requiresEconomicCommunicationAuthorization('chat_private_send', {
    confirm: true,
    text: 'Thanks, checking availability now.',
  }), false);
  assert.equal(requiresEconomicCommunicationAuthorization('chat_private_send', {
    confirm: false,
    text: 'Can supply 10k Water Q0 at $0.37.',
  }), false);
});

test('malformed, oversized, or symlink authorization stores fail closed', () => {
  const { directory, file } = temporaryStore();
  try {
    fs.writeFileSync(file, '{bad json}', { mode: 0o600 });
    assert.throws(() => readAuthorizationStore(file), /invalid JSON/u);
    fs.writeFileSync(file, 'x'.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => readAuthorizationStore(file), /regular bounded/u);
    fs.unlinkSync(file);
    const target = path.join(directory, 'outside.json');
    fs.writeFileSync(target, '{}', { mode: 0o600 });
    fs.symlinkSync(target, file);
    assert.throws(() => readAuthorizationStore(file), /regular bounded/u);
    assert.throws(() => issueCommunicationAuthorization(file, request(), { now: NOW }), /regular bounded/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
