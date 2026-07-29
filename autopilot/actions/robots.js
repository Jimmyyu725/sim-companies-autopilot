// Install robots on the currently-open building (/b/<id>/ — caller navigates).
// Params: window.__robots = { specialization, confirm, buyMissing }.
// Self-gating (scrap.js pattern, DOM mapped by board/.probe-robots.md):
//   - no confirm  -> open the dialog, parse cost/needs/savings/options, close via
//                    "I changed my mind", return the numbers. Nothing is clicked that spends.
//   - confirm:true -> requires `specialization` (resource name matching a tile); clicks the tile,
//                    then the modal's OWN "Install robots" btn-primary (page opener excluded by
//                    identity — it stays in the DOM, same trap as scrap.js). Refuses if ambiguous.
//   - buyMissing:true (separate explicit flag) -> clicks "Buy missing" FIRST (spends money on
//                    exchange robots) before the install. Never clicked otherwise.
// Facts (probe): robots = 3% WAGE reduction only (no production bonus); locks the building to one
// product; blocks upgrade/downgrade; uninstall refunds 50% of robots at Q0; install downtime =
// size × buildDuration. Judge ROI before confirming (BRAIN.md discipline).
const {
  buildingId,
  specialization,
  specializationKind,
  confirm,
  buyMissing,
  maxCost,
  minCashAfter,
  cash: cashSnapshot,
} = window.__robots || {};
const CANCEL = /changed my mind/i;
const closeDlg = (dlg) => {
  const c = all('button', dlg || document).find(b => CANCEL.test(norm(b.innerText)));
  if (c) c.click();
};

if (all('button').some(b => b.offsetParent !== null && /UNINSTALL ROBOTS/i.test(norm(b.innerText))))
  return { ok: false, reason: 'robots already installed on this building (Uninstall button present)' };
const opener = all('button').find(b =>
  b.offsetParent !== null && /INSTALL ROBOTS/i.test(norm(b.innerText)) && !/UNINSTALL/i.test(norm(b.innerText)));
if (!opener) return { ok: false, reason: 'no Install robots button (not owned / not a production building?)',
                      buttons: all('button').map(x => norm(x.innerText)).filter(Boolean).slice(0, 15) };
opener.click();          // state-only: opens the modal (probe: safe)
await sleep(3500);

const dlg = all('[role=dialog], [class*=odal], [class*=verlay]')
  .filter(m => /Install robots/i.test(m.innerText))
  .sort((a, b) => a.innerText.length - b.innerText.length)[0];
if (!dlg) return { ok: false, reason: 'robots dialog did not open' };
const text = norm(dlg.innerText);
const busy = /currently busy and cannot be upgraded/i.test(text);

// Parse the requirements block (probe §"Measured dialog numbers" shape).
const info = {
  needed: (text.match(/x\s*([\d,]+)\s*Robots/i) || [])[1] || null,
  quality: (text.match(/Robots\s*Q(\d+)\+/i) || [])[1] || null,
  unitPrice: (text.match(/@\s*\$([\d,.]+)/) || [])[1] || null,
  exchangeCost: (text.match(/Exchange purchase cost\s*\$([\d,.]+)/i) || [])[1] || null,
  warehouseCost: (text.match(/warehouse resources\s*\$([\d,.]+)/i) || [])[1] || null,
  wageSavingPct: (text.match(/reduced by\s*(\d+)\s*%/i) || [])[1] || '3',
  dollars: (text.match(/\$[\d,.]+/g) || []).slice(0, 8),
  busy,
};
const exchangeCostText = info.exchangeCost == null ? '' : String(info.exchangeCost).trim();
const parsedExchangeCost = exchangeCostText === ''
  ? null
  : Number(exchangeCostText.replace(/,/g, ''));
// A visible BUY MISSING action must have a positive, explicitly parsed exchange cost. An absent
// cost used to become Number('') === 0 and could incorrectly satisfy the cash guard.
const exchangeCostNumber = Number.isFinite(parsedExchangeCost) && parsedExchangeCost > 0
  ? parsedExchangeCost
  : null;
info.exchangeCostNumber = exchangeCostNumber;
// Specialization tiles: innermost img+span divs inside the dialog (probe §DOM 4).
const tileCands = all('div', dlg).filter(d =>
  d.offsetParent !== null && d.querySelector('img') && d.querySelector('span') &&
  norm(d.innerText).length >= 3 && norm(d.innerText).length <= 30 && !all('button', d).length);
const tiles = tileCands.filter(c => !tileCands.some(o => o !== c && c.contains(o)));
info.specializations = tiles.map(x => norm(x.innerText)).slice(0, 25);

if (confirm !== true) { closeDlg(dlg); return { ok: true, dry: true, ...info,
  note: 'dry read — pass confirm:true + specialization (one of specializations) to install' }; }

// ---- confirm path ----
if (busy) { closeDlg(dlg); return { ok: false, reason: 'building busy — install footer absent; retry when idle', ...info }; }
if (!specialization) { closeDlg(dlg); return { ok: false, reason: 'confirm requires specialization (resource name)', specializations: info.specializations }; }
const want = norm(String(specialization)).toLowerCase();
const tileHits = tiles.filter(x => norm(x.innerText).toLowerCase() === want);
if (tileHits.length !== 1) { closeDlg(dlg); return { ok: false,
  reason: 'specialization tile match != 1 — refusing', want, specializations: info.specializations }; }
tileHits[0].click();     // plain React onClick prop (probe §DOM 4)
await sleep(1500);
if (/Please select specialization resource/i.test(norm(dlg.innerText))) {
  closeDlg(dlg);
  return { ok: false, reason: 'tile click did not register (React ignored it) — needs a real-mouse driver; refusing', want };
}

// Footer buttons (probe §DOM 5): "Buy missing" (SPENDS) and "Install robots" (FINAL commit).
const buyButtons = all('button', dlg).filter(b => b.offsetParent !== null
  && /^BUY MISSING$/i.test(norm(b.innerText)));
const buyBtn = buyButtons.length === 1 ? buyButtons[0] : null;
if (buyMissing === true) {
  if (buyButtons.length !== 1) { closeDlg(dlg); return { ok: false,
    reason: 'buyMissing requested but the visible Buy missing button is not unique',
    count: buyButtons.length, ...info }; }
  if (typeof window.__evaluateSpendGuard !== 'function') { closeDlg(dlg); return { ok: false,
    reason: 'robot live spend guard is unavailable', ...info }; }
  const cash = cashSnapshot?.value == null ? NaN : Number(cashSnapshot.value);
  const spend = window.__evaluateSpendGuard(
    exchangeCostNumber,
    maxCost,
    cash,
    minCashAfter,
  );
  if (!spend.ok) { closeDlg(dlg); return { ok: false, guard: true,
    reason: `robot BUY MISSING refused: ${spend.reason}`, cash: Number.isFinite(cash) ? cash : null,
    maxCost, minCashAfter, ...info }; }
  const buyDisabled = buyBtn.disabled
    || String(buyBtn.getAttribute('aria-disabled')).toLowerCase() === 'true'
    || /(^|\s)disabled(\s|$)/i.test(String(buyBtn.className || ''))
    || getComputedStyle(buyBtn).pointerEvents === 'none';
  if (buyDisabled) { closeDlg(dlg); return { ok: false,
    reason: 'buyMissing requested but Buy missing is disabled', ...info }; }
  buyBtn.click();
  await sleep(4000);
}
const installs = all('button', dlg).filter(b =>
  b !== opener && b.offsetParent !== null && /^INSTALL ROBOTS$/i.test(norm(b.innerText)));
if (installs.length !== 1) { closeDlg(dlg); return { ok: false,
  reason: 'modal Install robots confirm count != 1 — refusing', count: installs.length,
  sawButtons: all('button', dlg).map(b => ({ t: norm(b.innerText), dis: b.disabled })) }; }
const installDisabled = installs[0].disabled
  || String(installs[0].getAttribute('aria-disabled')).toLowerCase() === 'true'
  || /(^|\s)disabled(\s|$)/i.test(String(installs[0].className || ''))
  || getComputedStyle(installs[0]).pointerEvents === 'none';
if (installDisabled) { closeDlg(dlg); return { ok: false,
  mutationAttempted: buyMissing === true, doNotRetry: buyMissing === true,
  reason: 'Install robots confirm is DISABLED (missing robots in warehouse? pass buyMissing:true to buy first — it spends money)', ...info }; }
installs[0].click();     // native click (React)
await sleep(2500);
const after = norm(document.body.innerText);
return { ok: false, commitClicked: true, verificationPending: true,
         installed: false, verified: false, mutationAttempted: true,
         doNotRetry: true, buildingId, specialization: want, specializationKind, ...info,
         installing: /Installing robots/i.test(after) || undefined,
         after: after.slice(0, 160),
         reason: 'Install robots was clicked; act.js must capture the authoritative buildings payload before reporting success' };
