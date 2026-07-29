'use strict';

// Pure helpers shared by the standalone browser driver and deterministic tests. Keep these
// functions dependency-free because their source is also injected into the browser page.

function normalizeAssetSlug(source) {
  const raw = String(source || '').trim();
  if (!raw) return '';
  let pathname = raw;
  try { pathname = new URL(raw, 'https://www.simcompanies.com/').pathname; }
  catch (_) { pathname = raw.split(/[?#]/, 1)[0]; }
  let filename = pathname.split('/').filter(Boolean).pop() || '';
  try { filename = decodeURIComponent(filename); } catch (_) {}
  filename = filename.toLowerCase().replace(/\.(?:png|webp|jpe?g|svg)$/i, '');
  // Production assets use names such as water.8df7bb28.png. Only remove a terminal hash; never
  // use substring matching, so "superpower.*.png" cannot match the requested "power" slug.
  return filename.replace(/\.[0-9a-f]{6,}$/i, '');
}

function validateExchangeUiReview(review) {
  // This function is stringified and evaluated inside the browser page. Keep every helper local
  // so the injected function never depends on the Node module closure.
  const finiteNumber = value => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const failures = [];
  const expectedSlug = String(review?.expectedSlug || '').trim().toLowerCase();
  const selectedSlug = String(review?.selectedProduct?.actualSlug || '').trim().toLowerCase();
  const requestedSlug = String(review?.selectedProduct?.requestedSlug || '').trim().toLowerCase();
  const expectedQty = finiteNumber(review?.expectedQty);
  const expectedPrice = finiteNumber(review?.expectedPrice);
  const actualQty = finiteNumber(review?.inputs?.quantity);
  const actualPrice = finiteNumber(review?.inputs?.price);
  const selectedAvailable = finiteNumber(review?.selectedLot?.available);
  const estimatedProfit = finiteNumber(review?.economics?.estimatedProfit);
  const expectedKind = finiteNumber(review?.expectedKind);
  const inventoryKind = finiteNumber(review?.inventory?.kind);
  const expectedReserve = finiteNumber(review?.expectedReserve);
  const availableTotal = finiteNumber(review?.inventory?.availableTotal);
  const transportPerUnit = finiteNumber(review?.transport?.perUnit);
  const transportAvailable = finiteNumber(review?.transport?.available);
  const transportNeeded = Number.isFinite(expectedQty) && Number.isFinite(transportPerUnit)
    ? expectedQty * transportPerUnit
    : null;

  if (!expectedSlug || review?.selectedProduct?.exact !== true ||
      requestedSlug !== expectedSlug || selectedSlug !== expectedSlug ||
      review?.selectedProduct?.boundToForm !== true) {
    failures.push('selected product slug does not exactly match the requested product');
  }
  if (!Number.isSafeInteger(expectedQty) || expectedQty <= 0 ||
      !Number.isSafeInteger(actualQty) || actualQty !== expectedQty) {
    failures.push('quantity input does not exactly match the requested quantity');
  }
  if (!Number.isFinite(expectedPrice) || expectedPrice <= 0 ||
      !Number.isFinite(actualPrice) || actualPrice !== expectedPrice) {
    failures.push('price input does not exactly match the requested price');
  }
  if (!Number.isFinite(selectedAvailable) || selectedAvailable < expectedQty ||
      review?.selectedLot?.stillSelected !== true || review?.selectedLot?.costBound !== true) {
    failures.push('selected quality lot is missing, changed, or too small');
  }
  if (!Number.isSafeInteger(expectedKind) || expectedKind <= 0 ||
      review?.inventory?.status !== 200 || inventoryKind !== expectedKind ||
      !Number.isFinite(expectedReserve) || expectedReserve < 0 ||
      !Number.isFinite(availableTotal) || availableTotal - expectedQty < expectedReserve) {
    failures.push('live available inventory would fall below the verified reserve');
  }
  if (!Number.isFinite(transportPerUnit) || transportPerUnit < 0 ||
      !Number.isFinite(transportAvailable) || transportAvailable < 0 ||
      !Number.isFinite(transportNeeded) || transportAvailable < transportNeeded) {
    failures.push('live Transport is insufficient for the exact sale');
  }
  if (!Number.isFinite(estimatedProfit) || estimatedProfit <= 0) {
    failures.push('game form estimated profit is not positive');
  }
  if (review?.confirm?.found !== true || review?.confirm?.unique !== true ||
      review?.confirm?.disabled === true || review?.confirm?.ariaDisabled === true ||
      review?.confirm?.pointerDisabled === true) {
    failures.push('final exchange confirmation control is missing, ambiguous, or disabled');
  }

  return { ok: failures.length === 0, failures };
}

function validateExchangePostSubmit(proof) {
  const status = proof?.status;
  const finiteValue = value => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const beforeAvailable = finiteValue(proof?.beforeAvailable);
  const afterAvailable = finiteValue(proof?.afterAvailable);
  const expectedQty = Number(proof?.expectedQty);
  const formClosed = proof?.formClosed === true;
  const availableDecrease = beforeAvailable != null && afterAvailable != null
    ? beforeAvailable - afterAvailable
    : null;
  const inventoryReduced = status === 200 && beforeAvailable != null && beforeAvailable >= 0 &&
    afterAvailable != null && afterAvailable >= 0 &&
    Number.isSafeInteger(expectedQty) && expectedQty > 0 &&
    Math.abs(availableDecrease - expectedQty) <= 1e-6;
  const failures = [];
  if (!formClosed) failures.push('exchange form did not close after confirmation');
  if (!inventoryReduced) failures.push('authoritative available inventory did not decrease by exactly the submitted quantity');
  return {
    ok: failures.length === 0,
    failures,
    formClosed,
    status,
    beforeAvailable,
    afterAvailable,
    availableDecrease,
    expectedQty: Number.isSafeInteger(expectedQty) ? expectedQty : null,
    inventoryReduced,
  };
}

module.exports = { normalizeAssetSlug, validateExchangePostSubmit, validateExchangeUiReview };
