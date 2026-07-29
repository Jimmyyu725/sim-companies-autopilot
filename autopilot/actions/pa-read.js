// Open the Personal Assistant conversation and dump the pending offer text + its reply options.
// Run inside the tick lock, right after `node cdp.js goto https://www.simcompanies.com/messages/`.
// Read here → decide → reply with actions/pa-reply.js (set window.__paChoice to the chosen option).
// The offer's choices are <a class="pa-reply"> anchors; the offer body is the tail of the pane.
const paLink = all('a').filter(a => /personal assistant/i.test(norm(a.innerText)) && a.offsetParent !== null);
paLink.sort((a, b) => a.innerText.length - b.innerText.length);
if (!paLink.length) {
  return { ok: false, reason: 'no Personal assistant row on /messages/',
           rows: all('a').filter(a => (a.href || '').includes('/messages/')).map(a => norm(a.innerText)) };
}
paLink[0].click();
await sleep(3500);
const options = all('a.pa-reply').filter(a => a.offsetParent !== null).map(a => norm(a.innerText));
const body = norm(document.body.innerText);
return { ok: true, url: location.href, options, tail: body.slice(-1800) };
