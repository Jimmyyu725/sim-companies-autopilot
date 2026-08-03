'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  actionTargetKey,
  validateActionParams,
} = require('../action-contracts.js');
const {
  CHAT_PREVIEW_ACTIONS,
  WakeRuntimeGuard,
} = require('../runtime-guard.js');
const {
  authorizeChatAction,
} = require('../chat/runtime-mode.js');
const {
  executionBindingHash,
} = require('../chat/execution-claim.js');

const manage = Object.freeze({
  targetCompany: 'Pavanium Inc Corp',
  targetCompanyId: 7812345,
  contactAction: 'pin',
  attemptId: 'contact-pin-001',
  confirm: false,
});
const contractAccept = Object.freeze({
  contractId: '9001',
  termsHash: 'a'.repeat(64),
  evidenceFingerprint: 'b'.repeat(64),
  previewId: 'c'.repeat(64),
  economicPreviewId: 'd'.repeat(64),
  attemptId: 'contract-accept-test-0001',
  preview: Object.freeze({ schemaVersion: 2 }),
  authorization: Object.freeze({ schemaVersion: 1 }),
  confirm: false,
});

test('central contact, message, subscription, and contract actions have strict schemas', () => {
  assert.equal(validateActionParams('chat_contact_manage', manage).ok, true);
  assert.equal(validateActionParams('chat_contact_manage', {
    ...manage,
    contactAction: 'invent-control',
  }).ok, false);
  assert.equal(validateActionParams('chat_contact_note', {
    targetCompany: manage.targetCompany,
    targetCompanyId: manage.targetCompanyId,
    note: '',
    attemptId: 'contact-note-001',
    confirm: false,
  }).ok, true);
  assert.equal(validateActionParams('chat_message_retract', {
    room: 'Sales',
    sourceText: 'SELL 10k Water Q0 @0.37',
    attemptId: 'retract-msg-001',
    confirm: false,
  }).ok, true);
  assert.equal(validateActionParams('chat_contract_list', { limit: 50 }).ok, true);
  assert.equal(validateActionParams('chat_contract_preview', {
    contractId: '9001',
    ownCompanyId: '900100',
    terms: {
      counterpartyCompanyId: '7812345',
      ourSide: 'buy',
      quality: 0,
      quantity: 100,
      resourceKind: 2,
      unitPrice: '0.37',
    },
    termsHash: 'a'.repeat(64),
    confirm: false,
  }).ok, true);
  assert.equal(validateActionParams('contract_accept', contractAccept).ok, true);
  assert.equal(validateActionParams('contract_accept', {
    ...contractAccept,
    contractId: 'guessed-row',
  }).ok, false);
  assert.match(executionBindingHash('contract_accept', {
    ...contractAccept,
    confirm: true,
  }), /^[0-9a-f]{64}$/u);
});

test('new mutation confirmations remain disabled by the default shadow mode', () => {
  for (const action of [
    'chat_contact_manage',
    'chat_contact_note',
    'chat_contact_report',
    'chat_subscription_toggle',
    'chat_message_translate',
    'chat_message_retract',
  ]) {
    const result = authorizeChatAction(action, { confirm: true }, 'shadow');
    assert.equal(result.ok, false, action);
    assert.equal(result.guard, true, action);
  }
});

test('every centrally enabled chat mutation requires an exact same-wake preview', () => {
  for (const action of [
    'chat_contact_manage',
    'chat_contact_note',
    'chat_contact_report',
    'chat_subscription_toggle',
    'chat_message_translate',
    'chat_message_retract',
  ]) assert.equal(CHAT_PREVIEW_ACTIONS.has(action), true, action);

  const guard = new WakeRuntimeGuard();
  assert.match(guard.beforeAction('chat_contact_manage', {
    ...manage,
    confirm: true,
  }).reason, /exact-target preview/u);

  guard.afterAction('chat_contact_manage', manage, {
    ok: true,
    dry: true,
    preview: true,
    exactTargetEvidence: true,
  });
  assert.match(guard.beforeAction('chat_contact_manage', {
    ...manage,
    contactAction: 'ignore',
    confirm: true,
  }).reason, /differs/u);
  assert.equal(guard.beforeAction('chat_contact_manage', {
    ...manage,
    confirm: true,
  }), null);
  assert.match(guard.beforeAction('chat_contact_manage', {
    ...manage,
    confirm: true,
  }).reason, /exact-target preview/u);
});

test('an evidence refresh invalidates a chat mutation preview', () => {
  const guard = new WakeRuntimeGuard();
  guard.afterAction('chat_contact_manage', manage, { ok: true, dry: true });
  guard.noteEvidenceChange('fresh-contact-read');
  assert.match(guard.beforeAction('chat_contact_manage', {
    ...manage,
    confirm: true,
  }).reason, /exact-target preview/u);
});

test('a superficial UI preview cannot unlock confirmation', () => {
  const guard = new WakeRuntimeGuard();
  guard.afterAction('chat_private_start', {
    targetCompany: 'Pavanium Inc Corp',
    targetCompanyId: 7812345,
    targetRealmId: 0,
    confirm: false,
  }, {
    ok: true,
    dry: true,
    targetCompany: 'Pavanium Inc Corp',
    targetCompanyId: 7812345,
    targetRealmId: 0,
  });
  assert.match(guard.beforeAction('chat_private_start', {
    targetCompany: 'Pavanium Inc Corp',
    targetCompanyId: 7812345,
    targetRealmId: 0,
    confirm: true,
  }).reason, /exact-target preview/u);
});

test('failure budgets receive exact central chat target keys', () => {
  assert.equal(actionTargetKey('chat_contact_manage', manage),
    'chat_contact_manage:7812345:pin');
  assert.equal(actionTargetKey('chat_contract_preview', { contractId: '9001' }),
    'chat_contract_preview:9001');
});

test('act centrally dispatches every completed UI helper and removes the legacy contract API path', () => {
  const actSource = fs.readFileSync(path.join(__dirname, '..', 'act.js'), 'utf8');
  for (const [action, fragment] of [
    ['chat_contact_manage', 'chat-contact-manage.js'],
    ['chat_contact_note', 'chat-contact-note.js'],
    ['chat_contact_report', 'chat-contact-report.js'],
    ['chat_subscription_toggle', 'chat-subscription-toggle.js'],
    ['chat_message_translate', 'chat-message-translate.js'],
    ['chat_message_retract', 'chat-message-retract-confirm.js'],
    ['chat_contract_list', 'chat-contract-list.js'],
    ['chat_contract_preview', 'chat-contract-preview.js'],
  ]) {
    assert.match(actSource, new RegExp(`action === '${action}'`, 'u'), action);
    assert.match(actSource, new RegExp(fragment.replace('.', '\\.')), fragment);
  }
  const acceptBranch = actSource.slice(actSource.indexOf("} else if (action === 'contract_accept')"),
    actSource.indexOf("} else if (action === 'contract_send')"));
  assert.match(acceptBranch, /chat-contract-accept\.js/u);
  assert.doesNotMatch(acceptBranch, /page\('contract-accept\.js'\)/u);
  assert.doesNotMatch(acceptBranch, /\/api\//u);
});

test('shadow confirmations and unclaimed contract acceptance refuse before browser access', () => {
  const act = path.join(__dirname, '..', 'act.js');
  const run = (action, params, environment = {}) => {
    const child = spawnSync(process.execPath, [act, action, JSON.stringify(params)], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, ...environment },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
  };
  const shadow = run('chat_contact_manage', { ...manage, confirm: true }, {
    SIM_CHAT_MODE: 'shadow',
  });
  assert.equal(shadow.ok, false);
  assert.equal(shadow.guard, true);
  assert.match(shadow.reason, /disabled in chat mode shadow/u);

  const acceptance = run('contract_accept', {
    ...contractAccept,
    confirm: true,
  }, { SIM_CHAT_MODE: 'full' });
  assert.equal(acceptance.ok, false);
  assert.equal(acceptance.doNotClick, true);
  assert.equal(acceptance.clickCount, 0);
  assert.equal(acceptance.mutationAuthorized, false);
  assert.equal(acceptance.doNotRetry, true);
  assert.match(acceptance.reason, /worker execution claim/u);
});
