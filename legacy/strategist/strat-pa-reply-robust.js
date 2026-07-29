// Robust PA reply: click the chosen a.pa-reply anchor. Unlike pages/pa-reply.js it does NOT
// blindly re-click the sidebar PA link (that remount raced the 3s wait and gave before:[]).
// If anchors are already visible (convo open), click directly; else open the convo, wait 5s.
const want = 'no time for parties'; // decline the $3,000 party (cash-sink, no stated return)
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
