'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_SCHEMA_VERSION = 1;

function numericKind(value) {
  const kind = Number(value);
  return Number.isSafeInteger(kind) && kind > 0 ? kind : null;
}

function emptyStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    updatedAt: null,
    artifactsByKind: {},
  };
}

function normalizeStore(value) {
  const store = emptyStore();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return store;

  if (Number(value.schemaVersion) === STORE_SCHEMA_VERSION &&
      value.artifactsByKind && typeof value.artifactsByKind === 'object' &&
      !Array.isArray(value.artifactsByKind)) {
    for (const [key, artifact] of Object.entries(value.artifactsByKind)) {
      const kind = numericKind(key);
      if (kind != null && artifact && typeof artifact === 'object' && !Array.isArray(artifact) &&
          numericKind(artifact.kind) === kind) {
        store.artifactsByKind[String(kind)] = artifact;
      }
    }
    store.updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : null;
    return store;
  }

  // Migrate the former single-artifact file without discarding an inspection that may still
  // be valid. The next write converts it to the per-kind registry format.
  const legacyKind = numericKind(value.kind);
  if (legacyKind != null) {
    store.artifactsByKind[String(legacyKind)] = value;
    store.updatedAt = typeof value.inspectedAt === 'string' ? value.inspectedAt : null;
  }
  return store;
}

function readInspectionStore(file) {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return emptyStore();
  }
}

function writeStoreAtomic(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(store));
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function readInspectionArtifact(file, kind) {
  const resolvedKind = numericKind(kind);
  if (resolvedKind == null) return null;
  return readInspectionStore(file).artifactsByKind[String(resolvedKind)] || null;
}

function writeInspectionArtifact(file, artifact) {
  const kind = numericKind(artifact?.kind);
  if (kind == null) {
    return { ok: false, reason: 'inspection artifact has no positive numeric resource kind' };
  }
  const store = readInspectionStore(file);
  const previous = store.artifactsByKind[String(kind)] || null;
  const previousInspectedAtMs = Date.parse(previous?.inspectedAt);
  const inspectedAtMs = Date.parse(artifact?.inspectedAt);
  if (Number.isFinite(previousInspectedAtMs) && Number.isFinite(inspectedAtMs) &&
      inspectedAtMs < previousInspectedAtMs) {
    return { ok: false, kind, reason: 'inspection is older than the active evidence' };
  }
  store.artifactsByKind[String(kind)] = artifact;
  store.updatedAt = typeof artifact.inspectedAt === 'string'
    ? artifact.inspectedAt
    : new Date().toISOString();
  writeStoreAtomic(file, store);
  return { ok: true, kind };
}

function consumeInspectionArtifact(activeFile, usedFile, kind, expectedInspectionId = null) {
  const resolvedKind = numericKind(kind);
  if (resolvedKind == null) throw new Error('inspection kind must be a positive integer');

  const activeStore = readInspectionStore(activeFile);
  const key = String(resolvedKind);
  const artifact = activeStore.artifactsByKind[key] || null;
  if (!artifact) throw new Error(`no active inspection exists for resource kind ${resolvedKind}`);
  if (expectedInspectionId != null && artifact.inspectionId !== expectedInspectionId) {
    throw new Error(`active inspection changed for resource kind ${resolvedKind}`);
  }

  // Removing this one kind from the active registry is the security boundary. Once this atomic
  // rename succeeds, the confirmed inspection cannot be replayed, while other products remain.
  delete activeStore.artifactsByKind[key];
  activeStore.updatedAt = new Date().toISOString();
  writeStoreAtomic(activeFile, activeStore);

  const usedStore = readInspectionStore(usedFile);
  usedStore.artifactsByKind[key] = artifact;
  usedStore.updatedAt = activeStore.updatedAt;
  writeStoreAtomic(usedFile, usedStore);
  return artifact;
}

module.exports = {
  STORE_SCHEMA_VERSION,
  consumeInspectionArtifact,
  normalizeStore,
  readInspectionArtifact,
  readInspectionStore,
  writeInspectionArtifact,
};
