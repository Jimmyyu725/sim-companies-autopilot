// Collect finished/partial production from every building.
//
// Must run on /landscape/. The real collect control is the resource bubble floating over
// each building — `div.js-landscape-busy-info`, nested inside the building's <a>. Clicking
// it banks whatever the order has released so far (orders expose `amountAvailableNow` and
// release continuously) without navigating away.
//
// The header's "Collect ready resources" is NOT a collect button — it is a hint banner
// that only opens an explanatory tooltip. Clicking it collects nothing.
if (!location.pathname.startsWith('/landscape')) {
  return { ok: false, collected: false, reason: 'not on /landscape/' };
}

const beforeBuildings = window.__collect?.beforeBuildings;
if (!Array.isArray(beforeBuildings)) {
  return { ok: false, collected: false,
    reason: 'authoritative pre-collection buildings are unavailable' };
}
const collectible = (building) => {
  const busy = building?.busy;
  if (!busy) return false;
  const resourceAmount = busy.resource?.amountAvailableNow;
  const retailProfit = busy.sales_order?.profitAvailableNow;
  return busy.canFetch === true
    || (resourceAmount != null && Number(resourceAmount) > 0)
    || (retailProfit != null && Number(retailProfit) > 0);
};
const expectedIds = beforeBuildings.filter(collectible).map(building => Number(building.id));
if (expectedIds.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(expectedIds).size !== expectedIds.length) {
  return { ok: false, collected: false,
    reason: 'pre-collection snapshot contains invalid or duplicate building IDs' };
}
if (!expectedIds.length) {
  return { ok: true, collected: false, verified: true, mutationAttempted: false,
    clicked: [], note: 'authoritative snapshot shows no collectible building' };
}

const bubbleBuildingId = (el) => {
  const link = el.closest('a');
  const match = String(link?.getAttribute('href') || link?.href || '').match(/\/b\/(\d+)\/?/);
  const id = match ? Number(match[1]) : null;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const initialBubbles = all('div.js-landscape-busy-info').filter(el => el.offsetParent !== null);
const counts = new Map();
for (const bubble of initialBubbles) {
  const id = bubbleBuildingId(bubble);
  if (id != null) counts.set(id, (counts.get(id) || 0) + 1);
}
const missing = expectedIds.filter(id => counts.get(id) !== 1);
if (missing.length) {
  return { ok: false, collected: false,
    reason: 'collectible building bubble is missing or ambiguous; nothing was clicked',
    missingOrAmbiguousBuildingIds: missing };
}

const clicked = [];
for (const buildingId of expectedIds) {
  // Re-resolve after every click because React can replace the landscape nodes.
  const matches = all('div.js-landscape-busy-info').filter(el =>
    el.offsetParent !== null && bubbleBuildingId(el) === buildingId);
  if (matches.length !== 1) {
    return { ok: false, collected: false, mutationAttempted: clicked.length > 0,
      doNotRetry: clicked.length > 0,
      reason: `building ${buildingId} bubble changed before click`, clicked };
  }
  const el = matches[0];
  const img = all('img', el)[0];
  const label = img ? img.src.replace(/.*\//, '').replace(/\.\w+\.png$/, '') : 'unknown';
  el.click();
  await sleep(2500);
  clicked.push({ buildingId, resource: label });
}

return {
  ok: false,
  collected: false,
  verified: false,
  verificationPending: true,
  mutationAttempted: clicked.length > 0,
  doNotRetry: clicked.length > 0,
  clicked,
  reason: 'collect bubbles were clicked; act.js must verify exact before/after authoritative transitions',
};
