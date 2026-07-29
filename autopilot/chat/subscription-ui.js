'use strict';

function normalizeText(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function nonNegativeInteger(value) {
  if (typeof value === 'boolean' || value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseChatroomSettingsRoute(href) {
  try {
    const url = new URL(String(href), 'https://www.simcompanies.com');
    const match = decodeURIComponent(url.pathname).match(/^\/(?:[a-z]{2}\/)?account-settings\/chatrooms\/(\d+)\/?$/iu);
    if (!match) return null;
    const realmId = nonNegativeInteger(match[1]);
    return realmId == null ? null : { realmId, pathname: decodeURIComponent(url.pathname) };
  } catch (_) {
    return null;
  }
}

function normalizeSubscriptions(records) {
  if (!Array.isArray(records)) return { ok: false, reason: 'chatrooms must be an array' };
  const rooms = [];
  const letters = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, reason: 'chatroom evidence must be an object' };
    }
    const dbLetter = normalizeText(record.dbLetter);
    const name = normalizeText(record.name);
    if (!dbLetter || !name || letters.has(dbLetter)) {
      return { ok: false, reason: 'chatroom requires unique dbLetter and name evidence' };
    }
    letters.add(dbLetter);
    rooms.push({
      dbLetter,
      name,
      subscribed: record.subscribed === true,
      disabled: record.disabled === true,
    });
  }
  return { ok: true, rooms };
}

function planSubscriptionChange({ records, dbLetter, name, subscribe } = {}) {
  if (typeof subscribe !== 'boolean') return { ok: false, reason: 'subscribe must be boolean' };
  const normalized = normalizeSubscriptions(records);
  if (!normalized.ok) return normalized;
  const wantedLetter = normalizeText(dbLetter);
  const wantedName = normalizeText(name).toLocaleLowerCase('en-US');
  const matches = normalized.rooms.filter(room => room.dbLetter === wantedLetter
    && room.name.toLocaleLowerCase('en-US') === wantedName);
  if (matches.length !== 1) return { ok: false, reason: 'exact chatroom count is not one', count: matches.length };
  const room = matches[0];
  if (room.disabled) return { ok: false, unsupported: true, reason: 'chatroom checkbox is disabled' };
  if (room.subscribed === subscribe) {
    return { ok: false, reason: subscribe ? 'already subscribed' : 'already unsubscribed' };
  }
  return { ok: true, room, subscribe, persistent: true };
}

function verifySubscriptionTransition({ before, after, subscribe, successDelta } = {}) {
  const plan = planSubscriptionChange({
    records: [before],
    dbLetter: before && before.dbLetter,
    name: before && before.name,
    subscribe,
  });
  if (!plan.ok) return plan;
  const normalized = normalizeSubscriptions([after]);
  const next = normalized.ok ? normalized.rooms[0] : null;
  const sameRoom = next && next.dbLetter === plan.room.dbLetter
    && next.name.toLocaleLowerCase('en-US') === plan.room.name.toLocaleLowerCase('en-US');
  if (sameRoom && next.subscribed === subscribe && successDelta === 1) {
    return { ok: true, verified: true };
  }
  return {
    ok: false,
    ambiguous: true,
    doNotRetry: true,
    reason: 'checkbox state plus one new UI save acknowledgement were not both proven',
  };
}

module.exports = {
  normalizeSubscriptions,
  parseChatroomSettingsRoute,
  planSubscriptionChange,
  verifySubscriptionTransition,
};
