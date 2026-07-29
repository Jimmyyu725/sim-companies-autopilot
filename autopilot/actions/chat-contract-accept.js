// Guarded UI acceptance of one exact incoming contract.
// A trusted Node worker has already evaluated economics and durably claimed the exact action. This
// fragment re-verifies the same React-bound rendered row, performs the minimum one or two UI clicks,
// and proves success only when the exact contract ID disappears after the game's success reducer.
const request = window.__chatContractAccept || {};
const compact = value => String(value == null ? '' : value)
  .normalize('NFKC').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
const blocked = (reason, extra = {}) => ({ ok: false, refused: true, mutationAuthorized: false,
  doNotClick: true, clickCount: 0, reason, ...extra });
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
const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
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
  return { quantity, resourceName, quality, unitPrice, totalPrice, sellerCompany };
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
const renderedRows = () => Array.from(document.querySelectorAll('div[tabindex="0"][aria-label]'))
  .filter(row => row.offsetParent !== null
    && /^incoming contract,/i.test(compact(row.getAttribute('aria-label'))))
  .map(row => ({ row, binding: exactReactContract(row) }));

if (request.confirm !== true) return blocked('acceptance requires literal confirm:true');
if (location.pathname !== '/headquarters/warehouse/incoming-contracts/') {
  return blocked('exact English incoming-contracts route is required', { pathname: location.pathname });
}
const contractId = positiveId(request.contractId);
const termsHash = compact(request.termsHash);
const evidenceFingerprint = compact(request.evidenceFingerprint);
if (!contractId) return blocked('an exact positive contract ID is required');
if (!/^[0-9a-f]{64}$/.test(termsHash) || !/^[0-9a-f]{64}$/.test(evidenceFingerprint)) {
  return blocked('valid immutable terms and UI evidence fingerprints are required');
}
const preview = request.preview;
const authorization = request.authorization;
if (!preview || preview.schemaVersion !== 2 || preview.operation !== 'accept'
    || preview.confirm !== false) {
  return blocked('a valid confirm:false UI preview is required');
}
if (!authorization || authorization.schemaVersion !== 1
    || authorization.attemptId !== request.attemptId
    || authorization.uiPreviewId !== preview.previewId
    || authorization.economicPreviewId !== request.economicPreviewId
    || authorization.termsHash !== termsHash
    || ![1, 2].includes(authorization.maxClicks)
    || authorization.retryAfterAmbiguous !== false
    || !/^[0-9a-f]{64}$/.test(compact(authorization.idempotencyKey))) {
  return blocked('contract-gate authorization is missing or not bound to the UI preview');
}
if (preview.contractId !== contractId || preview.termsHash !== termsHash
    || preview.evidenceFingerprint !== evidenceFingerprint) {
  return blocked('contract ID, terms, or evidence changed after preview');
}
const expiresAt = Date.parse(authorization.expiresAt);
if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return blocked('authorization expired');
const { previewId, ...previewBase } = preview;
if (await digest(previewBase) !== previewId) return blocked('preview artifact integrity failed');

const exact = renderedRows().filter(candidate => candidate.binding?.contractId === contractId);
if (exact.length !== 1) {
  return blocked('exact React-bound rendered contract ID count is not one', {
    contractIdStatus: exact.length === 0 ? 'MISSING' : 'AMBIGUOUS',
    exactMatchCount: exact.length,
  });
}
const { row, binding } = exact[0];
const parsed = parseLabel(row);
if (!parsed || binding.sellerCompany !== parsed.sellerCompany
    || binding.quality !== parsed.quality || binding.unitPrice !== parsed.unitPrice) {
  return blocked('current React row identity differs from visible contract terms');
}
const groups = Array.from(compact(row.innerText).matchAll(/\(([0-9]+)x\)/gi));
const groupedCount = groups.length ? Number(groups[0][1]) : 1;
if (groups.length > 1 || groupedCount !== 1) return blocked('the UI grouped multiple contracts into one row');
const acceptControls = Array.from(row.querySelectorAll('a[role="button"][aria-label]'))
  .filter(control => control.offsetParent !== null
    && compact(control.getAttribute('aria-label')) === 'Sign contract');
if (acceptControls.length !== 1) return blocked('one exact Sign contract control was not proven');
const currentEvidence = {
  contractId,
  contractIdStatus: 'VERIFIED_REACT_RENDER_BINDING',
  sellerCompany: parsed.sellerCompany,
  sellerCompanyId: binding.sellerCompanyId,
  buyerCompanyId: positiveId(window.__companyId),
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
if (await digest(currentEvidence) !== evidenceFingerprint
    || JSON.stringify(currentEvidence) !== JSON.stringify(preview.row)) {
  return blocked('current rendered contract evidence differs from the exact preview');
}
const expectedClicks = binding.needsConfirmation ? 2 : 1;
if (authorization.maxClicks !== expectedClicks) {
  return blocked('authorized click ceiling differs from the exact confirmation path');
}

let clickCount = 0;
acceptControls[0].click();
clickCount += 1;
if (binding.needsConfirmation) {
  const modal = await waitFor(() => {
    const headers = Array.from(document.querySelectorAll('div, h1, h2, h3, h4'))
      .filter(element => element.offsetParent !== null
        && compact(element.textContent) === 'Contract confirmation required');
    const containers = headers.map(header => {
      let node = header.parentElement;
      while (node && node !== document.body) {
        const text = compact(node.innerText);
        const buttons = Array.from(node.querySelectorAll('button'))
          .filter(button => button.offsetParent !== null && compact(button.textContent) === 'Sign');
        if (text.includes('The price appears to be significantly higher than usual.')
            && text.includes(parsed.sellerCompany) && text.includes(parsed.resourceName)
            && text.includes(String(parsed.quantity)) && buttons.length === 1) {
          return { container: node, button: buttons[0] };
        }
        node = node.parentElement;
      }
      return null;
    }).filter(Boolean);
    return containers.length === 1 ? containers[0] : null;
  }, 3000);
  if (!modal) {
    return { ok: false, accepted: false, status: 'AMBIGUOUS', mutationAuthorized: true,
      mutationAttempted: true, ambiguous: true, doNotRetry: true, clickCount,
      contractId, reason: 'confirmation modal identity was not exactly proven after the first click' };
  }
  modal.button.click();
  clickCount += 1;
}

const exactRowAbsent = !!(await waitFor(() => renderedRows()
  .every(candidate => candidate.binding?.contractId !== contractId), 12000));
if (!exactRowAbsent) {
  return { ok: false, accepted: false, status: 'AMBIGUOUS', mutationAuthorized: true,
    mutationAttempted: true, ambiguous: true, doNotRetry: true, clickCount,
    contractId, exactRowAbsent: false,
    reason: 'acceptance click occurred but the exact contract transition was not proven' };
}
return {
  ok: true,
  accepted: true,
  status: 'VERIFIED',
  mutationAuthorized: true,
  mutationAttempted: true,
  doNotRetry: true,
  clickCount,
  contractId,
  termsHash,
  evidenceFingerprint,
  exactRowAbsent: true,
  postconditionSource: 'exact React-bound contract ID removed by the measured sign-success reducer',
};
