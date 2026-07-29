'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROVIDER_FAIL_CLOSED_REASONS,
  WORKER_ERROR_REASONS,
} = require('./diagnostic-codes.js');

const DEFAULT_CHAT_DIARY_ROOT = path.resolve(__dirname, '..', 'chat-diaries');
const MAX_DIARY_FILES = 10_000;

// Diary fields are durable.  Never "sanitize" arbitrary runtime strings into something that is
// merely identifier-shaped: a player/company/message fragment can also be identifier-shaped.  Only
// literal codes emitted by trusted host code may cross this boundary; everything else collapses to
// UNKNOWN.
const ALLOWED_ERROR_STAGES = new Set([
  'authorize', 'budget', 'claim', 'decision', 'dedupe', 'ingest', 'plan', 'postcondition',
  'preview', 'rate', 'read', 'source-state',
]);
const ALLOWED_ERROR_REASONS = new Set([
  'active-cycle-deadline-exceeded',
  'active-cycle-unhandled-error',
  'ambiguous-confirm-outcome',
  'business-snapshot-load-failed',
  'business-snapshot-required',
  'confirm-rate-limit',
  'confirm-rate-limit-after-preview',
  'confirm-rate-unavailable',
  'content-replay-state-unavailable',
  'decision-provider-failed',
  'decision-snapshot-build-failed',
  'decision-timeout',
  'decision-token-budget-exceeded',
  'decision-token-budget-exhausted',
  'decision-token-reservation-unavailable',
  'decision-usage-unavailable',
  'durable-attempt-claim-failed',
  'durable-attempt-claim-refused',
  'durable-attempt-store-required',
  'durable-economic-authorization-required',
  'durable-execution-claim-token-missing',
  'economic-authorization-issue-failed-after-claim',
  'economic-authorization-store-unreadable',
  'exact-action-plan-build-failed',
  'issued-economic-binding-mismatch-after-claim',
  'lock-or-mutation-permission-denied',
  'next-wake-read-failed',
  'next-wake-safety-margin',
  'next-wake-unknown',
  'observation-normalization-failed',
  'observation-not-durable',
  'observation-persistence-failed',
  'outcome-persistence-unproven',
  'plan-authorization-action-mismatch',
  'plan-authorization-build-refused',
  'plan-authorization-factory-invalid',
  'plan-authorization-factory-missing',
  'plan-authorization-input-invalid',
  'plan-internal-failure',
  'plan-ordinary-template-rejected',
  'plan-private-source-binding-invalid',
  'plan-public-context-invalid',
  'plan-public-parts-invalid',
  'plan-public-policy-refused',
  'plan-public-source-binding-invalid',
  'plan-public-style-limit',
  'plan-unsupported-action',
  'permission-guard-failed',
  'permission-guard-required',
  'preview-result-missing',
  'preview-runner-failed',
  'preview-timeout',
  'private-outbox-required',
  'private-outbox-unreadable',
  'private-preview-binding-mismatch',
  'prompt-injection-suspected',
  ...PROVIDER_FAIL_CLOSED_REASONS,
  ...Object.values(WORKER_ERROR_REASONS),
  'public-post-preview-binding-mismatch',
  'public-preview-binding-mismatch',
  'read-not-successful',
  'read-runner-failed',
  'read-timeout',
  'runtime-mode-refused-confirmation',
  'shadow-preview-persistence-failed',
  'shadow-preview-store-required',
  'source-message-not-fresh',
  'source-state-unavailable',
]);
const ALLOWED_STOP_REASONS = new Set([
  ...ALLOWED_ERROR_REASONS,
  'chat-runtime-off',
]);

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function allowedCode(value, allowlist, fallback = 'UNKNOWN') {
  return typeof value === 'string' && allowlist.has(value) ? value : fallback;
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError('chat diary time must be valid');
  return new Date(parsed).toISOString();
}

function initializeDirectory(root) {
  const resolved = path.resolve(root);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('chat diary root must be a private regular directory');
  }
  fs.chmodSync(resolved, 0o700);
  const existing = fs.readdirSync(resolved).filter(name => /^chat-diary-.*\.md$/u.test(name));
  if (existing.length >= MAX_DIARY_FILES) throw new Error('chat diary directory is full');
  return resolved;
}

function buildChatDiaryRecord({ startedAt, completedAt = new Date(), mode, discovery, result }) {
  const start = timestamp(startedAt);
  const completed = timestamp(completedAt);
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const outcomes = Array.isArray(result?.outcomes) ? result.outcomes : [];
  const proposals = Array.isArray(result?.proposals) ? result.proposals : [];
  const isPublicAction = proposal => ['chat_room_reply', 'chat_room_post'].includes(proposal?.action);
  const outboundProposals = proposals.filter(proposal => [
    'chat_private_send', 'chat_room_reply', 'chat_room_post',
  ].includes(proposal?.action));
  const usage = result?.metrics?.decisionUsage && typeof result.metrics.decisionUsage === 'object'
    ? result.metrics.decisionUsage : {};
  return Object.freeze({
    schemaVersion: 1,
    startedAt: start,
    completedAt: completed,
    mode: ['off', 'read-only', 'shadow', 'safe-reply', 'full'].includes(mode) ? mode : 'unknown',
    roomCount: integer(discovery?.rooms?.length),
    privateContactCount: integer(discovery?.contacts?.length),
    observations: integer(result?.observations?.length),
    strictInboundMessages: integer(result?.strictInboundMessages),
    proposals: integer(outboundProposals.length),
    publicReplyProposals: outboundProposals.filter(
      proposal => proposal?.action === 'chat_room_reply').length,
    proactivePublicPostProposals: outboundProposals.filter(
      proposal => proposal?.action === 'chat_room_post').length,
    economicPublicProposals: outboundProposals.filter(proposal =>
      isPublicAction(proposal) && proposal?.economicAuthorizationRequired === true).length,
    buyProposals: outboundProposals.filter(proposal => proposal?.tradeSide === 'buy').length,
    sellProposals: outboundProposals.filter(proposal => proposal?.tradeSide === 'sell').length,
    exactShadowPreviews: outboundProposals.filter(
      proposal => proposal?.previewStatus === 'VERIFIED').length,
    decisionCalls: integer(result?.metrics?.decisionCalls),
    actionCalls: integer(result?.metrics?.actionCalls) + 2,
    previews: integer(result?.metrics?.previews),
    confirmAttempts: integer(result?.metrics?.confirmAttempts),
    verifiedOutcomes: outcomes.filter(outcome => outcome?.state === 'VERIFIED').length,
    ambiguousOutcomes: outcomes.filter(outcome => outcome?.state === 'AMBIGUOUS').length,
    decisionUsage: Object.freeze({
      knownCalls: integer(usage.knownCalls),
      inputTokens: integer(usage.inputTokens),
      outputTokens: integer(usage.outputTokens),
      totalTokens: integer(usage.totalTokens),
      cachedInputTokens: integer(usage.cachedInputTokens),
      reasoningTokens: integer(usage.reasoningTokens),
    }),
    errorCodes: Object.freeze([...new Set(errors.map(error =>
      `${allowedCode(error?.stage, ALLOWED_ERROR_STAGES)}:${allowedCode(error?.reason, ALLOWED_ERROR_REASONS)}`))]
      .slice(0, 12)),
    stoppedReason: result?.reason == null
      ? null : allowedCode(result.reason, ALLOWED_STOP_REASONS),
    includesMessageBodies: false,
    includesPrivateIdentities: false,
  });
}

function renderChatDiary(record) {
  const errorCodes = record.errorCodes.length ? record.errorCodes.map(code => `- ${code}`).join('\n') : '- none';
  return `# Chat cycle diary\n\n`
    + `- Started: ${record.startedAt}\n`
    + `- Completed: ${record.completedAt}\n`
    + `- Mode: ${record.mode}\n`
    + `- Rooms discovered: ${record.roomCount}\n`
    + `- Private contacts considered: ${record.privateContactCount}\n`
    + `- Observations: ${record.observations}\n`
    + `- Strict inbound messages: ${record.strictInboundMessages}\n`
    + `- Outbound draft proposals: ${record.proposals}\n`
    + `- Public reply proposals: ${record.publicReplyProposals}\n`
    + `- Proactive public post proposals: ${record.proactivePublicPostProposals}\n`
    + `- Economic public proposals: ${record.economicPublicProposals}\n`
    + `- Buy proposals: ${record.buyProposals}\n`
    + `- Sell proposals: ${record.sellProposals}\n`
    + `- Exact shadow previews: ${record.exactShadowPreviews}\n`
    + `- Decision calls: ${record.decisionCalls}\n`
    + `- Total action calls (including discovery): ${record.actionCalls}\n`
    + `- Previews: ${record.previews}\n`
    + `- Confirm attempts: ${record.confirmAttempts}\n`
    + `- Verified outcomes: ${record.verifiedOutcomes}\n`
    + `- Ambiguous outcomes: ${record.ambiguousOutcomes}\n`
    + `- Decision input tokens: ${record.decisionUsage.inputTokens}\n`
    + `- Decision output tokens: ${record.decisionUsage.outputTokens}\n`
    + `- Decision total tokens: ${record.decisionUsage.totalTokens}\n`
    + `- Cached input tokens: ${record.decisionUsage.cachedInputTokens}\n`
    + `- Reasoning tokens: ${record.decisionUsage.reasoningTokens}\n`
    + `- Stop reason: ${record.stoppedReason || 'none'}\n\n`
    + `## Error codes\n\n${errorCodes}\n\n`
    + `## Privacy\n\nNo message bodies or private contact identities are stored in this diary.\n`;
}

class ChatDiaryStore {
  constructor(root = DEFAULT_CHAT_DIARY_ROOT) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new TypeError('chat diary root must be an absolute path');
    }
    this.root = path.resolve(root);
  }

  initialize() {
    initializeDirectory(this.root);
    return this.root;
  }

  write(input) {
    const directory = initializeDirectory(this.root);
    const record = buildChatDiaryRecord(input);
    const slug = record.startedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const suffix = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 10);
    const file = path.join(directory, `chat-diary-${slug}-${suffix}.md`);
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | Number(fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, renderChatDiary(record), 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    return { ok: true, durable: true, file, record };
  }
}

module.exports = {
  ALLOWED_ERROR_REASONS,
  ALLOWED_ERROR_STAGES,
  ALLOWED_STOP_REASONS,
  ChatDiaryStore,
  DEFAULT_CHAT_DIARY_ROOT,
  MAX_DIARY_FILES,
  buildChatDiaryRecord,
  renderChatDiary,
};
