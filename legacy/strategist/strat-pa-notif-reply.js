// PA "enable email notifications?" settings vignette (2026-07-24 15:54). Not a trade — no cash/
// inventory. Options: (1) "Good catch! Switch it on!" (2) "No, I rather be surprised by changes
// coming out of nowhere". DECLINE (2): this is an AUTONOMOUS operation — a bot gains nothing from
// game notification emails, and option (1) is an outward-facing change (sends real emails to the
// owner's inbox y326433462@gmail.com) that I'm not durably authorized to make and can't confirm.
// Keeping notifications off = status quo, risk-free (declines are never penalized). Robust clicker:
// click the already-rendered a.pa-reply directly; re-open the convo only if anchors are absent.
const want = 'rather be surprised';
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
