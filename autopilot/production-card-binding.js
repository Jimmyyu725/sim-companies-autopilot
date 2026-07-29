'use strict';

// This function is serialized into the building page. Keep every helper lexical and avoid Node
// globals. A resource image is the stable product identity; surrounding text is only a second
// check because Quarry/Mine/Rig cards insert an Abundance line before Production.
function bindExactProductionCard(options = {}) {
  const doc = options.document || globalThis.document;
  const canonicalText = (value) => String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  const imageSlug = (value) => {
    let raw = String(value || '').split(/[?#]/, 1)[0];
    try { raw = decodeURIComponent(raw); } catch (_) {}
    const filename = raw.split('/').pop() || '';
    return filename
      .replace(/(?:\.[0-9a-f]{6,})?\.(?:png|svg|webp)$/i, '')
      .trim()
      .toLowerCase();
  };
  const elementText = (element) => String(element?.innerText || element?.textContent || '');
  const query = (root, selector) => Array.from(root?.querySelectorAll?.(selector) || []);
  const contains = (parent, child) => parent === child || parent?.contains?.(child) === true;
  const sourceOf = (image) => image?.currentSrc
    || image?.getAttribute?.('src')
    || image?.src
    || '';

  const expectedName = canonicalText(options.name);
  const expectedKind = Number(options.kind);
  const expectedSlug = imageSlug(options.resourceSlug);
  if (!doc || !expectedName || !Number.isSafeInteger(expectedKind) || expectedKind <= 0 || !expectedSlug) {
    return {
      ok: false,
      guard: true,
      reason: 'exact production resource identity is incomplete; no card was selected',
      expectedName: expectedName || null,
      expectedKind: Number.isSafeInteger(expectedKind) ? expectedKind : null,
      expectedResourceSlug: expectedSlug || null,
    };
  }

  const images = query(doc, 'img');
  const observedResourceSlugs = [...new Set(images.map(image => imageSlug(sourceOf(image))).filter(Boolean))]
    .sort();
  const targetImages = images.filter(image => imageSlug(sourceOf(image)) === expectedSlug);
  const productionPattern = /\bProduction:\s*[\d,.]+\s*\/h\b/i;
  const productionNodes = query(doc, '*').filter(element => productionPattern.test(elementText(element)));
  const productionLeaves = productionNodes.filter(element =>
    !productionNodes.some(other => other !== element && contains(element, other)));
  const observedProductionTexts = productionLeaves
    .map(element => elementText(element).replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean);

  const candidates = [];
  let multiProductAncestorRejected = false;
  for (const image of targetImages) {
    let selected = null;
    for (let node = image; node && node !== doc; node = node.parentElement) {
      const text = canonicalText(elementText(node));
      if (!(text === expectedName || text.startsWith(`${expectedName} `))) continue;
      const targetCount = query(node, 'img')
        .filter(candidate => imageSlug(sourceOf(candidate)) === expectedSlug).length;
      const containedProductionLeaves = productionLeaves.filter(leaf => contains(node, leaf));
      const usableInputs = query(node, 'input').filter(input =>
        input?.disabled !== true && String(input?.type || '').toLowerCase() !== 'hidden');
      if (targetCount === 1 && usableInputs.length === 1 && containedProductionLeaves.length > 1) {
        multiProductAncestorRejected = true;
      }
      if (targetCount !== 1 || containedProductionLeaves.length !== 1 || usableInputs.length !== 1) continue;
      selected = {
        card: node,
        input: usableInputs[0],
        productionText: elementText(containedProductionLeaves[0]).replace(/\s+/g, ' ').trim(),
      };
      break;
    }
    if (selected && !candidates.some(candidate => candidate.card === selected.card)) candidates.push(selected);
  }

  if (candidates.length !== 1) {
    return {
      ok: false,
      guard: true,
      reason: candidates.length > 1
        ? 'exact production resource matched multiple cards; no card was selected'
        : 'exact production card was not found; no card was selected',
      expectedName,
      expectedKind,
      expectedResourceSlug: expectedSlug,
      targetImageCount: targetImages.length,
      matchingCardCount: candidates.length,
      multiProductAncestorRejected,
      observedResourceSlugs,
      observedProductionTexts,
    };
  }

  return {
    ok: true,
    card: candidates[0].card,
    input: candidates[0].input,
    matchedKind: expectedKind,
    matchedResourceSlug: expectedSlug,
    matchedProductionText: candidates[0].productionText,
  };
}

function buildProductionCardBindingPagePrelude() {
  return `window.__bindExactProductionCard=${bindExactProductionCard.toString()};`;
}

module.exports = {
  bindExactProductionCard,
  buildProductionCardBindingPagePrelude,
};
