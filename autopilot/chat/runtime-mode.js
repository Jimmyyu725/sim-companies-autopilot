'use strict';

const CHAT_MODES = Object.freeze(['off', 'read-only', 'shadow', 'safe-reply', 'full']);
const DEFAULT_CHAT_MODE = 'shadow';

const CHAT_READ_ACTIONS = new Set([
  'chat_scan',
  'chat_rooms_discover',
  'chat_room_read',
  'chat_room_scroll',
  'chat_private_read',
  'chat_private_retry_assess',
  'chat_contact_list',
  'chat_contact_read',
  'chat_subscription_list',
  'chat_contract_list',
  'chat_contract_preview',
  'chat_leads',
]);

const CHAT_MUTATION_ACTIONS = new Set([
  'chat_post',
  'chat_room_post',
  'chat_room_reply',
  'chat_private_open',
  'chat_private_start',
  'chat_private_send',
  'chat_contact_settings',
  'chat_contact_manage',
  'chat_contact_note',
  'chat_contact_report',
  'chat_subscription_toggle',
  'chat_message_translate',
  'chat_message_retract',
  // Direct warehouse contracts are a communication-side mutation too.  Keeping
  // them in this set makes the default shadow rollout a hard "no messages and
  // no contracts" boundary, even through the older standalone contract tool.
  'contract_accept',
  'contract_send',
]);

const SAFE_REPLY_ACTIONS = new Set([
  'chat_room_reply',
  'chat_private_send',
]);

function normalizeChatMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  return CHAT_MODES.includes(mode) ? mode : DEFAULT_CHAT_MODE;
}

function resolveChatMode(environment = process.env) {
  return normalizeChatMode(environment?.SIM_CHAT_MODE ?? environment?.CHAT_MODE);
}

function isChatAction(action) {
  return CHAT_READ_ACTIONS.has(action) || CHAT_MUTATION_ACTIONS.has(action);
}

function isChatMutationAction(action) {
  return CHAT_MUTATION_ACTIONS.has(action);
}

function confirmationRequested(action, params = {}) {
  if (!CHAT_MUTATION_ACTIONS.has(action)) return false;
  return params?.confirm === true;
}

function authorizeChatAction(action, params = {}, modeValue = DEFAULT_CHAT_MODE) {
  const mode = normalizeChatMode(modeValue);
  if (!isChatAction(action)) return { ok: true, mode, chatAction: false };
  if (mode === 'off') {
    return {
      ok: false,
      guard: true,
      mode,
      chatAction: true,
      reason: 'chat runtime is off; no chat browser action is authorized',
    };
  }
  if (!CHAT_MUTATION_ACTIONS.has(action) || params?.confirm !== true) {
    return {
      ok: true,
      mode,
      chatAction: true,
      mutation: CHAT_MUTATION_ACTIONS.has(action),
      previewOnly: CHAT_MUTATION_ACTIONS.has(action),
    };
  }
  if (action === 'chat_post') {
    return {
      ok: false,
      guard: true,
      mode,
      chatAction: true,
      mutation: true,
      reason: 'legacy chat_post is preview-only; use chat_room_post with a durable attemptId',
    };
  }
  if (action === 'contract_send') {
    return {
      ok: false,
      guard: true,
      mode,
      chatAction: true,
      mutation: true,
      reason: `${action} is preview-only until durable message evidence, economics, and idempotency are bound at the execution boundary`,
    };
  }
  if (action === 'chat_private_send'
      && (!Number.isSafeInteger(params?.targetCompanyId) || params.targetCompanyId <= 0)) {
    return {
      ok: false,
      guard: true,
      mode,
      chatAction: true,
      mutation: true,
      reason: 'confirmed private send requires a stable targetCompanyId bound to the exact contact record',
    };
  }
  if (mode === 'full') {
    return { ok: true, mode, chatAction: true, mutation: true, previewOnly: false };
  }
  if (mode === 'safe-reply' && SAFE_REPLY_ACTIONS.has(action)) {
    if (action === 'chat_private_send'
        && (typeof params?.inReplyToText !== 'string' || params.inReplyToText.trim().length < 4)) {
      return {
        ok: false,
        guard: true,
        mode,
        chatAction: true,
        mutation: true,
        reason: 'safe-reply private send requires exact inReplyToText evidence from the rendered thread',
      };
    }
    return { ok: true, mode, chatAction: true, mutation: true, previewOnly: false };
  }
  return {
    ok: false,
    guard: true,
    mode,
    chatAction: true,
    mutation: true,
    reason: `${action} confirm:true is disabled in chat mode ${mode}; use confirm:false to draft or preview`,
  };
}

function visibleChatActions(actionNames, modeValue = DEFAULT_CHAT_MODE) {
  if (!Array.isArray(actionNames)) throw new TypeError('actionNames must be an array');
  const mode = normalizeChatMode(modeValue);
  if (mode !== 'off') return [...actionNames];
  return actionNames.filter(action => !isChatAction(action));
}

module.exports = {
  CHAT_MODES,
  CHAT_MUTATION_ACTIONS,
  CHAT_READ_ACTIONS,
  DEFAULT_CHAT_MODE,
  SAFE_REPLY_ACTIONS,
  authorizeChatAction,
  confirmationRequested,
  isChatAction,
  isChatMutationAction,
  normalizeChatMode,
  resolveChatMode,
  visibleChatActions,
};
