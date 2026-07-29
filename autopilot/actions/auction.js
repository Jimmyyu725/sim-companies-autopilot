// Building-auction INFO — READ-ONLY BY CONSTRUCTION. There is deliberately NO confirm path in
// this file: SEND TO AUCTION is instantly irreversible (slot freed immediately, 24h Vickrey,
// 20% fee, NO cancel — board/.probe-auction.md) and stays chairman-gated. This fragment only
// GETs the app's own endpoints (GETs need no signing). Caller navigates anywhere on the site.
// Params: window.__auction = { kind, limit, confirm }.
const { kind, limit, confirm } = window.__auction || {};
if (confirm === true || confirm === 'true')
  return { ok: false, refused: true,
           reason: 'chairman approval required — auction actions are not automated (send-to-auction ' +
                   'is irreversible: slot freed immediately, 24h auction, 20% fee, no cancel). ' +
                   'This tool is read-only; journal a CHAIRMAN: proposal instead.' };

const out = { ok: true, readOnly: true };
const live = await api('/api/v2/building-auctions/0/');
if (live.status !== 200 || !Array.isArray(live.json?.buildingAuctions)) {
  return {
    ok: false,
    readOnly: true,
    apiStatus: live.status ?? 'UNKNOWN',
    auctions: 'UNKNOWN',
    reason: 'building-auction API is unavailable or malformed; do not interpret it as zero auctions',
  };
}
const arr = live.json.buildingAuctions;
out.liveTotal = arr.length;
let rows = arr;
if (kind != null) rows = rows.filter(a => String(a.buildingKind) === String(kind));
out.filteredTotal = rows.length;
out.auctions = rows
  .slice()
  .sort((a, b) => new Date(a.closesAt) - new Date(b.closesAt))
  .slice(0, Number(limit) > 0 ? Number(limit) : 15)
  .map(a => ({ id: a.id, kind: a.buildingKind, size: a.buildingSize, minBid: a.minBid,
               guaranteedReturn: a.guaranteedReturn, closesAt: a.closesAt, promoted: a.promoted,
               seller: (a.seller && (a.seller.company || a.seller.name)) || a.sellerId,
               abundance: (a.auctionbuildingabundanceSet || [])
                 .map(x => x.resourceKind + ':' + x.abundanceLevel).join(',') || undefined }));

const cid = window.__companyId;
if (cid) {
  const mine = await api('/api/v2/companies/' + cid + '/building-auctions/');
  out.ourAuctions = mine.json !== undefined ? mine.json : { status: mine.status };
}
// NOTE: GET /api/v2/building-auctions/bids/0/ answers "cannot access bids of other company"
// (measured 2026-07-25) — our own bids are not readable this way; omitted.
out.note = 'Vickrey: winner pays 2nd-highest bid; minBid = size × building cost; we are Lv11 — ' +
           'buildingAuctions capability unlocks at Lv20, so selling/bidding is out of reach anyway.';
return out;
