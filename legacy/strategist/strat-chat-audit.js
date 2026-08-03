// Audit: has THIS company posted anything in the public rooms, and are there any real DMs?
// Dumps the /messages/ sidebar rows (room + last-message preview) and any element whose
// author label is "YOU", so a stray outbound post cannot hide in a 2,600-char tail slice.
const rows = all('a').filter(a => (a.href || '').includes('/messages/'))
  .map(a => norm(a.innerText)).filter(Boolean);
const you = all('div, li, p, span')
  .filter(e => /^YOU\b/.test(norm(e.innerText)) && norm(e.innerText).length < 400)
  .map(e => norm(e.innerText));
return { url: location.href, rows, youMentions: Array.from(new Set(you)).slice(0, 10) };
