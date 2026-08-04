// Collect finished/partial production from every building.
//
// Must run on /landscape/. Two controls can trigger a collect:
//
// 1. The supporter "Collect All" button in the landscape side panel. One click banks every
//    collectible building at once. Bind ONLY to its aria-label — the adjacent `css-*` class
//    is a CSS-in-JS hash that changes on every frontend build and must never be selected on —
//    and cross-check the `hand-holding-medical` icon so a coincidental aria-label match on
//    some unrelated control can never be clicked in its place. This is a supporter benefit, so
//    the button can be entirely absent (no subscription) or disabled (subscription lapsed);
//    both cases fall back to path 2 rather than failing the action.
// 2. The resource bubble floating over each building — `div.js-landscape-busy-info`, nested
//    inside the building's <a>. Clicking it banks whatever the order has released so far
//    (orders expose `amountAvailableNow` and release continuously) without navigating away.
//    This is the original mechanism and remains the fallback for every non-supporter account.
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
const resourceLabelOf = (bubble) => {
  const img = all('img', bubble)[0];
  return img ? img.src.replace(/.*\//, '').replace(/\.\w+\.png$/, '') : 'unknown';
};

// Every expected building must show exactly one visible bubble before anything is clicked,
// no matter which control ends up doing the clicking below. This is what proves the page
// actually shows what the authoritative API claims, so it applies to both paths.
const initialBubbles = all('div.js-landscape-busy-info').filter(el => el.offsetParent !== null);
const bubblesByBuildingId = new Map();
for (const bubble of initialBubbles) {
  const id = bubbleBuildingId(bubble);
  if (id == null) continue;
  bubblesByBuildingId.set(id, (bubblesByBuildingId.get(id) || []).concat(bubble));
}
const missing = expectedIds.filter(id => (bubblesByBuildingId.get(id) || []).length !== 1);
if (missing.length) {
  return { ok: false, collected: false,
    reason: 'collectible building bubble is missing or ambiguous; nothing was clicked',
    missingOrAmbiguousBuildingIds: missing };
}

// Read each building's resource label now, from the single confirmed bubble, before anything
// is clicked. A "Collect All" click removes every bubble at once, so path 1 has no later
// opportunity to read them; path 2 re-derives its own label per building at click time anyway,
// but capturing here first keeps both paths sourcing labels the same way.
const labelByBuildingId = new Map(expectedIds.map(id =>
  [id, resourceLabelOf(bubblesByBuildingId.get(id)[0])]));

// Verified live on this account: <button aria-label="Collect resource and cash from buildings"
// type="button" role="button" class="css-1h3q6hg btn btn-secondary"><svg
// data-icon="hand-holding-medical">...</svg></button>, inside <div role="group"
// aria-label="Side Panel">. The css-* class is a CSS-in-JS hash that changes on every
// frontend build, so it is never used here. Require exactly one visible match on both the
// aria-label and the icon before trusting this is really the supporter Collect All control.
const collectAllMatches = all('button[aria-label="Collect resource and cash from buildings"]')
  .filter(button => button.offsetParent !== null);
const collectAllButton = collectAllMatches.length === 1 ? collectAllMatches[0] : null;
const collectAllUsable = !!collectAllButton
  && all('svg[data-icon="hand-holding-medical"]', collectAllButton).length === 1
  && collectAllButton.disabled !== true
  && String(collectAllButton.getAttribute('aria-disabled')).toLowerCase() !== 'true';

if (collectAllUsable) {
  collectAllButton.click();
  await sleep(2500);
  const clicked = expectedIds.map(buildingId =>
    ({ buildingId, resource: labelByBuildingId.get(buildingId) }));
  return {
    ok: false,
    collected: false,
    verified: false,
    verificationPending: true,
    mutationAttempted: true,
    doNotRetry: true,
    method: 'collect-all-button',
    clicked,
    reason: 'supporter Collect All button was clicked once; act.js must verify exact before/after authoritative transitions',
  };
}

// Fallback: no usable supporter button (absent, disabled, or an ambiguous/unconfirmed match) —
// click each bubble individually, exactly as every account without the subscription always has.
const clicked = [];
for (const buildingId of expectedIds) {
  // Re-resolve after every click because React can replace the landscape nodes.
  const matches = all('div.js-landscape-busy-info').filter(el =>
    el.offsetParent !== null && bubbleBuildingId(el) === buildingId);
  if (matches.length !== 1) {
    return { ok: false, collected: false, mutationAttempted: clicked.length > 0,
      doNotRetry: clicked.length > 0, method: 'per-bubble',
      reason: `building ${buildingId} bubble changed before click`, clicked };
  }
  const el = matches[0];
  const label = resourceLabelOf(el);
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
  method: 'per-bubble',
  clicked,
  reason: 'collect bubbles were clicked; act.js must verify exact before/after authoritative transitions',
};
