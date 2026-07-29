#!/usr/bin/env node
// Sim Companies autopilot — one management tick.
//
// Each run: collect finished orders, then refill every idle building with the
// highest-scoring order it can run. Scoring mode is configurable because the two
// goals pull in different directions:
//   mode=profit  maximise $/hour        (cash growth)
//   mode=xp      maximise revenue/hour  (company level, if XP tracks revenue)
// The tick also appends an observation to xp-ledger.jsonl so the XP formula can be
// derived from real data instead of guessed at — see calibrate.js.
//
// Usage: node tick.js [--mode profit|xp] [--dry]

const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.js');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const LOG = path.join(DIR, 'bot.log');
const LEDGER = path.join(DIR, 'xp-ledger.jsonl');

const argv = process.argv.slice(2);
const modeIdx = argv.indexOf('--mode');
const MODE = (modeIdx >= 0 ? argv[modeIdx + 1] : null) || CFG.mode || 'profit';
const DRY = argv.includes('--dry');

const page = (f) => fs.readFileSync(path.join(DIR, 'pages', f), 'utf8');

// Human-facing output is in the machine's own timezone, which is also what the game UI
// shows — reading a log against the game meant a five-hour conversion every time. The
// abbreviation is kept so the line stays unambiguous across a DST change.
const TZ = 'America/Chicago';
function localTime(d = new Date()) {
  const stamp = d.toLocaleString('sv-SE', { timeZone: TZ });          // 2026-07-21 19:59:42
  const abbr = d.toLocaleTimeString('en-US', { timeZone: TZ, timeZoneName: 'short' })
    .split(' ').pop();                                                 // CDT
  return `${stamp} ${abbr}`;
}
function log(...parts) {
  const line = `${localTime()} ${parts.join(' ')}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

const B = (id) => `https://www.simcompanies.com/b/${id}/`;

// Production rate: the game PRINTS "Production: X/h" on every building page, and that number
// is ground truth (DOCTRINE Rule 1). The raw x level x 0.8087 model reproduces the FARM to
// within 0.1% (seeds 2,695.85/h printed vs 1100 x 3 x 0.8087 x 1.01 modelled) but overstates
// the MILL by 1.76x — measured 2026-07-23 off /b/55042846/: powder 17.86/h, flour 88.13/h,
// fodder 287.57/h against a model of 31.1 / 190 / 620. All three Mill products share the same
// 0.4638 constant where the Farm shares 0.8168, so it is a per-building factor the model does
// not capture, not noise. An overstated rate writes a too-LONG order: the 08:20 grind was
// sized for ~12h and the game quoted 20h57m with $8,136 of wages prepaid — exactly the
// over-commitment DOCTRINE Rule 5b forbids, and wages are forfeited if the order is cancelled.
// So a measured printed rate always beats the model. Populate config.printedRates from the
// building page (see printed-rates.js); anything absent falls back to the model as before.
// Caveat: a printed rate is measured at the acceleration in force when it was read. The realm
// has been x1 since 2026-07-22 15:42 CDT; if acceleration ever returns, RE-MEASURE.
function rateFor(kind, modelled) {
  const pr = (CFG.printedRates || {})[String(kind)];
  return (typeof pr === 'number' && pr > 0) ? pr : modelled;
}

// Strategist wake throttle. A strategist run executes the FULL STRATEGIST.md sequence
// (chat + prices + books + industry re-rank), so a single wake covers every standing
// signal at once. run-strategist.sh deletes the *.flag files on exit, which would let a
// still-true condition — a persistent PA offer that needs cash we don't have yet, a
// slow-moving price dip whose trailing median hasn't caught up — re-spawn a fresh Opus
// strategist every 2-minute heartbeat. Gate spawns on a shared timestamp so we wake at
// most once per cooldown no matter how many signals stand. Measured 2026-07-23: an open
// "200 sausages -> +1 building level" PA offer (deferred until cash turns positive) plus
// an eggs DIP both sat true for ~1h — without this they would have re-woken ~30 strategists.
function maybeWakeStrategist(why) {
  if (DRY) return false;   // a dry run must never spawn — the strategist's own --dry would recurse
  const tsFile = path.join(DIR, '.strategist-wake');
  const cooldownMs = ((CFG.strategistWake || {}).cooldownMin || 90) * 60000;
  let last = 0;
  try { last = fs.statSync(tsFile).mtimeMs; } catch (e) { /* first wake ever */ }
  if (Date.now() - last < cooldownMs) { log(`WAKE ${why} — on cooldown, not spawning`); return false; }
  fs.writeFileSync(tsFile, new Date().toISOString() + '\n');
  // run-strategist.sh (bash, serial — restored 2026-07-24 after the workflow runners were found
  // to only complete their FIRST phase: the headless claude launching Workflow returned before the
  // background orchestrator finished, so Decide/CEO never ran. Re-point here to the working runner
  // until the workflow versions' wait-mechanism is fixed and verified).
  require('child_process').spawn('/srv/appdata/chrome-automation/sim/run-strategist.sh',
    [], { detached: true, stdio: 'ignore' }).unref();
  log(`WAKE ${why} — strategist woken`);
  return true;
}

// --- realizable-demand guard (board/.realizable.json, written by realizable.js) -----------------
// Advisory demand verdicts (DOCTRINE Rule 4d): how much of a product's output the market can
// actually absorb. The fast loop uses this ONLY to annotate surplus alerts so the strategist sees
// WHY a good is piling (OVERSUPPLIED vs a genuine backlog) — never to change strategy. FAIL-OPEN:
// missing / malformed / STALE data => { fresh:false } => every caller keeps its pre-metric behaviour.
function loadRealizable() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'board', '.realizable.json'), 'utf8'));
    const ageMs = Date.now() - Date.parse(j.generated || 0);            // NaN if timestamp missing/bad
    const staleMs = ((CFG.realizable || {}).maxAgeHours || 12) * 3600e3;
    if (!j.byKind || !(ageMs < staleMs)) return { byKind: {}, fresh: false };  // absent/old -> fail open
    return { byKind: j.byKind, fresh: true, generated: j.generated };
  } catch (e) { return { byKind: {}, fresh: false }; }                  // absent/corrupt -> fail open
}

// Record the PA offer the moment it is seen, because the fast loop and the strategist do
// not share a clock. The wake throttle above is 90 minutes; a PA offer can be answered by
// something other than us and vanish inside that window (2026-07-23 14:24: an eggs offer
// arrived and was closed before any strategist read it, and the run that followed could
// only guess at what it had been). A capture costs one page click on a signal that fires a
// few times a day, and it makes the miss measurable instead of invisible.
//
// Deliberately capture-once-per-offer, not once-per-heartbeat: opening the conversation is
// the same action that clears the unread badge, so re-opening it every 2 minutes is exactly
// how a pending offer would get marked read behind the strategist's back. The options list
// is the signature — a new offer changes it, a still-pending one does not.
async function capturePaOffer() {
  const file = path.join(DIR, 'pa-offers.jsonl');
  try {
    const seen = await cdp.evaluate(page('pa-read.js'));
    if (!seen || !seen.ok) { log('PA capture skipped:', (seen && seen.reason) || 'no result'); return; }
    // Signature is options + the tail's last stretch, not options alone: a flavour event with
    // no choices signs as [] and so would every other one, collapsing distinct events into a
    // single record. The tail moves whenever the PA says anything new.
    const tail = seen.tail || '';
    const sigOf = (o) => JSON.stringify(o.options || []) + '|' + (o.tail || '').slice(-200);
    let last = null;
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    } catch (e) { /* first capture ever */ }
    if (last && sigOf(last) === sigOf({ options: seen.options, tail })) return;   // already on file
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(), atLocal: localTime(),
      options: seen.options || [], tail: (seen.tail || '').slice(-700),
    }) + '\n');
    log(`PA offer captured (${(seen.options || []).length} choices) -> pa-offers.jsonl`);
  } catch (e) {
    log('PA capture failed:', e.message);   // never let a diagnostic break the tick
  }
  try { await cdp.goto('https://www.simcompanies.com/messages/'); } catch (e) { /* caller re-navigates anyway */ }
}

// ---------------------------------------------------------------- state

// Sessions expire. Unattended, a logged-out browser turns every later tick into a silent
// no-op, so check first and sign back in from the 600-mode .creds file when needed.
async function ensureLoggedIn() {
  const where = await cdp.evaluate('return location.pathname');
  const looksOut = /^\/(signin|$)/.test(where) ||
    await cdp.evaluate("return /Sign in|START PLAYING/i.test(document.body.innerText) && !/Lv\\./.test(document.body.innerText)");
  if (!looksOut) return false;
  log('SESSION lost — signing back in');
  await cdp.goto('https://www.simcompanies.com/signin/');
  const res = await cdp.evaluate(page('login.js')).catch(e => ({ ok: false, reason: e.message }));
  await new Promise(r => setTimeout(r, 4000));
  log('SESSION relogin ->', JSON.stringify({ ok: res && res.ok }));
  return true;
}

async function readState() {
  // Capture on the store page, not /landscape/: the landscape never requests
  // /api/v3/resources/, so reading state there leaves stock empty and the store looks
  // like it has nothing to sell. The store page fetches buildings, auth-data AND stock.
  const cap = await cdp.capture(B(CFG.storeId), 15);
  const auth = cap['/api/v3/companies/auth-data/'];
  const buildings = cap['/api/v2/companies/me/buildings/'];
  const resources = cap['/api/v3/resources/' + CFG.companyId + '/'];
  const ticker = cap['/api/v3/market-ticker/0/'];
  const retail = cap['/api/v4/0/resources-retail-info/'];
  const modsRaw = cap['/api/v2/production-modifiers/0/'];
  if (!auth || !buildings) throw new Error('state capture incomplete');

  // Live event modifiers (+21% beans, −23% coffee powder, ...). Missing them skews every
  // rate: the encyclopedia audit found nine active, my hardcoded model had three.
  const mods = {};
  for (const m of (modsRaw?.resourceProductionModifiers || [])) {
    if (new Date(m.until).getTime() > Date.now()) mods[m.kind] = m.speedModifier;
  }

  // The game publishes the current retail average per resource. Use it instead of the
  // snapshot baked into config so the price sweep follows the market as it moves.
  const retailAvg = {};
  for (const r of retail || []) {
    if (r.dbLetter != null && r.averagePrice) retailAvg[r.dbLetter] = +r.averagePrice.toFixed(3);
  }

  const stock = {};
  for (const r of resources || []) {
    const total = Object.values(r.cost).reduce((a, b) => a + b, 0);
    stock[r.kind] = { amount: r.amount, unitCost: total / r.amount };
  }
  const price = {};
  for (const t of ticker || []) price[t.kind] = t.price;

  return {
    money: auth.authCompany.money,
    level: auth.levelInfo.level,
    xp: auth.levelInfo.experience,
    xpNext: auth.levelInfo.experienceToNextLevel,
    maxBuildings: auth.levelInfo.maxBuildings,
    accel: (() => {
      // The x3 new-account acceleration expires. Reading it live means every rate-based
      // decision self-corrects the moment it lapses, instead of being wrong by 3x.
      const a = auth.levelInfo.acceleration;
      const live = a && new Date(a.until).getTime() > Date.now();
      return { multiplier: live ? a.multiplier : 1, until: a?.until || null, active: !!live };
    })(),
    buildings, stock, price, retailAvg, mods,
    realizable: loadRealizable(),        // advisory demand verdicts, fail-open (see loadRealizable)
  };
}

// What a building has actually been earning, from its own recent orders. Used to price
// upgrades against reality rather than against a guess.
function recentEarnRate(buildingId) {
  try {
    const rows = fs.readFileSync(path.join(DIR, 'observations.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l))
      .filter(o => (o.type === 'sell' || o.type === 'produce') && o.ok && o.perHour > 0);
    if (!rows.length) return null;
    const recent = rows.slice(-5);
    return recent.reduce((s, r) => s + r.perHour, 0) / recent.length;
  } catch { return null; }
}

// Learned parameters, when we have them, beat the config snapshot.
function knowledge() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'knowledge.json'), 'utf8')); }
  catch { return {}; }
}
function observe(rec) {
  fs.appendFileSync(path.join(DIR, 'observations.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');   // data stays ISO UTC
}

// ------------------------------------------------------------- decisions

// Probe every product the store can actually stock and let the game's own
// projection rank them. `Profit per hour` already nets out wages and our cost basis.
async function pickStoreOrder(state) {
  await cdp.goto(B(CFG.storeId));
  // Powder sells at ~$1,291/h at the store (measured 2026-07-23), ~4.5x grapes' $284/h, but the
  // Mill only supplies ~16/h — a trickle. Selling it as it drips fixates the single store slot on
  // micro-orders: powder always out-scores fruit on $/h, so the store keeps placing tiny powder
  // orders, sells at the ~16/h supply rate, idles between them, and never sells fruit. Instead
  // let powder accrue to a worthwhile burst, then sell it fast (~87/h); below the threshold
  // powder is NOT a candidate, so the store sells fruit and the powder buffer keeps building.
  const POWDER_BURST = CFG.powderBurst || 100;
  const powderStock = state.stock[119]?.amount || 0;
  const millUp = state.buildings.some(b => b.name === 'Mill')
    || (CFG.buildPlan?.enabled && /mill/i.test(CFG.buildPlan.next || ''));
  // minStock is the general form of the powder-burst idea: a product only competes for the
  // single sales queue once there is enough of it to be worth an order. Without it the 2
  // leftover sausages from the PA deal would out-score grapes on $/h and win the slot for a
  // two-unit sale.
  const candidates = CFG.storeProducts.filter(p =>
    (state.stock[p.kind]?.amount || 0) >= (p.minStock || 1) &&
    !(p.kind === 119 && powderStock < POWDER_BURST));
  if (!candidates.length) return null;

  // Sweet-spot cap for sales too: an order sized at today's x3 selling speed stretches 3x
  // if it crosses the acceleration expiry, so never commit past that boundary (plus a
  // 12h sanity cap). Uses the learned sell rate when fresh, else a conservative default.
  const hoursToAccelEnd = state.accel?.active
    ? Math.max(0.5, (new Date(state.accel.until) - Date.now()) / 3600e3) : 12;
  // Keep fruit orders short while powder is still accruing below the burst threshold, so the
  // store re-decides often and jumps on the powder buffer the moment it is worth a burst — a
  // 12h fruit lock would strand ~200 units of powder ($3k) behind it until it clears.
  const powderAccruing = millUp && powderStock < POWDER_BURST;
  const sellHorizon = Math.min(hoursToAccelEnd, powderAccruing ? 4 : 12);
  const k = knowledge();

  const results = [];
  for (const c of candidates) {
    const have = state.stock[c.kind].amount;
    const learned = k.sellRates?.[c.kind];
    const rate = (learned && learned.status === 'fresh') ? learned.sellRate : 400;
    let qty = Math.min(have, c.maxBatch || have, Math.max(200, Math.round(rate * sellHorizon)));
    const avg = state.retailAvg[c.kind] ?? c.avgPrice;   // live if available
    let best = null;
    // The 400/h fallback can size an order far past the decision horizon (real fruit rate
    // at x1 is ~150-160/h, so 400 x 12h quotes as a ~30h lock — fatal once the mill's
    // powder needs the store). The probe returns the game's own projected duration, so
    // trust it: if the pick overshoots the horizon, resize to the implied rate and
    // sweep once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      best = null;
      for (const mult of CFG.priceSweep) {
        await cdp.evaluate(`window.__probe={name:${JSON.stringify(c.name)},qty:${qty},price:${(avg * mult).toFixed(2)}}; return 1`);
        const r = await cdp.evaluate(page('probe-retail.js'));
        if (!r || !r.ok) continue;
        const perHour = Number((r.text.match(/Profit per hour: \$?(-?[\d,]+)/) || [])[1]?.replace(/,/g, ''));
        const hours = parseDuration(r.text);
        if (!isFinite(perHour) || !hours) continue;
        const revenuePerHour = (avg * mult) * qty / hours;
        const score = MODE === 'xp' ? revenuePerHour : perHour;
        if (perHour > 0 && (!best || score > best.score)) {
          best = { ...c, qty, price: +(avg * mult).toFixed(2), perHour, revenuePerHour, hours, score };
        }
      }
      if (!best || best.hours <= sellHorizon * 1.25 || qty <= 200) break;
      const resized = Math.min(have, Math.max(200, Math.round((best.qty / best.hours) * sellHorizon)));
      if (resized >= qty) break;   // implied rate not lower — nothing to fix
      log(`STORE resize ${c.name}: ${qty} -> ${resized} (probe said ${best.hours.toFixed(1)}h vs horizon ${sellHorizon}h)`);
      qty = resized;
    }
    if (best) results.push(best);
  }
  // Priority products (config.storePriority, e.g. coffee powder) win the single store slot
  // over everything else whenever they're a viable candidate — powder at ~$1,593/h must not
  // sit in the warehouse behind grapes at ~$291/h. Among priority products, and among the
  // rest, the $/h probe still ranks. Lower number = higher priority.
  const prio = CFG.storePriority || {};
  results.sort((a, b) => {
    const pa = prio[a.kind] ?? 99, pb = prio[b.kind] ?? 99;
    if (pa !== pb) return pa - pb;          // priority tier first
    return b.score - a.score;               // then $/h within the tier
  });
  return results[0] || null;
}

function parseDuration(text) {
  const m = text.match(/in (?:(\d+)h,?\s*)?(?:(\d+)m,?\s*)?(?:(\d+)s)?/);
  if (!m) return null;
  const h = (+m[1] || 0) + (+m[2] || 0) / 60 + (+m[3] || 0) / 3600;
  return h || null;
}

// The farm has spare capacity relative to the store, so pick the crop whose retail
// margin per unit is highest and simply run the longest order allowed.
function pickFarmOrder(state) {
  let best = null;
  for (const c of CFG.farmProducts) {
    const matCost = c.inputs.reduce((sum, [kind, mult]) => {
      const unit = state.stock[kind]?.unitCost ?? state.price[kind] ?? 0;
      return sum + unit * mult;
    }, 0);
    const realRate = c.baseRate * (state.accel?.multiplier ?? CFG.accelerationFactor ?? 1);
    const cost = matCost + CFG.farmWage / realRate;
    const profit = c.retailNet - cost;
    const score = MODE === 'xp' ? c.retailAvg * c.storeRate : profit * c.storeRate;
    if (!best || score > best.score) best = { ...c, cost, profit, score };
  }
  return best;
}

// ------------------------------------------------------------------ run

(async () => {
  await cdp.connect();

  // Collect before reading stock, not after: production releases output continuously
  // (the busy order exposes `amountAvailableNow`), so whatever just landed has to be
  // visible to the store decision in THIS tick. Deferring it to the next tick leaves
  // the bottleneck building idle for a full interval.
  await cdp.goto('https://www.simcompanies.com/landscape/');
  if (await ensureLoggedIn()) await cdp.goto('https://www.simcompanies.com/landscape/');
  const collected = await cdp.evaluate(page('collect.js'));
  if (collected.collected) log('COLLECT', JSON.stringify(collected.clicked));

  // Chat watch. The unread count is NOT in the nav-bar "Chat" link (that reads plain
  // "Chat" — the old detector saw null and silently treated every state as 0, so this never
  // fired). It's a trailing number on each row of the /messages/ page. We care only about
  // the PERSONAL ASSISTANT row: its offers are time-limited yes/no trades. Public rooms
  // (Sales 167, Social 180 …) are server-wide chatter — ignored on purpose. The fast loop
  // only DETECTS; the strategist replies (DOCTRINE §7). A flag + early wake handles it.
  try {
    await cdp.goto('https://www.simcompanies.com/messages/');
    const chat = await cdp.evaluate(`
      const rows = all('a').filter(a => (a.href || '').includes('/messages/')).map(a => norm(a.innerText));
      const pa = rows.find(t => /personal assistant/i.test(t));
      const paUnread = pa ? Number((pa.match(/(\\d+)\\s*$/) || [])[1] || 0) : 0;
      return { paUnread, rows };`);
    if (chat.paUnread > 0) {
      log(`CHAT assistant has ${chat.paUnread} unread`);
      fs.writeFileSync(path.join(DIR, 'chat-pending.flag'), new Date().toISOString() + '\n');
      await capturePaOffer();
      // Cash-gate: a PA purchase-offer the strategist already triaged but cannot complete until
      // cash turns positive (e.g. "200 sausages -> +1 building level" while a big Mill order
      // holds cash negative) should not re-wake a fresh strategist every cooldown to do nothing.
      // The strategist writes chat-ack.json {paUnread, needMoney, expiresAt}; suppress the wake
      // only while it still applies. Fails toward waking (any doubt -> wake); scheduled runs
      // (~every 4h) and the expiry are backstops, so a genuinely new offer is never stranded.
      let suppress = false;
      const ackFile = path.join(DIR, 'chat-ack.json');
      try {
        const ack = fs.existsSync(ackFile) && JSON.parse(fs.readFileSync(ackFile, 'utf8'));
        if (ack && ack.paUnread === chat.paUnread && Date.now() < ack.expiresAt) {
          const m = await cdp.evaluate("const r = await api('/api/v3/companies/auth-data/'); return r.json && r.json.authCompany ? r.json.authCompany.money : null");
          if (typeof m === 'number' && m < ack.needMoney) {
            suppress = true;
            log(`WAKE chat — ack holds, blocked on cash ($${m} < $${ack.needMoney}), suppressed`);
          } else { fs.unlinkSync(ackFile); }   // cash cleared (or unreadable) -> let it wake
        } else if (ack) { fs.unlinkSync(ackFile); }   // paUnread changed or ack expired -> stale
      } catch (e) { /* malformed ack -> fall through and wake */ }
      if (!suppress) maybeWakeStrategist('chat');   // throttled: a pending PA offer stays unread for hours
    } else {
      log('CHAT assistant clear' + (chat.rows.some(r => /\d/.test(r)) ? ' (public rooms have chatter, ignored)' : ''));
    }
  } catch (e) { log('CHAT check failed:', e.message); }

  const state = await readState();

  // Price watch: every tick records the watchlist and compares each price to its trailing
  // median. A dip on an input is a buying window (stock up before the Bakery needs it); a
  // spike on a sell-side product is margin worth locking. Either wakes the strategist —
  // a 4-hour cadence would sleep through most market moves.
  try {
    const wl = CFG.watchlist || {};
    if (!Object.keys(state.price).length) {
      const t = await cdp.evaluate("const r = await api('/api/v3/market-ticker/0/'); return r.json || []");
      for (const x of t) state.price[x.kind] = x.price;
    }
    const snap = {};
    for (const k of Object.keys(wl)) if (state.price[k] != null) snap[k] = state.price[k];
    if (Object.keys(snap).length) {
      const histFile = path.join(DIR, 'price-history.jsonl');
      fs.appendFileSync(histFile, JSON.stringify({ t: new Date().toISOString(), p: snap }) + '\n');
      let all = fs.readFileSync(histFile, 'utf8').trim().split('\n');
      const keep = (CFG.priceAlert || {}).windowSamples || 36;
      // price-history.jsonl is NOT in run-tick.sh's 5MB rotation set but is appended every tick;
      // compact it to a small multiple of the window so both the file and this per-tick read stay
      // bounded over weeks of unattended running. Single writer (this tick, under .tick.lock).
      if (all.length > keep * 4) { all = all.slice(-keep * 4); fs.writeFileSync(histFile, all.join('\n') + '\n'); }
      const lines = all.slice(-keep);
      const hist = lines.map(l => JSON.parse(l));
      const alerts = [];
      for (const [k, cur] of Object.entries(snap)) {
        const series = hist.map(h => h.p[k]).filter(v => v != null).sort((a, b) => a - b);
        if (series.length < 6) continue;
        const med = series[Math.floor(series.length / 2)];
        const movePct = (cur - med) / med * 100;
        // dipBelow: absolute gate for self-supplied inputs — a dip only matters if the
        // exchange undercuts our own production cost, not merely its own recent median.
        const dipOk = wl[k].dipBelow == null || cur < wl[k].dipBelow;
        if (movePct <= -(CFG.priceAlert.dipPct || 6) && dipOk) alerts.push(`${wl[k].name} DIP ${movePct.toFixed(1)}% ($${cur} vs med $${med})`);
        if (movePct >= (CFG.priceAlert.spikePct || 8)) alerts.push(`${wl[k].name} SPIKE +${movePct.toFixed(1)}% ($${cur} vs med $${med})`);
        // spikeAbove: absolute ceiling for watched inputs — median-relative rules miss a
        // slow climb through a hard decision line (e.g. the CU $2,820 hedge trigger).
        if (wl[k].spikeAbove != null && cur >= wl[k].spikeAbove) alerts.push(`${wl[k].name} ABOVE $${wl[k].spikeAbove} ($${cur})`);
      }
      log('PRICE ' + Object.entries(snap).map(([k, v]) => `${(wl[k].name || k)}=$${v}`).join(' '));
      if (alerts.length) {
        log('PRICE ALERT ' + alerts.join(' | '));
        fs.writeFileSync(path.join(DIR, 'price-alert.flag'), alerts.join('\n') + '\n');
        maybeWakeStrategist('price');   // throttled: a dip persists until its trailing median catches up
      }
    }
  } catch (e) { log('PRICE watch failed:', e.message); }

  // Surplus watch. The store runs ONE sales order at a time — measured 2026-07-23 off the
  // store page itself at level 2: "Building is currently busy and cannot sell other items
  // until the current order is finished." So retail throughput is a single shared queue, and
  // any line that produces faster than its share of that queue converts cash into inventory
  // rather than into cash. The Slaughterhouse makes ~48.5 steak/h against a store that also
  // has to move coffee powder, and tick.js has no auto-exchange-sell (selling is a judgement
  // call: retail nets ~$34.7/steak against ~$29.5 on the exchange, so dumping is a real cost,
  // not a free release). This does not sell anything — it makes the pile visible and wakes
  // the layer that is allowed to decide. Thresholds are hours-of-production, not round
  // numbers; see config surplusWatch.
  try {
    const over = [];
    for (const [kind, w] of Object.entries(CFG.surplusWatch || {})) {
      if (kind.startsWith('_') || !w || typeof w.max !== 'number') continue;   // config uses _keys as comments
      const have = state.stock[kind]?.amount || 0;
      if (have < w.max) continue;
      const px = state.price[kind];
      // Annotate with the realizable verdict so a surplus wake is actionable at a glance
      // (OVERSUPPLIED lake vs a genuine backlog). Diagnostic only — the loop still NEVER sells.
      const rv = (state.realizable && state.realizable.byKind || {})[String(kind)];
      const tag = (state.realizable && state.realizable.fresh && rv)
        ? ` [${rv.verdict}, realizable ~${Math.round(rv.realizablePerHour_preWage)}/h]` : '';
      over.push(`${w.name}: ${Math.round(have)} units (limit ${w.max})` +
                (px ? ` ≈ $${Math.round(have * px)} frozen at $${px}` : '') + tag);
    }
    const sflag = path.join(DIR, 'surplus-alert.flag');
    if (over.length) {
      fs.writeFileSync(sflag, over.join('\n') + '\n');
      log('SURPLUS ' + over.join(' | '));
      maybeWakeStrategist('surplus');   // throttled: a pile persists until someone sells it
    } else if (fs.existsSync(sflag)) {
      fs.unlinkSync(sflag);
      log('SURPLUS cleared — all watched stock back under its limit');
    }
  } catch (e) { log('SURPLUS watch failed:', e.message); }

  log(`STATE money=$${state.money} lvl=${state.level} xp=${state.xp}/${state.xpNext} ` +
      `accel=x${state.accel.multiplier}${state.accel.active ? '' : ' (EXPIRED)'} mode=${MODE}`);
  // Acceleration is a LADDER, not a cliff (owner-confirmed: x3 steps down to x2). Whatever
  // the server hands out, mirror it into the cold-start fallback and mark every regime
  // change loudly — measurements from a different tier are not comparable (learn.js keys
  // its freshness on this).
  if (CFG.accelerationFactor !== state.accel.multiplier) {
    log(`ACCEL regime change: x${CFG.accelerationFactor} -> x${state.accel.multiplier}` +
        (state.accel.until ? ` (until ${localTime(new Date(state.accel.until))})` : '') +
        ' — rate-based projections must be re-derived at the new tier');
    CFG.accelerationFactor = state.accel.multiplier;
    fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(CFG, null, 2));
  }

  observe({
    type: 'state', money: state.money, level: state.level,
    xp: state.xp, xpNext: state.xpNext, accel: state.accel,
    stock: Object.fromEntries(Object.entries(state.stock).map(([k, v]) => [k, v.amount])),
    retailAvg: state.retailAvg,
  });

  // Standing order: no building is ever idle. Each one either works or upgrades.
  // Upgrading is the fallback, not the goal — an upgrade at least converts idle time into
  // permanent capacity, whereas an idle building converts it into nothing.
  // Upgrade decisions are made here, not asked about. The test is payback: an upgrade
  // that doubles a building's output only earns back its cost at the rate that building
  // is *actually* earning, which is why upgrading a building that is not the bottleneck
  // scores badly on its own — the farm already out-produces the store, so doubling it
  // adds nothing and the payback comes out effectively infinite.
  function upgradeWorthIt(b, up) {
    const earning = recentEarnRate(b.id);            // $/h this building is really making
    if (earning == null) return { ok: true, why: 'no earnings history — allow within cost cap' };
    const gain = earning;                            // +100% output ~= +100% of current rate
    const payback = up.assumedCost ? up.assumedCost / gain : null;
    if (payback == null) return { ok: true, why: 'cost unknown until dialog opens' };
    if (payback > (up.maxPaybackHours || 48)) {
      return { ok: false, why: `payback ${Math.round(payback)}h exceeds ${up.maxPaybackHours || 48}h` };
    }
    return { ok: true, why: `payback ~${Math.round(payback)}h` };
  }

  async function tryUpgrade(b, why) {
    const up = (CFG.upgrades || {})[b.id];
    if (!up || up.enabled === false) { log(`IDLE ${b.name} — ${why}; upgrades disabled here`); return false; }
    const verdict = upgradeWorthIt(b, up);
    if (!verdict.ok) { log(`IDLE ${b.name} — ${why}; skipping upgrade: ${verdict.why}`); return false; }
    if (state.money <= up.minCashAfter) { log(`IDLE ${b.name} — ${why}; below operating reserve`); return false; }
    await cdp.goto(B(b.id));
    await cdp.evaluate(`window.__upgrade=${JSON.stringify({
      maxCost: up.maxCost, minCashAfter: up.minCashAfter, confirm: !DRY })}; return 1`);
    const res = await cdp.evaluate(page('upgrade.js'));
    log(`UPGRADE ${b.name} (${why}; ${verdict.why}) ->`, JSON.stringify(res).slice(0, 200));
    return !!res.ok;
  }

  // Free building slots are idle capacity too. Build when the plan says to and the cash is
  // there — the plan is deliberately conservative about *what*, because capacity added
  // behind the bottleneck earns nothing (a second farm while the store is the constraint
  // just converts cash into apples that cannot be sold).
  const plan = CFG.buildPlan;
  // Seasonal city-gift buildings do NOT consume a construction slot, so they must not be
  // counted against maxBuildings. The Beach market's own page says it "doesn't contribute to
  // the administration overhead, company building count, or company value", and the API
  // serves the flag directly: category "seasonal", freeAndLocked true, cost 0. Measured
  // 2026-07-23: /landscape/ renders the three real buildings plus TWO "CONSTRUCTION SLOT"
  // tiles against maxBuildings 5 — i.e. 2 free slots where this line reported 1. Counting the
  // Beach market hid a whole slot and would have silently blocked every build after the
  // Slaughterhouse (5 - 5 = 0) until Lv.10 raised maxBuildings and made the sum accidentally
  // right again.
  const slotUsers = state.buildings.filter(b => !b.freeAndLocked && b.category !== 'seasonal');
  const freeSlots = (state.maxBuildings || 4) - slotUsers.length;
  const slotFlag = path.join(DIR, 'slot-alert.flag');
  if (plan && plan.enabled && freeSlots > 0) {
    if (state.money >= plan.minCashToBuild) {
      await cdp.goto('https://www.simcompanies.com/landscape/');
      await cdp.evaluate(`window.__build=${JSON.stringify({
        building: plan.next, maxCost: plan.maxCost,
        minCashAfter: plan.minCashAfter, confirm: !DRY,
        effectiveCost: plan.effectiveCost })}; return 1`);
      const built = await cdp.evaluate(page('build.js'));
      log(`BUILD ${plan.next} ->`, JSON.stringify(built).slice(0, 220));
      observe({ type: 'build', ok: !!built.ok, building: plan.next,
                quoted: built.quoted, reason: built.reason });
      if (built.ok) {
        CFG.buildPlan.enabled = false;
        CFG.buildPlan._done = `${plan.next} built ${new Date().toISOString()} for ~$${built.quoted}`;
        fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(CFG, null, 2));
      }
    } else {
      log(`BUILD deferred — ${freeSlots} free slot(s), need $${plan.minCashToBuild} for ${plan.next}, have $${state.money}`);
    }
  } else if (freeSlots > 0) {
    // A free slot with nothing armed is idle capacity (Rule 5b), and the fast loop is not
    // allowed to pick the building — ranking industries against live prices is the
    // strategist's job. So make it loud and wake the layer that may decide, rather than
    // sitting on a slot in silence the way the miscount above did for two days.
    fs.writeFileSync(slotFlag, `${freeSlots} free construction slot(s), no armed build plan\n`);
    log(`SLOT FREE — ${freeSlots} construction slot(s) idle, no armed build plan`);
    // ...but only WAKE someone once the slot could actually be filled. A strategist woken with
    // $4.7k against a $23.2k cheapest candidate can do nothing but re-read the same table and
    // write the same "not affordable" note — and the flag is re-raised every heartbeat, so it
    // would do that once per cooldown all night. The flag itself still goes up (visible in the
    // log, cleared by run-strategist.sh) and the cash ladder guarantees a wake anyway: chat-ack
    // fires at $8k, this at slotAlert.minCash, and the scheduled runs are the backstop.
    const slotGate = (CFG.slotAlert || {}).minCash || 0;
    if (state.money >= slotGate) maybeWakeStrategist('slot');
    else log(`SLOT wake gated — $${Math.round(state.money)} < $${slotGate} minimum for any endorsed candidate`);
  } else if (fs.existsSync(slotFlag)) {
    fs.unlinkSync(slotFlag);
    log('SLOT cleared — no free construction slots');
  }

  for (const b of state.buildings) {
    if (b.busy) {
      const ends = new Date(new Date(b.busy.started).getTime() + b.busy.duration * 1000);
      const mins = Math.round((ends - Date.now()) / 60000);
      log(`BUSY ${b.name} until ${localTime(ends)} (${mins}m)`);
      continue;
    }
    if (b.id === CFG.storeId) {
      // (Store upgrades now go through the same tryUpgrade fallback as everything else;
      // the old CFG.upgrade single-shot branch was dead code after the config moved to
      // the plural CFG.upgrades map.)
      const order = await pickStoreOrder(state);
      if (!order) { await tryUpgrade(b, 'nothing in stock to sell'); continue; }
      log(`STORE pick ${order.name} x${order.qty} @ $${order.price} ` +
          `profit=$${order.perHour}/h revenue=$${Math.round(order.revenuePerHour)}/h`);
      if (DRY) continue;
      await cdp.evaluate(`window.__sell={name:${JSON.stringify(order.name)},qty:${order.qty},price:${order.price}}; return 1`);
      const sold = await cdp.evaluate(page('sell.js'));
      log('STORE sell ->', JSON.stringify(sold).slice(0, 200));
      observe({ type: 'sell', ok: !!sold.ok, kind: order.kind, name: order.name,
                qty: order.qty, price: order.price, perHour: order.perHour,
                hours: order.hours, unitCost: state.stock[order.kind]?.unitCost });
      if (!sold.ok) await tryUpgrade(b, 'sell failed: ' + sold.reason);
    } else if (b.name === 'Mill') {
      // Mill: grind whatever beans the farm has stocked. 10 beans -> 1 powder. Sized to
      // the bean stock (never triggers BUY MISSING for more than a smoothing top-up).
      const accel = state.accel?.multiplier ?? 1;
      const powderRate = rateFor(119, 50 * 0.8087 * accel * (1 + (state.mods?.[119] || 0) / 100));
      const beanStock = state.stock[118]?.amount || 0;
      const canMake = Math.floor(beanStock / 10);
      if (canMake < Math.round(powderRate)) {   // less than an hour of work — wait for beans
        log(`MILL waiting for beans (have ${beanStock}, want ≥${Math.round(powderRate) * 10})`);
        continue;
      }
      const qty = Math.min(canMake, Math.round(powderRate * 12));
      log(`MILL pick COFFEE POWDER x${qty} (beans=${beanStock}, rate=${powderRate.toFixed(1)}/h)`);
      if (DRY) continue;
      await cdp.goto(B(b.id));
      await cdp.evaluate(`window.__produce=${JSON.stringify({
        name: 'COFFEE POWDER', qty,
        maxBuyCost: 0, minCashAfter: CFG.minCash || 800 })}; return 1`);
      const made = await cdp.evaluate(page('produce.js'));
      log('MILL produce ->', JSON.stringify(made).slice(0, 220));
      observe({ type: 'produce', ok: !!made.ok, name: 'COFFEE POWDER', kind: 119, qty, spent: made.spent });
    } else if (CFG.factories && CFG.factories[b.name]) {
      // Market-fed factory (Slaughterhouse today; the Bakery and Oil rig drop into the same
      // block by adding a config entry). Unlike the farm, which grows its own inputs, and the
      // Mill, which the farm feeds, these buy every input on the exchange — so the order is
      // bounded by CASH, not by a harvest.
      //
      // produce.js never clicks BUY MISSING (that is the control that stalled the farm for
      // 7 hours), so the inputs are bought up front here and the order is then sized strictly
      // to what actually landed in the warehouse.
      const f = CFG.factories[b.name];
      const inputs = Object.entries(f.inputs);
      const unitInput = inputs.reduce((s, [k, per]) => s + (state.price[k] || 0) * per, 0);
      // Wages are prepaid at order time, so they are part of the bill cash has to cover.
      // wageSafety guards the modelled rate: the Mill's realised rate came in at half its
      // model, which would double the hours — and therefore the wages — of a given order.
      // config.printedRates wins over the config rate the moment the building exists and its
      // page has been read — f.rate is modelled off the same raw x 0.8087 formula that came
      // in 1.76x high for the Mill, so it is a placeholder until measured.
      const fRate = rateFor(f.kind, f.rate);
      const unitCost = unitInput + (f.wage / fRate) * (f.wageSafety || 1);
      // Buying cows to keep a $23k Slaughterhouse working is NOT discretionary spend, so it must
      // be gated by an OPERATING floor, not the $5k discretionary minCash — exactly the fix the
      // farm's water buy got on 2026-07-23 (farmInputFloor). Measured 2026-07-24 00:02: with the
      // $5k floor, `spendable = 4881-5000 = 0` idled the brand-new Slaughterhouse at $0/h while
      // $6k of grapes sat frozen (DOCTRINE §4 "does not stop working"; 6a "unfreeze before
      // declaring a shortage"). factoryInputFloor ($2,500) leaves ample cover for farm water
      // (own $500 floor) + reserve while letting the order self-size smaller when cash is tight.
      const spendable = Math.max(0, state.money - (CFG.factoryInputFloor || 2500));
      let qty = Math.min(Math.round(fRate * (f.maxOrderHours || 8)),
                         Math.floor(spendable / unitCost));
      if (qty < Math.round(fRate)) {          // under an hour of work — wait for cash
        log(`${b.name} waiting for cash — spendable $${Math.round(spendable)} at ` +
            `$${unitCost.toFixed(2)}/unit buys only ${qty} ${f.product}`);
        continue;
      }
      for (const [k, per] of inputs) {
        const have = state.stock[k]?.amount || 0;
        const need = qty * per;
        if (have >= need) continue;
        const ask = state.price[k] || 0;
        const spend = Math.ceil((need - have) * ask * 1.05);
        log(`${b.name} needs ${Math.ceil(need)} of kind ${k} for ${qty} ${f.product}, ` +
            `has ${have} — buying $${spend}`);
        if (DRY) continue;
        await cdp.goto(`https://www.simcompanies.com/market/resource/${k}/`);
        await cdp.evaluate(`window.__buy={kind:${Number(k)}, maxSpend:${spend}, ask:${ask}}; return 1`).catch(() => {});
        const bought = await cdp.evaluate(page('buy.js')).catch(e => ({ ok: false, reason: e.message }));
        log(`${b.name} input buy ->`, JSON.stringify(bought).slice(0, 150));
        // Size to stock ON HAND with 5% headroom for the game's ceil-rounding, exactly as the
        // farm does with water, so PRODUCE is enabled and no input is consumed on a failure.
        const now = bought.stockNow != null ? bought.stockNow : have;
        qty = Math.min(qty, Math.floor(now * 0.95 / per));
      }
      if (qty < 1) { log(`${b.name} — inputs unavailable, skipping (cash self-heals)`); continue; }
      log(`${b.name} pick ${f.product} x${qty} ($${unitCost.toFixed(2)}/unit, ` +
          `~${(qty / fRate).toFixed(1)}h at ${fRate.toFixed(1)}/h` +
          `${(CFG.printedRates || {})[String(f.kind)] ? ' printed' : ' MODELLED'})`);
      if (DRY) continue;
      await cdp.goto(B(b.id));
      await cdp.evaluate(`window.__produce=${JSON.stringify({
        name: f.product, qty, maxBuyCost: 0, minCashAfter: CFG.minCash || 800 })}; return 1`);
      const made = await cdp.evaluate(page('produce.js'));
      log(`${b.name} produce ->`, JSON.stringify(made).slice(0, 220));
      observe({ type: 'produce', ok: !!made.ok, name: f.product, kind: f.kind, qty });
      // As with the farm: a produce failure never justifies spending cash on an upgrade.
      // Repeats trip the stuck detector below, which wakes the strategist to fix it.
      if (!made.ok) log(`${b.name} produce failed (${made.reason}) — retry smaller next tick`);
    } else if (b.id === CFG.farmId) {
      // Sweet-spot sizing (owner principle 2026-07-21: no shortage, no overflow — of time
      // or money). An order should commit the building exactly up to the next moment the
      // plan might change, no further:
      //   - the acceleration expiry (a regime change: rates ÷3),
      //   - the next build gate at the current earn rate (the farm may need to switch
      //     products the moment the Mill lands),
      // clamped to [2h, 24h]. Shorter churns for nothing; longer freezes prepaid wages and
      // inputs past a known decision point, and cancelling forfeits them.
      const level = CFG.farmLevel || 2;
      const accel = state.accel?.multiplier ?? 1;
      // Guard on .active, not just .until: auth-data keeps the expired boost entry, and a
      // past `until` clamped at 0.5h would pin the horizon to the 2h floor forever.
      const hoursToAccelEnd = state.accel?.active && state.accel?.until
        ? Math.max(0.5, (new Date(state.accel.until) - Date.now()) / 3600e3) : 24;
      const earn = recentEarnRate(CFG.storeId) || 900;
      const gate = (CFG.buildPlan && CFG.buildPlan.enabled) ? CFG.buildPlan.minCashToBuild : null;
      const hoursToGate = gate && gate > state.money ? (gate - state.money) / earn : 24;
      const horizon = Math.min(24, Math.max(2, Math.min(hoursToAccelEnd, hoursToGate)));

      const seedStock = state.stock[66]?.amount || 0;
      const waterStock = state.stock[2]?.amount || 0;
      const appleRate = 202.19 * level * accel;
      const seedRate = 889.63 * level * accel;

      // Input affordability is part of the horizon (the money side of the sweet spot):
      // an order may consume at most the water on hand plus a bounded top-up — 15% of
      // spendable cash per order, never more than maxInputBuy. Without this cap a 13h
      // order would quietly convert the entire Mill fund into water (seen in simulation:
      // 47.7k water needed, $14.3k). Orders stay affordable BY CONSTRUCTION, which also
      // turns produce.js's post-hoc budget check into a true backstop instead of a lie.
      const waterPrice = state.price[2] || 0.39;
      // Essential water is guarded by the OPERATING RESERVE (farmInputFloor, $500), NOT the
      // $5k discretionary minCash. minCash was sized for x3-era mega water-buys ($4.6k); at x1
      // a grape order's water is ~$150, so the $5k floor idled the farm whenever the Mill wage
      // prepay dipped cash into the $0.5k-5k band (stall measured 2026-07-23). The 0.15 throttle
      // below + per-order shortfall sizing keep each top-up small, so this cannot drain cash.
      const spendable = Math.max(0, state.money - (CFG.farmInputFloor || 500));
      // While an enabled build gate is unfunded but within a shift of being reached, the
      // farm must not eat the build fund: $600 covers a full horizon of the cheap crops
      // (seeds 0.1 / beans 0.5 water per unit) but blocks the $1-3k fruit water buys that
      // would push the gate back by hours for fruit a backlogged store cannot sell anyway.
      const gateSoon = gate && gate > state.money && hoursToGate < 12;
      // Throttle 0.08 (was 0.15): with the floor lowered to the $500 reserve, 0.15 let a
      // cash-rich farm convert ~$2.3k/tick into grape-water, and the L3 farm out-produces the
      // store ~5:1, so that just piles grape inventory. 0.08 still gives a positive top-up at
      // low cash (~$66/tick at $1.3k -> unstalls) but caps high-cash water-buying BELOW the
      // pre-fix baseline (~$1.24k vs $1.65k at $16k). Bounds the cash->grape overproduction drain.
      const inputBudget = Math.min(CFG.maxInputBuy || 0, Math.round(spendable * 0.08),
                                   gateSoon ? 600 : Infinity);
      const waterCapacity = waterStock + inputBudget / waterPrice;

      // Once a Mill exists the farm's first duty is keeping it fed: beans are the input
      // to the highest-margin line we own. Priority: seeds (they feed everything) →
      // beans (mill hungry) → apples (store).
      const mill = state.buildings.find(x => x.name === 'Mill');
      const millCount = state.buildings.filter(x => x.name === 'Mill').length || 1;
      const beanStock = state.stock[118]?.amount || 0;
      const beanMod = 1 + (state.mods?.[118] || 0) / 100;
      const beanRate = rateFor(118, 510 * 0.8087 * level * accel * beanMod);
      const powderRate = rateFor(119, 50 * 0.8087 * accel * (1 + (state.mods?.[119] || 0) / 100));
      // Beans are sized to what the Mills DRAIN (~10 beans / powder / mill), not to what the
      // farm can GROW. The L3 farm grows ~1,527 beans/h but one L1 Mill drains only ~180/h, so a
      // production-rate bean order (beanRate x horizon ~ 12k) buries cash as WIP — measured
      // 2026-07-24, beans piled to 14,695 (~$10.9k frozen) while the Mill chewed 180/h. Target a
      // consumption buffer (millCount x powderRate x 10 x beanBufferHours) and refill only up to
      // it. Scales automatically when a 2nd Mill lands (millCount 1 -> 2 -> 360 beans/h drain).
      const beanBufferTarget = Math.round(powderRate * 10 * millCount * (CFG.beanBufferHours || 12));
      // A planned Mill counts as a hungry one: the farm should walk into the build with
      // ~12h of beans already stocked so the first grind starts the moment construction
      // ends, instead of the mill sitting idle while beans accumulate.
      const millPlanned = !mill && plan && plan.enabled && /mill/i.test(plan.next || '');
      const millHungry = (mill || millPlanned)
        && beanStock < powderRate * 10 * millCount * (mill ? Math.min(horizon, 6) : 12);

      // Buy water FIRST (if low), re-read stock, THEN size the order to what's actually on
      // hand. The old order was: size to old water → buy → but the order was already sized
      // small, so the farm stalled. buy.js is API-verified now; BUY MISSING is never used.
      let effectiveWater = waterStock;
      // Water PER UNIT for each crop, straight from the recipes (defs). Grapes use 4, not
      // the 3 that a hardcoded apple divisor assumed — that mismatch made every grape order
      // ask for BUY MISSING and stall the farm. Seeds/beans have their own water cost.
      const waterPerUnit = { SEEDS: 0.1, 'COFFEE BEANS': 0.5, APPLES: 3, ORANGES: 3, GRAPES: 4 };

      // Decide the crop first (so we know its water cost), THEN buy enough water for a full
      // horizon of it, THEN size to what's on hand. Buying is triggered by "not enough for a
      // decent order", not a fixed 3000 threshold that a 10k-water grape order sailed past.
      let cropName;
      // Hard seed floor 2,000 (board 2026-07-22): ~3h of bean feed. The horizon-scaled
      // trigger alone lets seeds coast to ~1.6k before a long bean order drains them dry.
      if (seedStock < Math.max(2000, appleRate * Math.min(horizon, 4))) cropName = 'SEEDS';
      else if (millHungry) cropName = 'COFFEE BEANS';
      else cropName = pickFarmOrder(state).name;

      // The sweet spot (Rule 5b) binds on the OUTPUT side too, not just on cash. The L3 farm
      // grows ~600 grapes/h while the single store retails ~135/h, so a full-horizon fruit
      // order converts cash into water and then into inventory that can only be dumped on the
      // exchange at ~$0.9 net against $2.35 in the store. Grow only what the store can
      // plausibly sell over the horizon, less what is already on the shelf; if that is under
      // an hour of farm output, grow beans instead — the Mill actually consumes those.
      const fruitKinds = { APPLES: 3, ORANGES: 4, GRAPES: 5 };
      let fruitRoom = null;
      if (fruitKinds[cropName]) {
        const fk = fruitKinds[cropName];
        const learned = knowledge().sellRates?.[fk];
        const storeRate = (learned && learned.sellRate) || 150;
        const onShelf = state.stock[fk]?.amount || 0;
        // Buffer to fruitBufferHours (8h), NOT the full 24h order horizon. storeRate (~136/h) is
        // grapes' rate when they OWN the queue, but the single store queue is now shared with
        // steak+powder (higher $/h), so a 24h buffer (3,268) is stock the shared queue cannot
        // clear — it just freezes cash the Slaughterhouse needs for cows. Measured 2026-07-24:
        // grapes piled 1,121→1,937 against a 1,500 watch limit while the farm chased the 24h
        // target. An 8h buffer (~1,088) still leaves the store hours of grapes and lets the farm
        // spend the freed time on beans, which the Mill actually consumes (Rule 5b: no overflow).
        fruitRoom = Math.max(0, Math.round(storeRate * Math.min(horizon, CFG.fruitBufferHours || 8)) - onShelf);
        if (fruitRoom < appleRate) {
          // Fruit shelf is full. The old code fell back to COFFEE BEANS here unconditionally —
          // but this branch is only reached when the Mill is NOT hungry (beans already buffered),
          // so it dumped 1,527 beans/h onto a pile the Mill drains at ~180/h/mill, freezing cash
          // (measured 2026-07-24: 14,695 beans ~ $10.9k frozen). Grow SEEDS instead (cheap water,
          // feeds future beans, deep B2B book) up to a cap; if seeds are also full, keep a minimal
          // fruit keep-alive (fruitRoom caps it below). Never grow more beans while buffered.
          if (seedStock < (CFG.seedFallbackCap || 6000)) {
            log(`FARM ${cropName} shelf full (${onShelf}) & beans buffered (${beanStock}) — growing seeds instead`);
            cropName = 'SEEDS';
            fruitRoom = null;
          } else {
            log(`FARM ${cropName} shelf full (${onShelf}), beans+seeds buffered — minimal keep-alive order`);
          }
        }
      }
      const wpu = waterPerUnit[cropName] || 3;

      // target units for a full horizon (crop-appropriate rate), and the water that needs
      let targetUnits = cropName === 'SEEDS' ? Math.round(seedRate * Math.min(horizon, 3))
        : cropName === 'COFFEE BEANS' ? Math.max(0, beanBufferTarget - beanStock)
        : Math.round(appleRate * horizon);
      if (fruitRoom != null && fruitRoom < targetUnits) {
        log(`FARM cap ${cropName} ${targetUnits} -> ${fruitRoom} (store shelf)`);
        targetUnits = fruitRoom;
      }
      const waterNeeded = targetUnits * wpu;

      if (effectiveWater < waterNeeded && inputBudget > 0) {
        const shortfall = waterNeeded - effectiveWater;
        const spend = Math.min(inputBudget, Math.ceil(shortfall * waterPrice * 1.05));
        log(`FARM need ${waterNeeded} water for ${targetUnits} ${cropName}, have ${effectiveWater} — buying $${spend}`);
        await cdp.goto('https://www.simcompanies.com/market/resource/2/');
        await cdp.evaluate(`window.__buy={kind:2, maxSpend:${spend}, ask:${waterPrice}}; return 1`).catch(() => {});
        const bought = await cdp.evaluate(page('buy.js')).catch(e => ({ ok: false, reason: e.message }));
        log('FARM water buy ->', JSON.stringify(bought).slice(0, 150));
        if (bought.ok && bought.stockNow) effectiveWater = bought.stockNow;
        await cdp.goto(B(CFG.farmId));
      }

      // Size STRICTLY to water ON HAND with 5% headroom for the game's ceil-rounding, so
      // PRODUCE is always enabled and no input is consumed on a failure.
      const waterBudget = Math.floor(effectiveWater * 0.95);
      const maxByWater = Math.floor(waterBudget / wpu);
      let order;
      if (cropName === 'SEEDS') {
        order = { name: 'SEEDS', kind: 66, qty: Math.max(100, Math.min(targetUnits, maxByWater)), cost: 0.04, profit: 0.25 };
      } else if (cropName === 'COFFEE BEANS') {
        order = { name: 'COFFEE BEANS', kind: 118, qty: Math.max(100, Math.min(targetUnits, seedStock, maxByWater)), cost: 0.68, profit: 2.5 };
      } else {
        order = { ...pickFarmOrder(state), qty: Math.max(100, Math.min(targetUnits, seedStock, maxByWater)) };
      }
      // On-hand water is the HARD ceiling — the Math.max(100,...) floor above must never force
      // an order the water can't fill. That is exactly what stalled the farm (2026-07-23): with
      // 251 water it floored grapes to x100 (needs 400), failed BUY MISSING every tick. Clamp to
      // what water supports; if that is zero (no water AND cash at reserve), skip rather than stall.
      order.qty = Math.min(order.qty, maxByWater);
      if (order.qty < 1) {
        log(`FARM ${order.name}: 0 water on hand and cash at reserve — skipping (store/mill buffered, cash self-heals)`);
        continue;
      }
      log(`FARM horizon=${horizon.toFixed(1)}h (accelEnd=${hoursToAccelEnd.toFixed(1)}h ` +
          `gate=${hoursToGate.toFixed(1)}h) water=${effectiveWater} inputBudget=$${inputBudget}`);
      log(`FARM pick ${order.name} x${order.qty} (seeds=${seedStock})`);
      if (DRY) continue;
      await cdp.goto(B(CFG.farmId));
      await cdp.evaluate(`window.__produce=${JSON.stringify({
        name: order.name, qty: order.qty,
        maxBuyCost: inputBudget, minCashAfter: CFG.minCash || 800 })}; return 1`);
      const made = await cdp.evaluate(page('produce.js'));
      log('FARM produce ->', JSON.stringify(made).slice(0, 220));
      observe({ type: 'produce', ok: !!made.ok, name: order.name, kind: order.kind, qty: order.qty, spent: made.spent });
      // Upgrade-on-failure is for ECONOMIC failures (missing inputs, cash floor). A broken
      // selector or changed UI must never spend money: those reasons are excluded.
      if (!made.ok) {
        // A produce failure is NEVER a reason to spend cash on an upgrade — that turned a
        // water shortage into an 8-hour stall + repeated upgrade attempts. Just log; the
        // next tick reorders smaller against whatever water is on hand.
        log('FARM produce failed (' + made.reason + ') — will retry smaller next tick, no upgrade');
      }
    }
  }
  // Record when the next building frees up. run-tick.sh reads this and returns without
  // opening a CDP session until then, so cron can poll often (small idle gap) without
  // paying for a full state capture every time.
  // Only buildings the loop above actually places orders on count: the Beach market never
  // reports busy, so including it pinned next-due to "now" and made every 2-minute cron
  // pass a full CDP tick. Its trickle output is still collected by the 10-min heartbeat.
  const managed = state.buildings.filter(b =>
    b.id === CFG.farmId || b.id === CFG.storeId || b.name === 'Mill' ||
    (CFG.factories && CFG.factories[b.name]));
  const dueTimes = managed.map(b => b.busy
    ? new Date(b.busy.started).getTime() + b.busy.duration * 1000
    : Date.now());
  const nextDue = new Date(dueTimes.length ? Math.min(...dueTimes) : Date.now());
  fs.writeFileSync(path.join(DIR, 'next-due.txt'), nextDue.toISOString() + '\n');
  log('NEXT DUE', localTime(nextDue));

  // Stuck detector: the fast loop is a deterministic script and cannot reason its way out of
  // a novel failure (the 7-hour water stall, the repeated BUY-MISSING refusal). So it watches
  // its OWN recent log: if the same failure signature repeats N times, or a managed building
  // has been idle across several ticks, it wakes the strategist (Opus — which CAN reason and
  // fix code/config) instead of grinding the same failure forever. This is the "escalate,
  // don't grind" rule — the loop stays a cheap script but gains a way to call for help.
  try {
    // Window must cover several TICKS, not several lines: a tick logs ~22 lines and a persistent
    // single-building stall logs ONE failSig/tick, so the old slice(-40) (~1.8 ticks) could never
    // reach the >=4 escalate threshold — the detector was blind to the exact persistent failure it
    // exists for (STUCK had fired 0× ever). ~160 lines ≈ 7 ticks: trips >=4 after ~4 ticks and still
    // ages out below the <2 clear threshold ~7 ticks after recovery. Thresholds unchanged.
    const recent = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-160);
    const failSig = (l) => {
      const m = l.match(/produce failed \(([^)]+)\)|IDLE ([A-Za-z ]+?) —|water buy .*"ok":false|TICK FAILED|EXECUTOR FAILED|SESSION lost/);
      return m ? (m[1] || m[2] || m[0]).slice(0, 40).trim() : null;
    };
    const sigs = recent.map(failSig).filter(Boolean);
    const counts = {};
    for (const g of sigs) counts[g] = (counts[g] || 0) + 1;
    const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const flag = path.join(DIR, 'fastloop-stuck.flag');
    if (worst && worst[1] >= 4) {
      const already = fs.existsSync(flag);
      // Attach a cash + sellable-inventory snapshot so the strategist can tell at a glance
      // whether the fix is "liquidate frozen inventory" (the owner's manual move) vs a real
      // shortage. Sellable = anything the store retails that we hold in quantity.
      const sellable = Object.entries(state.stock)
        .filter(([k, v]) => v.amount >= 50 && CFG.storeProducts?.some(p => String(p.kind) === k))
        .map(([k, v]) => `${k}:${v.amount}`).join(' ') || 'none';
      const cashLow = state.money < (CFG.minCash || 800) + 2000;
      const diag = /BUY MISSING|water buy|inputs short/i.test(worst[0]) && cashLow && sellable !== 'none'
        ? `LIKELY CASH-FROZEN: cash $${state.money}, sellable stock [${sellable}] — liquidation probably unblocks this`
        : `cash $${state.money}, sellable [${sellable}]`;
      fs.writeFileSync(flag, `stuck: "${worst[0]}" ×${worst[1]} @ ${localTime()}\n${diag}\n`);
      log(`STUCK "${worst[0]}" ×${worst[1]} — ${diag}`);
      // Wake the reasoning layer via maybeWakeStrategist, NOT a raw spawn: run-strategist.sh
      // deletes fastloop-stuck.flag on exit, so `already` can't dedupe across runs — a persistent
      // signature would re-spawn a max-effort Opus EVERY tick. maybeWakeStrategist gates on the
      // shared 90-min cooldown and is DRY-safe; the flag written just above still carries the
      // URGENT prompt to whichever run wins the wake.
      if (!already) maybeWakeStrategist(`stuck ${worst[0]}`);
    } else if (worst && worst[1] < 2 && fs.existsSync(flag)) {
      fs.unlinkSync(flag);           // recovered — clear the flag
      log('STUCK cleared — failure signature no longer repeating');
    }
  } catch (e) { /* stuck-detector must never break the tick */ }

  // Re-derive learned parameters from everything observed so far. Cheap, and it means the
  // next tick already benefits from this one.
  try {
    require('child_process').execFileSync(process.execPath, [path.join(DIR, 'learn.js'), '--quiet']);
    const k = knowledge();
    if (k.xp) log(`LEARN obs=${k.observations} xpModel=${k.xp.model} rates=${Object.keys(k.sellRates || {}).length}`);
  } catch (e) { log('LEARN failed:', e.message); }

  cdp.close();
  process.exit(0);
})().catch(e => { log('TICK FAILED:', e.message); process.exit(1); });
