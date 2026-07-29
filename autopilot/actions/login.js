// Signs in to Sim Companies on the current /signin/ page.
// __SC_EMAIL__ / __SC_PASSWORD__ are substituted by cdp.js from the 600-mode .creds file.
const accept = all('button').find(b => norm(b.innerText) === 'ACCEPT ALL');
if (accept) { accept.click(); await sleep(1200); }

const email = all('input[name=email]')[0];
const pass = all('input[name=password]')[0];
if (!email || !pass) return { ok: false, reason: 'login form not found' };

setInput(email, '__SC_EMAIL__');
setInput(pass, '__SC_PASSWORD__');
await sleep(400);

const btn = all('button').find(b => norm(b.innerText) === 'Sign in');
if (!btn) return { ok: false, reason: 'sign-in button not found' };
btn.click();

for (let i = 0; i < 25; i++) {
  await sleep(1000);
  if (!location.pathname.startsWith('/signin')) break;
}
const signedIn = !location.pathname.startsWith('/signin');
return { ok: signedIn, url: location.href,
  reason: signedIn ? undefined : 'sign-in submit did not leave /signin within 25 seconds',
  body: norm(document.body.innerText).slice(0, 300) };
