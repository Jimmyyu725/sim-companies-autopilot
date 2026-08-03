// PA offer 2026-07-24 17:48 CDT: "SimConstruction ... urgently need 2,000 [bricks] ...
// They offered a free service in exchange." (community: halves your NEXT upgrade's build time.)
// DECLINE: we hold 0 bricks (measured), buying 2,000 (~$3-7k) rivals the 2nd-Mill gate gap and
// STRATEGIST §4 forbids starving the active build; the time-perk is worth far less and our next
// build is CASH-gated, not time-gated. Robust clicker (LESSONS B5): click the rendered anchor.
const want = 'too busy'; // decline: "Sorry, I am too busy and we do not have the bricks."
const replies = () => all('a.pa-reply').filter(a => a.offsetParent !== null);
if (!replies().length) {
  const paLink = all('a').filter(a => /personal assistant/i.test(norm(a.innerText)) && a.offsetParent !== null);
  paLink.sort((a, b) => a.innerText.length - b.innerText.length);
  if (paLink.length) { paLink[0].click(); await sleep(5000); }
}
const before = replies().map(a => norm(a.innerText));
const hits = replies().filter(a => norm(a.innerText).toLowerCase().includes(want));
if (!hits.length) return { ok: false, reason: 'no pa-reply matches choice', before, url: location.href };
if (new Set(hits.map(a => norm(a.innerText))).size > 1) return { ok: false, reason: 'ambiguous', before };
hits[0].scrollIntoView({ block: 'center' });
hits[0].click();
await sleep(4000);
let after = replies().map(a => norm(a.innerText));
let method = 'native-click';
if (after.length) {
  const again = replies().filter(a => norm(a.innerText).toLowerCase().includes(want))[0];
  if (again) { again.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); await sleep(4000); method = 'dispatch-mouseevent'; }
  after = replies().map(a => norm(a.innerText));
}
return { ok: after.length === 0, method, chosen: norm(hits[0].innerText), before, after, url: location.href };
