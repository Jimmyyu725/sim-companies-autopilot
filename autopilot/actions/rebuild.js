// Rebuild one idle level-1 abundance building through the rendered UI.
// Params from window.__rebuild = { buildingId, confirm, beforeBuilding, idleEvidence }.
//
// Sim Companies skips its confirmation dialog when every abundance is <=80%. A dry preview must
// therefore never click the REBUILD opener: merely opening it can be the irreversible commit.
const { buildingId, confirm, beforeBuilding, idleEvidence } = window.__rebuild || {};
const canon = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const allowed = new Set(['QUARRY', 'MINE', 'OIL RIG']);
const beforeName = canon(beforeBuilding?.name);
if (!beforeBuilding || Number(beforeBuilding.id) !== Number(buildingId)) {
  return { ok: false, reason: 'authoritative pre-rebuild target is unavailable', buildingId };
}
if (!allowed.has(beforeName)) {
  return { ok: false, reason: 'REBUILD is limited to Quarry, Mine, or Oil rig', buildingId };
}
if (Number(beforeBuilding.size) !== 1) {
  return { ok: false, reason: 'REBUILD is limited to a level-1 abundance building', buildingId };
}
const evidenceAgeMs = Date.now() - Date.parse(idleEvidence?.observedAt);
const evidenceBound = idleEvidence?.status === 'validated' &&
  Number(idleEvidence?.buildingId) === Number(buildingId) &&
  canon(idleEvidence?.buildingName) === beforeName &&
  Number(idleEvidence?.level) === Number(beforeBuilding.size) &&
  Number.isFinite(evidenceAgeMs) && evidenceAgeMs >= -10000 && evidenceAgeMs <= 60000;
const apiIdle = idleEvidence?.source === 'authoritative-api' &&
  Object.prototype.hasOwnProperty.call(beforeBuilding, 'busy') && beforeBuilding.busy === null;
const pageIdle = idleEvidence?.source === 'page-derived' &&
  !Object.prototype.hasOwnProperty.call(beforeBuilding, 'busy') &&
  idleEvidence.path === `/b/${Number(buildingId)}/` &&
  idleEvidence.construction === false && idleEvidence.orderBusy === false &&
  idleEvidence.collectible === false && idleEvidence.orderAvailable === true &&
  idleEvidence.rebuildOpenerCount === 1 && idleEvidence.rebuildOpenerEnabled === true;
if (!evidenceBound || (!apiIdle && !pageIdle)) {
  return { ok: false, reason: 'building does not have fresh exact idle evidence', buildingId };
}
if (!new RegExp(`/b/${Number(buildingId)}/?$`).test(location.pathname)) {
  return { ok: false, reason: 'browser is not on the exact rebuild target', buildingId };
}

const openers = all('button').filter(button => button.offsetParent !== null &&
  /^REBUILD$/i.test(norm(button.innerText)));
if (openers.length !== 1) {
  return { ok: false, reason: 'visible REBUILD opener is not unique', count: openers.length };
}
const opener = openers[0];
if (opener.disabled) return { ok: false, reason: 'REBUILD button is disabled' };

const body = norm(document.body.innerText);
const abundanceValues = [...body.matchAll(/Abundance:\s*([\d.]+)%/gi)]
  .map(match => Number(match[1]))
  .filter(value => Number.isFinite(value) && value >= 0 && value <= 100);
if (abundanceValues.length === 0) {
  return { ok: false, reason: 'could not read any live abundance values; refusing REBUILD' };
}
const directCommit = abundanceValues.every(value => value <= 80);
const preview = {
  buildingId: Number(buildingId),
  building: beforeBuilding.name,
  level: Number(beforeBuilding.size),
  abundanceValues,
  confirmationMode: directCommit ? 'direct-on-opener' : 'dialog',
};
if (confirm !== true) {
  return {
    ok: true,
    dry: true,
    preview: true,
    note: 'dry run — REBUILD opener was not clicked',
    ...preview,
  };
}

opener.click();
await sleep(3000);
if (directCommit) {
  return {
    ok: false,
    commitClicked: true,
    verificationPending: true,
    mutationAttempted: true,
    verified: false,
    doNotRetry: true,
    reason: 'direct REBUILD opener was clicked; act.js must verify reconstruction',
    ...preview,
  };
}

const dialogs = all('[role=dialog], [class*=odal], [class*=verlay]').filter(dialog =>
  dialog.offsetParent !== null && /\brebuild\b/i.test(norm(dialog.innerText)));
const innermostDialogs = dialogs.filter(dialog =>
  !dialogs.some(other => other !== dialog && dialog.contains(other)));
if (innermostDialogs.length !== 1) {
  // A live threshold/render race could have taken the direct path despite the displayed values.
  // Treat the opener click as potentially mutating and require authoritative tail verification.
  return {
    ok: false,
    commitClicked: true,
    verificationPending: true,
    mutationAttempted: true,
    verified: false,
    doNotRetry: true,
    reason: 'REBUILD opener was clicked but a unique confirmation dialog was not observed',
    dialogCount: innermostDialogs.length,
    ...preview,
  };
}
const dialog = innermostDialogs[0];
const confirms = all('button', dialog).filter(button => button.offsetParent !== null &&
  !button.disabled && /^REBUILD$/i.test(norm(button.innerText)) && button !== opener);
if (confirms.length !== 1) {
  const cancel = all('button', dialog).find(button =>
    /changed my mind|cancel|^back$/i.test(norm(button.innerText)));
  if (cancel) cancel.click();
  return {
    ok: false,
    reason: 'REBUILD confirmation is ambiguous; no mutation was attempted',
    confirmCount: confirms.length,
    ...preview,
  };
}
confirms[0].click();
await sleep(3000);
return {
  ok: false,
  commitClicked: true,
  verificationPending: true,
  mutationAttempted: true,
  verified: false,
  doNotRetry: true,
  reason: 'REBUILD confirmation was clicked; act.js must verify reconstruction',
  ...preview,
};
