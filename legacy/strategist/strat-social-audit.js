// Open the Social room and look specifically for messages attributed to us.
const links = all('a, div[role=button], li, span').filter(
  e => norm(e.innerText).startsWith('Social') && e.offsetParent !== null);
links.sort((a, b) => a.innerText.length - b.innerText.length);
if (!links.length) return { ok: false, reason: 'no Social link' };
links[0].click();
await sleep(3000);
const t = norm(document.body.innerText);
const idx = t.indexOf('YOU');
return {
  ok: true, url: location.href,
  hasYou: idx > -1,
  around: idx > -1 ? t.slice(Math.max(0, idx - 300), idx + 300) : null,
  appleMentions: (t.match(/apple\.co[^]{0,120}/gi) || []).slice(0, 5),
};
