'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const DEFAULT_READ_LIMIT_BYTES = 4 * 1024 * 1024;

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWriteText(file, text) {
  if (typeof text !== 'string') throw new TypeError('atomicWriteText requires a string');
  ensureParent(file);
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function atomicWriteJson(file, value) {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWriteJsonl(file, values) {
  if (!Array.isArray(values)) throw new TypeError('JSONL value must be an array');
  const content = values.length > 0
    ? `${values.map(value => JSON.stringify(value)).join('\n')}\n`
    : '';
  atomicWriteText(file, content);
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockIdentity(lockFile) {
  const stat = fs.lstatSync(lockFile);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) {
    throw new Error(`Chat memory lock is not a regular file: ${lockFile}`);
  }
  let record = null;
  try { record = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (_) {}
  return {
    stat,
    pid: Number(record?.pid),
    token: typeof record?.token === 'string' ? record.token : null,
  };
}

function sameFileIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function withFileLock(file, operation, {
  waitMs = 2000,
  staleMs = 120000,
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('lock operation must be a function');
  ensureParent(file);
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let descriptor;
  let ownedIdentity = null;
  const token = randomUUID();
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        ownedIdentity = fs.fstatSync(descriptor);
      } catch (error) {
        fs.closeSync(descriptor);
        descriptor = undefined;
        try { fs.unlinkSync(lockFile); } catch (_) {}
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const observed = readLockIdentity(lockFile);
        const ageMs = Date.now() - observed.stat.mtimeMs;
        if (ageMs > staleMs && !processIsAlive(observed.pid)) {
          const current = readLockIdentity(lockFile);
          if (sameFileIdentity(observed.stat, current.stat) && observed.token === current.token) {
            fs.unlinkSync(lockFile);
          }
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for chat memory lock ${lockFile}`);
      sleepSync(10);
    }
  }
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = readLockIdentity(lockFile);
      if (sameFileIdentity(ownedIdentity, current.stat) && current.token === token) {
        fs.unlinkSync(lockFile);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function readJson(file, fallbackFactory, { maxBytes = DEFAULT_READ_LIMIT_BYTES } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
      throw new Error('file is not a regular bounded JSON file');
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && typeof fallbackFactory === 'function') return fallbackFactory();
    throw new Error(`Cannot read valid JSON from ${file}: ${error.message}`, { cause: error });
  }
}

function readJsonl(file, { maxBytes = DEFAULT_READ_LIMIT_BYTES } = {}) {
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
      throw new Error('file is not a regular bounded JSONL file');
    }
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!text.trim()) return [];
  return text.split(/\r?\n/).reduce((values, line, index) => {
    if (!line.trim()) return values;
    try {
      values.push(JSON.parse(line));
      return values;
    } catch (error) {
      throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${error.message}`, { cause: error });
    }
  }, []);
}

module.exports = {
  DEFAULT_READ_LIMIT_BYTES,
  atomicWriteJson,
  atomicWriteJsonl,
  atomicWriteText,
  readJson,
  readJsonl,
  withFileLock,
};
