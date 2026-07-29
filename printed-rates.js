#!/usr/bin/env node
// Read the game's OWN printed production rate for every product of every building we own.
//
// Why this exists (measured 2026-07-23): the raw x level x 0.8087 model in DOCTRINE reproduces
// the Farm to within 0.1% but overstates the Mill by 1.76x — the Mill page prints coffee powder
// 17.86/h against a model of 31.1/h, and flour/fodder agree on the same 0.4638 constant. tick.js
// sized a grind for ~12h on the model; the game quoted 20h57m and charged $8,136 of wages up
// front, which cannot be recovered if the order is cancelled. So the model is a hypothesis and
// this page number is the fact (DOCTRINE Rule 1 / Rule 4b).
//
// Usage:  flock -w 300 .tick.lock node printed-rates.js [--write]
// Without --write it only prints. With --write it merges the readings into config.printedRates
// (which tick.js prefers over the model) and stamps _asOf. Buildings are read from the same
// capture tick.js uses, so a newly-completed building is picked up automatically.
const fs = require('fs');
const cdp = require('./cdp.js');
const CFG = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
const DEFS = JSON.parse(fs.readFileSync(__dirname + '/defs.json', 'utf8')).resources;
const WRITE = process.argv.includes('--write');

// image slug -> kind. The product card's own <img> is the join key, NOT the printed name:
// the game labels images/resources/coffee-ground.png as "COFFEE POWDER" and cocoa-beans.png as
// "COCOA", so a name-derived map silently dropped both (measured 2026-07-24 — the Mill's
// headline product went unmeasured for a full run while the log cheerfully printed "kind=?").
const byImage = {};
for (const [kind, r] of Object.entries(DEFS)) {
  const n = (r.image || '').split('/').pop().split('.')[0];
  if (n) byImage[n.toLowerCase()] = Number(kind);
}

(async () => {
  await cdp.connect();
  const cap = await cdp.capture(`https://www.simcompanies.com/b/${CFG.storeId}/`, 15);
  const buildings = cap['/api/v2/companies/me/buildings/'] || [];
  const out = {};
  const unresolved = [];
  for (const b of buildings) {
    if (b.freeAndLocked || b.category === 'seasonal') continue;   // no slot, no production
    await cdp.goto(`https://www.simcompanies.com/b/${b.id}/`);
    await new Promise(r => setTimeout(r, 2500));
    // The card renders as "<PRODUCT NAME>\nProduction: 17.86/h\nWages: $391/h". Sales buildings
    // print no Production line at all — they are priced through the retail probe instead.
    const rows = await cdp.evaluate(`
      const t = document.body.innerText;
      const lvl = (t.match(/LEVEL\\s+(\\d+)/) || [])[1];
      const wage = (t.match(/Wages:\\s*\\$([\\d,]+)\\/h/) || [])[1];
      // Each product card prints "Production: X/h" and carries that resource's <img> a couple
      // of levels up the tree. Walk up from the innermost node holding the Production line
      // until exactly one resource image is in scope — that image names the kind unambiguously.
      const PROD = /Production:\\s*([\\d,.]+)\\/h/;
      const withProd = all('*').filter(e => PROD.test(e.innerText || ''));
      const leaves = withProd.filter(e => !withProd.some(o => o !== e && e.contains(o)));
      const hits = [];
      for (const leaf of leaves) {
        const rate = Number((leaf.innerText.match(PROD) || [])[1].replace(/,/g, ''));
        let slug = null, name = null;
        for (let node = leaf, up = 0; node && up < 4; node = node.parentElement, up++) {
          const imgs = all('img', node)
            .map(i => (i.src || '').split('/').pop())
            .filter(f => /resources|\\.png$/.test(f));
          if (imgs.length === 1) {
            slug = imgs[0].split('.')[0];
            name = (norm(node.innerText).match(/^([A-Z][A-Z0-9 .'\\-]{2,}?)\\s*(?:Production|Wages|$)/) || [])[1] || slug;
            break;
          }
        }
        hits.push({ name: (name || '?').trim(), slug, rate });
      }
      return { level: lvl && Number(lvl), wage: wage && Number(wage.replace(/,/g, '')), hits };`);
    console.log(`--- ${b.name} (id ${b.id}) level ${rows.level} wages $${rows.wage}/h`);
    for (const h of rows.hits) {
      const kind = h.slug ? byImage[h.slug.toLowerCase()] : undefined;
      console.log(`    ${h.name.padEnd(18)} ${String(h.rate).padStart(10)}/h  kind=${kind ?? '?'}  img=${h.slug ?? '-'}`);
      if (kind) out[String(kind)] = h.rate;
      else unresolved.push(`${b.name}: ${h.name} (img=${h.slug ?? 'none'}) @ ${h.rate}/h`);
    }
  }
  // An unmatched product is not cosmetic: tick.js falls back to the raw x level x 0.8087 model,
  // which is a FARM constant and runs ~1.7x hot on a processor. That is exactly how the Mill got
  // a 20h57m order it had sized for 12h, with $8,136 of non-refundable wages. Say so loudly.
  if (unresolved.length) {
    console.log('\nWARNING — printed rate could not be mapped to a kind (tick.js will MODEL these,');
    console.log('and the model runs ~1.7x hot on processors):');
    for (const u of unresolved) console.log('  ! ' + u);
  }
  if (!WRITE) { console.log('\n(dry — pass --write to merge into config.printedRates)'); process.exit(0); }
  // Merge, never replace: the _asOf/_why/_staleness notes in config are the audit trail and a
  // building that failed to render must not silently delete a good reading from another one.
  const next = Object.assign({}, CFG.printedRates || {}, out);
  next._asOf = new Date().toISOString();
  CFG.printedRates = next;
  fs.writeFileSync(__dirname + '/config.json', JSON.stringify(CFG, null, 2));
  JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));   // fail loudly, not silently
  console.log('\nmerged into config.printedRates:', JSON.stringify(out));
  // Explicit exit: the CDP websocket keeps the event loop alive, so without this the process
  // sits there holding the tick lock after its work is done. Measured the hard way on
  // 2026-07-23 — the first --write run blocked the 2-minute fast loop for ~11 minutes.
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
