'use strict';

// Provider failures cross a durable privacy boundary. Keep the finite provider vocabulary and the
// corresponding host-facing reasons in one dependency-free module so the worker, launcher, and
// aggregate diary cannot drift apart.
const PROVIDER_FAILURE_CODES = Object.freeze([
  'action-not-allowed-by-host',
  'decision-input-invalid',
  'evidence-reference-invalid',
  'business-snapshot-identity-missing',
  'business-snapshot-time-invalid',
  'business-snapshot-stale',
  'business-snapshot-trust-boundary-missing',
  'business-snapshot-decision-context-invalid',
  'business-snapshot-external-wrapper-invalid',
  'complete-positive-contract-economics-required',
  'contract-counterparty-mismatch',
  'contract-preview-gate-blocked',
  'contract-preview-gate-failed',
  'fresh-lead-offer-required',
  'fresh-public-history-required',
  'lead-economic-evaluation-failed',
  'private-commitment-needs-economic-gate',
  'private-draft-policy-rejected',
  'private-draft-template-not-allowlisted',
  'public-concrete-public-reason-required',
  'public-contract-operation-invalid',
  'public-draft-policy-rejected',
  'public-draft-exceeds-learned-room-length',
  'public-draft-template-not-allowlisted',
  'public-duplicate-public-message',
  'public-proactive-room-cooldown',
  'public-public-daily-limit',
  'public-public-hourly-limit',
  'public-room-evidence-missing',
  'public-roomId-required',
  'public-resource-catalog-invalid',
  'public-safety-evidence-invalid',
  'public-style-evidence-invalid',
  'contract-scope-invalid',
  'raw-player-text-repeated-in-snapshot',
  'responses-output-missing',
  'responses-schema-rejected',
  'responses-transport-error',
]);

const PROVIDER_FAIL_CLOSED_REASONS = Object.freeze([
  ...PROVIDER_FAILURE_CODES.map(code => `provider-fail-closed-${code}`),
  'provider-fail-closed-unknown',
]);

// These worker reasons are returned directly by fixed host validation paths rather than by the
// provider's failureCode schema. They share this module so the durable aggregate allowlist always
// accepts exactly the same privacy-safe literals.
const WORKER_ERROR_REASONS = Object.freeze({
  NEXT_WAKE_READER_REQUIRED: 'next-wake-reader-required',
  PROVIDER_ACTION_OUTSIDE_SOURCE_ALLOWLIST: 'provider-action-outside-source-allowlist',
  PROVIDER_CONTRACT_CANDIDATE_INVALID: 'provider-contract-candidate-invalid',
  PROVIDER_DECISION_NOT_VALIDATED: 'provider-decision-not-validated',
  PROVIDER_PRIVATE_DRAFT_INVALID: 'provider-private-draft-invalid',
  PROVIDER_PRIVATE_DRAFT_POLICY_REJECTED: 'provider-private-draft-policy-rejected',
  PROVIDER_PUBLIC_DRAFT_INVALID: 'provider-public-draft-invalid',
  PROVIDER_PUBLIC_PARTS_INVALID: 'provider-public-parts-invalid',
  UNSUPPORTED_PREVIEW_ACTION: 'unsupported-preview-action',
});

module.exports = {
  PROVIDER_FAIL_CLOSED_REASONS,
  PROVIDER_FAILURE_CODES,
  WORKER_ERROR_REASONS,
};
