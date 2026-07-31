'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('Personal Assistant reply is dispatched at most once and ambiguous completion is not retryable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', 'pa-reply.js'), 'utf8');
  assert.equal((source.match(/hits\[0\]\.click\(\)/g) || []).length, 1,
    'the selected reply must be clicked exactly once');
  assert.doesNotMatch(source, /dispatchEvent\s*\(/);
  assert.match(source, /doNotRetry:\s*!verified/);
  assert.match(source, /UNKNOWN_AFTER_SINGLE_CLICK/);
});

test('read-only lists do not turn failed APIs into authoritative empty arrays', () => {
  const contracts = fs.readFileSync(path.join(__dirname, '..', 'actions', 'contract-accept.js'), 'utf8');
  const auctions = fs.readFileSync(path.join(__dirname, '..', 'actions', 'auction.js'), 'utf8');
  assert.match(contracts, /r\.status\s*!==\s*200\s*\|\|\s*!Array\.isArray\(r\.json\?\.incomingContracts\)/);
  assert.match(contracts, /incoming:\s*'UNKNOWN'/);
  assert.doesNotMatch(contracts, /incomingContracts\)\s*\|\|\s*\[\]/);
  assert.match(auctions, /live\.status\s*!==\s*200\s*\|\|\s*!Array\.isArray\(live\.json\?\.buildingAuctions\)/);
  assert.match(auctions, /auctions:\s*'UNKNOWN'/);
  assert.doesNotMatch(auctions, /buildingAuctions\)\s*\|\|\s*\[\]/);
});

test('exchange BUY binds the dynamic price label to the exact quantity form', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', 'buy.js'), 'utf8');
  assert.match(source, /qtyInput\.closest\('form'\)/);
  assert.match(source, /all\('button', buyForm\)/);
  assert.match(source, /\^BUY\(\?:\\s\|\$\)/);
  assert.doesNotMatch(source, /\^BUY\$\/i/);
});

test('rebuild dry preview never clicks a UI control and confirmation clicks at most twice', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', 'rebuild.js'), 'utf8');
  const previewBranch = source.slice(source.indexOf('if (confirm !== true)'), source.indexOf('opener.click()'));
  assert.doesNotMatch(previewBranch, /\.click\s*\(/);
  assert.equal((source.match(/opener\.click\(\)/g) || []).length, 1);
  assert.equal((source.match(/confirms\[0\]\.click\(\)/g) || []).length, 1);
  assert.match(source, /every\(value => value <= 80\)/);
  assert.match(source, /doNotRetry:\s*true/);
});

test('build candidate preview reports affordability before enforcing confirmation spend caps', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', 'build.js'), 'utf8');
  const preview = source.indexOf('if (confirm !== true) return {');
  const maxCostGuard = source.indexOf('if (quoted > maxCost)');
  const reserveGuard = source.indexOf('if (money - cashNeeded < minCashAfter)');
  assert(preview >= 0);
  assert(maxCostGuard > preview);
  assert(reserveGuard > preview);
  assert.match(source.slice(preview, maxCostGuard), /affordability:[\s\S]*withinMaxCost/);
  assert.match(source.slice(preview, maxCostGuard), /reserveSatisfied/);
});

test('build confirmation binds the current full-page construction panel without spending globally', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'actions', 'build.js'), 'utf8');
  assert.match(source, /\/landscape\/buildings\/<kind>\//);
  assert.match(source, /const constructionScopes/);
  assert.match(source, /hasBuyMissing \|\| text\.includes\('REQUIRED MATERIALS'\)/);
  assert.match(source, /exactBuildButtons\.length !== 1 \|\| innermostScopes\.length !== 1/);
  const safeFailure = source.indexOf('safeToRetry: true');
  const firstPersistentSpend = source.indexOf('priced[0].b.click()');
  assert(safeFailure >= 0 && firstPersistentSpend > safeFailure,
    'only the pre-spend scope failure may advertise a safe retry');
  assert.match(source.slice(safeFailure - 300, safeFailure + 300), /mutationAttempted: false/);
});

test('confirmed rebuild refreshes authenticated Prospector evidence before claiming or clicking', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'act.js'), 'utf8');
  const start = source.indexOf("} else if (action === 'rebuild')");
  const end = source.indexOf("} else if (action === 'exchange_sell')", start);
  assert(start >= 0 && end > start);
  const branch = source.slice(start, end);
  const freshEvidence = branch.indexOf('await captureOwnerProspectorOverview()');
  const oneUseClaim = branch.indexOf('refreshAndClaimOwnerProspectorRebuildAttempt(');
  const pageAction = branch.indexOf('window.__rebuild');
  assert(freshEvidence >= 0);
  assert(oneUseClaim > freshEvidence);
  assert(pageAction > oneUseClaim);
  assert.match(source, /api\(\$\{JSON\.stringify\(PROSPECTOR_OVERVIEW_PATH\)\}\)/);
  assert.match(branch, /source:\s*'authoritative-buildings-capture'/);
  assert.match(branch, /buildings:\s*beforeBuildings/);
  assert.match(branch, /idleEvidence:\s*idle\.evidence/);
});

test('both brain engines prioritize the exact owner Prospector rebuild over another bridge', () => {
  for (const filename of ['brain.js', 'brain56.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    assert.match(source, /isOwnerAuthorizedProspectorRebuild\(/, filename);
    assert.match(source, /action === 'produce' && ownerProspectorEligible/, filename);
    assert.match(source, /priority over another production bridge/, filename);
    assert.match(source, /ownerDirectivePriority:\s*true/, filename);
    assert.match(source, /councilRequired:\s*false/, filename);
    assert.match(source, /requiredNextAction:[\s\S]{0,180}confirm:\s*true/, filename);
    assert.match(source,
      /councilRequiredForStructuralAction\([\s\S]{0,180}ownerDirectiveForAction/, filename);
  }
});
