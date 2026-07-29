// Pull the game's resource/building definition tables straight out of the public JS
// bundle. Each table is a minified object literal, so locate the assignment, brace-match
// to its end, and eval the literal.
const url = performance.getEntriesByType('resource').map(e => e.name)
  .find(x => /index-.*\.js$/.test(x));
const src = await (await fetch(url)).text();

function extractObjectAt(openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
    else if (c === '"' || c === "'" || c === '`') { // skip string literals
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    }
  }
  return null;
}

function findTable(marker) {
  const m = src.indexOf(marker);
  if (m < 0) return null;
  const open = src.lastIndexOf('={', m);
  if (open < 0) return null;
  const lit = extractObjectAt(open + 1);
  if (!lit) return null;
  try { return (0, eval)('(' + lit + ')'); } catch (e) { return { __error: e.message }; }
}

const resources = findTable('producedFrom:{}');
const marker = window.__defMarker;
const extra = marker ? findTable(marker) : null;
return {
  resourceCount: resources ? Object.keys(resources).length : 0,
  resources,
  extraKeys: extra ? Object.keys(extra).slice(0, 40) : null,
  extraSample: extra ? JSON.stringify(extra).slice(0, 1200) : null,
};
