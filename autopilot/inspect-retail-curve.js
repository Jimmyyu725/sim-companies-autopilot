#!/usr/bin/env node
'use strict';

// Read the Grocery form's own profit projections without submitting a sale. Council calls this
// only while holding .tick.lock and only when the store is idle.
const fs = require('fs');
const path = require('path');
const cdp = require(path.join(__dirname, '..', 'shared', 'cdp.js'));
const {
  chooseBestRetailQuote,
  parseRetailQuote,
  roundPrice,
} = require('./retail-optimizer.js');

function parseArgs(raw) {
  const value = raw ? JSON.parse(raw) : {};
  const buildingId = Number(value.buildingId);
  const qty = Number(value.qty);
  const anchorPrice = Number(value.anchorPrice);
  const name = String(value.name || 'COFFEE POWDER').trim();
  if (!Number.isSafeInteger(buildingId) || buildingId <= 0) {
    throw new Error('buildingId must be a positive integer');
  }
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) {
    throw new Error('qty must be positive and bounded');
  }
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0 || anchorPrice > 1_000_000) {
    throw new Error('anchorPrice must be positive and bounded');
  }
  if (!name || name.length > 120) throw new Error('name must be non-empty and bounded');
  return { buildingId, qty, anchorPrice, name };
}

function boundedRetailPrices(anchorPrice) {
  const anchor = Number(anchorPrice);
  if (!Number.isFinite(anchor) || anchor <= 0) return [];
  return [...new Set([0.70, 0.85, 0.95, 1, 1.05, 1.15, 1.30]
    .map(multiplier => roundPrice(anchor * multiplier))
    .filter(price => price >= 0.01)
    .map(price => price.toFixed(2)))]
    .map(Number)
    .sort((left, right) => left - right);
}

function compactQuote(quote) {
  return {
    price: quote.price,
    profitPerUnit: quote.profitPerUnit,
    profitPerHour: quote.profitPerHour,
    finishes: quote.finishes,
    valid: quote.valid === true,
    reason: quote.reason || null,
  };
}

async function main() {
  const args = parseArgs(process.argv[2]);
  const expectedPath = `/b/${args.buildingId}/`;
  const probeSource = fs.readFileSync(path.join(__dirname, 'actions', 'probe-retail.js'), 'utf8');
  const tested = [];

  await cdp.connect();
  await cdp.goto(`https://www.simcompanies.com${expectedPath}`);
  const pageStatus = await cdp.evaluate(String.raw`
    return {
      path: location.pathname,
      busy: /currently busy|currently upgrading|cannot take any orders/i.test(document.body.innerText || ''),
    };
  `);
  if (pageStatus.path !== expectedPath) {
    throw new Error(`retail page route mismatch: ${pageStatus.path || 'UNKNOWN'}`);
  }
  if (pageStatus.busy) {
    console.log(JSON.stringify({
      ok: true,
      status: 'BUSY',
      source: expectedPath,
      observedAt: new Date().toISOString(),
      buildingId: args.buildingId,
      qty: args.qty,
      anchorPrice: args.anchorPrice,
      tested: [],
      best: null,
    }));
    cdp.close();
    return;
  }

  for (const price of boundedRetailPrices(args.anchorPrice)) {
    await cdp.evaluate(`window.__probe=${JSON.stringify({
      name: args.name,
      qty: args.qty,
      price,
    })}; return true;`);
    const probed = await cdp.evaluate(probeSource);
    if (!probed?.ok) {
      tested.push({ price, valid: false, reason: String(probed?.reason || 'probe failed').slice(0, 160) });
      if (/store still busy/i.test(String(probed?.reason || ''))) break;
      continue;
    }
    const enteredPrice = Number(probed.entered?.price);
    const enteredQty = Number(probed.entered?.qty);
    const sellEnabled = Array.isArray(probed.buttons) && probed.buttons.some(button =>
      /^SELL$/i.test(String(button.t || '').trim()) && !button.disabled && !button.ariaDisabled &&
      !button.classDisabled && !button.pointerDisabled);
    const quote = parseRetailQuote(
      probed.text,
      Number.isFinite(enteredPrice) && enteredPrice > 0 ? enteredPrice : price,
    );
    quote.valid = quote.valid && Number.isFinite(enteredQty) &&
      Math.abs(enteredQty - args.qty) < 1e-9 && sellEnabled;
    if (!quote.valid && !quote.reason) quote.reason = 'form projection was not actionable';
    tested.push(compactQuote(quote));
  }

  const best = chooseBestRetailQuote(tested);
  console.log(JSON.stringify({
    ok: true,
    status: best ? 'LIVE_CURVE' : 'CURVE_UNAVAILABLE',
    source: `${expectedPath} read-only retail form projection`,
    observedAt: new Date().toISOString(),
    buildingId: args.buildingId,
    qty: args.qty,
    anchorPrice: args.anchorPrice,
    tested,
    best: best ? compactQuote(best) : null,
  }));
  cdp.close();
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => {
    try { cdp.close(); } catch (_) {}
    console.log(JSON.stringify({ ok: false, status: 'ERROR', error: String(error.message || error).slice(0, 300) }));
    process.exit(0);
  });
}

module.exports = {
  boundedRetailPrices,
  compactQuote,
  parseArgs,
};
