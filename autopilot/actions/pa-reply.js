// Answer a Personal Assistant event by clicking its chosen reply.
// The PA's multiple-choice replies are <a class="pa-reply"> anchors (NOT <button>s); a native
// .click() on the specific anchor fires the React handler, but a broad text selector can hit a
// non-interactive duplicate (seen 2026-07-23), so match a.pa-reply directly.
//
// This is a CLICKER, not a decider: the strategist reads the offer and evaluates it against
// live prices (DOCTRINE §7 / STRATEGIST step 5), then passes the chosen option's text.
// Params: window.__paChoice = substring uniquely identifying the option to click.
// Success = every pa-reply option for this offer disappears after the click.
const want = norm(window.__paChoice || '').toLowerCase();
if (!want) return { ok: false, reason: 'no __paChoice given' };

const paLink = all('a').filter(a => /personal assistant/i.test(norm(a.innerText)) && a.offsetParent !== null);
paLink.sort((a, b) => a.innerText.length - b.innerText.length);
const replies = () => all('a.pa-reply').filter(a => a.offsetParent !== null);
if (!replies().length && paLink.length) { paLink[0].click(); await sleep(3000); }
const before = replies().map(a => norm(a.innerText));
const hits = replies().filter(a => norm(a.innerText).toLowerCase().includes(want));
if (!hits.length) return { ok: false, reason: 'no pa-reply matches choice', before };
if (hits.length !== 1)
  return { ok: false, reason: 'choice ambiguous — matches multiple options', before };

hits[0].scrollIntoView({ block: 'center' });
const chosen = norm(hits[0].innerText);
hits[0].click();
await sleep(3500);
const after = replies().map(a => norm(a.innerText));
const verified = after.length === 0;
const resultTail = norm(document.body.innerText).slice(-2200);
// Never dispatch the same choice twice. The first click may have reached the server while React is
// still rendering the old options; a second event could answer a newly rendered offer or duplicate
// a non-idempotent reward/cost. An unresolved UI is UNKNOWN and must be refreshed, not replayed.
return {
  ok: verified,
  method: 'native-click-once',
  chosen,
  before,
  after,
  resultTail,
  mutationAttempted: true,
  doNotRetry: !verified,
  outcome: verified ? 'VERIFIED_RESOLVED' : 'UNKNOWN_AFTER_SINGLE_CLICK',
  reason: verified ? undefined
    : 'reply was clicked once but the offer did not disappear within 3.5 seconds; refresh state/messages before any further action',
};
