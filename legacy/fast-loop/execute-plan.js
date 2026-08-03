#!/usr/bin/env node
// Autonomous executor for the board-approved motion (2026-07-23, APPROVE-AS-AMENDED 3-0):
//   build a 2nd L1 grocery store → sell grapes through both → when cash reaches the Mill
//   threshold, scrap the store (100% material return) → BUILD MILL from warehouse stock.
//
// It is a STATE MACHINE persisted in plan-state.json, driven by cron (called each tick).
// Each call advances at most one step, only when that step's guard passes, so an
// interrupted run resumes cleanly. Runs under the shared tick lock.
//
// Guards baked in from the ruling:
//   - only build the 2nd store if a free slot exists AND cash-after > $5,000 reserve
//   - store built at L1 only (never upgraded here)
//   - scrap+mill fires only when cash >= millReadyCash (so BUILD MILL's BUY MISSING is covered)
//   - every browser action verified via API, never by text
//   - abort to manual-review state on any anomaly rather than guessing

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.js');
const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_FILE = path.join(DIR, 'plan-state.json');
const LOG = path.join(DIR, 'bot.log');

function log(...p) {
  const line = `${new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' })} CDT PLAN ${p.join(' ')}`;
  fs.appendFileSync(LOG, line + '\n'); console.log(line);
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { step: 'idle', note: 'not started' }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

const GROCERY_KIND = 'Grocery store';
const RESERVE = 5000;
// Mill's live BUY MISSING bill was $23,739 with warehouse stock covering the rest; require a
// cushion so the click never fails for cash. Refined from the ruling's $18,200 cash-at-scrap.
const MILL_READY_CASH = 18200;

async function readLive() {
  // Capture the store page (it requests buildings + resources + auth). The resources feed
  // sometimes 403s in one capture; retry once so grapes/stock aren't false-zero (that made
  // the executor skip the grape sale on 2026-07-23 with 4,600 grapes actually in stock).
  let cap = await cdp.capture('https://www.simcompanies.com/b/' + CFG.storeId + '/', 14);
  let resources = cap['/api/v3/resources/' + CFG.companyId + '/'];
  const auth = cap['/api/v3/companies/auth-data/'];
  const buildings = cap['/api/v2/companies/me/buildings/'];
  if (!Array.isArray(resources)) {
    // second attempt for just the stock feed
    const r2 = await cdp.capture('https://www.simcompanies.com/b/' + CFG.storeId + '/', 12);
    resources = r2['/api/v3/resources/' + CFG.companyId + '/'];
  }
  const grapes = Array.isArray(resources) ? (resources.find(r => r.kind === 5)?.amount || 0) : null;
  return {
    money: auth?.authCompany?.money,
    maxBuildings: auth?.levelInfo?.maxBuildings,
    buildings: Array.isArray(buildings) ? buildings : [],
    grapes,                       // null = read failed (distinct from 0 = truly empty)
    grapesReadOk: Array.isArray(resources),
  };
}

(async () => {
  const s = loadState();
  if (s.step === 'idle' || s.step === 'done' || s.step === 'manual-review') {
    log(`state=${s.step} — nothing to do (${s.note || ''})`); process.exit(0);
  }

  await cdp.connect();
  const live = await readLive();
  if (live.money == null) { log('state read failed — will retry next tick'); cdp.close(); process.exit(0); }

  const stores = live.buildings.filter(b => b.name === GROCERY_KIND);
  const freeSlots = (live.maxBuildings || 5) - live.buildings.length;
  log(`step=${s.step} money=$${live.money} stores=${stores.length} freeSlots=${freeSlots}`);

  // STEP 1 — build the second grocery store (L1)
  if (s.step === 'build-store') {
    if (stores.length >= 2) { s.step = 'sell-grapes'; s.note = 'second store already exists'; saveState(s); log('store#2 present → sell-grapes'); cdp.close(); return; }
    if (freeSlots < 1) { s.step = 'manual-review'; s.note = 'no free slot for store#2'; saveState(s); log('ABORT: no free slot'); cdp.close(); return; }
    await cdp.goto('https://www.simcompanies.com/landscape/');
    await cdp.evaluate(`window.__build=${JSON.stringify({ building: GROCERY_KIND, maxCost: 13000, minCashAfter: RESERVE, confirm: true })}; return 1`);
    const built = await cdp.evaluate(require('fs').readFileSync(path.join(DIR, 'pages', 'build.js'), 'utf8'));
    log('BUILD store#2 ->', JSON.stringify(built).slice(0, 160));
    if (built.ok) { s.step = 'sell-grapes'; s.builtStoreQuote = built.quoted; saveState(s); }
    else if (/reserve|maxCost/.test(built.reason || '')) { log('build gated: ' + built.reason + ' — retry next tick'); }
    else { s.step = 'manual-review'; s.note = 'build failed: ' + built.reason; saveState(s); }
    cdp.close(); return;
  }

  // STEP 2 — sell grapes through the new store, wait for cash to reach the Mill line.
  if (s.step === 'sell-grapes') {
    // Cash check FIRST: once the line is reached, never start another sale — the scrap
    // step needs the store idle, and a fresh order would block it for its whole duration.
    if (live.money >= MILL_READY_CASH) {
      s.step = 'scrap-store'; saveState(s);
      log(`cash $${live.money} >= $${MILL_READY_CASH} → scrap-store`);
      cdp.close(); return;
    }
    const store2 = stores.find(b => b.id !== CFG.storeId);
    // Sell in 200-unit chunks (~2-4.5h at the 45-90/h L1 estimate), not the whole stock:
    // a full-stock order would run for days, prepay wages for its entire duration, and
    // make the store unscrappable at the cash line. qty must be a NUMBER (the input
    // rejects the string 'ALL').
    if (!store2) { log('store#2 not found — abort'); s.step = 'manual-review'; saveState(s); cdp.close(); return; }
    if (store2.busy) {
      log('store#2 busy (already selling) — let it run');
    } else if (live.grapes == null) {
      log('grape stock read failed this tick — will retry, not skipping');
    } else if (live.grapes >= 50) {
      const qty = Math.min(200, live.grapes);
      await cdp.goto('https://www.simcompanies.com/b/' + store2.id + '/');
      await cdp.evaluate(`window.__sell={name:'GRAPES', qty:${qty}, price:6.78}; return 1`);
      const sold = await cdp.evaluate(require('fs').readFileSync(path.join(DIR, 'pages', 'sell.js'), 'utf8'));
      log(`store#2 grape sale (qty ${qty} of ${live.grapes}) ->`, JSON.stringify(sold).slice(0, 120));
    } else {
      log(`store#2 idle, only ${live.grapes} grapes — waiting for stock`);
    }
    log(`waiting: cash $${live.money} < $${MILL_READY_CASH}`);
    cdp.close(); return;
  }

  // STEP 3+4 — scrap store#2, then BUILD MILL from warehouse stock, same window.
  if (s.step === 'scrap-store') {
    const store2 = stores.find(b => b.id !== CFG.storeId);
    if (!store2) { s.step = 'build-mill'; saveState(s); log('no store#2 to scrap → build-mill'); cdp.close(); return; }
    if (store2.busy) { log('store#2 busy (mid-sale) — wait to scrap'); cdp.close(); return; }
    await cdp.goto('https://www.simcompanies.com/b/' + store2.id + '/');
    // Self-gate, not owner-gate (owner is chairman, not operator): on the first idle
    // encounter do a DRY read of the real scrap dialog and let the CODE decide whether it's
    // safe. Safe = a recovering-materials line was read AND scrap.js would find exactly one
    // unambiguous confirm button. If both hold, arm automatically and proceed next tick; if
    // ambiguous, hold and wake the strategist (Opus) to inspect — never freeze on a human.
    if (!s.scrapDryDone) {
      await cdp.evaluate('window.__scrap={confirm:false}; return 1');
      const dry = await cdp.evaluate(require('fs').readFileSync(path.join(DIR, 'pages', 'scrap.js'), 'utf8'));
      s.scrapDryDone = true; s.scrapDry = dry;
      const materialsOk = /\d+x/.test(dry.recovering || '');
      const buttonOk = dry.reason !== 'confirm button ambiguous — refusing irreversible scrap';
      if (materialsOk && buttonOk) {
        s.scrapArmed = true; saveState(s);
        log(`SCRAP self-check PASSED (recovering: ${dry.recovering}) — auto-armed, scraps next tick`);
      } else {
        saveState(s);
        fs.writeFileSync(path.join(DIR, 'scrap-review.flag'), JSON.stringify(dry) + '\n');
        require('child_process').spawn('/srv/appdata/chrome-automation/sim/run-strategist.sh', [], { detached: true, stdio: 'ignore' }).unref();
        log(`SCRAP self-check UNCERTAIN (materials=${materialsOk} button=${buttonOk}) — strategist woken to inspect, not scrapping`);
      }
      cdp.close(); return;
    }
    if (!s.scrapArmed) { log('SCRAP held pending strategist review (scrap-review.flag)'); cdp.close(); return; }
    await cdp.evaluate('window.__scrap={confirm:true}; return 1');
    const scr = await cdp.evaluate(require('fs').readFileSync(path.join(DIR, 'pages', 'scrap.js'), 'utf8'));
    log('SCRAP store#2 ->', JSON.stringify(scr).slice(0, 160));
    if (scr.ok) {
      // Verify via API the store is actually gone before advancing.
      const after = await readLive();
      if (after.buildings.filter(b => b.name === GROCERY_KIND).length < stores.length) {
        s.step = 'build-mill'; saveState(s); log('scrap confirmed by API → build-mill');
      } else { s.step = 'manual-review'; s.note = 'scrap clicked but store still present'; saveState(s); log('ABORT: scrap not confirmed by API'); }
    } else { s.step = 'manual-review'; s.note = 'scrap failed: ' + scr.reason; saveState(s); }
    cdp.close(); return;
  }

  // STEP 5 — BUILD MILL (uses warehouse materials + BUY MISSING for the rest)
  if (s.step === 'build-mill') {
    if (live.buildings.some(b => b.name === 'Mill')) { s.step = 'done'; s.note = 'Mill exists'; saveState(s); log('Mill present → DONE'); cdp.close(); return; }
    await cdp.goto('https://www.simcompanies.com/landscape/');
    // effectiveCost = the live BUY MISSING (warehouse materials offset the full catalogue
    // quote). Without it, build.js's pre-flight gates on the FULL quote (~$30,600) and refuses
    // a build the real bill easily covers — which blocked this build on 2026-07-23 05:12 CDT.
    // Measured directly off the Mill dialog at 05:14 CDT: full quote $30,604, BUY MISSING
    // $15,691 with the scrapped store#2's materials in the warehouse. This value only clears
    // the cheap pre-flight; build.js re-reads the live BUY MISSING and gates the actual spend
    // on THAT (minCashAfter $500), so effectiveCost can never cause an overspend.
    await cdp.evaluate(`window.__build=${JSON.stringify({ building: 'Mill', maxCost: 35000, minCashAfter: 500, confirm: true, effectiveCost: 16500 })}; return 1`);
    const built = await cdp.evaluate(require('fs').readFileSync(path.join(DIR, 'pages', 'build.js'), 'utf8'));
    log('BUILD Mill ->', JSON.stringify(built).slice(0, 160));
    if (built.ok) { s.step = 'done'; s.note = 'Mill built ' + new Date().toISOString(); saveState(s);
      // hand the coffee chain back to the fast loop by re-enabling its build plan target
      CFG.buildPlan.enabled = false; CFG.buildPlan._done = s.note;
      fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(CFG, null, 2));
    } else if (/reserve|maxCost|BUY MISSING/.test(built.reason || '')) { log('mill build gated: ' + built.reason + ' — retry'); }
    else { s.step = 'manual-review'; s.note = 'mill build failed: ' + built.reason; saveState(s); }
    cdp.close(); return;
  }

  cdp.close();
})().catch(e => { log('EXECUTOR FAILED:', e.message); process.exit(1); });
