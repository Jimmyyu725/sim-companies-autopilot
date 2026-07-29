'use strict';

function roundPrice(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function uniquePrices(values, minPrice = 0.01) {
  const floor = Math.max(0.01, Number(minPrice) || 0.01);
  return [...new Set(values
    .map(roundPrice)
    .filter((price) => Number.isFinite(price) && price >= floor)
    .map((price) => price.toFixed(2)))]
    .map(Number)
    .sort((a, b) => a - b);
}

function coarsePriceCandidates(anchorPrice, minPrice = 0.01) {
  const anchor = Number(anchorPrice);
  if (!Number.isFinite(anchor) || anchor <= 0) return [];
  const values = [];
  for (let pct = 60; pct <= 120; pct += 5) values.push(anchor * pct / 100);
  values.push(anchor);
  return uniquePrices(values, minPrice);
}

function finePriceCandidates(anchorPrice, coarseBestPrice, minPrice = 0.01) {
  const anchor = Number(anchorPrice);
  const best = Number(coarseBestPrice);
  if (!Number.isFinite(anchor) || anchor <= 0 || !Number.isFinite(best) || best <= 0) return [];
  const step = Math.max(0.01, roundPrice(anchor * 0.01));
  const values = [];
  for (let offset = -4; offset <= 4; offset++) values.push(best + offset * step);
  values.push(best);
  return uniquePrices(values, minPrice);
}

function parseMagnitude(raw) {
  const match = String(raw || '').replace(/,/g, '').trim().match(/^(-?\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) return null;
  const factor = match[2] && match[2].toLowerCase() === 'k'
    ? 1e3
    : match[2] && match[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Number(match[1]) * factor;
}

function extractDollarMetric(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(
    new RegExp(`${escaped}:\\s*\\$\\s*(-?[\\d,.]+\\s*[kKmM]?)`, 'i'),
  );
  return match ? parseMagnitude(match[1]) : null;
}

function parseRetailQuote(text, requestedPrice) {
  const body = String(text || '');
  const finish = body.match(/Finishes:\s*(.+?)\s+Profit per hour:/i);
  const quote = {
    price: roundPrice(requestedPrice),
    profitPerUnit: extractDollarMetric(body, 'Profit per unit'),
    profitPerHour: extractDollarMetric(body, 'Profit per hour'),
    finishes: finish ? finish[1].trim() : null,
  };
  quote.valid = Number.isFinite(quote.price)
    && Number.isFinite(quote.profitPerUnit)
    && Number.isFinite(quote.profitPerHour)
    && quote.profitPerUnit > 0
    && quote.profitPerHour > 0;
  return quote;
}

function chooseBestRetailQuote(quotes) {
  return (quotes || [])
    .filter((quote) => quote && quote.valid)
    .sort((a, b) => b.profitPerHour - a.profitPerHour
      || b.profitPerUnit - a.profitPerUnit
      || b.price - a.price)[0] || null;
}

module.exports = {
  chooseBestRetailQuote,
  coarsePriceCandidates,
  finePriceCandidates,
  parseRetailQuote,
  roundPrice,
};
