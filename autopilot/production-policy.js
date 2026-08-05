'use strict';

// Company-level limits are hard ceilings, not mandatory order durations. The brain chooses a
// shorter or maximum-duration batch from current operational evidence.

const MILL_BATCH_DEFAULT_SECONDS = 3600;
const MILL_BATCH_CHECKPOINT_LIMIT_SECONDS = 6 * 3600;
const MILL_BATCH_IMMINENT_SECONDS = 5 * 60;
const MILL_BATCH_MINIMUM_FRACTION = 0.75;
const STATE_MAX_AGE_SECONDS = 5 * 60;
const STATE_MAX_FUTURE_SKEW_SECONDS = 30;
const PRODUCTION_CHECKPOINT_BUFFER_SECONDS = 60;
const PRODUCTION_CHECKPOINT_MAX_AHEAD_SECONDS = 4 * 3600;
const COFFEE_CHAIN_KINDS = new Set([1, 2, 66, 118, 119]);

function maxProductionHoursForLevel(companyLevel) {
  const level = Number(companyLevel);
  if (!Number.isFinite(level)) return null;
  if (level >= 15) return 48;
  if (level >= 10) return 24;
  return null;
}

function resolveTargetHours(requestedHours, companyLevel) {
  if (requestedHours == null) return null;
  const requested = Number(requestedHours);
  const maximum = maxProductionHoursForLevel(companyLevel);
  if (!Number.isFinite(requested) || requested <= 0 || maximum == null) return null;
  return Math.min(requested, maximum);
}

function capQuantityForDuration(requestedQty, observedSeconds, maxHours) {
  return capQuantityForSeconds(requestedQty, observedSeconds, Number(maxHours) * 3600);
}

function capQuantityForSeconds(requestedQty, observedSeconds, maxSeconds) {
  const quantity = Number(requestedQty);
  const seconds = Number(observedSeconds);
  const ceilingSeconds = Number(maxSeconds);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(ceilingSeconds) || ceilingSeconds <= 0) {
    return Math.floor(quantity);
  }
  if (seconds <= ceilingSeconds) return Math.floor(quantity);
  return Math.max(1, Math.floor(quantity * ceilingSeconds / seconds));
}

function buildProductionPolicyPagePrelude() {
  // capQuantityForDuration references capQuantityForSeconds by its lexical name. Recreate that
  // binding inside the same page evaluation before exposing either helper on window; serializing
  // the two functions as unrelated window assignments loses their CommonJS module scope.
  return `const capQuantityForSeconds=${capQuantityForSeconds.toString()}; window.__capQuantityForSeconds=capQuantityForSeconds; window.__capQuantityForDuration=${capQuantityForDuration.toString()};`;
}

function parseProductionCheckpoint(finishBefore, nowMs = Date.now()) {
  if (finishBefore == null) {
    return { ok: true, enabled: false, finishBefore: null };
  }
  const now = Number(nowMs);
  const deadlineMs = Date.parse(finishBefore);
  if (!Number.isFinite(now) || !Number.isFinite(deadlineMs)) {
    return { ok: false, reason: 'finishBefore must be a valid ISO timestamp' };
  }
  const secondsAhead = Math.floor((deadlineMs - now) / 1000);
  if (secondsAhead <= PRODUCTION_CHECKPOINT_BUFFER_SECONDS) {
    return {
      ok: false,
      reason: `finishBefore must leave more than the ${PRODUCTION_CHECKPOINT_BUFFER_SECONDS}-second safety buffer`,
      secondsAhead,
    };
  }
  if (secondsAhead > PRODUCTION_CHECKPOINT_MAX_AHEAD_SECONDS) {
    return {
      ok: false,
      reason: `finishBefore cannot be more than ${PRODUCTION_CHECKPOINT_MAX_AHEAD_SECONDS / 3600} hours ahead`,
      secondsAhead,
    };
  }
  return {
    ok: true,
    enabled: true,
    finishBefore: new Date(deadlineMs).toISOString(),
    deadlineMs,
    secondsAhead,
    bufferSeconds: PRODUCTION_CHECKPOINT_BUFFER_SECONDS,
    usableSeconds: secondsAhead - PRODUCTION_CHECKPOINT_BUFFER_SECONDS,
  };
}

function buildMillBatchPolicy(
  state,
  buildingId,
  targetHours,
  nowMs = Date.now(),
  productName = null,
  finishBefore = null,
) {
  const capturedMs = Date.parse(state?.t);
  const now = Number(nowMs);
  const stateAgeSeconds = Number.isFinite(capturedMs) && Number.isFinite(now)
    ? Math.round((now - capturedMs) / 1000)
    : null;
  const buildings = Array.isArray(state?.buildings) ? state.buildings : [];
  const target = buildings.find((building) => Number(building.id) === Number(buildingId));
  const canonicalProduct = String(productName || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const isMill = target && (
    String(target.name || '').trim().toLowerCase() === 'mill'
    || String(target.kindLetter || '').trim().toLowerCase() === 'i'
  );
  if (!isMill && canonicalProduct !== 'COFFEE POWDER') {
    return { enabled: false, reason: 'target-is-not-a-mill', stateAgeSeconds };
  }

  // Fresh state is required for input and construction claims, but not for the basic safety
  // invariant: Coffee Powder is a Mill product and an unexplained ten-minute order is still a
  // micro-batch. Fall back to a conservative one-hour preview instead of disabling the guard.
  if (stateAgeSeconds == null || stateAgeSeconds > STATE_MAX_AGE_SECONDS ||
      stateAgeSeconds < -STATE_MAX_FUTURE_SKEW_SECONDS) {
    const requestedCeilingSeconds = Number(targetHours) > 0 ? Number(targetHours) * 3600 : null;
    const desiredDurationSeconds = Number.isFinite(requestedCeilingSeconds)
      ? Math.min(MILL_BATCH_DEFAULT_SECONDS, requestedCeilingSeconds)
      : MILL_BATCH_DEFAULT_SECONDS;
    return {
      enabled: true,
      reason: 'stale-state-default-one-hour-fallback',
      stateAsOf: state?.t ?? null,
      stateAgeSeconds,
      checkpointSeconds: null,
      desiredDurationSeconds,
      minimumDurationSeconds: Math.max(
        MILL_BATCH_IMMINENT_SECONDS,
        Math.round(desiredDurationSeconds * MILL_BATCH_MINIMUM_FRACTION),
      ),
      inputCapQty: null,
    };
  }

  const checkpointSeconds = buildings
    .filter((building) => (
      String(building.name || '').trim().toLowerCase() === 'mill'
      || String(building.kindLetter || '').trim().toLowerCase() === 'i'
    ) && building.busy?.type === 'construction')
    .map((building) => (Date.parse(building.busy.endsAt) - Number(nowMs)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
    .sort((a, b) => a - b)[0] ?? null;

  const explicitCheckpoint = parseProductionCheckpoint(finishBefore, nowMs);
  const usesExplicitCheckpoint = explicitCheckpoint.ok && explicitCheckpoint.enabled;

  if (!usesExplicitCheckpoint && checkpointSeconds != null && checkpointSeconds < MILL_BATCH_IMMINENT_SECONDS) {
    return {
      enabled: false,
      reason: 'mill-construction-checkpoint-imminent',
      stateAgeSeconds,
      checkpointSeconds: Math.round(checkpointSeconds),
    };
  }

  const usesCheckpoint = checkpointSeconds != null
    && checkpointSeconds <= MILL_BATCH_CHECKPOINT_LIMIT_SECONDS;
  let desiredDurationSeconds = usesExplicitCheckpoint
    ? explicitCheckpoint.usableSeconds
    : usesCheckpoint
    ? checkpointSeconds
    : MILL_BATCH_DEFAULT_SECONDS;
  const requestedCeilingSeconds = Number(targetHours) > 0 ? Number(targetHours) * 3600 : null;
  if (Number.isFinite(requestedCeilingSeconds)) {
    desiredDurationSeconds = Math.min(desiredDurationSeconds, requestedCeilingSeconds);
  }
  desiredDurationSeconds = Math.max(
    usesExplicitCheckpoint ? 1 : MILL_BATCH_IMMINENT_SECONDS,
    Math.round(desiredDurationSeconds),
  );

  const beans = Array.isArray(state?.stock)
    ? state.stock.find((entry) => Number(entry.kind) === 118 && entry.known === true)
    : null;
  const blockedBeanAmount = Number(beans?.blockedAmount);
  const beanAmount = beans?.availableAmount == null && Number.isFinite(blockedBeanAmount) && blockedBeanAmount > 0
    ? null
    : Number(beans?.availableAmount ?? beans?.amount);
  const inputCapQty = Number.isFinite(beanAmount) && beanAmount >= 0
    ? Math.floor(beanAmount / 10)
    : null;

  return {
    enabled: true,
    reason: usesExplicitCheckpoint
      ? 'explicit-production-checkpoint'
      : usesCheckpoint
      ? 'next-mill-construction-checkpoint'
      : 'default-useful-one-hour-fallback',
    stateAsOf: state.t,
    stateAgeSeconds,
    checkpointSeconds: checkpointSeconds == null ? null : Math.round(checkpointSeconds),
    desiredDurationSeconds,
    minimumDurationSeconds: Math.max(
      usesExplicitCheckpoint ? 1 : MILL_BATCH_IMMINENT_SECONDS,
      Math.round(desiredDurationSeconds * MILL_BATCH_MINIMUM_FRACTION),
    ),
    inputCapQty,
    finishBefore: usesExplicitCheckpoint ? explicitCheckpoint.finishBefore : null,
    checkpointBufferSeconds: usesExplicitCheckpoint ? explicitCheckpoint.bufferSeconds : null,
  };
}

// Self-contained on purpose: act.js serializes this function into the browser page so the exact
// previewed duration and labor quote can be checked before any click.
function evaluateMillBatchGuard({
  name,
  effectiveQty,
  observedSeconds,
  labor,
  cash,
  minCashAfter,
  policy,
}) {
  const canonicalName = String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const quantity = Number(effectiveQty);
  const duration = Number(observedSeconds);
  const minimum = Number(policy?.minimumDurationSeconds);
  const desired = Number(policy?.desiredDurationSeconds);
  if (!policy?.enabled || canonicalName !== 'COFFEE POWDER') {
    return { ok: true, microBatchGuard: false };
  }
  if (!(quantity > 0) || !(duration > 0) || !(minimum > 0) || !(desired > 0)) {
    return {
      ok: false,
      guard: true,
      preview: true,
      microBatchGuard: true,
      reason: 'cannot validate Mill Coffee Powder batch duration from the live preview',
    };
  }
  if (duration >= minimum) {
    return {
      ok: true,
      microBatchGuard: true,
      observedDurationSeconds: duration,
      minimumDurationSeconds: minimum,
    };
  }

  // An explicit checkpoint can create a whole-unit boundary: the current integer quantity fits,
  // while one more unit would cross the usable window. Accept that maximum discrete fit instead of
  // deadlocking between the minimum-fill guard and the absolute deadline guard.
  const nextWholeQuantity = Number.isInteger(quantity) ? quantity + 1 : null;
  const projectedNextWholeSeconds = nextWholeQuantity == null
    ? null
    : duration * nextWholeQuantity / quantity;
  if (policy?.reason === 'explicit-production-checkpoint' &&
      Number.isFinite(projectedNextWholeSeconds) && projectedNextWholeSeconds > desired) {
    return {
      ok: true,
      microBatchGuard: true,
      constrainedBy: 'checkpoint-whole-unit',
      observedDurationSeconds: duration,
      minimumDurationSeconds: minimum,
      projectedNextWholeSeconds: Math.round(projectedNextWholeSeconds),
      checkpointUsableSeconds: desired,
    };
  }

  const rawSuggestedQty = Math.max(quantity + 1, Math.ceil(quantity * desired / duration));
  const caps = [];
  const inputCapQty = policy?.inputCapQty == null ? null : Number(policy.inputCapQty);
  if (Number.isFinite(inputCapQty) && inputCapQty >= 0) {
    caps.push({ name: 'coffee-beans', qty: Math.floor(inputCapQty) });
  }
  const laborValue = labor == null ? null : Number(labor);
  const cashValue = cash == null ? null : Number(cash);
  const reserve = minCashAfter == null ? 0 : Math.max(0, Number(minCashAfter) || 0);
  if (laborValue > 0 && cashValue >= 0) {
    const unitLabor = laborValue / quantity;
    const affordableQty = Math.floor(Math.max(0, cashValue - reserve) / unitLabor * 0.995);
    if (Number.isFinite(affordableQty)) caps.push({ name: 'cash', qty: affordableQty });
  }

  const tightestCap = caps.sort((a, b) => a.qty - b.qty)[0] || null;
  if (tightestCap && tightestCap.qty <= quantity) {
    return {
      ok: true,
      microBatchGuard: true,
      constrainedBy: tightestCap.name,
      observedDurationSeconds: duration,
      minimumDurationSeconds: minimum,
      feasibleQtyCap: tightestCap.qty,
    };
  }

  const suggestedQty = tightestCap
    ? Math.min(rawSuggestedQty, tightestCap.qty)
    : rawSuggestedQty;
  if (!(suggestedQty > quantity)) {
    return { ok: true, microBatchGuard: true, constrainedBy: tightestCap?.name || null };
  }

  return {
    ok: false,
    guard: true,
    preview: true,
    microBatchGuard: true,
    reason: 'unjustified Mill Coffee Powder micro-batch; no order was placed — retry produce with suggestedQty instead of copying busy.amount',
    policyReason: policy.reason || null,
    requestedPreviewQty: quantity,
    observedDurationSeconds: duration,
    minimumDurationSeconds: minimum,
    desiredDurationSeconds: desired,
    suggestedQty,
    suggestedDurationSeconds: Math.round(duration * suggestedQty / quantity),
    limitingConstraint: tightestCap?.name || null,
    feasibleQtyCap: tightestCap?.qty ?? null,
  };
}

function resourceImageSlug(resource) {
  const raw = String(resource?.image || '').split(/[?#]/, 1)[0];
  const filename = raw.split('/').pop() || '';
  return filename.replace(/\.[^.]+$/, '').trim().toLowerCase();
}

function resolveProductionResourceIdentity({ name, knownKinds, lookupKind, resources }) {
  const canonicalName = String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  if (!canonicalName) {
    return { ok: false, reason: 'production resource name is empty' };
  }
  let kind = Number(knownKinds?.[canonicalName]);
  let kindSource = 'known-dialog-map';
  if (!Number.isSafeInteger(kind) || kind <= 0) {
    try { kind = Number(typeof lookupKind === 'function' ? lookupKind(name) : null); }
    catch (_) { kind = NaN; }
    kindSource = 'exchange-name-fallback';
  }
  if (!Number.isSafeInteger(kind) || kind <= 0) {
    return {
      ok: false,
      reason: 'production resource kind cannot be resolved from the dialog map or exchange names',
      name: canonicalName,
    };
  }
  const definitions = resources && typeof resources === 'object' && !Array.isArray(resources)
    ? resources
    : {};
  const resource = definitions[String(kind)];
  const slug = resourceImageSlug(resource);
  const dbLetter = Number(resource?.dbLetter);
  if (!resource || (Number.isFinite(dbLetter) && dbLetter !== kind) || !slug) {
    return {
      ok: false,
      reason: 'resolved production kind has no exact resource image definition',
      name: canonicalName,
      kind,
      kindSource,
    };
  }
  const matchingKinds = Object.entries(definitions)
    .filter(([, candidate]) => resourceImageSlug(candidate) === slug)
    .map(([candidateKind]) => Number(candidateKind))
    .filter(Number.isSafeInteger);
  if (matchingKinds.length !== 1 || matchingKinds[0] !== kind) {
    return {
      ok: false,
      reason: 'resource image slug is not uniquely bound to the resolved production kind',
      name: canonicalName,
      kind,
      resourceSlug: slug,
      matchingKinds,
    };
  }
  return {
    ok: true,
    name: canonicalName,
    kind,
    kindSource,
    resourceSlug: slug,
  };
}

function evaluateBridgeUtilitySurplusGuard({
  name,
  kind,
  qty,
  finishBefore,
  state,
  facts,
  nowMs = Date.now(),
}) {
  const resourceKind = Number(kind);
  const requestedQty = Number(qty);
  const base = {
    bridgeUtilityGuard: true,
    name: String(name || '').trim() || null,
    kind: Number.isSafeInteger(resourceKind) ? resourceKind : null,
    requestedQty: Number.isFinite(requestedQty) ? requestedQty : null,
  };
  if (finishBefore == null) return { ok: true, bridgeUtilityGuard: false, reason: 'no-finishBefore' };
  if (COFFEE_CHAIN_KINDS.has(resourceKind)) {
    return { ok: true, bridgeUtilityGuard: false, coffeeChain: true };
  }
  const failEvidence = (reason, extra = {}) => ({
    ...base,
    ok: false,
    guard: true,
    preview: true,
    failClosed: true,
    reason,
    suggestedQty: 0,
    ...extra,
  });
  if (!Number.isSafeInteger(resourceKind) || resourceKind <= 0 || !(requestedQty > 0)) {
    return failEvidence('non-Coffee finishBefore production lacks an exact kind or positive quantity');
  }

  const capturedMs = Date.parse(state?.t);
  const exactAgeSeconds = (Number(nowMs) - capturedMs) / 1000;
  const stateAgeSeconds = Number.isFinite(exactAgeSeconds) ? Math.round(exactAgeSeconds) : null;
  if (!Number.isFinite(capturedMs) || !Number.isFinite(Number(nowMs)) ||
      exactAgeSeconds < -STATE_MAX_FUTURE_SKEW_SECONDS || exactAgeSeconds > STATE_MAX_AGE_SECONDS) {
    return failEvidence('non-Coffee finishBefore production requires a fresh state-tied utility surplus plan', {
      stateAsOf: state?.t ?? null,
      stateAgeSeconds,
    });
  }
  const sameCapture = (value) => Number.isFinite(Date.parse(value)) && Date.parse(value) === capturedMs;
  const plan = state?.surplusPlan;
  const source = state?.sources?.surplusPlan;
  // Not the whole-plan flag. PR #67 removed it from the journal gate and the sale path after four
  // units of unpriceable construction leftovers withheld a fully priced 67,293-unit water surplus;
  // this is the same veto, one layer down, and it kept the sale blocked anyway. The per-item check
  // below already fails closed, and calculateCoffeeReservePolicy marks every item unknown on each of
  // its early-bail paths, so nothing the flag caught goes uncaught.
  // sources.surplusPlan.status is a copy of plan.status (state.js:396), so it carries the same
  // whole-plan verdict and goes with it. The asOf ties are provenance, not completeness, and stay.
  if (!sameCapture(plan?.asOf) || !sameCapture(source?.asOf)) {
    return failEvidence('utility sellable surplus is not complete and tied to the fresh state capture', {
      stateAsOf: state.t,
      stateAgeSeconds,
      surplusPlanStatus: plan?.status ?? null,
      surplusPlanComplete: plan?.complete === true,
      surplusPlanAsOf: plan?.asOf ?? null,
      surplusPlanSourceStatus: source?.status ?? null,
      surplusPlanSourceAsOf: source?.asOf ?? null,
    });
  }

  const resources = facts?.resources && typeof facts.resources === 'object'
    ? facts.resources
    : facts;
  const product = resources?.[String(resourceKind)];
  const recipe = product?.recipe;
  if (!product || !recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return failEvidence('exact production recipe is unavailable for non-Coffee finishBefore production', {
      stateAsOf: state.t,
      stateAgeSeconds,
    });
  }
  const recipeEntries = Object.entries(recipe);
  if (recipeEntries.some(([, coefficient]) =>
    coefficient == null || coefficient === '' ||
    !Number.isFinite(Number(coefficient)) || Number(coefficient) < 0)) {
    return failEvidence('production recipe contains an invalid input coefficient', {
      stateAsOf: state.t,
      stateAgeSeconds,
    });
  }
  const utilityInputs = recipeEntries
    .map(([inputKind, coefficient]) => ({ kind: Number(inputKind), unitsPerOutput: Number(coefficient) }))
    .filter(input => (input.kind === 1 || input.kind === 2) && input.unitsPerOutput > 0);
  if (!utilityInputs.length) {
    return {
      ...base,
      ok: true,
      constrained: false,
      stateAsOf: state.t,
      stateAgeSeconds,
      utilityRequirements: [],
    };
  }

  const utilityRequirements = [];
  for (const input of utilityInputs) {
    const item = plan.items?.[String(input.kind)];
    const sellable = item?.sellable == null || item.sellable === '' ? NaN : Number(item.sellable);
    const itemKind = Number(item?.kind);
    if (item?.status !== 'ok' || itemKind !== input.kind || !Number.isFinite(sellable) || sellable < 0 ||
        !sameCapture(item?.evidence?.stockAsOf)) {
      return failEvidence('Power/Water sellable surplus is not exactly verified for this state capture', {
        stateAsOf: state.t,
        stateAgeSeconds,
        utilityKind: input.kind,
        utilityStatus: item?.status ?? null,
        utilityEvidenceAsOf: item?.evidence?.stockAsOf ?? null,
      });
    }
    utilityRequirements.push({
      kind: input.kind,
      name: input.kind === 1 ? 'Power' : 'Water',
      unitsPerOutput: input.unitsPerOutput,
      requestedUnits: requestedQty * input.unitsPerOutput,
      verifiedSellable: sellable,
      maxOutputQty: Math.max(0, Math.floor((sellable + 1e-9) / input.unitsPerOutput)),
    });
  }
  const suggestedQty = Math.min(...utilityRequirements.map(input => input.maxOutputQty));
  if (requestedQty > suggestedQty) {
    return {
      ...base,
      ok: false,
      guard: true,
      preview: true,
      failClosed: true,
      constrained: true,
      reason: 'finishBefore bridge would consume Power/Water held for the verified Coffee reserve; no browser was opened',
      suggestedQty,
      stateAsOf: state.t,
      stateAgeSeconds,
      surplusPlanAsOf: plan.asOf,
      utilityRequirements,
    };
  }
  return {
    ...base,
    ok: true,
    constrained: true,
    suggestedQty,
    stateAsOf: state.t,
    stateAgeSeconds,
    surplusPlanAsOf: plan.asOf,
    utilityRequirements,
  };
}

module.exports = {
  buildMillBatchPolicy,
  buildProductionPolicyPagePrelude,
  capQuantityForDuration,
  capQuantityForSeconds,
  evaluateBridgeUtilitySurplusGuard,
  evaluateMillBatchGuard,
  maxProductionHoursForLevel,
  parseProductionCheckpoint,
  resolveProductionResourceIdentity,
  resolveTargetHours,
};
