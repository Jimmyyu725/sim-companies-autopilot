#!/usr/bin/env node
'use strict';

// Zero-LLM Prospector loop. Cron runs this every minute: every idle level-1 extraction building is
// rebuilt through the rendered UI, no model involved.
//
// Why it exists: the brain rebuilds at most one site per wake, because each cycle costs it a
// baseline verification, a preview and a confirm. At roughly twenty minutes a wake that leaves ten
// Quarries idle for hours — and an idle building earns no experience at all, while one under
// construction earns about 36 XP/h. Owner directive 2026-08-02: "不用管丰富度,拆就行了" — rebuild
// on sight, never weigh the abundance roll.
//
// Safety: only level-1 Quarry / Mine / Oil rig, only when idle, only while the owner's campaign is
// active. Every site is re-read on its own page with the landing URL verified before anything is
// clicked, so a stale capture costs a page load rather than a wrong click. The caller holds
// .tick.lock for the whole run, so this never races the brain for the shared browser tab.

const fs = require('fs');
const path = require('path');
const AUTOPILOT = __dirname;
const cdp = require(path.join(AUTOPILOT, '..', 'shared', 'cdp.js'));

const EXTRACTION = new Set(['quarry', 'mine', 'oil rig']);
const STATE = path.join(AUTOPILOT, '.state.json');
const DIRECTIVE = path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json');
const LOG = path.join(AUTOPILOT, 'quarry-rebuild.log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  try { fs.appendFileSync(LOG, line); } catch (_) {}
  process.stdout.write(line);
}

function campaignActive() {
  try {
    const directive = JSON.parse(fs.readFileSync(DIRECTIVE, 'utf8'));
    return directive?.prospectorExperiment?.campaign?.status === 'active';
  } catch (_) { return false; }
}

// Candidates only: the capture can be minutes stale, and a rebuilt site is issued a brand new id,
// so every entry is re-verified on its own page below.
function candidates() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return (Array.isArray(state.buildings) ? state.buildings : [])
      .filter(building => EXTRACTION.has(String(building?.name || '').trim().toLowerCase()) &&
        Number(building?.size) === 1 && building?.busy == null)
      .map(building => Number(building.id));
  } catch (_) { return []; }
}

async function open(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await cdp.goto(`https://www.simcompanies.com/b/${id}/`);
    await sleep(6000);
    const page = await cdp.evaluate(`
      const m = document.querySelector('main') || document.body;
      const t = (m && m.innerText) || '';
      return {
        href: location.href,
        extraction: /\\n(QUARRY|MINE|OIL RIG)\\n/.test(t),
        level: (t.match(/LEVEL\\s+(\\d+)/i) || [])[1],
        busy: /Finishes at|under construction/i.test(t),
        rebuild: [...document.querySelectorAll('button')]
          .some(b => /^Rebuild$/i.test(b.textContent.trim())),
      };`);
    // The SPA can keep showing the previous building for a moment; only a verified landing counts.
    if (new RegExp(`/b/${id}/`).test(page.href) && page.extraction) return page;
  }
  return null;
}

async function rebuildOne(id) {
  const page = await open(id);
  if (!page) return 'gone or unreachable';
  if (String(page.level) !== '1') return `level ${page.level}`;
  if (page.busy) return 'already building';
  if (!page.rebuild) return 'no Rebuild control';

  await cdp.evaluate(`
    [...document.querySelectorAll('button')]
      .find(b => /^Rebuild$/i.test(b.textContent.trim())).click();`);
  await sleep(3200);

  // Below 80% abundance the opener commits directly. Above it the game asks to confirm, and that
  // dialog's button is ALSO labelled "Rebuild" — the one immediately before "I changed my mind".
  // Matching on the label alone silently re-clicks the opener and nothing happens; that cost an
  // hour on 2026-08-02.
  await cdp.evaluate(`
    const all = [...document.querySelectorAll('button')];
    const mind = all.findIndex(b => /I changed my mind/i.test(b.textContent));
    if (mind > 0) { all[mind - 1].click(); return 'dialog'; }
    return 'direct';`);
  await sleep(5000);

  const after = await open(id);
  // A completed rebuild replaces the building, so an unreachable id afterwards means it worked.
  if (!after) return 'rebuilt';
  return after.busy ? 'rebuilt' : 'no construction started';
}

(async () => {
  if (!campaignActive()) { log('campaign not active — nothing to do'); return; }
  const ids = candidates();
  if (!ids.length) { log('no idle level-1 extraction sites'); return; }

  await cdp.connect();
  let rebuilt = 0;
  const skipped = [];
  for (const id of ids) {
    let outcome;
    try { outcome = await rebuildOne(id); }
    catch (error) { outcome = `error: ${String(error.message || error).slice(0, 80)}`; }
    if (outcome === 'rebuilt') { rebuilt += 1; log(`${id} rebuilt`); }
    else skipped.push(`${id} ${outcome}`);
  }
  log(`done — rebuilt ${rebuilt}/${ids.length}${skipped.length ? ` | skipped: ${skipped.join('; ')}` : ''}`);
  try { cdp.close(); } catch (_) {}
})().catch(error => {
  log('FAILED', String(error.message || error).slice(0, 200));
  try { cdp.close(); } catch (_) {}
  process.exitCode = 1;
});
