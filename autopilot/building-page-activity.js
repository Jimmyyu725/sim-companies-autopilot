'use strict';

const MAX_ACTIVITY_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;

// This function is serialized into the existing CDP page context by state.js and
// inspect-building.js. Keep it self-contained and read-only.
function readBuildingPageActivity({ expectedPath }) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = element => Boolean(element) && element.offsetParent !== null;
  const disabled = element => !element || element.disabled
    || String(element.getAttribute('aria-disabled')).toLowerCase() === 'true'
    || /(^|\s)disabled(\s|$)/i.test(String(element.className || ''))
    || getComputedStyle(element).pointerEvents === 'none';
  const elements = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = normalize(document.body?.innerText);
  // The current retail UI uses one <form> per product. Its buttons are ALL and AVG PRICE;
  // there is no literal SELL button. Bind the exact quantity+price form instead of relying on
  // wording that existed in an older DOM. The surrounding row owns the product image/name.
  const retailForms = elements('form').filter(form => {
    const inputs = elements('input', form).filter(visible);
    const quantityInputs = inputs.filter(input =>
      /^(?:quantity)$/i.test(normalize(input.name))
      || /^quantity$/i.test(normalize(input.placeholder)));
    const priceInputs = inputs.filter(input =>
      /^(?:price)$/i.test(normalize(input.name))
      || /^price$/i.test(normalize(input.placeholder)));
    const body = normalize(form.innerText).toUpperCase();
    return quantityInputs.length === 1 && priceInputs.length === 1
      && body.includes('QUANTITY') && body.includes('PRICE');
  });
  const retailCards = retailForms.map(form => {
    const inputs = elements('input', form).filter(visible);
    let card = form;
    for (let parent = form.parentElement, depth = 0; parent && depth < 4;
      parent = parent.parentElement, depth += 1) {
      const parentInputs = elements('input', parent).filter(visible);
      if (parentInputs.length > 2) break;
      card = parent;
      if (elements('img', parent).some(visible)) break;
    }
    const body = normalize(card.innerText);
    const imageName = elements('img', card).map(image => normalize(image.alt)).find(Boolean) || null;
    const name = imageName || (body.match(/^(.+?)(?=\s+(?:Stock:|Profit per unit:|Average price:|Quantity\b|Price\b))/i)
      || [])[1] || null;
    const sellButtons = elements('button', form)
      .filter(button => visible(button) && /^SELL$/i.test(normalize(button.innerText)));
    return {
      name: name ? name.slice(0, 120) : null,
      inputCount: inputs.length,
      enabledInputCount: inputs.filter(input => !disabled(input)).length,
      sellButtonCount: sellButtons.length,
      enabledSellButtonCount: sellButtons.filter(button => !disabled(button)).length,
    };
  });
  const productionOrderAvailable = elements('div').some(element => visible(element)
    && /\bPRODUCTION\b/i.test(normalize(element.innerText))
    && elements('input', element).some(input => visible(input) && !disabled(input)));
  const retailOrderAvailable = retailCards.some(card => card.enabledInputCount >= 2);
  return {
    path: location.pathname,
    pathMatches: location.pathname === expectedPath,
    construction: /(?:currently upgrading|upgrading to level|under construction|construction\s+finishes|cannot take any orders until the upgrade is finished)/i.test(text),
    retailSale: /\bstore is selling\b/i.test(text),
    orderBusy: /currently busy/i.test(text),
    collectible: elements('button').some(button => visible(button) && !disabled(button)
      && /^(?:COLLECT|COLLECT ALL)(?:\b|$)/i.test(normalize(button.innerText))),
    productionOrderAvailable,
    retailOrderAvailable,
    orderAvailable: productionOrderAvailable || retailOrderAvailable,
    retailCards,
  };
}

function classifyPageActivity(pageEvidence) {
  if (!pageEvidence || typeof pageEvidence !== 'object' || pageEvidence.pathMatches !== true) {
    return { status: 'unknown', busy: null, type: 'unknown' };
  }
  if (pageEvidence.construction === true) {
    return { status: 'page-derived', busy: true, type: 'construction' };
  }
  if (pageEvidence.retailSale === true) {
    return { status: 'page-derived', busy: true, type: 'sale' };
  }
  if (pageEvidence.orderBusy === true || pageEvidence.collectible === true) {
    return { status: 'page-derived', busy: true, type: 'unknown' };
  }
  if (pageEvidence.productionOrderAvailable === true
      || pageEvidence.retailOrderAvailable === true
      || pageEvidence.orderAvailable === true) {
    return { status: 'page-derived', busy: false, type: 'idle' };
  }
  return { status: 'unknown', busy: null, type: 'unknown' };
}

function buildPageActivityInspection({
  buildingId,
  level,
  observedAt,
  pageEvidence,
}) {
  const id = Number(buildingId);
  const numericLevel = Number(level);
  const observedMs = Date.parse(observedAt);
  if (!Number.isSafeInteger(id) || id <= 0
      || !Number.isSafeInteger(numericLevel) || numericLevel < 0
      || !Number.isFinite(observedMs)
      || pageEvidence?.path !== `/b/${id}/`
      || pageEvidence?.pathMatches !== true) return null;
  const activity = classifyPageActivity(pageEvidence);
  if (activity.status !== 'page-derived') return null;
  return {
    schemaVersion: 1,
    status: activity.status,
    observedAt: new Date(observedMs).toISOString(),
    source: pageEvidence.path,
    buildingId: id,
    level: numericLevel,
    busy: activity.busy,
    type: activity.type,
    evidence: {
      construction: pageEvidence.construction === true,
      retailSale: pageEvidence.retailSale === true,
      orderBusy: pageEvidence.orderBusy === true,
      collectible: pageEvidence.collectible === true,
      productionOrderAvailable: pageEvidence.productionOrderAvailable === true,
      retailOrderAvailable: pageEvidence.retailOrderAvailable === true,
      retailCardCount: Array.isArray(pageEvidence.retailCards)
        ? pageEvidence.retailCards.length : 0,
    },
  };
}

function validatePageActivityInspection(building, inspection, nowMs = Date.now()) {
  if (!building || typeof building !== 'object'
      || !inspection || typeof inspection !== 'object'
      || inspection.schemaVersion !== 1
      || inspection.status !== 'page-derived') return null;
  const buildingId = Number(building.id);
  const level = Number(building.size);
  const observedMs = Date.parse(inspection.observedAt);
  const now = Number(nowMs);
  if (!Number.isSafeInteger(buildingId) || buildingId <= 0
      || Number(inspection.buildingId) !== buildingId
      || !Number.isSafeInteger(level) || Number(inspection.level) !== level
      || inspection.source !== `/b/${buildingId}/`
      || !Number.isFinite(observedMs) || !Number.isFinite(now)
      || observedMs - now > MAX_FUTURE_SKEW_MS
      || now - observedMs > MAX_ACTIVITY_EVIDENCE_AGE_MS) return null;
  const evidence = inspection.evidence;
  if (!evidence || typeof evidence !== 'object') return null;
  const construction = inspection.busy === true && inspection.type === 'construction'
    && evidence.construction === true;
  const sale = inspection.busy === true && inspection.type === 'sale'
    && evidence.construction !== true && evidence.retailSale === true;
  const unknownBusy = inspection.busy === true && inspection.type === 'unknown'
    && evidence.construction !== true && evidence.retailSale !== true
    && (evidence.orderBusy === true || evidence.collectible === true);
  const idle = inspection.busy === false && inspection.type === 'idle'
    && evidence.construction !== true && evidence.retailSale !== true
    && evidence.orderBusy !== true && evidence.collectible !== true
    && (evidence.productionOrderAvailable === true || evidence.retailOrderAvailable === true);
  if (!construction && !sale && !unknownBusy && !idle) return null;
  return {
    status: 'page-derived',
    observedAt: inspection.observedAt,
    busy: inspection.busy,
    type: inspection.type,
  };
}

function attachPageActivityInspection(buildings, inspection) {
  if (!Array.isArray(buildings) || !inspection) return false;
  const matches = buildings.filter(building => Number(building?.id) === Number(inspection.buildingId));
  if (matches.length !== 1) return false;
  const [building] = matches;
  if (Object.prototype.hasOwnProperty.call(building, 'busy') && building.busy !== undefined) {
    const busyType = String(building.busy?.type || '').trim().toLowerCase();
    if (building.busy === null || (busyType && busyType !== 'unknown')) return false;
  }
  if (!validatePageActivityInspection(building, inspection, Date.parse(inspection.observedAt))) {
    return false;
  }
  building.activityInspection = inspection;
  return true;
}

module.exports = {
  MAX_ACTIVITY_EVIDENCE_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  attachPageActivityInspection,
  buildPageActivityInspection,
  classifyPageActivity,
  readBuildingPageActivity,
  validatePageActivityInspection,
};
