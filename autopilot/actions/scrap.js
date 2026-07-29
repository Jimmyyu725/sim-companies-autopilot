// Scrap the currently-open building. Must be on the building's /b/<id>/ page.
// Params: window.__scrap = { confirm }. Without confirm:true it's a dry run (reads the
// recovery, cancels). Returns the materials recovered so the caller can verify they landed.
const { buildingId, confirm, beforeBuildings } = window.__scrap || {};
const scrapOpeners = all('button').filter(b => b.offsetParent !== null
  && /^SCRAP$/i.test(norm(b.innerText)));
if (scrapOpeners.length !== 1) return { ok: false,
  reason: 'visible SCRAP opener is not unique; refusing irreversible action',
  count: scrapOpeners.length };
const scrapBtn = scrapOpeners[0];
if (confirm === true && (!Array.isArray(beforeBuildings)
    || !beforeBuildings.some(b => Number(b.id) === Number(buildingId)))) {
  return { ok: false, reason: 'could not prove the exact target building exists before scrap',
    buildingId };
}
scrapBtn.click();
await sleep(3000);

const dialogs = all('[role=dialog], [class*=odal], [class*=verlay]').filter(d =>
  d.offsetParent !== null && /scrap|scrapped recovering|cannot be scrapped/i.test(norm(d.innerText)));
const innermostDialogs = dialogs.filter(d => !dialogs.some(other => other !== d && d.contains(other)));
if (innermostDialogs.length !== 1) return { ok: false,
  reason: 'scrap confirmation dialog is not unique; refusing irreversible action',
  count: innermostDialogs.length };
const dlg = innermostDialogs[0];
const body = norm(dlg.innerText);
if (/currently busy and cannot be scrapped/i.test(body)) {
  const cancel = all('button', dlg).find(b => /changed my mind/i.test(norm(b.innerText)));
  if (cancel) cancel.click();
  return { ok: false, reason: 'building busy — cannot scrap' };
}
const recovering = (body.match(/scrapped recovering:\s*([\dx\s]+)/i) || [])[1] || '';

if (confirm !== true) {
  const cancel = all('button', dlg).find(b => /changed my mind/i.test(norm(b.innerText)));
  if (cancel) cancel.click();
  return {
    ok: true,
    dry: true,
    preview: true,
    note: 'dry run — not confirmed',
    buildingId,
    recovering,
  };
}

// Confirm the scrap. The page's top-row SCRAP button OPENS this dialog; the dialog's own
// confirm is a DIFFERENT button that only renders when the building is idle. Identify it
// precisely: a visible button inside the scrap modal that is NOT one of the always-present
// building actions and NOT the cancel. To avoid ever clicking the wrong control on an
// irreversible action, require an explicit confirm-looking label and refuse otherwise.
const CANCEL = /changed my mind/i;
const BUILDING_ACTIONS = /^(RENAME|UPGRADE|DOWNGRADE|REPOSITION|SEND TO AUCTION|CANCEL SELLING|ALL|MAX|SELL|PRODUCE)$/i;
const candidates = all('button', dlg).filter(b => {
  const t = norm(b.innerText);
  return b.offsetParent !== null && t && !CANCEL.test(t) && !BUILDING_ACTIONS.test(t);
});
// The confirm button inside the dialog is typically labelled exactly "SCRAP" but is a
// SECOND SCRAP button (the modal's), distinct from the page action that opened it. Measured
// 2026-07-23 on store#2's dialog: the page's top-row SCRAP button STAYS in the DOM (visible)
// while the modal is open, so a bare /^SCRAP$/ match finds TWO buttons and the old code
// refused every scrap as "ambiguous". The one we must NOT click is exactly `scrapBtn` — the
// page action we clicked at the top to open the dialog — so exclude it by identity; the modal
// confirm is the remaining SCRAP. If the count is still not 1, refuse rather than guess.
const scrapConfirms = candidates.filter(b => /^SCRAP$/i.test(norm(b.innerText)) && b !== scrapBtn);
const fallbackConfirms = candidates.filter(b =>
  /^(CONFIRM|I UNDERSTAND|SCRAP BUILDING)$/i.test(norm(b.innerText)));
const go = scrapConfirms.length === 1 && fallbackConfirms.length === 0 ? scrapConfirms[0]
  : (scrapConfirms.length === 0 && fallbackConfirms.length === 1 ? fallbackConfirms[0] : null);
if (!go) {
  const cancel = all('button', dlg).find(b => CANCEL.test(norm(b.innerText)));
  if (cancel) cancel.click();
  return { ok: false, reason: 'confirm button ambiguous — refusing irreversible scrap',
           recovering, sawButtons: candidates.map(b => norm(b.innerText)) };
}
// Native .click() — React ignores synthetic MouseEvents here (same lesson as the chat
// paper-plane button, see scan-rooms.js). The caller must still verify the building is
// gone via the buildings API; a click that lands on a re-rendered dialog can be a no-op.
go.click();
await sleep(2500);
return { ok: false, commitClicked: true, verificationPending: true,
  mutationAttempted: true, verified: false, doNotRetry: true, buildingId, recovering,
  reason: 'SCRAP was clicked; act.js must capture the authoritative buildings payload before reporting success',
  after: norm(document.body.innerText).slice(0, 150) };
