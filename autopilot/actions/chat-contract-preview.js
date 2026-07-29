// Zero-click preview for one exact incoming-contract row.
// Identity comes from the current React object bound to the exact rendered row and is cross-checked
// against the English aria-label. Missing, duplicate, grouped, or changed evidence fails closed.
const request = window.__chatContractPreview || {};
const compact = value => String(value == null ? '' : value)
  .normalize('NFKC').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
const blocked = (reason, extra = {}) => ({ ok: false, status: 'unsupported', readOnly: true,
  mutationAuthorized: false, doNotClick: true, clickCount: 0, reason, ...extra });
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
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = async value => {
  if (!window.crypto || !window.crypto.subtle || typeof TextEncoder !== 'function') return null;
  const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
  const hash = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const parseLabel = row => {
  const label = compact(row.getAttribute('aria-label'));
  const number = '[0-9][0-9,]*(?:\\.[0-9]+)?';
  const parsed = label.match(new RegExp(
    `^incoming contract, (${number}) (.+?) quality ([0-9]+), at \\$(${number}) per unit, `
      + `total price \\$(${number}), from (.+)$`, 'i'));
  if (!parsed) return null;
  const quantity = Number(parsed[1].replace(/,/g, ''));
  const resourceName = compact(parsed[2]);
  const quality = Number(parsed[3]);
  const unitPrice = canonicalDecimal(parsed[4]);
  const totalPrice = Number(parsed[5].replace(/,/g, ''));
  const sellerCompany = compact(parsed[6]);
  const expectedTotal = Math.ceil(Math.trunc(quantity * Number(unitPrice) * 1000) / 1000);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !resourceName
      || !Number.isSafeInteger(quality) || quality < 0 || !unitPrice
      || !Number.isSafeInteger(totalPrice) || totalPrice <= 0 || !sellerCompany
      || expectedTotal !== totalPrice) return null;
  return { ariaLabel: label, quantity, resourceName, quality, unitPrice, totalPrice, sellerCompany };
};
const exactReactContract = row => {
  const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber$'));
  if (!fiberKey) return null;
  const values = [];
  const add = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const contractId = positiveId(value.id);
    const resourceKind = Number(value.kind);
    const quality = Number(value.quality);
    const unitPrice = canonicalDecimal(value.price);
    const sellerCompanyId = positiveId(value.seller?.id);
    const sellerCompany = compact(value.seller?.company);
    if (!contractId || !Number.isSafeInteger(resourceKind) || resourceKind <= 0
        || !Number.isSafeInteger(quality) || quality < 0 || !unitPrice
        || !sellerCompanyId || !sellerCompany || typeof value.needsConfirmation !== 'boolean') return;
    const normalized = { contractId, resourceKind, quality, unitPrice, sellerCompanyId,
      sellerCompany, needsConfirmation: value.needsConfirmation };
    if (!values.some(candidate => JSON.stringify(candidate) === JSON.stringify(normalized))) {
      values.push(normalized);
    }
  };
  let fiber = row[fiberKey];
  for (let depth = 0; fiber && depth <= 16; depth += 1, fiber = fiber.return) {
    add(fiber.memoizedProps?.contract);
    add(fiber.pendingProps?.contract);
    add(fiber.stateNode?.props?.contract);
  }
  return values.length === 1 ? values[0] : null;
};

if (request.confirm !== false) return blocked('preview requires literal confirm:false');
if (location.pathname !== '/headquarters/warehouse/incoming-contracts/') {
  return blocked('exact English incoming-contracts route is required', { pathname: location.pathname });
}
const contractId = positiveId(request.contractId);
const ownCompanyId = positiveId(request.ownCompanyId || window.__companyId);
if (!contractId) return blocked('an exact positive contract ID is required');
if (!ownCompanyId) return blocked('the authenticated buyer company ID is required');
if (!/^[0-9a-f]{64}$/.test(String(request.termsHash || ''))) {
  return blocked('a valid termsHash is required');
}
const terms = request.terms;
const exactTermKeys = ['counterpartyCompanyId', 'ourSide', 'quality', 'quantity', 'resourceKind', 'unitPrice'];
if (!terms || typeof terms !== 'object' || Array.isArray(terms)
    || Object.keys(terms).sort().join('|') !== exactTermKeys.slice().sort().join('|')) {
  return blocked('exact immutable contract terms are required');
}

const candidates = Array.from(document.querySelectorAll('div[tabindex="0"][aria-label]'))
  .filter(row => row.offsetParent !== null
    && /^incoming contract,/i.test(compact(row.getAttribute('aria-label'))))
  .map(row => ({ row, binding: exactReactContract(row) }));
const matches = candidates.filter(candidate => candidate.binding?.contractId === contractId);
if (matches.length !== 1) {
  return blocked('exact React-bound rendered contract ID count is not one', {
    contractId,
    contractIdStatus: candidates.length > 0 && candidates.every(candidate => !candidate.binding)
      ? 'REACT_ROW_BINDING_UNAVAILABLE' : 'AMBIGUOUS_OR_MISSING',
    renderedGroupCount: candidates.length,
    exactMatchCount: matches.length,
  });
}
const { row, binding } = matches[0];
const parsed = parseLabel(row);
if (!parsed) return blocked('incoming-contract aria-label is localized, changed, or malformed');
if (binding.sellerCompany !== parsed.sellerCompany || binding.quality !== parsed.quality
    || binding.unitPrice !== parsed.unitPrice) {
  return blocked('React row identity differs from the visible contract terms');
}
const grouped = Array.from(compact(row.innerText).matchAll(/\(([0-9]+)x\)/gi));
const groupedCount = grouped.length ? Number(grouped[0][1]) : 1;
if (grouped.length > 1 || groupedCount !== 1) return blocked('the UI grouped multiple contracts into one row');
const acceptControls = Array.from(row.querySelectorAll('a[role="button"][aria-label]'))
  .filter(control => control.offsetParent !== null
    && compact(control.getAttribute('aria-label')) === 'Sign contract');
if (acceptControls.length !== 1) return blocked('one exact Sign contract control was not proven');

const canonicalTerms = {
  counterpartyCompanyId: binding.sellerCompanyId,
  ourSide: 'buy',
  quality: parsed.quality,
  quantity: parsed.quantity,
  resourceKind: binding.resourceKind,
  unitPrice: parsed.unitPrice,
};
const suppliedCanonical = {
  counterpartyCompanyId: positiveId(terms.counterpartyCompanyId),
  ourSide: terms.ourSide,
  quality: Number(terms.quality),
  quantity: Number(terms.quantity),
  resourceKind: Number(terms.resourceKind),
  unitPrice: canonicalDecimal(terms.unitPrice),
};
if (JSON.stringify(canonicalTerms) !== JSON.stringify(suppliedCanonical)) {
  return blocked('rendered contract terms differ from requested immutable terms');
}
if (await digest(canonicalTerms) !== request.termsHash) {
  return blocked('termsHash is not the hash of exact rendered terms');
}
const rowEvidence = {
  contractId,
  contractIdStatus: 'VERIFIED_REACT_RENDER_BINDING',
  sellerCompany: parsed.sellerCompany,
  sellerCompanyId: binding.sellerCompanyId,
  buyerCompanyId: ownCompanyId,
  ourSide: 'buy',
  resourceName: parsed.resourceName,
  resourceKind: binding.resourceKind,
  quality: parsed.quality,
  quantity: parsed.quantity,
  unitPrice: parsed.unitPrice,
  totalPrice: parsed.totalPrice,
  groupedCount,
  needsConfirmation: binding.needsConfirmation,
  acceptControlAriaLabel: 'Sign contract',
};
const evidenceFingerprint = await digest(rowEvidence);
if (!evidenceFingerprint) return blocked('browser evidence hashing is unavailable');
const previewBase = {
  schemaVersion: 2,
  operation: 'accept',
  confirm: false,
  contractId,
  terms: canonicalTerms,
  termsHash: request.termsHash,
  evidenceFingerprint,
  observedAt: new Date().toISOString(),
  row: rowEvidence,
};
const previewId = await digest(previewBase);
return { ok: true, status: 'preview-only', readOnly: true, mutationAuthorized: false,
  doNotClick: true, clickCount: 0, preview: { ...previewBase, previewId } };
