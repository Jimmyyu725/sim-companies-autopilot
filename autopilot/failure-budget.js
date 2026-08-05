'use strict';

function isExpectedPreview(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.dry === true || result.preview === true) return true;
  const reason = String(result.reason || '');
  return /dry run|not confirmed/i.test(reason);
}

function isActionFailure(result) {
  if (!result || typeof result !== 'object' || isExpectedPreview(result)) return false;
  return result.ok === false || Boolean(result.err);
}

class FailureBudget {
  constructor(limit = 2) {
    this.limit = limit;
    this.failures = new Map();
    this.rejectedPreviews = new Map();
  }

  before(key, previewKey = null) {
    const failures = this.failures.get(key) || 0;
    const repeatedPreviews = previewKey ? (this.rejectedPreviews.get(previewKey) || 0) : 0;
    if (repeatedPreviews > 0) {
      return {
        ok: false,
        guard: true,
        repeatedPreviewOpen: true,
        reason: `${previewKey} was already rejected by the Mill micro-batch preview this wake; use suggestedQty or fresh evidence, not the same qty`,
      };
    }
    if (failures < this.limit) return null;
    return {
      ok: false,
      guard: true,
      failureBudgetOpen: true,
      reason: `${key} already failed ${failures} times this wake; do not retry again`,
    };
  }

  // The keys this budget has closed for the rest of the wake. A guard that demands one of these
  // actions is demanding something no tool call can carry out — the budget refuses it before the
  // action is ever attempted.
  exhausted() {
    const keys = new Set();
    for (const [key, failures] of this.failures) if (failures >= this.limit) keys.add(key);
    return keys;
  }

  record(key, result, previewKey = null) {
    if (result?.ok === false && result?.preview === true
        && result?.microBatchGuard === true && previewKey) {
      this.rejectedPreviews.set(previewKey, (this.rejectedPreviews.get(previewKey) || 0) + 1);
      return this.failures.get(key) || 0;
    }
    if (!isActionFailure(result)) {
      if (!isExpectedPreview(result) && result?.ok === true) this.failures.delete(key);
      return this.failures.get(key) || 0;
    }
    if (result?.doNotRetry === true) {
      const failures = Math.max(this.limit, (this.failures.get(key) || 0) + 1);
      this.failures.set(key, failures);
      return failures;
    }
    const failures = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, failures);
    return failures;
  }
}

module.exports = { FailureBudget, isActionFailure, isExpectedPreview };
