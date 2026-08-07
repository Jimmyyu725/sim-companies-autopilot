'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { responsesActionTools } = require('../action-contracts.js');
const { resolveChatMode, normalizeChatMode } = require('../chat/runtime-mode.js');

// The chat family is off as a cost decision, not a feature decision. Measured 2026-08-07 it was 26
// of 41 action tools and 15,271 of 22,992 characters of tool payload, carried on every model
// request — 22 of the 26 never called across 12,231 tool calls, and the 4 that had been now fail
// against a game overlay that only a click dismisses. This is a shell-level setting, so nothing
// else in the suite would notice it being dropped, which is exactly how brain56 came to ignore
// BRAIN_MAX_ROUNDS for weeks with a green suite.

const isChatFamily = name => /^(chat_|contract_)/u.test(name);
const names = mode => responsesActionTools({ chatMode: mode }).map(t => t.name || t.function?.name);

test('run-brain.sh exports a chat mode, and it is off', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'run-brain.sh'), 'utf8');
  const match = runner.match(/^export SIM_CHAT_MODE=(\S+)$/mu);
  assert.ok(match, 'run-brain.sh must set SIM_CHAT_MODE explicitly rather than inherit the default');
  assert.equal(match[1], 'off');
  assert.equal(normalizeChatMode(match[1]), 'off', 'the value must survive normalisation');
});

test('off removes the chat and contract tools from the payload', () => {
  const off = names('off');
  assert.deepEqual(off.filter(isChatFamily), [],
    'no chat_ or contract_ tool may reach the model while the runtime is off');
  // auction_info is a read-only building-auction lookup rather than a chat feature, and it stays.
  assert.ok(off.includes('auction_info'));
});

test('turning chat off does not touch the Personal Assistant', () => {
  // PA is a separate system and the profitable one: 172 calls, and an accepted offer bought a
  // Grocery level for $2,320 against roughly $11,000 of capex.
  const off = names('off');
  for (const tool of ['pa_read', 'pa_consult_guide', 'pa_reply']) {
    assert.ok(off.includes(tool), `${tool} must survive the chat runtime being off`);
  }
});

test('turning chat off does not touch any economic tool', () => {
  const off = new Set(names('off'));
  for (const tool of ['collect', 'produce', 'buy', 'sell', 'build', 'upgrade', 'scrap', 'rebuild',
    'bonds', 'exchange_sell', 'inspect_exchange_buy', 'robots']) {
    assert.ok(off.has(tool), `${tool} must survive the chat runtime being off`);
  }
});

test('the saving is real and this test would notice it shrinking', () => {
  const size = mode => responsesActionTools({ chatMode: mode })
    .reduce((sum, t) => sum + JSON.stringify(t).length, 0);
  const offBytes = size('off');
  const shadowBytes = size('shadow');
  assert.ok(shadowBytes - offBytes > 12000,
    `expected the chat family to be worth more than 12k characters, saw ${shadowBytes - offBytes}`);
  assert.ok(offBytes < shadowBytes / 2,
    'off must be less than half the payload of the previous default');
});

test('the setting is reversible and every mode is still reachable', () => {
  // Nothing was deleted. Restoring the old behaviour must be one environment variable.
  for (const mode of ['off', 'read-only', 'shadow', 'safe-reply', 'full']) {
    assert.equal(resolveChatMode({ SIM_CHAT_MODE: mode }), mode);
  }
  assert.equal(names('shadow').filter(isChatFamily).length, 25,
    'shadow must still expose the full chat family, so this is a switch and not a removal');
});

// Owner directive 2026-08-07: DeepSeek permanently. The preflight used to answer a credential
// failure with `switch openai --confirm`, and switchProvider writes BOTH the active file and
// .owner-primary-provider — so one unreadable key file would have rewritten a standing decision,
// and brain-provider.js:175 only retries the primary when `resolved !== ownerPrimary`, which after
// that rewrite is never true again.
test('a credential failure does not rewrite the owner\'s provider choice', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'run-brain.sh'), 'utf8');
  const preflight = runner.slice(runner.indexOf('brain-provider.js" check'),
    runner.indexOf('unset OPENAI_API_KEY'));
  assert.doesNotMatch(preflight, /switch \w+ --confirm/u,
    'the preflight must not switch providers; that rewrites owner intent as a side effect');
  assert.match(preflight, /fail_before_state/u,
    'a credential problem must fail the wake so check-alarm can retry it');
});
