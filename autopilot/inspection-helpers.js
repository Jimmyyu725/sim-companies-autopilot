'use strict';

function parseInspectArgs(raw) {
  const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('inspection arguments must be an object');
  }
  const buildingId = Number(args.buildingId);
  if (!Number.isInteger(buildingId) || buildingId <= 0) {
    throw new Error('buildingId must be a positive integer');
  }
  const product = args.product == null ? null : String(args.product).trim();
  if (args.product != null && !product) throw new Error('product must be non-empty or null');
  const qty = args.qty == null ? null : Number(args.qty);
  if (args.qty != null && (!Number.isFinite(qty) || qty <= 0)) {
    throw new Error('qty must be positive or null');
  }
  if ((product == null) !== (qty == null)) {
    throw new Error('product and qty must either both be set or both be null');
  }
  return { buildingId, product, qty };
}

function parseDurationSeconds(text) {
  const finish = String(text || '').match(/Finishes:\s*([^\n]*?)(?=Labor cost:|Unit cost:|REQUIREMENTS|QUANTITY|$)/i);
  const scope = finish ? finish[1] : String(text || '');
  let seconds = 0;
  let matched = false;
  for (const match of scope.matchAll(/([\d.]+)\s*(d|h|m|s)\b/gi)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(value)) continue;
    matched = true;
    seconds += value * ({ d: 86400, h: 3600, m: 60, s: 1 })[unit];
  }
  return matched && seconds > 0 ? seconds : null;
}

function money(text, label) {
  const match = String(text || '').match(new RegExp(`${label}:?\\s*\\$([\\d,]+(?:\\.\\d+)?)`, 'i'));
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function parseProductionQuote(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const requirements = normalized.match(/REQUIREMENTS\s*(.*?)\s*QUANTITY/i);
  return {
    durationSeconds: parseDurationSeconds(normalized),
    laborCost: money(normalized, 'Labor cost'),
    unitCost: money(normalized, 'Unit cost'),
    requirements: requirements ? requirements[1].trim() : null,
    text: normalized.slice(0, 1200),
  };
}

module.exports = { parseDurationSeconds, parseInspectArgs, parseProductionQuote };
