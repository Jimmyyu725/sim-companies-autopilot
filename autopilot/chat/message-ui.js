'use strict';

const MESSAGE_ACTIONS = Object.freeze(['translate', 'retract_prepare', 'retract_confirm']);

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u00a0\u202f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizePane(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = normalizeText(record.id);
  const kind = record.kind === 'public' || record.kind === 'private' ? record.kind : null;
  const target = normalizeText(record.target);
  const textareaCount = Number(record.textareaCount);
  const sendButtonCount = Number(record.sendButtonCount);
  if (!id || !kind || !target || !Number.isSafeInteger(textareaCount) || !Number.isSafeInteger(sendButtonCount)) {
    return null;
  }
  return {
    id,
    kind,
    target,
    visible: record.visible === true,
    textareaCount,
    sendButtonCount,
    messages: Array.isArray(record.messages) ? record.messages : [],
  };
}

function chooseExactMessagePane(panes, { kind, target } = {}) {
  if (!Array.isArray(panes) || !['public', 'private'].includes(kind)) {
    return { ok: false, reason: 'panes and a valid pane kind are required' };
  }
  const wanted = normalizeText(target).toLocaleLowerCase('en-US');
  if (!wanted) return { ok: false, reason: 'target is required' };
  const matches = panes.map(normalizePane).filter(Boolean).filter(pane => pane.visible
    && pane.kind === kind
    && pane.target.toLocaleLowerCase('en-US') === wanted
    && pane.textareaCount === 1
    && pane.sendButtonCount === 1);
  if (matches.length !== 1) {
    return { ok: false, reason: 'exact message pane count is not one', count: matches.length };
  }
  return { ok: true, pane: matches[0] };
}

function selectExactMessage(records, { sourceText, sender, fromMe } = {}) {
  if (!Array.isArray(records)) return { ok: false, reason: 'messages must be an array' };
  const text = normalizeText(sourceText);
  const senderKey = normalizeText(sender).toLocaleLowerCase('en-US');
  if (!text || text.length < 4) return { ok: false, reason: 'sourceText must contain at least four characters' };
  const matches = records.filter(record => normalizeText(record && record.text) === text
    && (!senderKey || normalizeText(record && record.sender).toLocaleLowerCase('en-US') === senderKey)
    && (typeof fromMe !== 'boolean' || (record && record.fromMe === true) === fromMe));
  if (matches.length !== 1) {
    return { ok: false, reason: 'exact message count is not one', count: matches.length };
  }
  return { ok: true, message: matches[0] };
}

function planMessageAction({ action, message } = {}) {
  if (!MESSAGE_ACTIONS.includes(action)) {
    return { ok: false, unsupported: true, reason: 'unsupported message action' };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, reason: 'message evidence is required' };
  }
  const text = normalizeText(message.text);
  if (!text) return { ok: false, reason: 'message text is missing' };
  if (action === 'translate') {
    if (message.fromMe === true) return { ok: false, unsupported: true, reason: 'own messages have no translate control' };
    if (message.translateControl !== true) return { ok: false, unsupported: true, reason: 'translate control is not proven' };
  }
  if (action.startsWith('retract')) {
    if (message.fromMe !== true) return { ok: false, unsupported: true, reason: 'only own messages can be retracted' };
    if (message.retracted === true) return { ok: false, reason: 'message is already retracted' };
  }
  if (action === 'retract_prepare' && message.retractControl !== true) {
    return { ok: false, unsupported: true, reason: 'retract control is not proven' };
  }
  return { ok: true, action, text, persistent: action !== 'retract_prepare' };
}

function verifyMessageTransition({ action, before, after, confirmationVisible = false } = {}) {
  const plan = planMessageAction({ action, message: before });
  if (!plan.ok) return plan;
  if (action === 'retract_prepare') {
    return confirmationVisible
      ? { ok: true, verified: true }
      : { ok: false, ambiguous: true, doNotRetry: true, reason: 'retract confirmation did not appear' };
  }
  if (!after || normalizeText(after.text) !== plan.text) {
    return { ok: false, ambiguous: true, doNotRetry: true, reason: 'exact message identity was lost' };
  }
  if (action === 'translate' && after.translateControl !== true && normalizeText(after.translation)) {
    return { ok: true, verified: true };
  }
  if (action === 'retract_confirm' && after.retracted === true && after.retractControl !== true) {
    return { ok: true, verified: true };
  }
  return { ok: false, ambiguous: true, doNotRetry: true, reason: `${action} postcondition was not proven` };
}

module.exports = {
  MESSAGE_ACTIONS,
  chooseExactMessagePane,
  normalizePane,
  normalizeText,
  planMessageAction,
  selectExactMessage,
  verifyMessageTransition,
};
