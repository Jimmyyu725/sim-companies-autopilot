'use strict';

const MAX_INSPECTION_VALIDITY_MS = 5 * 60e3;

function finiteNonNegative(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function planItemForKind(plan, kind) {
  const key = String(Number(kind));
  if (plan?.items && !Array.isArray(plan.items)) {
    return plan.items[key] || plan.items[Number(kind)] || Object.values(plan.items)
      .find(item => Number(item?.kind) === Number(kind)) || null;
  }
  if (Array.isArray(plan?.items)) {
    return plan.items.find(item => Number(item?.kind) === Number(kind)) || null;
  }
  return null;
}

function availableStock(entry) {
  if (!entry || entry.known !== true) return null;
  const total = finiteNonNegative(entry.amount);
  const blocked = entry.blockedAmount == null ? 0 : finiteNonNegative(entry.blockedAmount);
  const available = entry.availableAmount == null && blocked > 0
    ? null
    : finiteNonNegative(entry.availableAmount ?? entry.amount);
  if (total == null || blocked == null || available == null ||
      Math.abs(total - available - blocked) > 1e-6) return null;
  return available;
}

function validateFreshSurplus(state, kind, qty, now = Date.now(), options = {}) {
  const maxStateAgeSeconds = options.maxStateAgeSeconds ?? 5 * 60;
  const maxPlanAgeSeconds = options.maxPlanAgeSeconds ?? 15 * 60;
  const nowMs = Number(now);
  const requestedQty = Number(qty);
  const numericKind = Number(kind);
  if (!Number.isFinite(nowMs) || !Number.isFinite(Number(maxStateAgeSeconds)) ||
      Number(maxStateAgeSeconds) <= 0 || !Number.isFinite(Number(maxPlanAgeSeconds)) ||
      Number(maxPlanAgeSeconds) <= 0 || !Number.isSafeInteger(numericKind) || numericKind <= 0 ||
      !Number.isSafeInteger(requestedQty) || requestedQty <= 0) {
    return { ok: false, reason: 'exchange sale requires a positive resource kind and quantity' };
  }
  if (numericKind === 13) {
    return { ok: false, reason: 'Transport is an operating constraint and is not authorized as surplus' };
  }
  if (state?.warehouse?.complete !== true || state?.warehouse?.allPositiveProductsIncluded !== true) {
    return { ok: false, reason: 'warehouse capture is incomplete; surplus is UNKNOWN' };
  }
  const stateMs = Date.parse(state?.t);
  const stateAgeSeconds = Number.isFinite(stateMs)
    ? Math.round((nowMs - stateMs) / 1000)
    : null;
  if (stateAgeSeconds == null || stateAgeSeconds < -30 || stateAgeSeconds > maxStateAgeSeconds) {
    return { ok: false, reason: 'captured warehouse state is stale', stateAgeSeconds };
  }
  const stockSourceMs = Date.parse(state?.sources?.stock?.asOf);
  if (state?.sources?.stock?.status !== 'ok' || !Number.isFinite(stockSourceMs) ||
      Math.abs(stockSourceMs - stateMs) > 5000) {
    return { ok: false, reason: 'warehouse source is not authoritative or tied to the captured state' };
  }

  const plan = state?.surplusPlan;
  if (!plan || plan.complete !== true || plan.status !== 'ok') {
    return { ok: false, reason: 'deterministic surplus plan is missing or incomplete' };
  }
  const planMs = Date.parse(plan.asOf);
  const planAgeSeconds = Number.isFinite(planMs)
    ? Math.round((nowMs - planMs) / 1000)
    : null;
  if (planAgeSeconds == null || planAgeSeconds < -30 || planAgeSeconds > maxPlanAgeSeconds) {
    return { ok: false, reason: 'deterministic surplus plan is stale', planAgeSeconds };
  }
  const planStateMs = Date.parse(plan.stateAsOf || plan.asOf);
  if (!Number.isFinite(planStateMs) || Math.abs(planStateMs - stateMs) > 5000) {
    return { ok: false, reason: 'deterministic surplus plan is not tied to the captured state' };
  }

  const item = planItemForKind(plan, numericKind);
  if (!item) return { ok: false, reason: `surplus plan has no resource kind ${numericKind}` };
  if (item.complete === false || ['unknown', 'blocked', 'stale', 'incomplete'].includes(String(item.status || '').toLowerCase())) {
    return { ok: false, reason: `resource kind ${numericKind} reserve evidence is not complete` };
  }

  const liveStockEntry = Array.isArray(state.stock)
    ? state.stock.find(entry => Number(entry?.kind) === numericKind)
    : null;
  const liveStock = availableStock(liveStockEntry);
  const plannedStock = finiteNonNegative(item.stock ?? item.stockQty);
  const reserve = finiteNonNegative(item.reserve ?? item.reserveQty ?? item.safetyStock);
  const declaredSellable = finiteNonNegative(item.sellable ?? item.sellableQty);
  if (liveStock == null || plannedStock == null || reserve == null || declaredSellable == null) {
    return { ok: false, reason: `resource kind ${numericKind} stock/reserve/sellable evidence is incomplete` };
  }
  if (Math.abs(liveStock - plannedStock) > 1e-6) {
    return { ok: false, reason: `resource kind ${numericKind} stock changed after the reserve calculation`, liveStock, plannedStock };
  }

  const recomputedSellable = Math.max(0, Math.floor(liveStock - reserve));
  let safeSellable = Math.min(declaredSellable, recomputedSellable);
  const transportPerUnit = finiteNonNegative(item.transportPerUnit ?? item.transportation);
  const transportStock = availableStock((state.stock || []).find(entry => Number(entry?.kind) === 13));
  let maxByTransport = null;
  if (transportPerUnit != null && transportStock != null) {
    maxByTransport = transportPerUnit === 0 ? null : Math.floor(transportStock / transportPerUnit);
    if (maxByTransport != null) safeSellable = Math.min(safeSellable, maxByTransport);
  } else {
    return { ok: false, reason: `resource kind ${numericKind} transport evidence is incomplete` };
  }

  if (requestedQty > safeSellable + 1e-6) {
    return {
      ok: false,
      reason: `requested ${requestedQty} exceeds verified sellable ${safeSellable}`,
      requestedQty,
      safeSellable,
      liveStock,
      reserve,
      maxByTransport,
    };
  }
  return {
    ok: true,
    kind: numericKind,
    requestedQty,
    safeSellable,
    liveStock,
    reserve,
    transportPerUnit,
    maxByTransport,
    stateAsOf: state.t,
    planAsOf: plan.asOf,
    stateAgeSeconds,
    planAgeSeconds,
  };
}

function validateFreshSaleInspection(artifact, state, kind, qty, price, now = Date.now()) {
  const blocked = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  const numericKind = Number(kind);
  const numericQty = Number(qty);
  const numericPrice = Number(price);
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs) || !artifact || Number(artifact.schemaVersion) !== 4 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(artifact.inspectionId || '')) ||
      artifact.ok !== true ||
      artifact.readOnly !== true || artifact.submitted !== false ||
      artifact.uiDryRun?.ok !== true) {
    return blocked('a successful read-only exchange inspection is required before confirmation');
  }
  const inspectedAtMs = Date.parse(artifact.inspectedAt);
  const expiresAtMs = Date.parse(artifact.expiresAt);
  const ageSeconds = Number.isFinite(inspectedAtMs)
    ? Math.round((nowMs - inspectedAtMs) / 1000)
    : null;
  const validityMs = expiresAtMs - inspectedAtMs;
  if (ageSeconds == null || ageSeconds < -30 || !Number.isFinite(expiresAtMs) ||
      !Number.isFinite(validityMs) || validityMs <= 0 || validityMs > MAX_INSPECTION_VALIDITY_MS ||
      nowMs > expiresAtMs) {
    return blocked('the read-only exchange inspection expired', { inspectedAt: artifact.inspectedAt || null, ageSeconds });
  }
  if (Number(artifact.kind) !== numericKind || Number(artifact.effectiveQty) !== numericQty) {
    return blocked('confirmed kind/quantity does not exactly match the inspected quote', {
      inspectedKind: artifact.kind ?? null,
      inspectedQty: artifact.effectiveQty ?? null,
    });
  }
  const bestAsk = Number(artifact.bestAsk);
  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || !Number.isFinite(numericPrice) ||
      bestAsk !== numericPrice) {
    return blocked('confirmed price does not exactly match the inspected live best ask', {
      inspectedPrice: Number.isFinite(bestAsk) ? bestAsk : null,
      requestedPrice: Number.isFinite(numericPrice) ? numericPrice : null,
    });
  }
  const uiQuantity = Number(artifact.uiInputs?.quantity);
  const uiPrice = Number(artifact.uiInputs?.price);
  if (!Number.isSafeInteger(uiQuantity) || uiQuantity !== numericQty) {
    return blocked('confirmed quantity does not exactly match the actual inspected UI input', {
      inspectedUiQuantity: Number.isFinite(uiQuantity) ? uiQuantity : null,
      requestedQuantity: numericQty,
    });
  }
  if (!Number.isFinite(uiPrice) || uiPrice !== numericPrice) {
    return blocked('confirmed price does not exactly match the actual inspected UI input', {
      inspectedUiPrice: Number.isFinite(uiPrice) ? uiPrice : null,
      requestedPrice: numericPrice,
    });
  }
  const expectedSlug = String(artifact.imageSlug || '').trim().toLowerCase();
  const uiRequestedSlug = String(artifact.uiProduct?.requestedSlug || '').trim().toLowerCase();
  const uiActualSlug = String(artifact.uiProduct?.actualSlug || '').trim().toLowerCase();
  if (!expectedSlug || artifact.uiProduct?.exact !== true ||
      uiRequestedSlug !== expectedSlug || uiActualSlug !== expectedSlug) {
    return blocked('the inspected UI product does not exactly match the target resource slug', {
      expectedSlug: expectedSlug || null,
      uiRequestedSlug: uiRequestedSlug || null,
      uiActualSlug: uiActualSlug || null,
    });
  }
  const selectedLotAvailable = Number(artifact.uiLot?.available);
  const selectedLotIndex = Number(artifact.uiLot?.index);
  const selectedLotQuality = artifact.uiLot?.quality == null ? null : Number(artifact.uiLot.quality);
  const selectedLotUnitCost = Number(artifact.uiLot?.unitCost);
  if (!Number.isFinite(selectedLotAvailable) || selectedLotAvailable < numericQty ||
      artifact.uiLot?.stillSelected !== true || !Number.isSafeInteger(selectedLotIndex) ||
      selectedLotIndex < 0 || (selectedLotQuality != null &&
        (!Number.isSafeInteger(selectedLotQuality) || selectedLotQuality < 0)) ||
      !Number.isFinite(selectedLotUnitCost) || selectedLotUnitCost < 0 ||
      artifact.uiLot?.costBound !== true) {
    return blocked('the inspected quality lot is missing, changed, or too small for the exact quantity', {
      selectedLotAvailable: Number.isFinite(selectedLotAvailable) ? selectedLotAvailable : null,
      requestedQuantity: numericQty,
    });
  }
  if (artifact.bookFreshness !== 'FRESH' || Number(artifact.feeRate) !== 0.04) {
    return blocked('the inspection lacks a fresh book or the measured 4% fee');
  }
  if (!Number.isFinite(Number(artifact.uiEconomics?.estimatedProfit)) ||
      Number(artifact.uiEconomics.estimatedProfit) <= 0) {
    return blocked('the game form does not show positive estimated profit for this exact sale');
  }
  const currentPlanAsOf = state?.surplusPlan?.stateAsOf || state?.surplusPlan?.asOf || null;
  if (artifact.stateAsOf !== state?.t || artifact.planAsOf !== currentPlanAsOf) {
    return blocked('the inspection is not tied to the current state and reserve plan', {
      inspectedStateAsOf: artifact.stateAsOf || null,
      currentStateAsOf: state?.t || null,
      inspectedPlanAsOf: artifact.planAsOf || null,
      currentPlanAsOf,
    });
  }
  const currentPolicy = validateFreshSurplus(state, numericKind, numericQty, nowMs);
  const inspectedReserve = finiteNonNegative(artifact.reserve);
  const projectionReserves = [
    finiteNonNegative(artifact.reserveProjection?.planCapture),
    finiteNonNegative(artifact.reserveProjection?.atInspection),
    finiteNonNegative(artifact.reserveProjection?.atExpiry),
  ];
  const transportPerUnit = finiteNonNegative(artifact.transportPerUnit);
  if (!currentPolicy.ok || inspectedReserve == null ||
      projectionReserves.some(reserve => reserve == null) ||
      inspectedReserve !== Math.max(...projectionReserves) ||
      inspectedReserve < Number(currentPolicy.reserve) ||
      Number(currentPolicy.liveStock) - numericQty + 1e-6 < inspectedReserve ||
      transportPerUnit == null || transportPerUnit !== Number(currentPolicy.transportPerUnit)) {
    return blocked('the inspected reserve or Transport requirement is no longer safe for current policy', {
      inspectedReserve,
      currentReserve: currentPolicy.reserve ?? null,
      liveStock: currentPolicy.liveStock ?? null,
      stockAfterSale: currentPolicy.ok ? Number(currentPolicy.liveStock) - numericQty : null,
    });
  }
  return {
    ok: true,
    kind: numericKind,
    qty: numericQty,
    price: numericPrice,
    imageSlug: expectedSlug,
    selectedLotAvailable,
    selectedLotIndex,
    selectedLotQuality,
    selectedLotUnitCost,
    reserve: inspectedReserve,
    transportPerUnit,
    inspectionId: artifact.inspectionId,
    inspectedAt: artifact.inspectedAt,
    expiresAt: artifact.expiresAt,
    ageSeconds,
    bookAsOf: artifact.bookAsOf || null,
  };
}

module.exports = { planItemForKind, validateFreshSaleInspection, validateFreshSurplus };
