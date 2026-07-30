'use strict';

function personalAssistantJournalGate(state, { pending = null, review = null } = {}) {
  const status = String(state?.pa?.status || '').trim().toLowerCase();
  if (status === 'unread') {
    return {
      ok: false,
      guard: true,
      reason: 'an unread Personal Assistant offer must be inspected before journal',
      requiredTool: 'pa_read',
    };
  }
  if (status !== 'pending') return null;
  if (!pending || pending.fingerprint !== state?.pa?.fingerprint) {
    return {
      ok: false,
      guard: true,
      reason: 'PA state is pending but its exact offer artifact is unavailable or mismatched',
      requiredTool: 'pa_read',
    };
  }
  if (!review || review.fingerprint !== pending.fingerprint) {
    return {
      ok: false,
      guard: true,
      reason: 'the pending PA offer still needs an independently recorded assessment and guide consultation',
      requiredTool: 'pa_consult_guide',
      offerFingerprint: pending.fingerprint,
    };
  }
  return {
    ok: false,
    guard: true,
    reason: 'the reviewed PA offer remains unresolved; reconcile the guide and submit one fingerprint-bound reply',
    requiredTool: 'pa_reply',
    offerFingerprint: pending.fingerprint,
  };
}

module.exports = { personalAssistantJournalGate };
