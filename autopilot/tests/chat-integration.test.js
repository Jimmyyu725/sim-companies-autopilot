'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const AUTOPILOT = path.resolve(__dirname, '..');
const {
  ACTION_NAMES,
  responsesActionTools,
  validateActionParams,
} = require('../action-contracts.js');
const {
  CHAT_MUTATION_ACTIONS,
  authorizeChatAction,
  resolveChatMode,
} = require('../chat/runtime-mode.js');
const { prepareChatIngest } = require('../chat/ingest.js');
const { appendPublicHistory, claimPublicAttempt, readPublicHistory } = require('../chat/public-history.js');
const { WakeRuntimeGuard } = require('../runtime-guard.js');

const textPart = value => ({ type: 'text', value, kind: null, name: null });
const resourcePart = (kind, name = null) => ({ type: 'resource', value: null, kind, name });

test('default chat mode is shadow and every confirmed chat mutation fails closed', () => {
  assert.equal(resolveChatMode({}), 'shadow');
  for (const action of CHAT_MUTATION_ACTIONS) {
    const blocked = authorizeChatAction(action, { confirm: true }, 'shadow');
    assert.equal(blocked.ok, false, action);
    assert.equal(blocked.guard, true, action);
  }
  assert.equal(authorizeChatAction('chat_post', { confirm: true }, 'read-only').ok, false);
  assert.equal(authorizeChatAction('chat_room_post', { confirm: false }, 'shadow').ok, true);
  assert.equal(authorizeChatAction('chat_room_read', {}, 'shadow').ok, true);
});

test('safe-reply permits only composite bound replies and private replies', () => {
  assert.equal(authorizeChatAction('chat_room_reply', { confirm: true }, 'safe-reply').ok, true);
  assert.equal(authorizeChatAction('chat_private_send', {
    confirm: true,
    targetCompanyId: 42,
    inReplyToText: 'Buying 100 Water',
  }, 'safe-reply').ok, true);
  assert.equal(authorizeChatAction('chat_private_send', {
    confirm: true,
    targetCompanyId: 42,
    inReplyToText: null,
  }, 'safe-reply').ok, false);
  assert.equal(authorizeChatAction('chat_room_post', { confirm: true }, 'safe-reply').ok, false);
  assert.equal(authorizeChatAction('chat_private_start', { confirm: true }, 'safe-reply').ok, false);
  assert.equal(authorizeChatAction('chat_private_send', {
    confirm: true,
    targetCompanyId: null,
    inReplyToText: 'Buying 100 Water',
  }, 'safe-reply').ok, false);
  assert.equal(authorizeChatAction('contract_send', { confirm: true }, 'full').ok, false);
});

test('off hides chat tools while shadow exposes reads and mutation previews', () => {
  const shadow = responsesActionTools({ chatMode: 'shadow' }).map(tool => tool.name);
  const off = responsesActionTools({ chatMode: 'off' }).map(tool => tool.name);
  assert.equal(shadow.length, ACTION_NAMES.length);
  assert(shadow.includes('chat_room_post'));
  assert(!off.some(name => name.startsWith('chat_')));
});

test('legacy chat_post confirm is blocked before act.js connects to Chrome', () => {
  const result = spawnSync(process.execPath, [
    path.join(AUTOPILOT, 'act.js'),
    'chat_post',
    JSON.stringify({ room: 'Sales', text: 'SELL 10 Power Q0 @0.40', confirm: true }),
  ], {
    cwd: path.dirname(AUTOPILOT),
    env: { ...process.env, SIM_CHAT_MODE: 'shadow' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.ok, false);
  assert.equal(output.mode, 'shadow');
  assert.match(output.reason, /preview-only/u);
});

test('direct contract confirmation is preview-only even in full mode and stops before Chrome', () => {
  const result = spawnSync(process.execPath, [
    path.join(AUTOPILOT, 'act.js'),
    'contract_send',
    JSON.stringify({ name: 'water', company: 'Buyer Corp', qty: 10, price: 1, lot: 0, confirm: true }),
  ], {
    cwd: path.dirname(AUTOPILOT),
    env: { ...process.env, SIM_CHAT_MODE: 'full' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.ok, false);
  assert.equal(output.guard, true);
  assert.match(output.reason, /preview-only/u);
});

test('structured public schemas are strict and preserve dual-pane reply binding fields', () => {
  const valid = validateActionParams('chat_room_reply', {
    room: 'Sales',
    company: 'HEMLOCK ENTERPRISE',
    bodyContains: 'Buying 10,000',
    conversationHref: null,
    sourceCompanyId: 42,
    sourceMessageId: '2001',
    sourceCreatedAt: '2026-07-27T07:59:00.000Z',
    parts: [textPart('SELL 100 '), resourcePart(2), textPart(' Q0 @0.40')],
    reason: 'reply',
    attemptId: 'reply-attempt-001',
    confirm: false,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.params.bodyContains, 'Buying 10,000');
  assert.equal(valid.params.conversationHref, null);
  assert.equal(validateActionParams('chat_room_post', {
    room: 'Sales',
    parts: [{ ...textPart('SELL'), extra: true }],
    reason: 'verified-offer',
    attemptId: 'post-attempt-001',
    confirm: false,
  }).ok, false);
  assert.equal(validateActionParams('chat_room_post', {
    room: 'Sales',
    parts: [textPart('SELL')],
    reason: 'verified-offer',
    attemptId: 'post-attempt-002',
    confirm: 'false',
  }).ok, false);
});

test('read-only chat actions do not dirty company-state refresh sequencing', () => {
  const guard = new WakeRuntimeGuard();
  assert.equal(guard.afterAction('chat_room_read', { room: 'Sales' }, { ok: true }), false);
  assert.equal(guard.afterAction('chat_rooms_discover', {}, { ok: true }), false);
  assert.equal(guard.dirty, false);
  assert.equal(guard.mutationVersion, 0);
  assert.equal(guard.afterAction('chat_private_send', { confirm: true }, {
    ok: false,
    mutationAttempted: true,
    ambiguous: true,
    doNotRetry: true,
  }), true);
});

test('UI observations without server IDs remain outside the strict message ledger', () => {
  const prepared = prepareChatIngest({
    conversationType: 'private',
    conversationId: 'Example Corp',
    observedAt: '2026-07-27T05:00:00.000Z',
    result: {
      thread: {
        messages: [{
          serverMessageId: null,
          observationFingerprint: 'ui-observation-fnv1a-1234abcd',
          direction: 'INCOMING',
          authorCompany: 'Example Corp',
          visibleBody: 'buy 10',
          resourceKinds: [1],
        }],
      },
    },
  });
  assert.equal(prepared.ledgerMessages.length, 0);
  assert.equal(prepared.observationSnapshot.ledgerIneligibleCount, 1);
  assert.equal(prepared.observationSnapshot.observations[0].serverMessageId, null);
});

test('IDs and timestamps without allowlisted UI provenance remain outside the strict ledger', () => {
  const prepared = prepareChatIngest({
    conversationType: 'private',
    conversationId: 'company-42',
    observedAt: '2026-07-27T05:00:00.000Z',
    result: { thread: { messages: [{
      serverMessageId: 9001,
      idStatus: 'UNKNOWN',
      authorCompany: 'Buyer Corp',
      authorCompanyId: 42,
      authorStatus: 'UNKNOWN',
      direction: 'INCOMING',
      directionStatus: 'UNKNOWN',
      visibleBody: 'BUY 10',
      exactCreatedAt: '2026-07-27T04:59:00.000Z',
      timeStatus: 'UNKNOWN',
    }] } },
  });
  assert.equal(prepared.ledgerMessages.length, 0);
  assert.equal(prepared.observationSnapshot.observations[0].serverMessageId, '9001');
  assert.equal(prepared.observationSnapshot.observations[0].idStatus, 'UNKNOWN');
});

test('only explicit IDs, exact times, and verified author identity enter the ledger', () => {
  const result = {
    groups: [{
      company: 'Buyer Corp',
      companyId: 42,
      authorStatus: 'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER',
      fromMe: false,
      directionStatus: 'VERIFIED_RENDERED_COMPONENT_AND_STYLE',
      exactTime: '2026-07-27T04:59:00.000Z',
      timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
      messages: [{
        messageId: 9001,
        idStatus: 'VERIFIED_RENDERED_COMPONENT_ID',
        timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
        text: 'BUY 10',
        resourceKinds: [2],
      }],
    }, {
      company: null,
      companyId: null,
      authorStatus: 'VERIFIED_RENDERED_COMPONENT_SELF_ID',
      fromMe: true,
      directionStatus: 'VERIFIED_RENDERED_COMPONENT_AND_STYLE',
      exactTime: '2026-07-27T04:59:30.000Z',
      timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
      messages: [{
        messageId: 9002,
        idStatus: 'VERIFIED_RENDERED_COMPONENT_ID',
        timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
        text: 'SELL 10',
        resourceKinds: [2],
      }],
    }],
  };
  const withoutOwnIdentity = prepareChatIngest({
    conversationType: 'room',
    conversationId: 'Sales',
    result,
    observedAt: '2026-07-27T05:00:00.000Z',
  });
  assert.deepEqual(withoutOwnIdentity.ledgerMessages.map(message => message.messageId), ['9001']);
  const withOwnIdentity = prepareChatIngest({
    conversationType: 'room',
    conversationId: 'Sales',
    result,
    observedAt: '2026-07-27T05:00:00.000Z',
    ownCompanyId: 900100,
    ownCompanyName: 'Verified Company Name',
  });
  assert.deepEqual(withOwnIdentity.ledgerMessages.map(message => message.messageId), ['9001', '9002']);
});

test('public ingestion preserves each component-verified message timestamp', () => {
  const prepared = prepareChatIngest({
    conversationType: 'room',
    conversationId: 'Sales',
    observedAt: '2026-07-27T05:00:00.000Z',
    result: {
      groups: [{
        company: 'Buyer Corp',
        companyId: 42,
        authorStatus: 'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER',
        fromMe: false,
        directionStatus: 'VERIFIED_RENDERED_COMPONENT_AND_STYLE',
        exactTime: '2026-07-27T04:58:00.000Z',
        timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
        messages: [
          {
            messageId: 9001,
            idStatus: 'VERIFIED_RENDERED_COMPONENT_ID',
            exactTime: '2026-07-27T04:58:00.000Z',
            timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
            text: 'BUY 10',
          },
          {
            messageId: 9002,
            idStatus: 'VERIFIED_RENDERED_COMPONENT_ID',
            exactTime: '2026-07-27T04:59:00.000Z',
            timeStatus: 'VERIFIED_RENDERED_COMPONENT_DATETIME',
            text: 'BUY 20',
          },
        ],
      }],
    },
  });
  assert.deepEqual(prepared.ledgerMessages.map(message => message.createdAt), [
    '2026-07-27T04:58:00.000Z',
    '2026-07-27T04:59:00.000Z',
  ]);
});

test('malformed public history fails closed and secure append creates mode 0600', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-chat-history-'));
  try {
    const file = path.join(directory, 'posts.jsonl');
    assert.deepEqual(readPublicHistory(file), []);
    fs.writeFileSync(file, '{not json}\n', { mode: 0o600 });
    assert.throws(() => readPublicHistory(file), /invalid JSON/u);
    fs.writeFileSync(file, '', { mode: 0o644 });
    appendPublicHistory(file, {
      t: Date.parse('2026-07-27T05:00:00.000Z'),
      room: 'Sales',
      text: 'SELL 10 Power Q0 @0.40',
      verified: true,
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(readPublicHistory(file).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('public attempts are durably armed once and symlink history paths fail closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-chat-attempt-'));
  try {
    const file = path.join(directory, 'posts.jsonl');
    const claim = {
      t: Date.parse('2026-07-27T05:00:00.000Z'),
      room: 'Sales',
      text: 'SELL 10 Power Q0 @0.40',
      verified: false,
      attemptId: 'public-attempt-001',
      status: 'ARMED',
    };
    assert.equal(claimPublicAttempt(file, claim).ok, true);
    assert.equal(claimPublicAttempt(file, claim).ok, false);
    assert.equal(readPublicHistory(file)[0].status, 'ARMED');

    appendPublicHistory(file, {
      ...claim,
      t: Date.parse('2026-07-27T05:00:01.000Z'),
      verified: true,
      status: 'VERIFIED',
    });
    const folded = readPublicHistory(file);
    assert.equal(folded.length, 1, 'one ARMED + outcome pair must count as one public attempt');
    assert.equal(folded[0].status, 'VERIFIED');

    const target = path.join(directory, 'outside.jsonl');
    const link = path.join(directory, 'linked.jsonl');
    fs.writeFileSync(target, '', { mode: 0o600 });
    fs.symlinkSync(target, link);
    assert.throws(() => readPublicHistory(link), /not a regular bounded file/u);
    assert.throws(() => appendPublicHistory(link, claim), /not a regular bounded file/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('act.js returns structured JSON before browser access when public history is corrupt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-chat-act-history-'));
  try {
    const file = path.join(directory, 'posts.jsonl');
    fs.writeFileSync(file, '{corrupt}\n', { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      path.join(AUTOPILOT, 'act.js'),
      'chat_room_post',
      JSON.stringify({
        room: 'Sales',
        parts: [textPart('SELL 10 Power Q0 @0.40')],
        reason: 'verified-offer',
        attemptId: 'public-attempt-corrupt',
        confirm: true,
      }),
    ], {
      cwd: path.dirname(AUTOPILOT),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SIM_CHAT_MODE: 'full',
        SIM_CHAT_HISTORY_FILE: file,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.ok, false);
    assert.equal(output.guard, true);
    assert.match(output.reason, /history is invalid/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat UI integration contains no direct chat write transport and imports have no runtime side effects', () => {
  const files = fs.readdirSync(path.join(AUTOPILOT, 'actions'))
    .filter(name => name.startsWith('chat-') && name.endsWith('.js'));
  for (const name of files) {
    const source = fs.readFileSync(path.join(AUTOPILOT, 'actions', name), 'utf8');
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|axios)\s*\(|\bapi\s*\(|\/api\//u, name);
  }
  const runtimeCandidates = ['CURRENT.json', 'contacts.json', 'outbox.jsonl', 'commitments.jsonl', 'audit.jsonl'];
  for (const name of runtimeCandidates) {
    assert.equal(fs.existsSync(path.join(AUTOPILOT, 'chat', name)), false, name);
  }
});
