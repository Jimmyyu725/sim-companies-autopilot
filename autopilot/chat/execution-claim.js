'use strict';

const crypto = require('node:crypto');

const CLAIMED_CHAT_ACTIONS = new Set([
  'chat_private_send',
  'chat_room_reply',
  'chat_room_post',
]);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function executionBindingHash(actionName, actionParams) {
  if (!CLAIMED_CHAT_ACTIONS.has(actionName) || !plainObject(actionParams)
      || actionParams.confirm !== true
      || typeof actionParams.attemptId !== 'string'
      || !/^[A-Za-z0-9._:-]{8,100}$/u.test(actionParams.attemptId)) {
    throw new TypeError('a supported exact confirmed chat action is required');
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableObject({ actionName, actionParams })))
    .digest('hex');
}

function executionClaimTokenHash(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError('execution claim token is invalid');
  }
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  CLAIMED_CHAT_ACTIONS,
  TOKEN_PATTERN,
  executionBindingHash,
  executionClaimTokenHash,
};
