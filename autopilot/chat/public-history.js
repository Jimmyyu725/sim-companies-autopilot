'use strict';

const fs = require('node:fs');
const { withFileLock } = require('./persistence.js');

const DEFAULT_MAX_BYTES = 1024 * 1024;

function readPublicHistory(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    throw new Error('public chat history is not a regular bounded file');
  }
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  const rows = text.split('\n').map((line, index) => {
    let entry;
    try { entry = JSON.parse(line); }
    catch (_) { throw new Error(`public chat history line ${index + 1} is invalid JSON`); }
    if (!entry || !Number.isFinite(Number(entry.t)) || typeof entry.room !== 'string'
        || typeof entry.text !== 'string' || typeof entry.verified !== 'boolean'
        || (entry.attemptId != null && !/^[A-Za-z0-9._:-]{8,100}$/u.test(entry.attemptId))
        || (entry.status != null
          && !['ARMED', 'VERIFIED', 'UNKNOWN', 'FAILED_PRE_CLICK'].includes(entry.status))) {
      throw new Error(`public chat history line ${index + 1} is malformed`);
    }
    return {
      roomId: entry.room,
      text: entry.text,
      sentAt: new Date(Number(entry.t)).toISOString(),
      verified: entry.verified,
      attemptId: entry.attemptId ?? null,
      status: entry.status ?? (entry.verified ? 'VERIFIED' : 'UNKNOWN'),
    };
  });
  const canonical = [];
  const attempts = new Map();
  for (const row of rows) {
    if (row.attemptId == null) {
      canonical.push(row);
      continue;
    }
    const prior = attempts.get(row.attemptId);
    if (prior && (prior.roomId !== row.roomId || prior.text !== row.text)) {
      throw new Error(`public chat history attempt ${row.attemptId} changed its binding`);
    }
    if (!prior) {
      attempts.set(row.attemptId, row);
      continue;
    }
    const priority = status => ({ ARMED: 0, FAILED_PRE_CLICK: 1, UNKNOWN: 2, VERIFIED: 3 })[status] ?? -1;
    if (priority(row.status) > priority(prior.status)
        || (priority(row.status) === priority(prior.status)
          && Date.parse(row.sentAt) >= Date.parse(prior.sentAt))) {
      attempts.set(row.attemptId, row);
    }
  }
  canonical.push(...attempts.values());
  return canonical.sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt)
    || String(left.attemptId || '').localeCompare(String(right.attemptId || '')));
}

function appendPublicHistory(file, entry, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!entry || !Number.isFinite(Number(entry.t)) || typeof entry.room !== 'string'
      || typeof entry.text !== 'string' || typeof entry.verified !== 'boolean'
      || (entry.attemptId != null && !/^[A-Za-z0-9._:-]{8,100}$/u.test(entry.attemptId))
      || (entry.status != null
        && !['ARMED', 'VERIFIED', 'UNKNOWN', 'FAILED_PRE_CLICK'].includes(entry.status))) {
    throw new TypeError('public chat history entry is malformed');
  }
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('public chat history is not a regular bounded file');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const line = `${JSON.stringify(entry)}\n`;
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size + Buffer.byteLength(line, 'utf8') > maxBytes) {
      throw new Error('public chat history is not a regular bounded file');
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.writeSync(descriptor, line);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function claimPublicAttempt(file, entry, options = {}) {
  if (!entry?.attemptId || entry.status !== 'ARMED' || entry.verified !== false) {
    throw new TypeError('public attempt claim must have attemptId, status ARMED, and verified false');
  }
  return withFileLock(file, () => {
    const history = readPublicHistory(file, options);
    if (history.some(record => record.attemptId === entry.attemptId)) {
      return { ok: false, reason: 'public attemptId already exists; never replay it' };
    }
    appendPublicHistory(file, entry, options);
    return { ok: true };
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  appendPublicHistory,
  claimPublicAttempt,
  readPublicHistory,
};
