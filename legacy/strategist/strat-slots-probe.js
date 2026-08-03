// Ground-truth the free construction-slot count. tick.js:501 computes
// freeSlots = maxBuildings - buildings.length, but the Beach market's own page says it
// "doesn't contribute to the administration overhead, company building count, or company
// value" — so the API building list may overstate the slots in use by one.
// Rule 4b: test it, do not infer it from the sentence. Reads only.
const auth = await api('/api/v3/companies/auth-data/');
const a = auth.json || {};

// Every landscape tile is a link to /b/<id>/ (built) or to the build flow (empty slot).
const tiles = all('a').map(el => ({
  href: el.getAttribute('href'),
  text: norm(el.innerText).slice(0, 70),
})).filter(t => t.text);

return {
  maxBuildings: a.levelInfo && a.levelInfo.maxBuildings,
  level: a.levelInfo && a.levelInfo.level,
  fullText: norm(document.body.innerText),
  tiles,
};
