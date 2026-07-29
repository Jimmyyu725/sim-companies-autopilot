// Incoming contracts: LIST + row-DOM dump. Caller navigates to /headquarters/ first.
// Params: window.__caccept = { contractId, confirm }.
//
// IMPORTANT LIMIT (board/.probe-contracts.md §B): the probe ran against an EMPTY incoming list,
// so the per-row accept/decline button DOM is UNVERIFIED. Per the iron rule (never click a button
// whose identity was not probed), confirm:true is REFUSED here — there is NO accept code path in
// this file yet. The dry run returns the API list AND a full row/button dump; once a live incoming
// contract has been dumped and the accept button verified, extend this file (and only then).
const { contractId, confirm } = window.__caccept || {};

// 1) Authoritative list via the app's own GET (no signing needed for GETs — probe §A).
const r = await api('/api/v3/contracts-incoming/0/me/');
if (r.status !== 200 || !Array.isArray(r.json?.incomingContracts)) {
  return {
    ok: false,
    dry: true,
    apiStatus: r.status ?? 'UNKNOWN',
    incoming: 'UNKNOWN',
    reason: 'incoming-contract API is unavailable or malformed; do not interpret it as an empty list',
  };
}
const listRaw = r.json.incomingContracts;
const list = listRaw.slice(0, 12).map(c => {
  const keep = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') keep[k] = v;
    else if (v && typeof v === 'object' && (v.company || v.name)) keep[k] = v.company || v.name;
  }
  return keep;
});

// 2) Click the INCOMING tab (a plain view switch — probe §B: safe) and dump any rows read-only.
const tabs = all('a, button, div, span, li')
  .filter(e => e.offsetParent !== null)
  .filter(e => { const t = norm(e.innerText); return /^INCOMING(\s*\(?\d*\)?)?$/i.test(t) && t.length <= 20; })
  .sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
let rows = [];
if (tabs.length) {
  tabs[0].click();
  await sleep(3500);
  const cands = all('div, li, tr').filter(el => {
    if (el.offsetParent === null) return false;
    const btns = el.querySelectorAll('button');
    if (btns.length < 1 || btns.length > 6) return false;
    const t = norm(el.innerText);
    return t.length > 10 && t.length < 400;
  });
  const innermost = cands.filter(c => !cands.some(o => o !== c && c.contains(o) && o.querySelectorAll('button').length > 0));
  rows = innermost.slice(0, 8).map(el => ({
    text: norm(el.innerText).slice(0, 220),
    buttons: all('button', el).map(b => ({
      text: norm(b.innerText).slice(0, 40),
      aria: b.getAttribute('aria-label') || null,
      cls: (b.className || '').toString().slice(0, 80),
      disabled: b.disabled,
      svg: (b.querySelector('svg') ? (b.querySelector('svg').getAttribute('data-icon') || '') : null),
    })),
  }));
}

if (confirm === true)
  return { ok: false, refused: true,
           reason: 'accept is NOT wired: the accept-button DOM was never observed (probe 2026-07-24 ' +
                   'ran on an empty list). This dry run just dumped the live rows — have the row dump ' +
                   'verified + this primitive extended before any accept. Journal good offers with a ' +
                   'CHAIRMAN: prefix meanwhile.',
           apiStatus: r.status, incoming: list, rowDump: rows };

return { ok: true, dry: true, apiStatus: r.status,
         count: listRaw.length, incoming: list,
         requested: contractId ?? null,
         rowDump: rows,
         note: rows.length ? 'ROW DOM CAPTURED — save this dump to close the probe §B gap' :
               (listRaw.length ? 'API shows contracts but no rows rendered — check tab' :
                'no incoming contracts') };
