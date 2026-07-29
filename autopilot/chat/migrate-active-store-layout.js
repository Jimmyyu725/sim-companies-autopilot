#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  DEFAULT_ACTIVE_ROOT,
  DEFAULT_ACTIVE_ROOT_ALLOWLIST,
  migrateLegacyActiveChatStore,
} = require('./active-store.js');

function parseArguments(values) {
  const options = {
    confirm: false,
    root: DEFAULT_ACTIVE_ROOT,
    allowedRoots: DEFAULT_ACTIVE_ROOT_ALLOWLIST,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--confirm') {
      options.confirm = true;
    } else if (value === '--root') {
      const root = values[index + 1];
      if (typeof root !== 'string' || !root || root.startsWith('--')) {
        throw new Error('--root requires an explicit path');
      }
      index += 1;
      options.root = path.resolve(root);
    } else if (value === '--allowed-root') {
      const allowedRoot = values[index + 1];
      if (typeof allowedRoot !== 'string' || !allowedRoot || allowedRoot.startsWith('--')) {
        throw new Error('--allowed-root requires an explicit path');
      }
      index += 1;
      options.allowedRoots = [path.resolve(allowedRoot)];
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (!options.confirm) {
    throw new Error('migration requires literal --confirm');
  }
  return options;
}

function main(values = process.argv.slice(2)) {
  const options = parseArguments(values);
  return migrateLegacyActiveChatStore(options.root, {
    allowedRoots: options.allowedRoots,
    now: new Date(),
  });
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(main()));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      migrated: false,
      reason: String(error.message || error).slice(0, 240),
    }));
    process.exitCode = 1;
  }
}

module.exports = { main, parseArguments };
