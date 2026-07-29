'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RESOURCE_NAMES_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'shared',
  'price-tracker',
  'data',
  'names.json',
);
const DEFAULT_RESOURCE_DEFS_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'shared',
  'facts',
  'defs.json',
);
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_CATALOG_ENTRIES = 300;
const MAX_PROJECTED_ENTRIES = 24;
const COMMON_CHAT_RESOURCE_KINDS = Object.freeze([1, 2, 118, 119]);

function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function validateTrustedResourceCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1 || value.trust !== 'internal-verified'
      || !Array.isArray(value.entries) || value.entries.length > MAX_CATALOG_ENTRIES) return false;
  const seen = new Set();
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).sort().join(',') !== 'kind,name'
        || !Number.isSafeInteger(entry.kind) || entry.kind <= 0
        || typeof entry.name !== 'string' || !normalizeName(entry.name)
        || entry.name.length > 120 || seen.has(entry.kind)) return false;
    seen.add(entry.kind);
  }
  return true;
}

function readBoundedJson(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CATALOG_BYTES) {
    throw new Error(`${label} must be a regular bounded file`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function nameFromImage(value) {
  const basename = String(value ?? '').split('/').at(-1)?.replace(/\.png$/iu, '') ?? '';
  return normalizeName(basename.replace(/-/gu, ' '));
}

function loadTrustedResourceCatalog(file = DEFAULT_RESOURCE_NAMES_FILE, {
  defsFile = DEFAULT_RESOURCE_DEFS_FILE,
} = {}) {
  const parsed = readBoundedJson(file, 'resource name catalog');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('resource name catalog must be an object');
  }
  const names = new Map(Object.entries(parsed).map(([rawKind, rawName]) => ([
    Number(rawKind),
    normalizeName(rawName),
  ])));
  if (defsFile != null) {
    const definitions = readBoundedJson(defsFile, 'resource definitions');
    for (const [rawKind, resource] of Object.entries(definitions?.resources || {})) {
      const kind = Number(rawKind);
      if (!names.has(kind)) names.set(kind, nameFromImage(resource?.image));
    }
  }
  const entries = [...names.entries()].map(([kind, name]) => ({ kind, name }))
    .sort((left, right) => left.kind - right.kind);
  const catalog = Object.freeze({
    schemaVersion: 1,
    trust: 'internal-verified',
    entries: Object.freeze(entries.map(Object.freeze)),
  });
  if (!validateTrustedResourceCatalog(catalog)) {
    throw new Error('resource name catalog is malformed or ambiguous');
  }
  return catalog;
}

function projectTrustedResourceCatalog(catalog, kinds = []) {
  if (!validateTrustedResourceCatalog(catalog)) {
    throw new TypeError('trusted resource catalog is invalid');
  }
  if (!Array.isArray(kinds)) throw new TypeError('resource kinds must be an array');
  const wanted = [...new Set([...COMMON_CHAT_RESOURCE_KINDS, ...kinds]
    .map(Number)
    .filter(kind => Number.isSafeInteger(kind) && kind > 0))];
  const byKind = new Map(catalog.entries.map(entry => [entry.kind, entry]));
  const entries = wanted.map(kind => byKind.get(kind)).filter(Boolean).slice(0, MAX_PROJECTED_ENTRIES)
    .map(entry => Object.freeze({ kind: entry.kind, name: entry.name }));
  return Object.freeze({
    schemaVersion: 1,
    trust: 'internal-verified',
    entries: Object.freeze(entries),
  });
}

function resourcePartMatchesCatalog(part, catalog) {
  if (!part || part.type !== 'resource' || !validateTrustedResourceCatalog(catalog)) return false;
  const matches = catalog.entries.filter(entry => entry.kind === Number(part.kind));
  if (matches.length !== 1) return false;
  return normalizeName(part.name).toLocaleLowerCase('en-US')
    === normalizeName(matches[0].name).toLocaleLowerCase('en-US');
}

module.exports = {
  COMMON_CHAT_RESOURCE_KINDS,
  DEFAULT_RESOURCE_DEFS_FILE,
  DEFAULT_RESOURCE_NAMES_FILE,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_ENTRIES,
  MAX_PROJECTED_ENTRIES,
  loadTrustedResourceCatalog,
  projectTrustedResourceCatalog,
  resourcePartMatchesCatalog,
  validateTrustedResourceCatalog,
};
