// Read-only rendered-UI snapshot of incoming contracts.
// Caller must navigate to the exact incoming-contracts warehouse route first.
// The current React row binding is used only to recover identities already attached to the exact
// rendered row. Any missing, duplicate, grouped, localized, or structurally changed binding fails
// closed. This fragment never clicks, writes, or calls a game API.
const request = window.__chatContractList || {};
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value)
  .normalize('NFKC').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
const canonicalDecimal = value => {
  const text = compact(value).replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(text) || !(Number(text) > 0)) return null;
  const [wholeRaw, fractionRaw = ''] = text.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
};
const positiveId = value => {
  const text = compact(value);
  return /^[1-9][0-9]{0,24}$/.test(text) ? text : null;
};
const positiveInteger = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const localeMatch = location.pathname.match(
  /^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?headquarters\/warehouse\/incoming-contracts\/$/i,
);
if (!localeMatch) {
  return { ok: false, unsupported: true, readOnly: true, clickCount: 0,
    reason: 'exact incoming-contracts warehouse route is required', pathname: location.pathname };
}
const locale = (localeMatch[1] || 'en').toLowerCase();
if (locale !== 'en') {
  return { ok: false, unsupported: true, readOnly: true, clickCount: 0,
    reason: 'localized incoming-contract aria-labels have not been evidenced', locale };
}
const bodyLines = String(document.body?.innerText || '').split(/\r?\n/).map(compact).filter(Boolean);
if (!bodyLines.includes('Incoming contracts')) {
  return { ok: false, unsupported: true, readOnly: true, clickCount: 0,
    reason: 'the exact Incoming contracts panel was not proven' };
}

const parseLabel = label => {
  const text = compact(label);
  const number = '[0-9][0-9,]*(?:\\.[0-9]+)?';
  const match = text.match(new RegExp(
    `^incoming contract, (${number}) (.+?) quality ([0-9]+), at \\$(${number}) per unit, `
      + `total price \\$(${number}), from (.+)$`, 'i'));
  if (!match) return null;
  const integer = value => Number(String(value).replace(/,/g, ''));
  const quantity = integer(match[1]);
  const quality = integer(match[3]);
  const unitPrice = canonicalDecimal(match[4]);
  const totalPrice = integer(match[5]);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(quality) || quality < 0
    || !unitPrice || !Number.isSafeInteger(totalPrice) || totalPrice <= 0) return null;
  const expectedTotal = Math.ceil(Math.trunc(quantity * Number(unitPrice) * 1000) / 1000);
  if (expectedTotal !== totalPrice) return null;
  return { ariaLabel: text, quantity, resourceName: compact(match[2]), quality,
    unitPrice, totalPrice, totalFormulaStatus: 'VERIFIED_BUNDLE_FORMULA',
    sellerCompany: compact(match[6]) };
};

const exactReactContract = row => {
  const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber$'));
  if (!fiberKey) return { ok: false, status: 'REACT_ROW_BINDING_UNAVAILABLE' };
  const candidates = [];
  const add = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const id = positiveId(value.id);
    const kind = positiveInteger(value.kind);
    const quality = Number(value.quality);
    const price = canonicalDecimal(value.price);
    const sellerCompanyId = positiveId(value.seller?.id);
    const sellerCompany = compact(value.seller?.company);
    if (!id || !kind || !Number.isSafeInteger(quality) || quality < 0 || !price
        || !sellerCompanyId || !sellerCompany || typeof value.needsConfirmation !== 'boolean') return;
    const normalized = {
      contractId: id,
      resourceKind: kind,
      quality,
      unitPrice: price,
      sellerCompanyId,
      sellerCompany,
      needsConfirmation: value.needsConfirmation,
    };
    if (!candidates.some(candidate => JSON.stringify(candidate) === JSON.stringify(normalized))) {
      candidates.push(normalized);
    }
  };
  let fiber = row[fiberKey];
  for (let depth = 0; fiber && depth <= 16; depth += 1, fiber = fiber.return) {
    add(fiber.memoizedProps?.contract);
    add(fiber.pendingProps?.contract);
    add(fiber.stateNode?.props?.contract);
  }
  return candidates.length === 1
    ? { ok: true, status: 'VERIFIED_REACT_RENDER_BINDING', contract: candidates[0] }
    : { ok: false, status: candidates.length === 0
      ? 'REACT_ROW_BINDING_UNAVAILABLE' : 'REACT_ROW_BINDING_AMBIGUOUS' };
};

const candidates = Array.from(document.querySelectorAll('div[tabindex="0"][aria-label]'))
  .filter(visible)
  .map(row => ({ row, parsed: parseLabel(row.getAttribute('aria-label')) }))
  .filter(candidate => candidate.parsed);
const requestedLimit = Number(request.limit);
const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
  ? Math.min(requestedLimit, 100) : 50;
const observedAt = new Date().toISOString();
const rows = [];
for (const { row, parsed } of candidates.slice(0, limit)) {
  const groupMatches = Array.from(compact(row.innerText).matchAll(/\(([0-9]+)x\)/gi));
  if (groupMatches.length > 1) {
    return { ok: false, readOnly: true, clickCount: 0,
      reason: 'contract row has ambiguous grouping evidence' };
  }
  const groupedCount = groupMatches.length ? Number(groupMatches[0][1]) : 1;
  const acceptControls = Array.from(row.querySelectorAll('a[role="button"][aria-label]'))
    .filter(control => visible(control) && compact(control.getAttribute('aria-label')) === 'Sign contract');
  const binding = exactReactContract(row);
  const exact = binding.ok ? binding.contract : null;
  const bindingMatchesVisible = !!exact && exact.sellerCompany === parsed.sellerCompany
    && exact.quality === parsed.quality && exact.unitPrice === parsed.unitPrice;
  const trusted = bindingMatchesVisible ? exact : null;
  const resourceImage = Array.from(row.querySelectorAll('img[alt=""]')).filter(visible)[0] || null;
  const counterpartyLinks = Array.from(row.querySelectorAll('a[href][aria-label]'))
    .filter(anchor => visible(anchor) && compact(anchor.getAttribute('aria-label')) === parsed.sellerCompany);
  rows.push({
    ...parsed,
    observedAt,
    direction: 'incoming',
    ourSide: 'buy',
    status: 'pending-rendered',
    groupedCount,
    contractId: trusted?.contractId ?? null,
    contractIdStatus: trusted ? 'VERIFIED_REACT_RENDER_BINDING' : binding.status,
    resourceKind: trusted?.resourceKind ?? null,
    resourceKindStatus: trusted ? 'VERIFIED_REACT_RENDER_BINDING' : binding.status,
    sellerCompanyId: trusted?.sellerCompanyId ?? null,
    sellerCompanyIdStatus: trusted ? 'VERIFIED_REACT_RENDER_BINDING' : binding.status,
    needsConfirmation: trusted?.needsConfirmation ?? null,
    needsConfirmationStatus: trusted ? 'VERIFIED_REACT_RENDER_BINDING' : binding.status,
    buyerCompanyId: compact(window.__companyId) || null,
    buyerCompanyIdStatus: compact(window.__companyId)
      ? 'CALLER_BOUND_AUTH_COMPANY' : 'CURRENT_COMPANY_UNAVAILABLE',
    acceptControlCount: acceptControls.length,
    acceptControlAriaLabel: acceptControls.length === 1 ? 'Sign contract' : null,
    resourceImageSrc: resourceImage ? resourceImage.src : null,
    counterpartyHref: counterpartyLinks.length === 1 ? counterpartyLinks[0].href : null,
  });
}

if (!rows.length && !bodyLines.includes('Wow! Such empty')) {
  return { ok: false, incomplete: true, readOnly: true, clickCount: 0,
    reason: 'neither contract rows nor the measured loaded empty state were proven' };
}

return {
  ok: true,
  readOnly: true,
  clickCount: 0,
  source: 'rendered-ui-with-exact-react-row-binding',
  locale,
  observedAt,
  count: rows.reduce((sum, row) => sum + row.groupedCount, 0),
  renderedGroupCount: rows.length,
  truncated: candidates.length > limit,
  complete: candidates.length <= limit,
  rows,
  acceptanceDomStatus: rows.length === 0
    ? 'NO_PENDING_CONTRACTS' : 'GUARDED_REACT_ROW_BINDING_AVAILABLE',
};
