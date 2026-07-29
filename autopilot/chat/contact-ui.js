'use strict';

const CONTACT_ACTIONS = Object.freeze([
  'pin',
  'unpin',
  'hide',
  'ignore',
  'unignore',
  'note_open',
  'note_save',
  'report_prepare',
  'report_confirm',
]);
const MAX_PRIVATE_NOTE_CHARS = 2000;

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u00a0\u202f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function positiveInteger(value) {
  if (typeof value === 'boolean' || value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeContactEvidence(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'contact evidence must be an object' };
  }
  const companyId = positiveInteger(record.companyId);
  const company = normalizeText(record.company);
  const unread = Number(record.unread);
  if (!companyId || !company || !Number.isSafeInteger(unread) || unread < 0) {
    return { ok: false, reason: 'contact requires companyId, company, and non-negative unread evidence' };
  }
  return {
    ok: true,
    contact: {
      companyId,
      company,
      unread,
      pinned: record.pinned === true,
      ignored: typeof record.ignored === 'boolean' ? record.ignored : null,
      privateNote: record.privateNote == null ? null : normalizeText(record.privateNote),
      href: typeof record.href === 'string' ? record.href : null,
      visible: record.visible !== false,
    },
  };
}

function normalizeContactList(records) {
  if (!Array.isArray(records)) return { ok: false, reason: 'contacts must be an array' };
  const contacts = [];
  const ids = new Set();
  for (const record of records) {
    const normalized = normalizeContactEvidence(record);
    if (!normalized.ok) return normalized;
    if (ids.has(normalized.contact.companyId)) {
      return { ok: false, reason: `duplicate companyId ${normalized.contact.companyId}` };
    }
    ids.add(normalized.contact.companyId);
    contacts.push(normalized.contact);
  }
  return { ok: true, contacts };
}

function chooseExactContact(records, { companyId, company } = {}) {
  const normalized = normalizeContactList(records);
  if (!normalized.ok) return normalized;
  const wantedId = positiveInteger(companyId);
  const wantedCompany = normalizeText(company).toLocaleLowerCase('en-US');
  if (!wantedId || !wantedCompany) {
    return { ok: false, reason: 'exact companyId and company are required' };
  }
  const matches = normalized.contacts.filter(contact => contact.companyId === wantedId
    && contact.company.toLocaleLowerCase('en-US') === wantedCompany);
  if (matches.length !== 1) {
    return { ok: false, reason: 'exact contact count is not one', count: matches.length };
  }
  return { ok: true, contact: matches[0] };
}

function validatePrivateNote(note) {
  if (typeof note !== 'string') return { ok: false, reason: 'note must be a string' };
  const normalized = note.normalize('NFKC').replace(/\r\n?/gu, '\n');
  if (normalized.length > MAX_PRIVATE_NOTE_CHARS) {
    return { ok: false, reason: `note exceeds ${MAX_PRIVATE_NOTE_CHARS} characters` };
  }
  return { ok: true, note: normalized };
}

function planContactAction({ action, contact, note } = {}) {
  if (!CONTACT_ACTIONS.includes(action)) {
    return { ok: false, unsupported: true, reason: 'unsupported contact action' };
  }
  const normalized = normalizeContactEvidence(contact);
  if (!normalized.ok) return normalized;
  const current = normalized.contact;
  if (action === 'pin' && current.pinned) return { ok: false, reason: 'contact is already pinned' };
  if (action === 'unpin' && !current.pinned) return { ok: false, reason: 'contact is not pinned' };
  if (action === 'ignore' && current.ignored == null) {
    return { ok: false, unsupported: true, reason: 'current ignore state is unknown' };
  }
  if (action === 'unignore' && current.ignored == null) {
    return { ok: false, unsupported: true, reason: 'current ignore state is unknown' };
  }
  if (action === 'ignore' && current.ignored) return { ok: false, reason: 'contact is already ignored' };
  if (action === 'unignore' && !current.ignored) return { ok: false, reason: 'contact is not ignored' };
  if (action === 'hide' && !current.visible) return { ok: false, reason: 'contact is already hidden' };
  if (action === 'note_save') {
    const checked = validatePrivateNote(note);
    if (!checked.ok) return checked;
    return { ok: true, action, contact: current, note: checked.note, persistent: true };
  }
  return {
    ok: true,
    action,
    contact: current,
    persistent: !['note_open', 'report_prepare'].includes(action),
  };
}

function verifyContactTransition({ action, before, after, note, confirmationVisible = false } = {}) {
  const planned = planContactAction({ action, contact: before, note });
  if (!planned.ok) return planned;
  if (action === 'note_open') {
    return confirmationVisible
      ? { ok: true, verified: true }
      : { ok: false, ambiguous: true, doNotRetry: true, reason: 'private-note editor did not appear' };
  }
  if (action === 'report_prepare') {
    return confirmationVisible
      ? { ok: true, verified: true }
      : { ok: false, ambiguous: true, doNotRetry: true, reason: 'report warning did not appear' };
  }
  if (action === 'hide') {
    return after == null
      ? { ok: true, verified: true }
      : { ok: false, ambiguous: true, doNotRetry: true, reason: 'contact remains rendered after hide' };
  }
  const normalizedAfter = normalizeContactEvidence(after);
  if (!normalizedAfter.ok) {
    return { ok: false, ambiguous: true, doNotRetry: true, reason: normalizedAfter.reason };
  }
  const next = normalizedAfter.contact;
  const sameIdentity = next.companyId === planned.contact.companyId
    && next.company.toLocaleLowerCase('en-US') === planned.contact.company.toLocaleLowerCase('en-US');
  if (!sameIdentity) {
    return { ok: false, ambiguous: true, doNotRetry: true, reason: 'contact identity changed' };
  }
  let expected = false;
  if (action === 'pin') expected = next.pinned === true;
  else if (action === 'unpin') expected = next.pinned === false;
  else if (action === 'ignore') expected = next.ignored === true;
  else if (action === 'unignore') expected = next.ignored === false;
  else if (action === 'note_save') expected = next.privateNote === planned.note.slice(0, 32);
  else if (action === 'report_confirm') expected = confirmationVisible === true;
  return expected
    ? { ok: true, verified: true }
    : { ok: false, ambiguous: true, doNotRetry: true, reason: `${action} postcondition was not proven` };
}

module.exports = {
  CONTACT_ACTIONS,
  MAX_PRIVATE_NOTE_CHARS,
  chooseExactContact,
  normalizeContactEvidence,
  normalizeContactList,
  normalizeText,
  planContactAction,
  positiveInteger,
  validatePrivateNote,
  verifyContactTransition,
};
