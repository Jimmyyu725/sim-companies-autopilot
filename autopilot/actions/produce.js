// Start a production order. Params from window.__produce = { name, qty, targetHours,
//   finishBefore, checkpointBufferSeconds, maxBuyCost, minCashAfter }.
//
// Hard rule learned the expensive way (a 7-hour overnight stall): NEVER click BUY MISSING.
// That control silently spends cash on the exchange AND its success is unreliable in this
// headless build — a partial fill consumes inputs without starting the order, which then
// loops and drains the warehouse. Instead the caller sizes qty to inputs already on hand
// (tick.js does this from the live resources API), so the normal PRODUCE button is enabled
// and no buying happens inside the dialog. If PRODUCE isn't available, we report and leave
// the warehouse untouched — the caller buys inputs up front via the market page if needed.
const { buildingId, kind, name, resourceSlug, qty, targetHours, finishBefore } = window.__produce;
const checkpointMs = finishBefore == null ? null : Date.parse(finishBefore);
const checkpointBufferSeconds = Math.max(0, Number(window.__produce.checkpointBufferSeconds) || 60);
if (finishBefore != null && !Number.isFinite(checkpointMs)) {
  return { ok: false, guard: true, reason: 'invalid finishBefore reached the production page' };
}
const checkpointSecondsAvailable = () => checkpointMs == null
  ? null
  : Math.floor((checkpointMs - Date.now()) / 1000) - checkpointBufferSeconds;

if (document.body.innerText.includes('currently busy')) {
  return { ok: false, reason: 'building still busy' };
}

if (typeof window.__bindExactProductionCard !== 'function') {
  return { ok: false, guard: true,
    reason: 'exact production-card binder is unavailable; no card was selected' };
}
const cardBinding = window.__bindExactProductionCard({
  document,
  name,
  kind,
  resourceSlug,
});
if (!cardBinding?.ok) {
  return Object.assign({
    ok: false,
    guard: true,
    reason: 'exact production card could not be bound; no input or button was touched',
    kindSource: window.__produce.kindSource || null,
  }, cardBinding || {});
}
const card = cardBinding.card;
const qtyInput = cardBinding.input;
const requestedQty = Number(qty) || null;
const targetSeconds = Number(targetHours) > 0 ? Number(targetHours) * 3600 : null;
let sizingMethod = 'requested-qty';

const durationSeconds = (text) => {
  const finish = String(text || '').match(/Finishes:\s*([^\n]*?)(?=Labor cost:|Unit cost:|REQUIREMENTS|QUANTITY|$)/i);
  const scope = finish ? finish[1] : String(text || '');
  let seconds = 0;
  let matched = false;
  for (const m of scope.matchAll(/([\d.]+)\s*(d|h|m|s)\b/gi)) {
    const value = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(value)) continue;
    matched = true;
    seconds += value * ({ d: 86400, h: 3600, m: 60, s: 1 })[unit];
  }
  return matched && seconds > 0 ? seconds : null;
};

if (!requestedQty) {
  return { ok: false, reason: 'no positive business quantity given' };
}

// Quantity is the business requirement; targetHours is a duration ceiling. Always preview the
// requested quantity first. Never increase it merely to fill the available time horizon.
setInput(qtyInput, requestedQty);
await sleep(1800);
let state = norm(card.innerText);
if (targetSeconds) {
  const requestedDuration = durationSeconds(state);
  if (!requestedDuration) {
    return { ok: false, reason: 'cannot verify requested quantity against duration ceiling',
             targetHours, requestedQty, state };
  }
  if (requestedDuration > targetSeconds) {
    const cappedQty = typeof window.__capQuantityForDuration === 'function'
      ? window.__capQuantityForDuration(requestedQty, requestedDuration, Number(targetHours))
      : Math.max(1, Math.floor(requestedQty * targetSeconds / requestedDuration));
    setInput(qtyInput, cappedQty);
    sizingMethod = 'requested-qty+duration-cap';
    await sleep(1800);
    state = norm(card.innerText);
  }
}

// A bridge order must end before the absolute structural/financing checkpoint. Preview, shrink
// downward by whole units, and re-read the game's printed duration. Never treat a linear estimate
// as click authorization.
if (checkpointMs != null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const observedDuration = durationSeconds(state);
    const availableSeconds = checkpointSecondsAvailable();
    if (!(observedDuration > 0) || !(availableSeconds > 0)) {
      return {
        ok: false,
        guard: true,
        preview: true,
        reason: 'cannot fit production before finishBefore with the required safety buffer',
        requestedQty,
        effectiveQty: Number(String(qtyInput.value || '').replace(/,/g, '')) || null,
        finishBefore,
        checkpointBufferSeconds,
        availableSeconds,
        observedDurationSeconds: observedDuration,
        state,
      };
    }
    if (observedDuration <= availableSeconds) break;
    if (typeof window.__capQuantityForSeconds !== 'function') {
      return {
        ok: false,
        guard: true,
        preview: true,
        reason: 'checkpoint quantity cap is unavailable; no order placed',
        finishBefore,
      };
    }
    const effectiveQty = Number(String(qtyInput.value || '').replace(/,/g, ''));
    const cappedQty = window.__capQuantityForSeconds(effectiveQty, observedDuration, availableSeconds);
    if (!(cappedQty >= 1) || cappedQty >= effectiveQty) {
      return {
        ok: false,
        guard: true,
        preview: true,
        reason: 'even the next smaller whole-unit batch cannot be proven to finish before finishBefore',
        requestedQty,
        effectiveQty,
        suggestedQty: cappedQty >= 1 ? cappedQty : null,
        finishBefore,
        checkpointBufferSeconds,
        availableSeconds,
        observedDurationSeconds: observedDuration,
        state,
      };
    }
    setInput(qtyInput, cappedQty);
    sizingMethod += '+checkpoint-cap';
    await sleep(1800);
    state = norm(card.innerText);
  }
}

// Wage-prepay guard (2026-07-25): production charges its FULL labor cost up front and
// cancelling forfeits it. Refuse an order whose prepay would drop exact company cash below
// minCashAfter. Cash comes from the auth API (or a <=5-minute state fallback); unknown cash or
// labor fails closed because a guessed header number can violate the reserve.
const minCashAfter = Number(window.__produce.minCashAfter) || 0;
if (typeof window.__parseExplicitCurrency !== 'function') {
  return { ok: false, guard: true,
    reason: 'explicit labor-cost parser is unavailable; no order placed' };
}
const laborText = (state.match(/Labor cost: \$([\d,]+(?:\.\d+)?)/) || [])[1];
let labor = window.__parseExplicitCurrency(laborText);
const cash = window.__produce.cash?.value == null ? NaN : Number(window.__produce.cash.value);
const cashSource = window.__produce.cash?.source || null;
const cashAsOf = window.__produce.cash?.asOf || null;
if (minCashAfter && (!Number.isFinite(labor) || !Number.isFinite(cash))) {
  return { ok: false, reason: 'cannot verify labor prepay against exact company cash',
           labor: Number.isFinite(labor) ? labor : null, cash: Number.isFinite(cash) ? cash : null,
           cashSource, cashAsOf, minCashAfter, state };
}
if ((targetSeconds || checkpointMs != null) && minCashAfter && labor > 0 && cash - labor < minCashAfter) {
  // When the caller supplied a duration ceiling or checkpoint, shrink the requested business
  // quantity further if needed to preserve the cash floor. Never increase quantity in this path.
  const effectiveQty = Number(String(qtyInput.value || '').replace(/,/g, ''));
  const spendable = Math.max(0, cash - minCashAfter);
  const affordableQty = Math.floor(effectiveQty * spendable / labor * 0.995);
  if (Number.isFinite(affordableQty) && affordableQty > 0 && affordableQty < effectiveQty) {
    setInput(qtyInput, affordableQty);
    sizingMethod += '+cash-floor-clamp';
    await sleep(1800);
    state = norm(card.innerText);
    const resizedLaborText = (state.match(/Labor cost: \$([\d,]+(?:\.\d+)?)/) || [])[1];
    labor = window.__parseExplicitCurrency(resizedLaborText);
  }
}
if (minCashAfter && !Number.isFinite(labor)) {
  return { ok: false, reason: 'cannot verify resized labor prepay against exact company cash',
           labor: null, cash: Number.isFinite(cash) ? cash : null,
           cashSource, cashAsOf, minCashAfter, state };
}
if (minCashAfter && labor > 0 && cash - labor < minCashAfter) {
  return { ok: false, reason: 'labor prepay would breach minCashAfter', labor, cash,
           cashSource, cashAsOf, minCashAfter, state };
}


let finalDurationSeconds = durationSeconds(state);
let finalCheckpointSecondsAvailable = checkpointSecondsAvailable();
if (checkpointMs != null && (!(finalDurationSeconds > 0) || !(finalCheckpointSecondsAvailable > 0) ||
    finalDurationSeconds > finalCheckpointSecondsAvailable)) {
  const effectiveQty = Number(String(qtyInput.value || '').replace(/,/g, '')) || null;
  const suggestedQty = effectiveQty && finalDurationSeconds > 0 && finalCheckpointSecondsAvailable > 0 &&
    typeof window.__capQuantityForSeconds === 'function'
    ? window.__capQuantityForSeconds(effectiveQty, finalDurationSeconds, finalCheckpointSecondsAvailable)
    : null;
  return {
    ok: false,
    guard: true,
    preview: true,
    reason: 'final live quote would cross finishBefore; no order placed',
    requestedQty,
    effectiveQty,
    suggestedQty: suggestedQty && suggestedQty < effectiveQty ? suggestedQty : null,
    finishBefore,
    checkpointBufferSeconds,
    availableSeconds: finalCheckpointSecondsAvailable,
    observedDurationSeconds: finalDurationSeconds,
    state,
  };
}

// A partial collect mutates the production API's busy.resource.amount into a live residual. The
// LLM once copied that residual (`3`) into every following Mill order, creating a 10-minute loop.
// Preview suspiciously short Coffee Powder orders and return a feasible useful quantity before any
// click. This is advisory and never silently inflates the business quantity.
const batchPolicy = window.__produce.batchPolicy || null;
if (batchPolicy?.enabled && typeof window.__evaluateMillBatchGuard !== 'function') {
  return { ok: false, guard: true, preview: true,
           reason: 'Mill batch policy is enabled but its evaluator is unavailable; no order placed' };
}
if (batchPolicy?.enabled) {
  const effectiveQty = Number(String(qtyInput.value || '').replace(/,/g, ''));
  const batchCheck = window.__evaluateMillBatchGuard({
    name,
    effectiveQty,
    observedSeconds: durationSeconds(state),
    labor,
    cash,
    minCashAfter,
    policy: batchPolicy,
  });
  if (!batchCheck.ok) {
    return Object.assign({}, batchCheck, {
      state,
      requestedQty,
      effectiveQty,
      targetHours: targetSeconds ? Number(targetHours) : null,
      sizingMethod,
      cashSource,
      cashAsOf,
    });
  }
}

const label = (b) => norm(b.innerText);

// The order is placeable only if a real PRODUCE button is enabled. BUY MISSING or a
// disabled PRODUCE both mean inputs are short — bail WITHOUT touching anything, so no
// input is ever consumed on a failed attempt.
const produce = all('button', card).find(b => /^PRODUCE$/i.test(label(b)));
const buyMissing = all('button', card).find(b => /BUY MISSING/i.test(label(b)));

if (buyMissing && (!produce || produce.disabled)) {
  return { ok: false, reason: 'inputs short — order needs BUY MISSING (not clicked by design)',
           state, needBuy: true };
}
if (!produce) {
  return { ok: false, reason: 'no PRODUCE button', state,
           buttons: all('button', card).map(label).filter(Boolean) };
}
if (produce.disabled) return { ok: false, reason: 'PRODUCE disabled', state };

// Recheck immediately before the click. No awaited work is allowed between this deadline check and
// dispatching the event.
finalDurationSeconds = durationSeconds(state);
finalCheckpointSecondsAvailable = checkpointSecondsAvailable();
if (checkpointMs != null && (!(finalDurationSeconds > 0) || !(finalCheckpointSecondsAvailable > 0) ||
    finalDurationSeconds > finalCheckpointSecondsAvailable)) {
  return {
    ok: false,
    guard: true,
    preview: true,
    reason: 'finishBefore became too close before click; no order placed',
    finishBefore,
    checkpointBufferSeconds,
    availableSeconds: finalCheckpointSecondsAvailable,
    observedDurationSeconds: finalDurationSeconds,
    state,
  };
}

produce.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

// Confirm the order actually started. Direct in-page fetch of the buildings API trips
// Cloudflare's managed challenge (403 — measured 2026-07-22 22:52; every one of the 254
// validations in bot.log returned started:false, including orders that demonstrably ran),
// so the API is only believed when it answers 200. The primary signal is the DOM: a
// successful click unmounts the card's PRODUCE button / switches the page to the busy view.
const canon = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
let started = false;
for (let i = 0; i < 5 && !started; i++) {
  await sleep(3000);
  if (/currently busy|production started/i.test(norm(document.body.innerText))) {
    started = true;
    break;
  }
  const b = await api('/api/v2/companies/me/buildings/');
  if (b.status === 200 && Array.isArray(b.json)
      && typeof window.__buildingHasBusyResource === 'function') {
    // Match the exact target building. Several Mills can produce Coffee Powder at once; matching
    // only the resource name made a swallowed click on one idle Mill look successful whenever a
    // different Mill was already busy with the same product.
    started = window.__buildingHasBusyResource(b.json, buildingId, name, kind);
  }
}
return { ok: started, state, started, buildingId, requestedQty,
         effectiveQty: Number(String(qtyInput.value || '').replace(/,/g, '')) || null,
         targetHours: targetSeconds ? Number(targetHours) : null,
         finishBefore: finishBefore || null,
         checkpointBufferSeconds: checkpointMs == null ? null : checkpointBufferSeconds,
         expectedEndAt: finalDurationSeconds > 0
           ? new Date(Date.now() + finalDurationSeconds * 1000).toISOString()
           : null,
         sizingMethod, durationSeconds: finalDurationSeconds, cashSource, cashAsOf,
         after: norm(document.body.innerText).slice(0, 200) };
