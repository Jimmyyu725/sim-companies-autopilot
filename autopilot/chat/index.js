'use strict';

const activeWorker = require('./active-worker.js');
const activeStore = require('./active-store.js');
const businessSnapshot = require('./business-snapshot.js');
const executionClaim = require('./execution-claim.js');
const replyTemplates = require('./reply-templates.js');

module.exports = {
  ...require('./communication-authorization.js'),
  ...require('./injection-guard.js'),
  ...require('./ingest.js'),
  ...require('./memory-store.js'),
  ...require('./llm-decision-provider.js'),
  ...require('./policy.js'),
  ...require('./private-outbox.js'),
  ...require('./public-history.js'),
  ...require('./runtime-mode.js'),
  // Keep the two orchestrator surfaces namespaced so their DEFAULT_* constants do not overwrite
  // unrelated flat exports above.  A launcher can call chat.activeWorker.runActiveChatCycle() and
  // inject chat.businessSnapshot.createBusinessSnapshotLoader() without enabling either one here.
  activeWorker,
  activeStore,
  businessSnapshot,
  executionClaim,
  replyTemplates,
  schemas: require('./schemas.js'),
};
