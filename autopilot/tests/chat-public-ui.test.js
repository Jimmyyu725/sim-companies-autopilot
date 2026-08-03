'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { element, runAction } = require('./helpers/fake-chat-dom');
const {
  MAX_PUBLIC_POST_CHARS,
  MAX_PUBLIC_POST_LINES,
  buildPublicPostPlan,
  buttonSemantic,
  choosePublicRoomPane,
  directRoomFromHref,
  discoverRoomLinks,
  exactRenderedSignature,
  parseResourceAlt,
  replyPrefix,
  resourceSuggestionSpec,
  verifySingleSendTransition,
} = require('../chat/public-ui');

const ACTIONS = [
  'chat-room-discover.js',
  'chat-room-read.js',
  'chat-room-scroll.js',
  'chat-room-reply.js',
  'chat-room-post.js',
];

test('public posts are one line and at most 60 characters', () => {
  assert.equal(MAX_PUBLIC_POST_CHARS, 60);
  assert.equal(MAX_PUBLIC_POST_LINES, 1);
  const plan = buildPublicPostPlan([
    { type: 'text', value: 'SELL 10k ' },
    { type: 'resource', kind: 2 },
    { type: 'text', value: ' Q0 @0.37' },
  ]);
  assert.equal(plan.finalMarkup, 'SELL 10k :re-2: Q0 @0.37');
  assert.equal(plan.visibleText, 'SELL 10k Q0 @0.37');
  assert.deepEqual(plan.resourceKinds, [2]);
  assert.throws(() => buildPublicPostPlan([
    { type: 'text', value: 'X'.repeat(61) },
  ]), /exceeds 60 characters/);
  assert.throws(() => buildPublicPostPlan([
    { type: 'text', value: 'SELL\nNOW' },
  ]), /exceeds 1 lines/);
});

test('resource icons are planned as native suggestion selections for the four verified kinds', () => {
  assert.deepEqual(resourceSuggestionSpec({ type: 'resource', kind: 1 }), {
    kind: 1, token: ':re-1:', suggestionName: 'Power', query: 'Power',
  });
  assert.deepEqual(resourceSuggestionSpec({ type: 'resource', kind: 2 }), {
    kind: 2, token: ':re-2:', suggestionName: 'Water', query: 'Water',
  });
  assert.deepEqual(resourceSuggestionSpec({ type: 'resource', kind: 118 }), {
    kind: 118, token: ':re-118:', suggestionName: 'Coffee beans', query: 'Coffee beans',
  });
  assert.deepEqual(resourceSuggestionSpec({ type: 'resource', kind: 119, name: 'Coffee Ground' }), {
    kind: 119, token: ':re-119:', suggestionName: 'Coffee powder', query: 'Coffee powder',
  });
  assert.equal(parseResourceAlt(':re-45:'), 45);
  assert.equal(parseResourceAlt('Water'), null);
  assert.deepEqual(resourceSuggestionSpec({ type: 'resource', kind: 110, name: 'Tools' }), {
    kind: 110, token: ':re-110:', suggestionName: 'Tools', query: 'Tools',
  });
  assert.deepEqual(resourceSuggestionSpec({ type: 'resource', kind: 99, name: 'Satellite' }), {
    kind: 99, token: ':re-99:', suggestionName: 'Satellite', query: 'Satellite',
  });
  assert.throws(() => resourceSuggestionSpec({ type: 'resource', kind: 45 }),
    /require the exact visible suggestion name/);
});

test('raw resource markup cannot bypass the native suggestion-menu plan', () => {
  assert.throws(() => buildPublicPostPlan([
    { type: 'text', value: 'SELL :re-2: Q0' },
  ]), /raw resource tokens are forbidden/);
  assert.throws(() => buildPublicPostPlan([
    { type: 'resource', kind: 2, name: 'Power' },
  ]), /does not match Water/);
});

test('room discovery accepts direct subscribed-room links and rejects mixed-tab URLs', () => {
  assert.deepEqual(directRoomFromHref('/messages/chatroom_Aerospace%20sales/'), {
    room: 'Aerospace sales',
    slug: 'chatroom_Aerospace%20sales',
    url: 'https://www.simcompanies.com/messages/chatroom_Aerospace%20sales/',
  });
  assert.equal(directRoomFromHref('/messages/Acme-chatroom_Sales/'), null);
  assert.deepEqual(discoverRoomLinks([
    { href: '/messages/chatroom_Sales/', text: 'Sales 108', active: false },
    { href: '/messages/chatroom_Sales/', text: 'Sales 3', active: true },
    { href: '/messages/chatroom_Game/', text: 'Game' },
    { href: '/messages/Acme-chatroom_Sales/', text: 'Acme' },
  ]), [
    {
      room: 'Game', slug: 'chatroom_Game',
      url: 'https://www.simcompanies.com/messages/chatroom_Game/', unread: 0, active: false,
    },
    {
      room: 'Sales', slug: 'chatroom_Sales',
      url: 'https://www.simcompanies.com/messages/chatroom_Sales/', unread: 3, active: true,
    },
  ]);
});

test('dual-pane fixture selects only the exact public Sales pane', () => {
  const fixture = [
    {
      id: 'private', visible: true, textareaCount: 1, sendButtonCount: 1,
      exactHeaders: ['HEMLOCK ENTERPRISE'], iconAlts: ['HEMLOCK ENTERPRISE'],
      conversationHrefs: ['/messages/HEMLOCK-ENTERPRISE-chatroom_Sales/'],
    },
    {
      id: 'sales', visible: true, textareaCount: 1, sendButtonCount: 1,
      exactHeaders: ['SALES'], iconAlts: ['Sales'],
      conversationHrefs: ['/messages/HEMLOCK-ENTERPRISE-chatroom_Sales/'],
    },
  ];
  const selected = choosePublicRoomPane(fixture, 'Sales');
  assert.equal(selected.ok, true);
  assert.equal(selected.pane.id, 'sales');
  assert.equal(choosePublicRoomPane([
    ...fixture,
    { ...fixture[1], id: 'duplicate-sales' },
  ], 'Sales').ok, false);
});

test('button semantics reflect the rendered chat behavior', () => {
  assert.equal(buttonSemantic('copy'), 'copy_company_name');
  assert.equal(buttonSemantic('envelope'), 'open_private_conversation');
  assert.equal(buttonSemantic('reply'), 'mention_reply');
  assert.equal(buttonSemantic('paper-plane'), 'send_message');
  assert.equal(buttonSemantic('made-up'), 'unknown');
  assert.equal(replyPrefix('HEMLOCK ENTERPRISE'), '@HEMLOCK-ENTERPRISE ');
  assert.equal(replyPrefix('Société Démo'), '@Société-Démo ');
});

test('post verification binds text and resource order, then requires one exact transition', () => {
  const expected = { visibleText: 'SELL 10k Q0 @0.37', resourceKinds: [2] };
  assert.equal(exactRenderedSignature({
    visibleText: ' SELL 10k  Q0 @0.37 ', resourceKinds: [2],
  }, expected), true);
  assert.equal(exactRenderedSignature({
    visibleText: 'SELL 10k Q0 @0.37', resourceKinds: [1],
  }, expected), false);
  assert.deepEqual(verifySingleSendTransition({
    beforeCount: 0, afterCount: 1, composerValue: '', sendClicked: true,
  }), { ok: true, posted: true, doNotRetry: false });
  const ambiguous = verifySingleSendTransition({
    beforeCount: 0, afterCount: 0, composerValue: '', sendClicked: true,
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.posted, null);
  assert.equal(ambiguous.doNotRetry, true);
  assert.equal(ambiguous.status, 'UNKNOWN_AFTER_SINGLE_CLICK');
});

test('all public-room fragments compile and contain no direct chat write transport', () => {
  const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
  const actionDir = path.join(__dirname, '..', 'actions');
  for (const name of ACTIONS) {
    const source = fs.readFileSync(path.join(actionDir, name), 'utf8');
    assert.doesNotThrow(() => new AsyncFunction(source), name);
    assert.doesNotMatch(source, /\bfetch\s*\(|\bXMLHttpRequest\b|\/api\/|axios|\.post\s*\(/i, name);
  }
});

test('post fragment scopes composer and paper-plane to the room pane and clicks send once', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', 'chat-room-post.js'), 'utf8');
  assert.match(source, /localAreas\.length === 1/);
  assert.match(source, /pane\.contains\(button\)/);
  assert.match(source, /pane\.contains\(image\)/);
  assert.match(source, /options\[0\]\.click\(\)/);
  assert.doesNotMatch(source, /setInput\(textarea,\s*finalMarkup\)/u);
  assert.match(source, /nativeComposerKinds/u);
  assert.match(source, /attemptId must be an opaque/u);
  assert.equal((source.match(/sendButton\.click\(\)/g) || []).length, 1);
  assert.match(source, /UNKNOWN_AFTER_SINGLE_CLICK/);
  assert.match(source, /doNotRetry:\s*!landed/);
});

test('reply fragment clicks one exact reply target and never sends', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', 'chat-room-reply.js'), 'utf8');
  assert.equal((source.match(/replyButton\.click\(\)/g) || []).length, 1);
  assert.doesNotMatch(source, /paper-plane|sendButton\.click/);
  assert.match(source, /actual === expectedPrefix/);
  assert.match(source, /regions\.find\(region => region !== headerRegion/u);
  assert.match(source, /VERIFIED|componentSourceEvidence/u);
});

test('public reply preview resolves a live sibling group by component source identity', async () => {
  const conversationHref = '/messages/HEMLOCK%20ENTERPRISE-chatroom_Sales/';
  const headerRegion = element('div', { class: 'invisible-possible' }, [
    element('a', { href: conversationHref }, [
      element('div', { text: 'HEMLOCK ENTERPRISE' }),
      element('svg', { 'data-icon': 'envelope' }),
    ]),
    element('svg', { 'data-icon': 'reply' }),
    element('time', { datetime: '2026-07-27T07:00:00.000Z', text: 'about an hour ago' }),
  ]);
  const bodyRegion = element('div', { class: 'invisible-possible' }, [
    element('div', {}, [
      'Buying 10k ', element('img', { alt: ':re-2:' }), ' Q0 @0.37',
    ]),
  ]);
  const messageGroup = element('div', { style: { textAlign: 'left' } }, [
    element('div', { class: 'logo' }),
    headerRegion,
    bodyRegion,
  ]);
  messageGroup['__reactInternalInstance$test'] = {
    memoizedProps: {
      messageGroupId: 'S-9001',
      sender: { id: 7812345, company: 'HEMLOCK ENTERPRISE' },
      body: [{ id: 9001, body: 'Buying 10k', datetime: '2026-07-27T07:00:00.000Z' }],
      fromMe: false,
      myCompanyIds: [900100],
    },
    return: null,
  };
  const scroller = element('div', {
    style: { flexDirection: 'column-reverse', overflowY: 'auto' },
    scrollTop: 0,
    scrollHeight: 300,
    clientHeight: 300,
  }, [messageGroup]);
  const body = element('body', {}, [
    element('section', {}, [
      element('div', { class: 'well-header', text: 'Sales' }),
      element('img', { alt: 'Sales' }),
      scroller,
      element('div', { class: 'composer' }, [
        element('textarea', { placeholder: 'Type here...', value: '' }),
        element('button', {}, [element('svg', { 'data-icon': 'paper-plane' })]),
      ]),
    ]),
  ]);
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'actions', 'chat-room-reply.js'), 'utf8');
  const result = await runAction(source, {
    body,
    href: 'https://www.simcompanies.com/messages/chatroom_Sales/',
    windowProperties: {
      __chatRoomReply: {
        room: 'Sales',
        company: 'HEMLOCK ENTERPRISE',
        bodyContains: 'Buying 10k :re-2: Q0 @0.37',
        conversationHref: `https://www.simcompanies.com${conversationHref}`,
        requireExactBody: true,
        sourceCompanyId: 7812345,
        sourceMessageId: '9001',
        sourceCreatedAt: '2026-07-27T07:00:00.000Z',
        confirm: false,
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry, true);
  assert.equal(result.sourceMessageIdVerified, '9001');
  assert.equal(result.sourceCompanyIdVerified, 7812345);
  assert.equal(result.sourceCreatedAtVerified, '2026-07-27T07:00:00.000Z');
  assert.equal(result.wouldInsert, '@HEMLOCK-ENTERPRISE ');
});

test('public read fragment parses live sibling header/body message regions', async () => {
  const conversationHref = '/messages/HEMLOCK%20ENTERPRISE-chatroom_Sales/';
  const headerRegion = element('div', { class: 'invisible-possible' }, [
    element('a', { href: conversationHref }, [
      element('div', { text: 'HEMLOCK ENTERPRISE' }),
      element('svg', { 'data-icon': 'envelope' }),
    ]),
    element('time', { datetime: '2026-07-27T07:00:00.000Z', text: 'about an hour ago' }),
  ]);
  const bodyRegion = element('div', { class: 'invisible-possible' }, [
    element('div', {}, [
      'Buying 10k ', element('img', { alt: ':re-2:' }), ' Q0 @0.37',
    ]),
  ]);
  const messageGroup = element('div', { style: { textAlign: 'left' } }, [
    element('div', { class: 'logo' }),
    headerRegion,
    bodyRegion,
  ]);
  messageGroup['__reactInternalInstance$test'] = {
    memoizedProps: {
      messageGroupId: 'S-9001',
      sender: { id: 7812345, company: 'HEMLOCK ENTERPRISE' },
      body: [{ id: 9001, body: 'Buying 10k', datetime: '2026-07-27T07:00:00.000Z' }],
      fromMe: false,
      myCompanyIds: [900100],
    },
    return: null,
  };
  const scroller = element('div', {
    style: { flexDirection: 'column-reverse', overflowY: 'auto' },
    scrollTop: 0,
    scrollHeight: 300,
    clientHeight: 300,
  }, [
    messageGroup,
  ]);
  const body = element('body', {}, [
    element('section', {}, [
      element('div', { class: 'well-header', text: 'Sales' }),
      element('img', { alt: 'Sales' }),
      scroller,
      element('div', { class: 'composer' }, [
        element('textarea', { placeholder: 'Type here...', value: '' }),
        element('button', {}, [element('svg', { 'data-icon': 'paper-plane' })]),
      ]),
    ]),
  ]);
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'actions', 'chat-room-read.js'), 'utf8');
  const result = await runAction(source, {
    body,
    href: 'https://www.simcompanies.com/messages/chatroom_Sales/',
    windowProperties: { __chatRoomRead: { room: 'Sales' } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageCount, 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].company, 'HEMLOCK ENTERPRISE');
  assert.equal(result.groups[0].companyId, 7812345);
  assert.equal(result.groups[0].fromMe, false);
  assert.equal(result.groups[0].messageGroupId, 'S-9001');
  assert.equal(result.groups[0].identityStatus, 'VERIFIED_RENDERED_COMPONENT_ID');
  assert.equal(result.groups[0].messages[0].messageId, 9001);
  assert.equal(result.groups[0].messages[0].idStatus, 'VERIFIED_RENDERED_COMPONENT_ID');
  assert.equal(result.groups[0].messages[0].exactTime, '2026-07-27T07:00:00.000Z');
  assert.equal(result.groups[0].messages[0].text, 'Buying 10k :re-2: Q0 @0.37');
  assert.deepEqual(result.groups[0].messages[0].resourceKinds, [2]);
  assert.equal(result.emptyDiagnostics, null);
});
