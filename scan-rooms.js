// Visit each chatroom on /messages/, dismiss the one-time rules overlay if present,
// and return the tail of each room's visible text.
// Run via: node cdp.js js scan-rooms.js (inside the tick lock, after goto /messages/).
// Matching is startsWith because unread-count badges append digits to the link text
// ("Game 1"), which broke exact matching on 2026-07-22.
// If EVERY room reports ROOM LINK NOT FOUND, the room subscriptions were wiped (happened
// 2026-07-22 20:40): open the gear next to CHATROOMS, re-tick the five EN room checkboxes
// (names G/H/S/X/C) — they save on click — then reload /messages/. Re-subscribing brings
// the rules overlay back once per room; posting needs a native button.click() on the
// paper-plane <button> (dispatchEvent(MouseEvent) does not trigger the React handler).
const out = {};
for (const room of ['Game', 'Help', 'Sales', 'Aerospace sales', 'Social']) {
  const links = all('a, div[role=button], li, span').filter(
    e => norm(e.innerText).startsWith(room) && e.offsetParent !== null);
  if (!links.length) { out[room] = 'ROOM LINK NOT FOUND'; continue; }
  links.sort((a, b) => a.innerText.length - b.innerText.length);
  links[0].click();
  await sleep(2500);
  const dismiss = byText('Ok, and do not show again').find(e => e.offsetParent !== null);
  if (dismiss) { dismiss.click(); await sleep(2000); }
  const t = norm(document.body.innerText);
  out[room] = t.slice(-2600);
}
return out;
