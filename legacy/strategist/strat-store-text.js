const t = norm(document.body.innerText);
const i = t.indexOf('not sell other items');
return { found: i > -1, context: i > -1 ? t.slice(Math.max(0, i - 800), i + 140) : t.slice(0, 800) };
