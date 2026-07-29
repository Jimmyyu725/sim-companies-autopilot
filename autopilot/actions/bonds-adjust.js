// Adjust issued bonds on /headquarters/finance/ (issue, raise, lower = repay).
// Params: window.__bonds = { amount, interest, confirm }. Without confirm:true it DRY-reads the
// current form and returns it untouched. Self-gating like scrap.js: if the form can't be located
// unambiguously, refuse rather than click blind. Funding is ASYNC — players buy the listed bonds
// over time; listing is not cash-in-hand.
const { amount, interest, confirm } = window.__bonds || {};
const txt = document.body.innerText;
if (!/Adjust issued bonds/i.test(txt)) return { ok: false, reason: 'not on the finance page (no Adjust issued bonds section)' };

// The adjust row holds two numeric inputs (cash amount, interest %) and an UPDATE button.
const section = all('div').filter(d => d.offsetParent !== null
  && /Adjust issued bonds/i.test(d.innerText) && d.querySelectorAll('input').length >= 2)
  .sort((a, b) => a.innerText.length - b.innerText.length)[0];
if (!section) return { ok: false, reason: 'adjust section with inputs not found' };
const inputs = all('input', section).filter(i => i.offsetParent !== null && i.type !== 'checkbox');
const updateButtons = all('button', section).filter(b => b.offsetParent !== null
  && /^UPDATE$/i.test(norm(b.innerText)));
const btn = updateButtons.length === 1 ? updateButtons[0] : null;
if (inputs.length !== 2 || updateButtons.length !== 1) {
  return { ok: false, reason: 'finance form is ambiguous; refusing to infer input/button identity',
    inputCount: inputs.length, updateButtonCount: updateButtons.length };
}
const inputNumber = (input) => {
  if (!input) return null;
  const raw = String(input.value ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const current = { unsoldOfferAmountDollars: inputNumber(inputs[0]),
  offerInterestPctPerDay: inputNumber(inputs[1]),
  rating: (txt.match(/Rating\s*([A-Z][+-]?)/) || [])[1] || null,
  representsOutstandingDebt: false,
  outstandingPrincipalSource: 'refresh_state.bonds.principalOutstanding',
  soldRecords: /Bonds sold[\s\S]{0,80}\(none\)/i.test(txt) ? 'none yet' : 'some sold — read /api/v2/companies/me/bonds/sold/' };
if (confirm !== true) return { ok: true, dry: true, current,
  note: 'Dry read of the UNSOLD OFFER only. A zero offer does not mean zero outstanding debt. Use fresh state.bonds for debt, or pass confirm:true with amount+interest to UPDATE the offer.' };

if (!(Number(amount) >= 0) || !(Number(interest) > 0)) return { ok: false, reason: 'need amount>=0 and interest>0 (percent/day, e.g. 0.5)' };
setInput(inputs[0], Number(amount));
setInput(inputs[1], Number(interest));
await sleep(800);
const entered = {
  unsoldOfferAmountDollars: inputNumber(inputs[0]),
  offerInterestPctPerDay: inputNumber(inputs[1]),
};
if (entered.unsoldOfferAmountDollars == null || entered.offerInterestPctPerDay == null
    || Math.abs(entered.unsoldOfferAmountDollars - Number(amount)) >= 0.005
    || Math.abs(entered.offerInterestPctPerDay - Number(interest)) >= 0.000005) {
  return { ok: false, reason: 'finance form normalized or rejected the requested values before submit',
    requested: { amount: Number(amount), interest: Number(interest) }, entered };
}
const updateDisabled = btn.disabled
  || String(btn.getAttribute('aria-disabled')).toLowerCase() === 'true'
  || /(^|\s)disabled(\s|$)/i.test(String(btn.className || ''))
  || getComputedStyle(btn).pointerEvents === 'none';
if (updateDisabled) return { ok: false, reason: 'UPDATE is disabled; no bond change was submitted', entered };
btn.click();
await sleep(2500);
const after = document.body.innerText;
const bondsPayable = (after.match(/Bonds Payable[\s\S]{0,40}\$([\d,]+)/) || [])[1] || null;
return { ok: false, clicked: true, mutationAttempted: true, verificationPending: true,
  requested: { unsoldOfferAmountDollars: Number(amount), offerInterestPctPerDay: Number(interest) },
  pageStatementBondsPayableText: bondsPayable,
  reason: 'UPDATE was clicked; a fresh finance-page read is required before this can be reported as successful' };
