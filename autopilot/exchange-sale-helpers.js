'use strict';

// Confirmation guard also requires a state capture no older than five minutes. Keep inspection
// aligned so a successful quote is never impossible to confirm solely because its state was stale.
const DEFAULT_MAX_AGE_SECONDS = 5 * 60;
const DEFAULT_EXCHANGE_FEE_RATE = 0.04;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseInspectExchangeArgs(input, qtyArg) {
  let value = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{')) value = JSON.parse(trimmed);
    else value = { kind: trimmed, qty: qtyArg };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('arguments must be an object or <kind> [qty|null]');
  }

  const kind = Number(value.kind);
  if (!Number.isSafeInteger(kind) || kind <= 0) {
    throw new Error('kind must be a positive integer');
  }

  const rawQty = value.qty;
  const nullable = rawQty == null || String(rawQty).trim().toLowerCase() === 'null' || rawQty === '';
  const qty = nullable ? null : Number(rawQty);
  if (qty != null && (!Number.isSafeInteger(qty) || qty <= 0)) {
    throw new Error('qty must be null or a positive integer');
  }
  return { kind, qty };
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const numeric = finiteNumber(value);
  if (numeric != null) {
    const millis = numeric < 1e12 ? numeric * 1000 : numeric;
    return Number.isFinite(millis) ? millis : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageSeconds(value, nowMs = Date.now()) {
  const millis = timestampMs(value);
  return millis == null ? null : Math.round((nowMs - millis) / 1000);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
}

function resourceSlug(resource = {}) {
  return String(resource.image || '').split('/').pop().replace(/\.png$/i, '').trim().toLowerCase();
}

function findStockRow(state, kind) {
  const row = Array.isArray(state?.stock)
    ? state.stock.find(item => Number(item?.kind) === Number(kind))
    : null;
  const totalAmount = finiteNumber(row?.amount);
  const amount = finiteNumber(row?.availableAmount ?? row?.amount);
  const blockedAmount = row?.blockedAmount == null ? 0 : finiteNumber(row.blockedAmount);
  if (!row || row.known !== true || totalAmount == null || totalAmount < 0 || amount == null || amount < 0 ||
      blockedAmount == null || blockedAmount < 0 || Math.abs(totalAmount - amount - blockedAmount) > 1e-6) {
    return null;
  }
  return { ...row, totalAmount, amount, blockedAmount };
}

function planEntries(plan) {
  for (const value of [plan?.items, plan?.byKind, plan?.resources, plan?.entries]) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.entries(value).map(([key, entry]) => ({
      ...(entry && typeof entry === 'object' ? entry : {}),
      _key: key,
    }));
  }
  return [];
}

function findPlanEntry(plan, kind, name, slug) {
  const aliases = new Set([String(kind), normalizeName(name), normalizeName(slug)]);
  return planEntries(plan).find(entry => {
    if (Number(entry?.kind) === Number(kind)) return true;
    return [entry?._key, entry?.name, entry?.slug, entry?.image]
      .map(normalizeName)
      .some(alias => alias && aliases.has(alias));
  }) || null;
}

function reserveFromEntry(entry) {
  for (const field of ['reserve', 'reserveQty', 'safetyStock', 'reserveAmount', 'requiredReserve']) {
    const value = finiteNumber(entry?.[field]);
    if (value != null && value >= 0) return { value, field };
  }
  return null;
}

function validateSurplusPlan({ state, kind, resource, nowMs = Date.now(), maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS }) {
  const blocked = (reason, extra = {}) => ({ ok: false, failClosed: true, reason, ...extra });
  const stateAgeSeconds = ageSeconds(state?.t, nowMs);
  if (stateAgeSeconds == null || stateAgeSeconds < -30 || stateAgeSeconds > maxAgeSeconds) {
    return blocked('state is missing or stale', { stateAsOf: state?.t || null, stateAgeSeconds });
  }
  if (state?.warehouse?.complete !== true || state?.warehouse?.allPositiveProductsIncluded !== true) {
    return blocked('warehouse capture is incomplete', { stateAsOf: state.t, stateAgeSeconds });
  }

  const stock = findStockRow(state, kind);
  if (!stock) return blocked('target stock is missing, unknown, or invalid', { stateAsOf: state.t, stateAgeSeconds });

  const plan = state?.surplusPlan;
  if (!plan || typeof plan !== 'object' || plan.complete !== true || plan.status !== 'ok') {
    return blocked('latest complete surplusPlan is required', { stateAsOf: state.t, stateAgeSeconds });
  }
  const planAsOf = plan.stateAsOf || plan.asOf || plan.generatedAt || plan.t || null;
  const planAgeSeconds = ageSeconds(planAsOf, nowMs);
  if (planAgeSeconds == null || planAgeSeconds < -30 || planAgeSeconds > maxAgeSeconds) {
    return blocked('surplusPlan is missing a fresh timestamp', {
      stateAsOf: state.t,
      stateAgeSeconds,
      planAsOf,
      planAgeSeconds,
    });
  }
  const stateMs = timestampMs(state.t);
  const planStateMs = timestampMs(plan.stateAsOf || planAsOf);
  if (stateMs == null || planStateMs == null || Math.abs(stateMs - planStateMs) > 5000) {
    return blocked('surplusPlan is not tied to the latest state capture', {
      stateAsOf: state.t,
      planAsOf,
      stateAgeSeconds,
      planAgeSeconds,
    });
  }

  const name = stock.name || null;
  const slug = resourceSlug(resource);
  const entry = findPlanEntry(plan, kind, name, slug);
  if (!entry) {
    return blocked('surplusPlan has no entry for this resource', {
      stateAsOf: state.t,
      planAsOf,
      stateAgeSeconds,
      planAgeSeconds,
    });
  }
  if (entry.allowedToSell === false || entry.eligible === false || entry.blocked === true ||
      /^(blocked|hold|unknown)$/i.test(String(entry.status || ''))) {
    return blocked('surplusPlan does not authorize quoting this resource', {
      stateAsOf: state.t,
      planAsOf,
      stateAgeSeconds,
      planAgeSeconds,
      policyReason: entry.reason || entry.status || null,
    });
  }

  const reserve = reserveFromEntry(entry);
  if (!reserve) {
    return blocked('surplusPlan entry has no numeric reserve', {
      stateAsOf: state.t,
      planAsOf,
      stateAgeSeconds,
      planAgeSeconds,
    });
  }
  const calculatedSellable = Math.max(0, Math.floor(stock.amount - reserve.value));
  const statedSellable = finiteNumber(entry.sellable ?? entry.sellableQty ?? entry.maxSellQty);
  const sellable = statedSellable != null && statedSellable >= 0
    ? Math.min(calculatedSellable, Math.floor(statedSellable))
    : calculatedSellable;

  return {
    ok: true,
    failClosed: false,
    stateAsOf: state.t,
    stateAgeSeconds,
    planAsOf,
    planAgeSeconds,
    planSource: plan.source || null,
    horizonHours: finiteNumber(plan.horizonHours ?? entry.horizonHours),
    stock,
    reserve: reserve.value,
    reserveField: reserve.field,
    sellable,
    policyReason: entry.reason || null,
  };
}

function normalizeBookRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => Array.isArray(row)
    ? (row.length >= 3
      ? { id: row[0], quantity: finiteNumber(row[1]), price: finiteNumber(row[2]) }
      : { id: null, quantity: finiteNumber(row[0]), price: finiteNumber(row[1]) })
    : { id: row?.id ?? null, quantity: finiteNumber(row?.quantity), price: finiteNumber(row?.price) })
    .filter(row => row.quantity != null && row.quantity > 0 && row.price != null && row.price > 0)
    .sort((a, b) => a.price - b.price || b.quantity - a.quantity);
}

function summarizeBook(kind, rows, { source, asOf, nowMs = Date.now(), status = 200, capped = null } = {}) {
  const normalized = normalizeBookRows(rows);
  const levels = [];
  for (const row of normalized) {
    const previous = levels.at(-1);
    if (previous && previous.price === row.price) previous.quantity += row.quantity;
    else levels.push({ price: row.price, quantity: row.quantity });
  }
  const bestAsk = levels[0]?.price ?? null;
  const asOfAgeSeconds = ageSeconds(asOf, nowMs);
  return {
    kind: Number(kind),
    source: source || null,
    status,
    asOf: asOf || null,
    ageSeconds: asOfAgeSeconds,
    freshness: status === 200 && asOfAgeSeconds != null && asOfAgeSeconds >= -30 && asOfAgeSeconds <= 600
      ? 'FRESH' : 'STALE_OR_UNKNOWN',
    visibleRows: normalized.length,
    visibleLevels: levels.length,
    bestAsk,
    bestAskQuantity: bestAsk == null ? null : levels[0].quantity,
    top5Quantity: normalized.slice(0, 5).reduce((sum, row) => sum + row.quantity, 0),
    top20Quantity: normalized.slice(0, 20).reduce((sum, row) => sum + row.quantity, 0),
    visibleQuantity: normalized.reduce((sum, row) => sum + row.quantity, 0),
    topLevels: levels.slice(0, 5).map(level => ({ price: level.price, quantity: level.quantity })),
    bookCapped: capped == null ? normalized.length >= 200 : Boolean(capped),
  };
}

function summarizeCachedBook(kind, cached, nowMs = Date.now()) {
  if (!cached || !cached.o || typeof cached.o !== 'object' || Array.isArray(cached.o)) {
    return summarizeBook(kind, [], {
      source: `shared/price-tracker/data/book-state.json#/books/${kind}`,
      asOf: null,
      nowMs,
      status: 'UNKNOWN',
      capped: null,
    });
  }
  const rows = Object.entries(cached.o)
    .filter(([, value]) => Array.isArray(value) && value.length >= 2)
    .map(([id, value]) => [id, value[0], value[1]]);
  return summarizeBook(kind, rows, {
    source: `shared/price-tracker/data/book-state.json#/books/${kind}`,
    asOf: timestampMs(cached.t) == null ? null : new Date(timestampMs(cached.t)).toISOString(),
    nowMs,
    status: 200,
    capped: cached.full,
  });
}

function transportCapacity({ state, resource, quantity }) {
  const transportPerUnit = finiteNumber(resource?.transportation);
  if (transportPerUnit == null || transportPerUnit < 0) {
    return { ok: false, reason: 'transportation coefficient is missing or invalid' };
  }
  const transportStock = findStockRow(state, 13);
  if (transportPerUnit > 0 && !transportStock) {
    return { ok: false, reason: 'transport stock is missing or unknown', transportPerUnit };
  }
  const available = transportStock?.amount ?? 0;
  const maxByTransport = transportPerUnit === 0 ? null : Math.floor(available / transportPerUnit);
  return {
    ok: true,
    transportPerUnit,
    available,
    unlimitedByTransport: transportPerUnit === 0,
    maxByTransport,
    transportNeeded: round(quantity * transportPerUnit),
  };
}

function buildSaleQuote({ kind, requestedQty, state, resource, policy, book, feeRate = DEFAULT_EXCHANGE_FEE_RATE }) {
  const blocked = (reason, extra = {}) => ({ ok: false, failClosed: true, reason, ...extra });
  if (!policy?.ok) return blocked(policy?.reason || 'surplus policy is unavailable');
  if (!book || book.status !== 200 || book.freshness !== 'FRESH' || !Number.isFinite(book.bestAsk)) {
    return blocked('a fresh live order book with a best ask is required');
  }
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    return blocked('exchange fee is missing or invalid');
  }

  const provisionalQty = requestedQty == null ? policy.sellable : requestedQty;
  const transport = transportCapacity({ state, resource, quantity: provisionalQty });
  if (!transport.ok) return blocked(transport.reason, { transport });
  const maxSafeQty = Math.max(0, Math.floor(Math.min(
    policy.sellable,
    transport.maxByTransport == null ? Number.MAX_SAFE_INTEGER : transport.maxByTransport,
  )));
  if (requestedQty != null && requestedQty > maxSafeQty) {
    return blocked('requested quantity exceeds the reserve or transport-safe maximum', {
      requestedQty,
      maxSafeQty,
      sellableAfterReserve: policy.sellable,
      transport,
    });
  }
  const quantity = requestedQty == null ? maxSafeQty : requestedQty;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return blocked('no positive reserve-and-transport-safe quantity is available', {
      requestedQty,
      maxSafeQty,
      sellableAfterReserve: policy.sellable,
      transport,
    });
  }

  const price = book.bestAsk;
  const gross = round(quantity * price);
  const fee = round(gross * feeRate);
  const netBeforeSourceCost = round(gross - fee);
  return {
    ok: true,
    failClosed: false,
    kind: Number(kind),
    requestedQty,
    quantity,
    quantitySource: requestedQty == null ? 'maximum-safe' : 'requested',
    maxSafeQty,
    stock: policy.stock.amount,
    reserve: policy.reserve,
    sellableAfterReserve: policy.sellable,
    price,
    priceSource: 'fresh-live-best-ask',
    gross,
    feeRate,
    fee,
    netBeforeSourceCost,
    sourceCostIncluded: false,
    transport: {
      ...transport,
      transportNeeded: round(quantity * transport.transportPerUnit),
    },
  };
}

function summarizeUiDryRun(raw) {
  const safeBase = {
    submitted: raw?.submitted ?? false,
    mutationAttempted: raw?.mutationAttempted === true,
    source: 'autopilot/actions/sell-exchange-ui.js (without --submit)',
  };
  const verification = raw?.verification || null;
  const rawChoices = Array.isArray(raw?.qualityChoices)
    ? raw.qualityChoices
    : (Array.isArray(raw?.qualitySelection?.choices) ? raw.qualitySelection.choices : []);
  const qualityChoices = rawChoices.map((choice, index) => {
    if (choice && typeof choice === 'object') {
      return {
        index: Number.isSafeInteger(Number(choice.index)) ? Number(choice.index) : index,
        available: finiteNumber(choice.available),
        quality: finiteNumber(choice.quality),
        unitCost: finiteNumber(choice.unitCost),
        rowText: choice.rowText == null ? null : String(choice.rowText).slice(0, 180),
      };
    }
    return { index, available: finiteNumber(choice), quality: null, rowText: null };
  }).filter(choice => choice.available != null);
  const selectedProduct = verification?.selectedProduct || raw?.selectedProduct || null;
  const selectedLot = verification?.selectedLot || raw?.selectedLot || (raw?.qualitySelection ? {
    index: null,
    available: finiteNumber(raw.qualitySelection.available),
    inspectedAvailable: finiteNumber(raw.qualitySelection.available),
    quality: null,
    rowText: null,
    stillSelected: raw.qualitySelection.available != null,
  } : null);
  const actualInputs = verification?.inputs ? {
    quantityRaw: verification.inputs.quantityRaw == null ? null : String(verification.inputs.quantityRaw),
    quantity: finiteNumber(verification.inputs.quantity),
    priceRaw: verification.inputs.priceRaw == null ? null : String(verification.inputs.priceRaw),
    price: finiteNumber(verification.inputs.price),
  } : null;
  const failureEvidence = { selectedProduct, selectedLot, qualityChoices, actualInputs };

  if (!raw || raw.ok !== true || raw.armed !== false || raw.submitted !== false ||
      raw.mutationAttempted === true || raw?.validation?.ok !== true || !verification) {
    return {
      ...safeBase,
      status: 'UNAVAILABLE',
      ok: false,
      reason: raw?.reason || raw?.step || 'UI dry run did not return a safe preview',
      ...failureEvidence,
    };
  }
  const inputs = Array.isArray(raw.dump?.inputs) ? raw.dump.inputs : [];
  const buttons = Array.isArray(raw.dump?.buttons) ? raw.dump.buttons : [];
  const confirmText = raw.confirmFound || null;
  const matchingConfirms = confirmText
    ? buttons.filter(button => String(button?.t || '').trim() === String(confirmText).trim())
    : [];
  const confirm = matchingConfirms.find(button => button?.dis !== true && button?.ariaDis !== true &&
    button?.pointerDis !== true) || null;
  const pageText = String(raw.dump?.text || '');
  const moneyAfter = (label) => {
    const match = pageText.match(new RegExp(`${label}\\s*(?:\\(-\\)\\s*)?\\$([\\d,.]+)`, 'i'));
    return match ? finiteNumber(match[1].replace(/,/g, '')) : null;
  };
  const parsedEconomics = {
    totalRevenue: moneyAfter('Total revenue'),
    sourceCost: moneyAfter('Source cost'),
    transportationCost: moneyAfter('Transportation cost'),
    exchangeFee: moneyAfter('Exchange fees(?: \\(4%\\))?'),
    estimatedProfit: moneyAfter('Estimated profit'),
    source: 'game exchange-sale form',
  };
  const economics = verification?.economics && typeof verification.economics === 'object'
    ? {
      totalRevenue: finiteNumber(verification.economics.totalRevenue),
      sourceCost: finiteNumber(verification.economics.sourceCost),
      transportationCost: finiteNumber(verification.economics.transportationCost),
      exchangeFee: finiteNumber(verification.economics.exchangeFee),
      estimatedProfit: finiteNumber(verification.economics.estimatedProfit),
      source: 'game exchange-sale form',
    }
    : parsedEconomics;
  return {
    ...safeBase,
    status: confirm ? 'READY_TO_REVIEW' : 'FORM_NOT_READY',
    ok: Boolean(confirm),
    confirmFound: confirmText,
    confirmDisabled: matchingConfirms.length ? !confirm : null,
    selectedProduct,
    selectedLot,
    qualityChoices,
    actualInputs,
    qualitySelection: selectedLot ? {
      selectedAvailable: finiteNumber(selectedLot.available),
      availableLots: qualityChoices.map(choice => choice.available),
    } : null,
    economics,
    inputs: inputs.map(input => ({
      field: input.ph || input.name || '?',
      value: input.val == null ? null : String(input.val),
    })),
    pageExcerpt: pageText.slice(-700),
  };
}

module.exports = {
  DEFAULT_EXCHANGE_FEE_RATE,
  DEFAULT_MAX_AGE_SECONDS,
  ageSeconds,
  buildSaleQuote,
  findStockRow,
  normalizeBookRows,
  parseInspectExchangeArgs,
  resourceSlug,
  summarizeBook,
  summarizeCachedBook,
  summarizeUiDryRun,
  transportCapacity,
  validateSurplusPlan,
};
