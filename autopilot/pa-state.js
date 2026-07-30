'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const PA_SCHEMA_VERSION = 1;
const DEFAULT_STATUS_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_REVIEW_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function parsePaUnreadRows(rows) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map(row => normalizeText(typeof row === 'string' ? row : row?.text))
    .filter(Boolean);
  const matches = normalizedRows.filter(text => /personal assistant/iu.test(text));
  if (matches.length !== 1) {
    return {
      status: 'unknown',
      unread: null,
      rowText: matches.length === 1 ? matches[0] : null,
      reason: matches.length
        ? 'Personal Assistant row was not unique'
        : 'Personal Assistant row was not found',
    };
  }
  const match = matches[0].match(/(\d+)\s*$/u);
  const unread = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(unread) || unread < 0) {
    return {
      status: 'unknown',
      unread: null,
      rowText: matches[0],
      reason: 'Personal Assistant unread count was malformed',
    };
  }
  return { status: 'ok', unread, rowText: matches[0], reason: null };
}

function extractOfferText(tail, options) {
  let text = normalizeText(tail);
  const marker = 'YOUR PERSONAL ASSISTANT';
  const markerIndex = text.toUpperCase().lastIndexOf(marker);
  if (markerIndex >= 0) text = text.slice(markerIndex + marker.length).trim();

  const normalizedOptions = (Array.isArray(options) ? options : [])
    .map(normalizeText)
    .filter(Boolean);
  let firstOptionIndex = text.length;
  for (const option of normalizedOptions) {
    const index = text.indexOf(option);
    if (index >= 0) firstOptionIndex = Math.min(firstOptionIndex, index);
  }
  if (firstOptionIndex < text.length) text = text.slice(0, firstOptionIndex).trim();

  text = text
    .replace(/^\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\s+/iu, '')
    .replace(/\s+(?:Map\s+Warehouse\s+Search\s+Chat\s+Exchange)\s*$/iu, '')
    .trim();
  return text;
}

function paOfferFingerprint({ offerText, options }) {
  const normalizedOptions = (Array.isArray(options) ? options : [])
    .map(normalizeText)
    .filter(Boolean);
  const payload = JSON.stringify({
    offerText: normalizeText(offerText),
    options: normalizedOptions,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function buildPendingPa(observation, observedAt = new Date().toISOString()) {
  const options = (Array.isArray(observation?.options) ? observation.options : [])
    .map(normalizeText)
    .filter(Boolean);
  if (observation?.ok !== true || !options.length) return null;
  const offerText = normalizeText(
    observation.offerText || extractOfferText(observation.tail, options),
  );
  if (!offerText) return null;
  return {
    schemaVersion: PA_SCHEMA_VERSION,
    status: 'pending',
    observedAt,
    source: 'rendered-personal-assistant-ui',
    route: normalizeText(observation.url) || null,
    fingerprint: paOfferFingerprint({ offerText, options }),
    offerText,
    options,
  };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function regularBoundedFile(file, maxBytes = 64 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes;
  } catch (_) {
    return false;
  }
}

function validTimestamp(value, nowMs, maxAgeMs) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp <= nowMs + 30 * 1000
    && nowMs - timestamp <= maxAgeMs;
}

function readPendingPa(
  file,
  { nowMs = Date.now(), maxAgeMs = DEFAULT_PENDING_MAX_AGE_MS } = {},
) {
  if (!regularBoundedFile(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const options = Array.isArray(value?.options) ? value.options.map(normalizeText).filter(Boolean) : [];
    const offerText = normalizeText(value?.offerText);
    if (value?.schemaVersion !== PA_SCHEMA_VERSION || value?.status !== 'pending'
        || !validTimestamp(value.observedAt, nowMs, maxAgeMs)
        || !/^[a-f0-9]{64}$/u.test(String(value.fingerprint || ''))
        || !offerText || !options.length
        || paOfferFingerprint({ offerText, options }) !== value.fingerprint) return null;
    return { ...value, offerText, options };
  } catch (_) {
    return null;
  }
}

function writePendingPa(file, pending) {
  if (!pending || pending.status !== 'pending') {
    throw new TypeError('pending PA record is invalid');
  }
  writeJsonAtomic(file, pending);
  return pending;
}

function clearPendingPa(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function matchUniqueOption(options, choice) {
  const wanted = normalizeText(choice).toLocaleLowerCase('en-US');
  if (!wanted) return { ok: false, reason: 'choice is empty' };
  const normalizedOptions = (Array.isArray(options) ? options : [])
    .map(normalizeText)
    .filter(Boolean);
  const exact = normalizedOptions.filter(
    option => option.toLocaleLowerCase('en-US') === wanted,
  );
  if (exact.length === 1) return { ok: true, choice: exact[0] };
  const partial = normalizedOptions.filter(
    option => option.toLocaleLowerCase('en-US').includes(wanted),
  );
  if (partial.length !== 1) {
    return {
      ok: false,
      reason: partial.length
        ? 'choice matches multiple Personal Assistant options'
        : 'choice does not match a current Personal Assistant option',
    };
  }
  return { ok: true, choice: partial[0] };
}

function buildPaReview({
  pending,
  preliminaryChoice,
  rationale,
  guideDigest,
  matchCount,
}, reviewedAt = new Date().toISOString()) {
  if (!pending || pending.status !== 'pending') {
    throw new TypeError('pending PA record is required');
  }
  const option = matchUniqueOption(pending.options, preliminaryChoice);
  if (!option.ok) throw new TypeError(option.reason);
  const conciseRationale = normalizeText(rationale);
  if (conciseRationale.length < 10 || conciseRationale.length > 1000) {
    throw new TypeError('preliminary rationale must contain 10..1000 characters');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(guideDigest || ''))) {
    throw new TypeError('guide digest is invalid');
  }
  return {
    schemaVersion: PA_SCHEMA_VERSION,
    status: 'reviewed',
    reviewedAt,
    fingerprint: pending.fingerprint,
    preliminaryChoice: option.choice,
    rationale: conciseRationale,
    guideDigest,
    matchCount: Number.isSafeInteger(matchCount) && matchCount >= 0 ? matchCount : 0,
  };
}

function writePaReview(file, review) {
  if (!review || review.status !== 'reviewed') {
    throw new TypeError('PA review record is invalid');
  }
  writeJsonAtomic(file, review);
  return review;
}

function readPaReview(
  file,
  pending,
  { nowMs = Date.now(), maxAgeMs = DEFAULT_REVIEW_MAX_AGE_MS } = {},
) {
  if (!pending || !regularBoundedFile(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rationale = normalizeText(value?.rationale);
    const option = matchUniqueOption(pending.options, value?.preliminaryChoice);
    if (value?.schemaVersion !== PA_SCHEMA_VERSION || value?.status !== 'reviewed'
        || value?.fingerprint !== pending.fingerprint
        || !validTimestamp(value.reviewedAt, nowMs, maxAgeMs)
        || !option.ok
        || rationale.length < 10 || rationale.length > 1000
        || !/^[a-f0-9]{64}$/u.test(String(value.guideDigest || ''))) return null;
    return {
      ...value,
      preliminaryChoice: option.choice,
      rationale,
      matchCount: Number.isSafeInteger(value.matchCount) && value.matchCount >= 0
        ? value.matchCount
        : 0,
    };
  } catch (_) {
    return null;
  }
}

function clearPaReview(file) {
  return clearPendingPa(file);
}

function writePaStatus(file, observation, observedAt = new Date().toISOString()) {
  const unread = observation?.unread;
  const status = observation?.status === 'ok' && Number.isSafeInteger(unread) && unread >= 0
    ? 'ok'
    : 'unknown';
  const value = {
    schemaVersion: PA_SCHEMA_VERSION,
    status,
    observedAt,
    source: observation?.source || 'rendered-messages-ui',
    unread: status === 'ok' ? unread : null,
    rowText: normalizeText(observation?.rowText) || null,
    reason: status === 'unknown' ? normalizeText(observation?.reason) || 'PA status is unknown' : null,
  };
  writeJsonAtomic(file, value);
  return value;
}

function readPaStatus(
  file,
  { nowMs = Date.now(), maxAgeMs = DEFAULT_STATUS_MAX_AGE_MS } = {},
) {
  if (!regularBoundedFile(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schemaVersion !== PA_SCHEMA_VERSION
        || !['ok', 'unknown'].includes(value?.status)
        || !validTimestamp(value.observedAt, nowMs, maxAgeMs)) return null;
    if (value.status === 'ok'
        && (!Number.isSafeInteger(value.unread) || value.unread < 0)) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function derivePaState({ uiStatus = null, authUnread = null, pending = null } = {}) {
  if (pending) {
    return {
      status: 'pending',
      unread: uiStatus?.status === 'ok' ? uiStatus.unread : null,
      observedAt: pending.observedAt,
      source: pending.source,
      fingerprint: pending.fingerprint,
      offerPreview: pending.offerText.slice(0, 240),
      optionCount: pending.options.length,
    };
  }
  if (uiStatus?.status === 'ok') {
    return {
      status: uiStatus.unread > 0 ? 'unread' : 'clear',
      unread: uiStatus.unread,
      observedAt: uiStatus.observedAt,
      source: uiStatus.source,
      fingerprint: null,
      offerPreview: null,
      optionCount: null,
    };
  }
  if (Number.isSafeInteger(authUnread) && authUnread >= 0) {
    return {
      status: authUnread > 0 ? 'unread' : 'clear',
      unread: authUnread,
      observedAt: null,
      source: 'auth-data-fallback',
      fingerprint: null,
      offerPreview: null,
      optionCount: null,
    };
  }
  return {
    status: 'unknown',
    unread: null,
    observedAt: uiStatus?.observedAt || null,
    source: uiStatus?.source || null,
    fingerprint: null,
    offerPreview: null,
    optionCount: null,
  };
}

module.exports = {
  PA_SCHEMA_VERSION,
  buildPaReview,
  buildPendingPa,
  clearPaReview,
  clearPendingPa,
  derivePaState,
  extractOfferText,
  matchUniqueOption,
  normalizeText,
  paOfferFingerprint,
  parsePaUnreadRows,
  readPaReview,
  readPaStatus,
  readPendingPa,
  writePaReview,
  writePaStatus,
  writePendingPa,
};
