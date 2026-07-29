'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_PRIVATE_NOTE_CHARS,
  chooseExactContact,
  normalizeContactList,
  planContactAction,
  validatePrivateNote,
  verifyContactTransition,
} = require('../chat/contact-ui');
const {
  normalizeSubscriptions,
  parseChatroomSettingsRoute,
  planSubscriptionChange,
  verifySubscriptionTransition,
} = require('../chat/subscription-ui');
const {
  chooseExactMessagePane,
  planMessageAction,
  selectExactMessage,
  verifyMessageTransition,
} = require('../chat/message-ui');

const contact = {
  companyId: 7812345,
  company: 'Pavanium Inc Corp',
  unread: 2,
  pinned: false,
  ignored: false,
  privateNote: 'Water buyer',
  href: '/messages/Pavanium Inc Corp-chatroom_Sales/',
  visible: true,
};

const ACTIONS = [
  'chat-contact-list.js',
  'chat-contact-read.js',
  'chat-contact-settings.js',
  'chat-contact-manage.js',
  'chat-contact-note.js',
  'chat-contact-report.js',
  'chat-subscription-list.js',
  'chat-subscription-toggle.js',
  'chat-message-translate.js',
  'chat-message-retract-prepare.js',
  'chat-message-retract-confirm.js',
];

test('contact normalization requires unique exact company IDs and names', () => {
  assert.equal(normalizeContactList([contact]).ok, true);
  assert.equal(normalizeContactList([contact, contact]).ok, false);
  assert.equal(normalizeContactList([{ ...contact, companyId: null }]).ok, false);
  assert.equal(normalizeContactList([{ ...contact, ignored: undefined }]).contacts[0].ignored, null);
  assert.equal(planContactAction({
    action: 'ignore', contact: { ...contact, ignored: undefined },
  }).unsupported, true);
  assert.equal(chooseExactContact([contact], {
    companyId: contact.companyId,
    company: 'PAVANIUM INC CORP',
  }).contact.companyId, contact.companyId);
  assert.equal(chooseExactContact([contact], {
    companyId: contact.companyId,
    company: 'Pavanium Inc',
  }).ok, false);
});

test('contact changes are state-bound and fail closed on unsupported or redundant actions', () => {
  assert.equal(planContactAction({ action: 'pin', contact }).ok, true);
  assert.equal(planContactAction({ action: 'unpin', contact }).ok, false);
  assert.equal(planContactAction({ action: 'ignore', contact }).ok, true);
  assert.equal(planContactAction({ action: 'unignore', contact }).ok, false);
  assert.equal(planContactAction({ action: 'invent-control', contact }).unsupported, true);
  assert.equal(planContactAction({
    action: 'note_save', contact, note: 'Reliable supplier',
  }).persistent, true);
});

test('private notes use the measured 2000-character UI limit', () => {
  assert.equal(MAX_PRIVATE_NOTE_CHARS, 2000);
  assert.equal(validatePrivateNote('x'.repeat(2000)).ok, true);
  assert.equal(validatePrivateNote('x'.repeat(2001)).ok, false);
});

test('contact postconditions require an exact rendered state transition', () => {
  assert.equal(verifyContactTransition({
    action: 'pin', before: contact, after: { ...contact, pinned: true },
  }).ok, true);
  assert.equal(verifyContactTransition({
    action: 'pin', before: contact, after: contact,
  }).doNotRetry, true);
  assert.equal(verifyContactTransition({
    action: 'hide', before: contact, after: null,
  }).ok, true);
  assert.equal(verifyContactTransition({
    action: 'note_save',
    before: contact,
    after: { ...contact, privateNote: 'A'.repeat(32) },
    note: 'A'.repeat(50),
  }).ok, true);
  assert.equal(verifyContactTransition({
    action: 'report_prepare', before: contact, confirmationVisible: false,
  }).doNotRetry, true);
});

test('subscription settings route is exact and realm-bound', () => {
  assert.deepEqual(parseChatroomSettingsRoute(
    'https://www.simcompanies.com/account-settings/chatrooms/0/'), {
    realmId: 0,
    pathname: '/account-settings/chatrooms/0/',
  });
  assert.deepEqual(parseChatroomSettingsRoute(
    'https://www.simcompanies.com/account-settings/chatrooms/1/'), {
    realmId: 1,
    pathname: '/account-settings/chatrooms/1/',
  });
  assert.equal(parseChatroomSettingsRoute(
    'https://www.simcompanies.com/messages/chatroom_Sales/'), null);
});

test('subscribe and unsubscribe plans bind dbLetter plus exact rendered name', () => {
  const rooms = [
    { dbLetter: 'Sales', name: 'Sales', subscribed: true, disabled: false },
    { dbLetter: 'Aerospace sales', name: 'Aerospace sales', subscribed: false, disabled: false },
  ];
  assert.equal(normalizeSubscriptions(rooms).ok, true);
  assert.equal(planSubscriptionChange({
    records: rooms,
    dbLetter: 'Aerospace sales',
    name: 'Aerospace sales',
    subscribe: true,
  }).ok, true);
  assert.equal(planSubscriptionChange({
    records: rooms,
    dbLetter: 'Sales',
    name: 'Sale',
    subscribe: false,
  }).ok, false);
  assert.equal(planSubscriptionChange({
    records: [{ ...rooms[1], disabled: true }],
    dbLetter: 'Aerospace sales',
    name: 'Aerospace sales',
    subscribe: true,
  }).unsupported, true);
});

test('subscription postcondition needs both checkbox state and one fresh save acknowledgement', () => {
  const before = { dbLetter: 'Sales', name: 'Sales', subscribed: true, disabled: false };
  const after = { ...before, subscribed: false };
  assert.equal(verifySubscriptionTransition({
    before, after, subscribe: false, successDelta: 1,
  }).ok, true);
  const ambiguous = verifySubscriptionTransition({
    before, after, subscribe: false, successDelta: 0,
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.doNotRetry, true);
});

test('dual-pane selection scopes private and public controls independently', () => {
  const panes = [
    {
      id: 'private-pavanium', kind: 'private', target: 'PAVANIUM INC CORP', visible: true,
      textareaCount: 1, sendButtonCount: 1, messages: [],
    },
    {
      id: 'public-sales', kind: 'public', target: 'SALES', visible: true,
      textareaCount: 1, sendButtonCount: 1, messages: [],
    },
  ];
  assert.equal(chooseExactMessagePane(panes, {
    kind: 'private', target: 'Pavanium Inc Corp',
  }).pane.id, 'private-pavanium');
  assert.equal(chooseExactMessagePane(panes, {
    kind: 'public', target: 'Sales',
  }).pane.id, 'public-sales');
  assert.equal(chooseExactMessagePane([
    ...panes, { ...panes[1], id: 'duplicate-sales' },
  ], { kind: 'public', target: 'Sales' }).ok, false);
});

test('message action selection rejects duplicate bodies and unsupported controls', () => {
  const incoming = {
    text: 'Bonjour, prix?', sender: 'Pavanium Inc Corp', fromMe: false,
    translateControl: true, retractControl: false, retracted: false,
  };
  assert.equal(selectExactMessage([incoming], {
    sourceText: incoming.text, sender: incoming.sender, fromMe: false,
  }).ok, true);
  assert.equal(selectExactMessage([incoming, incoming], {
    sourceText: incoming.text, sender: incoming.sender, fromMe: false,
  }).ok, false);
  assert.equal(planMessageAction({ action: 'translate', message: incoming }).ok, true);
  assert.equal(planMessageAction({
    action: 'retract_prepare', message: incoming,
  }).unsupported, true);
  assert.equal(planMessageAction({ action: 'forward', message: incoming }).unsupported, true);
});

test('translate and retract postconditions require exact UI evidence', () => {
  const incoming = {
    text: 'Bonjour, prix?', fromMe: false, translateControl: true,
  };
  assert.equal(verifyMessageTransition({
    action: 'translate',
    before: incoming,
    after: { ...incoming, translateControl: false, translation: 'Hello, price?' },
  }).ok, true);
  const own = {
    text: 'SELL 10k Water Q0 @0.37', fromMe: true,
    retractControl: true, retracted: false,
  };
  assert.equal(verifyMessageTransition({
    action: 'retract_prepare', before: own, confirmationVisible: true,
  }).ok, true);
  assert.equal(verifyMessageTransition({
    action: 'retract_confirm',
    before: own,
    after: { ...own, retractControl: false, retracted: true },
  }).ok, true);
  assert.equal(verifyMessageTransition({
    action: 'retract_confirm', before: own, after: own,
  }).doNotRetry, true);
});

test('all fragments compile, avoid direct write transports, and click at most once', () => {
  const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
  const actionsDir = path.join(__dirname, '..', 'actions');
  for (const filename of ACTIONS) {
    const source = fs.readFileSync(path.join(actionsDir, filename), 'utf8');
    assert.doesNotThrow(() => new AsyncFunction(source), filename);
    assert.doesNotMatch(
      source,
      /\bfetch\s*\(|\bXMLHttpRequest\b|\/api\/|axios|le\(\)\.(?:post|patch|delete|get)/iu,
      filename,
    );
    assert.doesNotMatch(source, /__react(?:Fiber|Props|EventHandlers|InternalInstance)/u, filename);
    const clickCount = (source.match(/\.click\(\)/gu) || []).length;
    assert.ok(clickCount <= 1, `${filename} must click at most once, observed ${clickCount}`);
    if (clickCount === 1) {
      assert.ok(source.indexOf('confirm !== true') < source.indexOf('.click()'),
        `${filename} must dry-read before its only click`);
      assert.match(source, /doNotRetry/u, filename);
    }
  }
});

test('contact list never claims completeness without a rendered pagination boundary', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'actions', 'chat-contact-list.js'), 'utf8');
  assert.match(source, /complete:\s*false/u);
  assert.match(source, /UNKNOWN_NO_PAGINATION_BOUNDARY_EVIDENCE/u);
});

test('UI fragments contain measured semantic selectors and fail-closed language', () => {
  const actionsDir = path.join(__dirname, '..', 'actions');
  const contact = fs.readFileSync(path.join(actionsDir, 'chat-contact-manage.js'), 'utf8');
  const subscriptions = fs.readFileSync(path.join(actionsDir, 'chat-subscription-toggle.js'), 'utf8');
  const translate = fs.readFileSync(path.join(actionsDir, 'chat-message-translate.js'), 'utf8');
  const retract = fs.readFileSync(path.join(actionsDir, 'chat-message-retract-prepare.js'), 'utf8');
  assert.match(contact, /icon: 'eye-slash'/u);
  assert.match(contact, /icon: 'ban'/u);
  assert.match(contact, /icon: 'flag'/u);
  assert.match(subscriptions, /input\[type="checkbox"\]\[name\]/u);
  assert.match(translate, /pane\.querySelectorAll/u);
  assert.match(translate, /svg\[data-icon="language"\]/u);
  assert.match(retract, /svg\[data-icon="retract"\]/u);
  for (const source of [contact, subscriptions, translate, retract]) {
    assert.match(source, /unsupported|ambiguous/u);
  }
});
