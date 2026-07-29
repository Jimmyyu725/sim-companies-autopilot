#!/usr/bin/env node
// Walk the in-game encyclopedia and dump every page's text to encyclopedia/.
//
// The resource recipes and rates already come from the JS bundle; what the encyclopedia
// adds is the authoritative building data (construction cost, what each building makes)
// and the mechanics pages. Run under the same flock as tick.js — it shares the one
// automation tab, and two navigators would fight.
//
// Usage: node scrape-encyclopedia.js [--only buildings|resources|misc]

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.js');

const OUT = path.join(__dirname, 'encyclopedia');
fs.mkdirSync(OUT, { recursive: true });

const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

// Building dbLetters seen across the bundle's producedAt fields.
const BUILDINGS = ('P W E O R S T Q M Y L F e i o x g k j m q v b c h p s a f l 1 6 7 8 9 0 D')
  .split(' ');
const MISC = ['levels', 'ratings', 'ranking', 'events', 'seasons', 'certificates',
              'collectibles', 'collectors', 'supporters'];

const clean = (t) => t
  .replace(/^[\s\S]*?Collect ready resources\n/, '')      // strip the sticky header
  .replace(/\nMap\nWarehouse\nSearch[\s\S]*$/, '')        // strip the footer nav
  .trim();

async function grab(url, file) {
  try {
    await cdp.goto(url);
    const text = await cdp.evaluate('return document.body.innerText');
    const body = clean(text || '');
    if (body.length < 40) { console.log(`SKIP ${file} (empty)`); return null; }
    fs.writeFileSync(path.join(OUT, file), `# ${url}\n\n${body}\n`);
    console.log(`OK   ${file}  (${body.length} chars)`);
    return body;
  } catch (e) {
    console.log(`FAIL ${file}: ${e.message}`);
    return null;
  }
}

(async () => {
  await cdp.connect();
  const base = 'https://www.simcompanies.com/encyclopedia/0';

  if (!ONLY || ONLY === 'buildings') {
    for (const b of BUILDINGS) await grab(`${base}/building/${b}/`, `building-${b}.txt`);
  }
  if (!ONLY || ONLY === 'misc') {
    for (const m of MISC) await grab(`${base}/${m}/`, `misc-${m}.txt`);
  }
  if (ONLY === 'resources') {
    const defs = require('./defs.json');
    for (const k of Object.keys(defs.resources)) await grab(`${base}/resource/${k}/`, `resource-${k}.txt`);
  }

  cdp.close();
  process.exit(0);
})().catch(e => { console.error('SCRAPE FAILED:', e.message); process.exit(1); });
