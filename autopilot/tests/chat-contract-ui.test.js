'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { contractTermsHash } = require('../chat/contract-gate');
const {
  ACCEPTANCE_DOM_STATUS,
  assessAcceptClickOutcome,
  buildIncomingContractPreview,
  expectedBundleTotal,
  normalizeIncomingRowEvidence,
  normalizeIncomingRows,
  parseIncomingContractAriaLabel,
  parseIncomingContractsRoute,
  validateAcceptanceBinding,
} = require('../chat/contract-ui');

const actionsDir = path.join(__dirname, '..', 'actions');
const actionFiles = [
  'chat-contract-list.js',
  'chat-contract-preview.js',
  'chat-contract-accept.js',
];

const terms = {
  counterpartyCompanyId: '7812345',
  ourSide: 'buy',
  quality: 0,
  quantity: 250,
  resourceKind: 2,
  unitPrice: '0.376',
};
const termsHash = contractTermsHash(terms);
const explicitRow = {
  ariaLabel: 'incoming contract, 250 Water quality 0, at $0.376 per unit, total price $94, from Seller Inc',
  groupedCount: 1,
  contractId: '99112233',
  contractIdStatus: 'EXPLICIT_DOM_ATTRIBUTE',
  resourceKind: 2,
  resourceKindStatus: 'EXPLICIT_DOM_ATTRIBUTE',
  counterpartyCompanyId: '7812345',
  counterpartyCompanyIdStatus: 'EXPLICIT_DOM_ATTRIBUTE',
  acceptControlCount: 1,
  acceptControlAriaLabel: 'Sign contract',
  needsConfirmation: false,
  resourceImageSrc: 'https://example.invalid/water.hash.png',
  counterpartyHref: '/company/0/Seller-Inc/',
};

test('route parser accepts only the measured incoming-contracts route shape', () => {
  assert.deepEqual(parseIncomingContractsRoute(
    'https://www.simcompanies.com/headquarters/warehouse/incoming-contracts/'), {
    locale: 'en',
    pathname: '/headquarters/warehouse/incoming-contracts/',
    canonicalPath: '/headquarters/warehouse/incoming-contracts/',
  });
  assert.deepEqual(parseIncomingContractsRoute(
    'https://www.simcompanies.com/zh-cn/headquarters/warehouse/incoming-contracts/').locale, 'zh-cn');
  assert.equal(parseIncomingContractsRoute(
    'https://www.simcompanies.com/headquarters/'), null);
});

test('English aria parser preserves precise terms and verifies the measured total formula', () => {
  const parsed = parseIncomingContractAriaLabel(explicitRow.ariaLabel);
  assert.deepEqual(parsed, {
    ok: true,
    ariaLabel: explicitRow.ariaLabel,
    quantity: 250,
    resourceName: 'Water',
    quality: 0,
    unitPrice: '0.376',
    totalPrice: 94,
    sellerCompany: 'Seller Inc',
  });
  assert.equal(expectedBundleTotal(250, '0.376'), 94);
  assert.equal(expectedBundleTotal(1, '1.0009'), 1,
    'bundle truncates to three decimals before ceiling the displayed total');
  assert.equal(parseIncomingContractAriaLabel(
    explicitRow.ariaLabel.replace('$94', '$95')).ok, false);
  assert.equal(parseIncomingContractAriaLabel(
    'contrat entrant, 250 Eau qualité 0, à $0.376').unsupported, true);
});

test('rendered evidence never invents absent IDs or the current-company name', () => {
  const noIds = normalizeIncomingRowEvidence({
    ariaLabel: explicitRow.ariaLabel,
    groupedCount: 1,
    acceptControlCount: 1,
    acceptControlAriaLabel: 'Sign contract',
  });
  assert.equal(noIds.ok, true);
  assert.equal(noIds.row.contractId, null);
  assert.equal(noIds.row.contractIdStatus, 'UNAVAILABLE_IN_RENDERED_DOM');
  assert.equal(noIds.row.resourceKind, null);
  assert.equal(noIds.row.sellerCompanyId, null);
  assert.equal(noIds.row.buyerCompany, null);
  assert.match(noIds.row.evidenceFingerprint, /^[0-9a-f]{64}$/);
});

test('exact preview fails closed when the current rendered rows expose no contract ID', () => {
  const result = buildIncomingContractPreview({
    contractId: '99112233',
    ownCompany: 'Our Company',
    termsHash,
    rows: [{
      ariaLabel: explicitRow.ariaLabel,
      groupedCount: 1,
      acceptControlCount: 1,
      acceptControlAriaLabel: 'Sign contract',
    }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.doNotClick, true);
  assert.equal(result.contractIdStatus, 'UNAVAILABLE_IN_RENDERED_DOM');
});

test('duplicate explicit IDs and grouped contracts are rejected as ambiguous', () => {
  assert.equal(normalizeIncomingRows([explicitRow, explicitRow], {
    ownCompany: 'Our Company',
  }).ok, false);
  const grouped = buildIncomingContractPreview({
    contractId: '99112233',
    ownCompany: 'Our Company',
    termsHash,
    rows: [{ ...explicitRow, groupedCount: 2 }],
  });
  assert.equal(grouped.ok, false);
  assert.match(grouped.reason, /grouped multiple contracts/u);
});

test('a hypothetical explicit-ID preview binds every term and remains read-only', () => {
  const result = buildIncomingContractPreview({
    contractId: '99112233',
    ownCompany: 'Our Company',
    termsHash,
    rows: [explicitRow],
    observedAt: '2026-07-27T05:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.doNotClick, true);
  assert.equal(result.preview.confirm, false);
  assert.equal(result.preview.contractId, '99112233');
  assert.deepEqual(result.preview.terms, terms);
  assert.equal(result.preview.termsHash, termsHash);
  assert.match(result.preview.evidenceFingerprint, /^[0-9a-f]{64}$/);
  assert.match(result.preview.previewId, /^[0-9a-f]{64}$/);
});

test('preview rejects a valid-looking terms hash that is not tied to the rendered terms', () => {
  const differentTermsHash = contractTermsHash({ ...terms, quantity: 251 });
  const result = buildIncomingContractPreview({
    contractId: '99112233',
    ownCompany: 'Our Company',
    termsHash: differentTermsHash,
    rows: [explicitRow],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not bound to the exact rendered contract terms/u);
});

test('accept binding validates gate authorization and evidence, then stays disabled', () => {
  const previewResult = buildIncomingContractPreview({
    contractId: '99112233',
    ownCompany: 'Our Company',
    termsHash,
    rows: [explicitRow],
    observedAt: '2026-07-27T05:00:00.000Z',
  });
  const preview = previewResult.preview;
  const authorization = {
    previewId: preview.previewId,
    termsHash,
    idempotencyKey: 'a'.repeat(64),
    maxClicks: 1,
    retryAfterAmbiguous: false,
    expiresAt: '2026-07-27T05:10:00.000Z',
  };
  const result = validateAcceptanceBinding({
    confirm: true,
    contractId: '99112233',
    termsHash,
    evidenceFingerprint: preview.evidenceFingerprint,
    preview,
    authorization,
    currentRow: explicitRow,
    now: Date.parse('2026-07-27T05:05:00.000Z'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.doNotClick, true);
  assert.equal(result.acceptanceDomStatus, ACCEPTANCE_DOM_STATUS);
  assert.match(result.reason, /acceptance remains disabled/u);

  const changed = validateAcceptanceBinding({
    confirm: true,
    contractId: '99112233',
    termsHash,
    evidenceFingerprint: 'b'.repeat(64),
    preview,
    authorization,
    currentRow: explicitRow,
    now: Date.parse('2026-07-27T05:05:00.000Z'),
  });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /changed after preview/u);
});

test('accept outcome requires one click plus one exact disappearance and acknowledgement', () => {
  assert.deepEqual(assessAcceptClickOutcome({
    contractId: '99112233',
    clickCount: 1,
    beforeFingerprint: 'c'.repeat(64),
    afterContractIds: ['88112233'],
    successAcknowledgementCount: 1,
  }), {
    ok: true,
    clicked: true,
    doNotRetry: true,
    status: 'accepted-verified',
  });
  const ambiguous = assessAcceptClickOutcome({
    contractId: '99112233',
    clickCount: 1,
    beforeFingerprint: 'c'.repeat(64),
    afterContractIds: ['99112233'],
    successAcknowledgementCount: 0,
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.doNotRetry, true);
  const violation = assessAcceptClickOutcome({
    contractId: '99112233',
    clickCount: 2,
    beforeFingerprint: 'c'.repeat(64),
    afterContractIds: [],
    successAcknowledgementCount: 1,
  });
  assert.equal(violation.status, 'protocol-violation');
});

test('contract UI fragments compile, avoid direct APIs, and constrain React identity to exact rows', () => {
  for (const filename of actionFiles) {
    const source = fs.readFileSync(path.join(actionsDir, filename), 'utf8');
    assert.doesNotThrow(() => new Function(
      'window', 'document', 'location',
      `return (async () => { ${source}\n })();`,
    ), filename);
    assert.doesNotMatch(source,
      /fetch\s*\(|XMLHttpRequest|\/api\/|\bapi\s*\(|\.post\s*\(|\.patch\s*\(|\.delete\s*\(/u,
      filename);
    assert.match(source, /__reactFiber\$/u, filename);
    assert.match(source, /VERIFIED_REACT_RENDER_BINDING/u, filename);
    assert.match(source, /aria-label/u, filename);
    assert.doesNotMatch(source, /__react(?:Props|EventHandlers|InternalInstance)/u, filename);
  }
});

test('list and preview are zero-click, while accept uses the bounded verified UI path', () => {
  for (const filename of ['chat-contract-list.js', 'chat-contract-preview.js']) {
    const source = fs.readFileSync(path.join(actionsDir, filename), 'utf8');
    assert.equal((source.match(/\.click\s*\(/gu) || []).length, 0, filename);
  }
  const accept = fs.readFileSync(path.join(actionsDir, 'chat-contract-accept.js'), 'utf8');
  assert.equal((accept.match(/\.click\s*\(/gu) || []).length, 2);
  assert.match(accept, /\[1, 2\]\.includes\(authorization\.maxClicks\)/u);
  assert.match(accept, /expectedClicks = binding\.needsConfirmation \? 2 : 1/u);
  assert.match(accept, /retryAfterAmbiguous !== false/u);
  assert.match(accept, /evidenceFingerprint/u);
  assert.match(accept, /termsHash/u);
  assert.match(accept, /exactRowAbsent/u);
  assert.match(accept, /doNotRetry: true/u);
});

test('existing warehouse sender remains the only contract-send path', () => {
  const sender = fs.readFileSync(path.join(actionsDir, 'contract-send.js'), 'utf8');
  assert.match(sender, /input\[name=recipientLookup\]/u);
  assert.match(sender, /final\.click\(\)/u);
  for (const filename of actionFiles) {
    const source = fs.readFileSync(path.join(actionsDir, filename), 'utf8');
    assert.doesNotMatch(source, /recipientLookup|SEND CONTRACT|final\.click/u, filename);
  }
});
