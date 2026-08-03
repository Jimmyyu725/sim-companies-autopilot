'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_FILES = Object.freeze({
  systemPrompt: 'autopilot/BRAIN.md',
  currentMemory: 'autopilot/CURRENT.json',
  state: 'autopilot/.state.json',
  ownerDirective: 'autopilot/OWNER-DIRECTIVE.json',
  lastWake: 'autopilot/.last-wake.json',
  journal: 'autopilot/JOURNAL.md',
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readRequired(file) {
  return fs.readFileSync(file, 'utf8');
}

function readOptional(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function parseJson(source, label, fallback = null) {
  if (!String(source || '').trim()) return fallback;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function latestBrainJournal(source) {
  return String(source || '')
    .split(/\n(?=## )/u)
    .filter(section => section.startsWith('## ') && section.includes('BRAIN wake'))
    .slice(-1)
    .join('\n')
    .slice(-1800);
}

function sourceMetadata(simDir, relativePath, source) {
  const absolutePath = path.join(simDir, relativePath);
  let stat = null;
  try {
    stat = fs.statSync(absolutePath);
  } catch (_) {
    // Optional runtime inputs can legitimately be absent before the first wake.
  }
  return {
    path: relativePath,
    bytes: Buffer.byteLength(source),
    sha256: sha256(source),
    modifiedAt: stat ? stat.mtime.toISOString() : null,
  };
}

function createSnapshot(simDir, now = new Date(), options = {}) {
  const root = path.resolve(simDir);
  const sources = {
    systemPrompt: readRequired(path.join(root, SOURCE_FILES.systemPrompt)),
    currentMemory: readOptional(path.join(root, SOURCE_FILES.currentMemory)),
    state: readRequired(path.join(root, SOURCE_FILES.state)),
    ownerDirective: readOptional(path.join(root, SOURCE_FILES.ownerDirective)),
    lastWake: readOptional(path.join(root, SOURCE_FILES.lastWake)),
    journal: readOptional(path.join(root, SOURCE_FILES.journal)),
  };
  const state = parseJson(sources.state, SOURCE_FILES.state);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`${SOURCE_FILES.state} must contain one state object`);
  }
  const snapshotCreatedAt = now.toISOString();
  const replayStateAt = options.replayAtStateTime === true && Number.isFinite(Date.parse(state.t))
    ? new Date(Date.parse(state.t)).toISOString()
    : null;
  const capturedAt = replayStateAt || snapshotCreatedAt;
  return {
    schemaVersion: 1,
    mode: 'sim-model-shadow-benchmark',
    capturedAt,
    snapshotCreatedAt,
    replayAtStateTime: replayStateAt !== null,
    stateAsOf: state.t || null,
    stalenessSeconds: Number.isFinite(Date.parse(state.t))
      ? Math.max(0, Math.round((Date.parse(capturedAt) - Date.parse(state.t)) / 1000))
      : null,
    systemPrompt: sources.systemPrompt,
    currentMemory: parseJson(sources.currentMemory, SOURCE_FILES.currentMemory),
    state,
    ownerDirective: parseJson(sources.ownerDirective, SOURCE_FILES.ownerDirective),
    wakeReason: parseJson(sources.lastWake, SOURCE_FILES.lastWake)?.reason || '',
    recentJournal: latestBrainJournal(sources.journal),
    sourceManifest: Object.fromEntries(
      Object.entries(SOURCE_FILES).map(([key, relativePath]) => [
        key,
        sourceMetadata(root, relativePath, sources[key]),
      ]),
    ),
  };
}

function buildWakeMessage(snapshot) {
  return [
    `WAKE ${snapshot.capturedAt} (MODEL BENCHMARK SHADOW SIMULATION).`,
    `YOU WERE WOKEN BECAUSE: ${snapshot.wakeReason || '(scheduled check)'}`,
    'PENDING OWNER DIRECTIVE (highest priority; execute safely and keep pending until verified complete):',
    snapshot.ownerDirective ? JSON.stringify(snapshot.ownerDirective) : '(none)',
    'CURRENT MEMORY (authoritative cross-wake plan; current state still wins if newer):',
    snapshot.currentMemory ? JSON.stringify(snapshot.currentMemory) : '(missing — create it with master this wake)',
    '',
    'RECENT JOURNAL (last wake; historical context only, never override CURRENT or current state):',
    snapshot.recentJournal || '(no prior entries — this is your first wake)',
    '',
    'Current state:',
    JSON.stringify(snapshot.state),
  ].join('\n');
}

module.exports = {
  SOURCE_FILES,
  buildWakeMessage,
  createSnapshot,
  latestBrainJournal,
  sha256,
};
