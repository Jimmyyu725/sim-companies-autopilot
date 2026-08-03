'use strict';

function bytes(value) {
  const raw = JSON.stringify(value);
  return raw === undefined ? 0 : Buffer.byteLength(raw, 'utf8');
}

function previewJson(value, maxChars) {
  const raw = JSON.stringify(value);
  if (raw === undefined) return 'undefined';
  return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}…[${raw.length - maxChars} chars omitted]`;
}

function transport(totalBytes, omitted) {
  return {
    truncated: true,
    totalBytes,
    omitted,
    note: 'Fields were omitted as whole fields at the tool boundary; omitted data is UNKNOWN, never empty or zero.',
  };
}

function compactRefreshState(state, totalBytes, maxBytes) {
  const compact = { ...state };
  const omitted = [];
  delete compact.recipes;
  omitted.push('recipes');
  compact._transport = transport(totalBytes, omitted);
  if (bytes(compact) <= maxBytes) return compact;

  if (Array.isArray(compact.retail) && compact.retail.length > 6) {
    compact.retail = compact.retail.slice(0, 6);
    omitted.push('retail[6:]');
  }
  if (bytes(compact) <= maxBytes) return compact;

  delete compact.volume1h;
  delete compact.volume1hMeta;
  omitted.push('volume1h', 'volume1hMeta');
  if (bytes(compact) <= maxBytes) return compact;

  delete compact.printedRates;
  omitted.push('printedRates');
  if (bytes(compact) <= maxBytes) return compact;

  // The brain must always receive every warehouse product and every building after a mutation.
  // Collapse verbose nested fields before considering those two authoritative collections optional.
  const finalOmitted = [...new Set(omitted
    .filter(field => field !== 'retail[6:]')
    .concat(['retail', 'weather', 'modifiers']))];
  const compactBusy = building => {
    if (!Object.prototype.hasOwnProperty.call(building || {}, 'busy') || building.busy === undefined) return 'UNKNOWN';
    if (building.busy === null) return null;
    if (!building.busy || typeof building.busy !== 'object' || Array.isArray(building.busy)) return 'UNKNOWN';
    return {
      type: building.busy.type,
      makingKind: building.busy.makingKind,
      makingName: building.busy.makingName,
      remainingOrUncollectedAmount: building.busy.remainingOrUncollectedAmount,
      amountAvailableNow: building.busy.amountAvailableNow,
      remainingProfit: building.busy.remainingProfit,
      profitAvailableNow: building.busy.profitAvailableNow,
      expanding: building.busy.expanding,
      canFetch: building.busy.canFetch,
      endsAt: building.busy.endsAt,
    };
  };
  return {
    t: state.t,
    sources: Object.fromEntries(Object.entries(state.sources || {}).map(([key, value]) => [key, {
      status: value?.status ?? null,
      asOf: value?.asOf ?? null,
      ageSeconds: value?.ageSeconds ?? null,
    }])),
    money: state.money,
    level: state.level,
    pa: state.pa,
    paUnread: state.paUnread,
    baseSlotCapacity: state.baseSlotCapacity,
    extraBuildingSlots: state.extraBuildingSlots,
    slotCapacity: state.slotCapacity,
    usedSlots: state.usedSlots,
    freeSlots: state.freeSlots,
    warehouse: state.warehouse,
    stock: state.stock,
    bonds: state.bonds,
    buildings: (state.buildings || []).map(building => ({
      id: building.id,
      name: building.name,
      size: building.size,
      category: building.category,
      busy: compactBusy(building),
    })),
    surplusPlan: state.surplusPlan,
    keyPrices: state.keyPrices,
    flags: state.flags,
    config: state.config,
    _transport: transport(totalBytes, finalOmitted),
  };
}

function compactSellResult(result, totalBytes) {
  const compact = { ...result };
  const tested = compact.retailOptimization?.tested;
  if (Array.isArray(tested)) {
    const valid = tested.filter(row => row?.valid);
    const prices = valid.map(row => Number(row.price)).filter(Number.isFinite);
    compact.retailOptimization = {
      ...compact.retailOptimization,
      tested: undefined,
      testedSummary: {
        total: tested.length,
        valid: valid.length,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
      },
    };
  }
  compact._transport = transport(totalBytes, ['retailOptimization.tested']);
  return compact;
}

function genericSummary(name, result, totalBytes) {
  const scalars = {};
  const fields = {};
  const entries = Object.entries(result || {});
  for (const [key, value] of entries.slice(0, 20)) {
    if (value == null || ['number', 'boolean'].includes(typeof value)) scalars[key] = value;
    else if (typeof value === 'string') scalars[key] = value.length <= 250
      ? value
      : { preview: value.slice(0, 250), valueTruncated: true, totalChars: value.length };
    else if (Array.isArray(value)) fields[key] = { type: 'array', items: value.length };
    else fields[key] = { type: 'object', keys: Object.keys(value).slice(0, 40) };
  }
  return {
    ok: result?.ok ?? null,
    tool: name,
    scalars,
    fields,
    _transport: transport(totalBytes, [...new Set(Object.keys(fields).concat(entries.slice(20).map(([key]) => key)))]),
    next: name === 'refresh_state' ? 'Use the current state from this bounded result; omitted fields remain UNKNOWN.' : 'Call refresh_state or a narrower read tool before relying on omitted fields.',
  };
}

function formatToolOutput(name, result, maxBytes = 7800) {
  const totalBytes = bytes(result);
  if (totalBytes <= maxBytes) return JSON.stringify(result);
  let compact = name === 'refresh_state'
    ? compactRefreshState(result, totalBytes, maxBytes)
    : (name === 'sell' ? compactSellResult(result, totalBytes) : genericSummary(name, result, totalBytes));
  if (bytes(compact) > maxBytes && name !== 'refresh_state') compact = genericSummary(name, result, totalBytes);
  return JSON.stringify(compact);
}

module.exports = { formatToolOutput, previewJson };
