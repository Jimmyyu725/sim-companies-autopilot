#!/usr/bin/env node
// Board data collector. Pulls every statement/API the four executives read, into one
// board-data.json file. Each executive Claude reads its own slice from that file instead
// of driving the browser itself — one browser session, not four, and no per-role scraping.
//
// Availability is gated by company level (capabilities from auth-data). Locked sources are
// recorded as {locked:true, unlocksAt} so a role knows to stand down rather than error.
//
// Run under flock. Usage: node board-data.js  → writes board-data.json, prints a summary.

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.js');
const DIR = __dirname;
const CID = require(path.join(DIR, 'config.json')).companyId;

const UNLOCK = { research: 10, bonds: 10, executives: 15 };

(async () => {
  await cdp.connect();
  // Some endpoints (buildings, resources) 403 an in-page fetch but load fine when the app
  // requests them. Capture the store page's own traffic to get those reliably.
  const cap = await cdp.capture('https://www.simcompanies.com/b/' + require(path.join(DIR, 'config.json')).storeId + '/', 14);
  const captured = {
    buildings: cap['/api/v2/companies/me/buildings/'],
    resources: cap['/api/v3/resources/' + CID + '/'],
  };
  await cdp.goto('https://www.simcompanies.com/headquarters/accounting/');

  const data = await cdp.evaluate(`
    const cid = ${CID};
    // Cloudflare occasionally 403s an in-page fetch; retry a couple of times before giving up
    // so a transient block doesn't hand an executive an empty dataset.
    const grab = async (p) => {
      for (let i = 0; i < 3; i++) {
        try { const r = await api(p); if (r.status === 200) return r.json; }
        catch (e) { /* retry */ }
        await sleep(1500);
      }
      return { _failed: p };
    };
    const out = {};
    const cap = (await grab('/api/v3/companies/auth-data/'));
    out.auth = cap;

    // CFO: money, solvency, spend
    out.income = await grab('/api/v2/companies/me/income-statement/');
    out.balance = await grab('/api/v2/companies/me/balance-sheet/');
    out.cashflow = await grab('/api/v2/companies/me/cashflow-statement/');
    const recent = await grab('/api/v2/companies/me/cashflow/recent/');
    out.recent = recent && recent.data ? recent.data : [];

    // COO: inventory + contracts + throughput. buildings/resources come from the capture
    // (they 403 an in-page fetch); injected below after this eval returns.
    out.contractsIn = await grab('/api/v3/contracts-incoming/0/me/');
    out.contractsOut = await grab('/api/v3/contracts-outgoing/me/');

    // market context all roles share
    out.ticker = await grab('/api/v3/market-ticker/0/');
    out.retail = await grab('/api/v4/0/resources-retail-info/');
    out.modifiers = await grab('/api/v2/production-modifiers/0/');
    // CMO: weather affects selling speed; COO: exchange order-book depth for its inputs.
    out.weather = await grab('/api/v2/weather/0/');
    // Order books for the inputs/products the board actually cares about (water, seeds,
    // our current retail products, and construction units — the COO flagged on 7-22 that
    // the CU ask was quoted without depth) — COO procurement + CMO surplus disposal.
    out.orderBooks = {};
    for (const k of [2, 66, 3, 4, 5, 111, 119]) {
      out.orderBooks[k] = await grab('/api/v3/market/0/' + k + '/');
    }
    return out;`);

  // Inject the capture-sourced datasets that 403 via in-page fetch.
  data.buildings = captured.buildings || { _failed: 'buildings (capture empty)' };
  data.resources = captured.resources || { _failed: 'resources (capture empty)' };

  const level = data.auth?.levelInfo?.level ?? 0;
  const caps = data.auth?.levelInfo?.capabilities || {};

  // Fetch level-gated sources only when unlocked; otherwise mark locked.
  const gated = {};
  // Bonds terms live behind several endpoints (bundle: bonds/rating drives the coupon, bonds/sold =
  // what we've issued, bonds/ = market). /api/v3/bonds/0/ 404'd on 2026-07-24 and blocked the board
  // from scoring a debt decision, so try the candidates and keep whatever each returns — the CFO
  // needs the coupon (rating) + our ceiling to judge ROC-vs-coupon. Self-discovers the live path.
  gated.bonds = caps.bonds ? await cdp.evaluate(`
    const out={}; for (const [k,p] of [['rating','/api/v3/bonds/rating/'],['market','/api/v3/bonds/'],['sold','/api/v3/bonds/sold/'],['owned','/api/v3/bonds/owned/'],['me','/api/v3/companies/me/bonds/']]) {
      try { const r=await api(p); out[k]=r.status===200?r.json:{_status:r.status}; } catch(e){ out[k]={_err:String(e).slice(0,80)}; }
    } return out;
  `) : { locked: true, unlocksAt: UNLOCK.bonds };
  gated.research = caps.research ? await cdp.evaluate("const r=await api('/api/v2/companies/me/research/'); return r.status===200?r.json:{_status:r.status}") : { locked: true, unlocksAt: UNLOCK.research };
  gated.executives = caps.executives ? await cdp.evaluate("const r=await api('/api/v2/companies/me/executives/'); return r.status===200?r.json:{_status:r.status}") : { locked: true, unlocksAt: UNLOCK.executives };
  cdp.close();

  const board = {
    generated: new Date().toISOString(),
    level, capabilities: caps,
    cfo: { income: data.income, balance: data.balance, cashflow: data.cashflow, recent: data.recent, bonds: gated.bonds },
    coo: { resources: data.resources, buildings: data.buildings, contractsIn: data.contractsIn, contractsOut: data.contractsOut, orderBooks: data.orderBooks },
    cmo: { retail: data.retail, weather: data.weather, modifiers: data.modifiers, orderBooks: data.orderBooks, resources: data.resources },
    cto: { research: gated.research },
    hr: { executives: gated.executives },
    market: { ticker: data.ticker, retail: data.retail, modifiers: data.modifiers, weather: data.weather },
  };
  // Meeting-over-meeting market memory (owner directive 2026-07-22): the retailData series
  // is day-granular and lags, so a competitor influx between meetings is invisible to the
  // CMO until it is over. Persist a compact snapshot per meeting and hand the CMO the
  // trailing window so it can compute saturation/price rate-of-change at meeting cadence.
  const snapPath = path.join(DIR, 'market-snapshots.jsonl');
  const snap = {
    t: board.generated,
    retail: (Array.isArray(data.retail) ? data.retail : []).map(r => {
      const last = (r.retailData || []).slice(-1)[0] || {};
      return { kind: r.dbLetter, saturation: r.saturation,
               averagePrice: last.averagePrice, demand: last.demand };
    }),
  };
  try {
    board.cmo.snapshotHistory = fs.readFileSync(snapPath, 'utf8')
      .trim().split('\n').filter(Boolean).slice(-6).map(l => JSON.parse(l));
  } catch (e) { board.cmo.snapshotHistory = []; }
  fs.appendFileSync(snapPath, JSON.stringify(snap) + '\n');

  // Atomic write: an executive claude may be mid-read while a refresh lands.
  const outPath = path.join(DIR, 'board-data.json');
  fs.writeFileSync(outPath + '.tmp', JSON.stringify(board, null, 1));
  fs.renameSync(outPath + '.tmp', outPath);

  const active = ['CFO', 'COO', 'CMO'].concat(caps.research ? ['CTO'] : []).concat(caps.executives ? ['HR'] : []);
  console.log(`board-data.json written. Level ${level}. Active roles: ${active.join(', ')}` +
    ` | Gated: ${[!caps.research && 'CTO(Lv10)', !caps.bonds && 'bonds(Lv10)', !caps.executives && 'HR(Lv15)'].filter(Boolean).join(', ') || 'none'}`);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
