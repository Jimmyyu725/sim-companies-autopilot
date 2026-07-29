// Verify the PA unread badge cleared, using the SAME detector tick.js's chat-watch uses
// (the fast loop re-flags chat while paUnread>0). Run after re-opening the PA conversation
// AND reloading /messages/ — a resolved offer keeps its badge until the convo is viewed on a
// fresh list load (STRATEGIST §5, measured 2026-07-23). Returns paUnread:0 when truly clear.
const rows = all('a').filter(a => (a.href || '').includes('/messages/')).map(a => norm(a.innerText));
const pa = rows.find(t => /personal assistant/i.test(t));
const paUnread = pa ? Number((pa.match(/(\d+)\s*$/) || [])[1] || 0) : 0;
return { paUnread, paRow: pa || null };
