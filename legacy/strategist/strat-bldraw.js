// Dump the scalar fields of every building object as the game actually serves them, so the
// seasonal "doesn't count toward the company building count" flag can be identified by name
// rather than guessed. Uses cdp.capture (the buildings endpoint returns [] when re-fetched
// directly — it is only populated on the real page load).
const cdp = require('./cdp.js');
const CFG = require('./config.json');

(async () => {
  await cdp.connect();
  const cap = await cdp.capture('https://www.simcompanies.com/b/' + CFG.storeId + '/', 15);
  const list = cap['/api/v2/companies/me/buildings/'] || [];
  const out = list.map(b => {
    const o = {};
    for (const k of Object.keys(b)) {
      const v = b[k];
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) o[k] = v;
      else o[k] = '<' + (Array.isArray(v) ? 'array[' + v.length + ']' : typeof v) + '>';
    }
    return o;
  });
  console.log(JSON.stringify(out, null, 1));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
