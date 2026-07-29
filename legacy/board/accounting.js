#!/usr/bin/env node
// Daily financial physical. Reads the game's own accounting statements (structured JSON,
// not scraped text) and turns them into a verdict + concrete actions the operation should
// take. Jimmy's directive 2026-07-22: "every day, learn from the accounting page and
// improve the company."
//
// The core insight the ledger forced: NET INCOME lies. It folds in one-off gameIncome
// (achievements, bets, starting capital). The real health metric is OPERATING profit —
// sales minus what it truly cost to make and move them. This module isolates that, finds
// the biggest bleed, and writes findings the strategist acts on.
//
//   node accounting.js            fetch, analyse, print, append to finance-log.jsonl
//   node accounting.js --json     machine output only
//
// Must run under flock (shares the browser). Called by the strategist and by a daily cron.

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.js');
const DIR = __dirname;

const JSON_ONLY = process.argv.includes('--json');

async function fetchStatements() {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/accounting/');
  const data = await cdp.evaluate(`
    const out = {};
    for (const [k, p] of [
      ['income', '/api/v2/companies/me/income-statement/'],
      ['cashflow', '/api/v2/companies/me/cashflow-statement/'],
      ['balance', '/api/v2/companies/me/balance-sheet/'],
    ]) {
      const r = await api(p);
      out[k] = r.json || null;
      await sleep(400);
    }
    // Recent line items expose per-category disbursements (which input is bleeding).
    const cf = await api('/api/v2/companies/me/cashflow/recent/');
    out.recent = (cf.json && cf.json.data) || [];
    return out;`);
  return data;
}

// Derive the operating truth from the raw statement fields.
function analyse(s) {
  const inc = s.income, cf = s.cashflow, bal = s.balance;
  if (!inc || !cf || !bal) return { ok: false, reason: 'statements incomplete' };

  // Operating profit = the business only, no one-off game income.
  const grossProfit = inc.sales + inc.cogs + inc.freightOut;         // cogs/freight are negative
  const opex = inc.constructionCosts + inc.marketFees + inc.salariesCosts +
               inc.accountingOverhead + inc.bondInterestExpense;
  const operatingProfit = grossProfit + opex;
  const grossMarginPct = inc.sales ? grossProfit / inc.sales * 100 : 0;

  // Where the cash actually went, biggest first, from the recent ledger — but CAPEX and OPEX
  // must be told apart. Construction materials bought to erect a building (the Mill kit was
  // 24 reinforced concrete / 330 bricks / 96 planks / 8 construction units) are one-off
  // capital spend that then vanishes into the building; they are NOT a recurring operating
  // leak. The >40%-of-sales bleed rule exists to catch an operating leak, so folding capex in
  // trips a false HIGH on every single build ("self-supply construction units" is nonsense
  // advice for a one-off kit). Partition them: capex is surfaced on its own line, only opex
  // feeds the bleed test.
  // NOTE: matched by material name. If a future Construction factory ever BUYS these as
  // production inputs (not to build), revisit — under the farm/mill/store/bakery/oil-rig plan
  // these resources are only ever bought to erect a building.
  const CAPEX_MATERIAL = /construction unit|reinforced concrete|\bconcrete\b|\bbrick|\bplank|\bcement\b|\bsteel\b|\bglass\b|\bwindow|alumini|girder|\bnails?\b|\btools?\b/i;
  const isCapex = (label) => /bought|purchase/i.test(label) && CAPEX_MATERIAL.test(label);
  const spendByCategory = {}, capexByCategory = {};
  for (const row of s.recent || []) {
    const amt = row.money ?? row.amount ?? 0;
    if (amt >= 0) continue;
    const label = (row.description || row.label || 'other')
      .replace(/\s*\(-\)\s*$/, '').replace(/\$[\d,]+/g, '').trim();
    const key = label.replace(/\d+/g, '').replace(/\s+/g, ' ').trim() || 'other';
    const bucket = isCapex(label) ? capexByCategory : spendByCategory;
    bucket[key] = (bucket[key] || 0) + Math.abs(amt);
  }
  const bleeds = Object.entries(spendByCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const capexItems = Object.entries(capexByCategory).sort((a, b) => b[1] - a[1]);
  const capexTotal = capexItems.reduce((sum, [, v]) => sum + v, 0);

  // Inventory that is frozen cash — materials + WIP + finished goods sitting idle.
  const frozenInventory = bal.materials + bal.workInProcess + bal.finishedGoods;

  return {
    ok: true,
    period: inc.date,
    sales: inc.sales,
    cogs: -inc.cogs,
    grossProfit, grossMarginPct: +grossMarginPct.toFixed(1),
    operatingProfit,
    netIncome: inc.netIncome,
    gameIncome: inc.gameIncome,
    eva: inc.economicValueAdded,
    realBusinessHealthy: operatingProfit > 0,
    dependsOnOneOffs: inc.gameIncome > Math.abs(operatingProfit) * 2,
    cashFromRetail: cf.fromRetail,
    cashToExchange: cf.toExchange,
    cashToEmployees: cf.toEmployees,
    bleeds,
    capexItems, capexTotal,
    frozenInventory,
    companyValue: bal.cash + frozenInventory + bal.buildings + bal.constructionInProgress,
    buildings: bal.buildings,
    cash: bal.cash,
  };
}

// Turn the analysis into recommendations the strategist will execute.
function recommend(a) {
  const recs = [];
  if (!a.realBusinessHealthy) {
    recs.push({ severity: 'HIGH', issue: `operating profit is $${a.operatingProfit} — the real business is losing money`,
                action: 'The paper gains are one-off game income. Priority: get a high-margin line running (Mill/coffee) and stop the biggest bleed below.' });
  }
  if (a.grossMarginPct < 30) {
    recs.push({ severity: 'MED', issue: `gross margin only ${a.grossMarginPct}%`,
                action: 'Inputs are eating the product. Either self-supply the costliest input or switch to a higher-margin product.' });
  }
  const topBleed = a.bleeds[0];
  if (topBleed && topBleed[1] > a.sales * 0.4) {
    recs.push({ severity: 'HIGH', issue: `"${topBleed[0]}" cost $${Math.round(topBleed[1])} — over 40% of sales`,
                action: /water|power|input|bought/i.test(topBleed[0])
                  ? 'A bought input dominates spend — self-supplying it (reservoir/power plant) or buying it in bulk at dips beats emergency buys.'
                  : 'Investigate this line; it is the largest single drain.' });
  }
  if (a.frozenInventory > a.cash * 0.5) {
    recs.push({ severity: 'LOW', issue: `$${a.frozenInventory} frozen in inventory (materials/WIP/finished)`,
                action: 'Cash is tied up in stock. Sell finished goods faster or cut order sizes toward the sweet spot.' });
  }
  if (!recs.length) recs.push({ severity: 'OK', issue: 'operating profit positive, margins healthy, no dominant bleed', action: 'Stay the course; keep compounding into the next building.' });
  return recs;
}

(async () => {
  const s = await fetchStatements();
  cdp.close();
  const a = analyse(s);
  if (!a.ok) { console.error('FAIL:', a.reason); process.exit(1); }
  const recs = recommend(a);

  // Append a dated snapshot so day-over-day trend is visible.
  fs.appendFileSync(path.join(DIR, 'finance-log.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), ...a, recs }) + '\n');

  if (JSON_ONLY) { console.log(JSON.stringify({ ...a, recs }, null, 2)); process.exit(0); }

  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  console.log('════════ DAILY FINANCIAL PHYSICAL ════════');
  console.log(`period ending ${a.period?.slice(0, 10)}`);
  console.log(`Sales ${money(a.sales)}  COGS ${money(-a.cogs)}  Gross ${money(a.grossProfit)} (${a.grossMarginPct}%)`);
  console.log(`OPERATING PROFIT  ${money(a.operatingProfit)}   ${a.realBusinessHealthy ? '✅ business profitable' : '🔴 business LOSING money'}`);
  console.log(`Net income ${money(a.netIncome)} — but ${money(a.gameIncome)} of that is one-off game income${a.dependsOnOneOffs ? ' (paper gains depend on it)' : ''}`);
  console.log(`Company value ${money(a.companyValue)}  |  frozen inventory ${money(a.frozenInventory)}`);
  console.log('\nbiggest cash drains (operating):');
  for (const [label, amt] of a.bleeds) console.log(`  ${money(amt).padStart(9)}  ${label}`);
  if (a.capexTotal > 0) {
    console.log(`\ncapex this period ${money(a.capexTotal)} (build materials, one-off — excluded from operating bleed):`);
    for (const [label, amt] of a.capexItems) console.log(`  ${money(amt).padStart(9)}  ${label}`);
  }
  console.log('\nRECOMMENDATIONS:');
  for (const r of recs) console.log(`  [${r.severity}] ${r.issue}\n         → ${r.action}`);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
