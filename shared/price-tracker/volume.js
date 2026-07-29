#!/usr/bin/env node
// Exchange VOLUME collector — order-level diff of /api/v3/market/0/<kind>/ per
// board/.vol-design.md, ADAPTED for the endpoint's measured rate limit (see addendum in the
// design doc): the market endpoint is a ~10-request bucket refilling in ~1 min, and blasting
// into 429s appears to penalize the refill. So instead of fetching all 142 books per run, each
// run fetches a ROTATING COHORT of 10 kinds (cursor kept in book-state.json) every 2 minutes on
// EVEN minutes -> a full sweep of all 142 kinds every ~30 min, ~5 req/min sustained.
//
// Diff per kind against its previous snapshot (each snapshot carries its own timestamp):
//   - persisting order id with a quantity drop  -> partial fill, count the delta
//   - vanished order id                          -> full fill, count prev quantity
//   - vanished from a FULL (200-row) prev book, priced >= current book's highest visible price
//     while the current book is also full        -> may merely be displaced past rank 200,
//                                                   count into the separate "amb" bucket
//   - brand-new order id                         -> new listing, NOT a purchase, ignored
// Cancels/decay-expiries also vanish orders, so measured volume slightly overstates true
// purchases (documented in the design; acceptable).
// A kind's snapshot is only overwritten after a successful, structurally valid fetch of that
// kind, so a failed run/kind just makes that kind's next diff span a longer window. State is
// committed before the derived JSONL line: a crash may lose one optional interval, but can never
// count the same vanished orders twice on the next run.
// Pure in-page fetch, but it still shares one CDP execution context with processes that navigate
// the tab. It therefore holds both locks in the global order (.brain.lock -> .tick.lock) and skips
// within five minutes of a scheduled wake. This prevents navigation races and preserves the same
// rate-limit bucket for live decisions. On the first 429 the run STOPS requesting (remaining cohort
// marked failed) to avoid the penalty.
// Ends with cdp.close(); process.exit(0) per LESSONS.md.
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const TRACKER = __dirname;
const SHARED = path.dirname(TRACKER);
const SIM = path.dirname(SHARED);
const cdp = require(path.join(SHARED, 'cdp.js'));
const { volumeCollectionPriority } = require(path.join(TRACKER, 'volume-priority.js'));
const {
  appendJsonlBoundedAtomic,
  atomicWriteJson,
  canonicalKind,
  diffOrderBooks,
  normalizeBookState,
  normalizeNameMap,
  normalizeOrderRows,
  normalizeVolumeRecord,
  suspiciousBookCollapse,
} = require(path.join(TRACKER, 'data-quality.js'));
const DATA = path.join(TRACKER, 'data');
const VOLFILE = path.join(DATA, 'volume.jsonl');
const STATEFILE = path.join(DATA, 'book-state.json');
const NAMES = path.join(DATA, 'names.json');
const KEEP = 20000;        // line bound, same style as prices.jsonl
const BOOK_CAP = 200;      // the market endpoint returns at most 200 rows
const PER_RUN = 10;        // measured burst budget of the endpoint after ~1 min quiet
const LOCK_MARKER = 'SIM_VOLUME_BRAIN_LOCK_HELD';
const TICK_LOCK_MARKER = 'SIM_VOLUME_TICK_LOCK_HELD';
const NEXT_WAKE_FILE = path.join(SIM, 'autopilot', 'next-wake.json');

function currentCollectionPriority() {
  let nextAlarm = null;
  try { nextAlarm = JSON.parse(fs.readFileSync(NEXT_WAKE_FILE, 'utf8')); }
  catch (_) {}
  return volumeCollectionPriority(nextAlarm);
}

// Serialize against the full brain wake, not only individual browser actions. This eliminates the
// observed "Inspected target navigated or closed" race and gives live exchange decisions priority
// over optional volume telemetry. Re-exec once under flock so the lock covers the whole process.
if (process.env[LOCK_MARKER] !== '1') {
  // Yield before touching .brain.lock when a wake is already due or imminent. Keep the identical
  // check below after both locks are held because the alarm can change between this preflight and
  // lock acquisition. The preflight prevents the optional collector from making a due wake miss
  // its first non-blocking runner attempt on even minutes.
  const preflight = currentCollectionPriority();
  if (!preflight.run) {
    console.log(`${new Date().toISOString()} skipped: ${preflight.reason}`);
    process.exit(0);
  }
  const child = spawnSync('flock', [
    '-n', '-E', '75', path.join(SIM, 'autopilot', '.brain.lock'),
    'env', `${LOCK_MARKER}=1`, process.execPath, __filename,
  ], { cwd: SIM, env: process.env, stdio: 'inherit' });
  if (child.error) {
    console.error('ERR could not acquire brain-priority lock:', child.error.message);
    process.exit(1);
  }
  if (child.status === 75) {
    console.log(`${new Date().toISOString()} skipped: brain wake active`);
    process.exit(0);
  }
  process.exit(child.status == null ? 1 : child.status);
}

// Keep the lock order identical to a normal wake: brain first, browser second. The odd-minute
// ticker collector owns only .tick.lock, so this additional lock prevents it from navigating the
// page while the volume collector is evaluating its market-book loop.
if (process.env[TICK_LOCK_MARKER] !== '1') {
  const child = spawnSync('flock', [
    '-w', '30', '-E', '76', path.join(SIM, '.tick.lock'),
    'env', `${LOCK_MARKER}=1`, `${TICK_LOCK_MARKER}=1`, process.execPath, __filename,
  ], { cwd: SIM, env: process.env, stdio: 'inherit' });
  if (child.error) {
    console.error('ERR could not acquire browser lock:', child.error.message);
    process.exit(1);
  }
  if (child.status === 76) {
    console.log(`${new Date().toISOString()} skipped: browser lock busy`);
    process.exit(0);
  }
  process.exit(child.status == null ? 1 : child.status);
}

const priority = currentCollectionPriority();
if (!priority.run) {
  console.log(`${new Date().toISOString()} skipped: ${priority.reason}`);
  process.exit(0);
}

(async () => {
  const checkedNames = normalizeNameMap(JSON.parse(fs.readFileSync(NAMES, 'utf8')), {
    minimumKinds: 100,
  });
  if (!checkedNames.ok) {
    console.error(`invalid names.json: ${checkedNames.reason}`);
    process.exit(1);
  }
  const all = Object.keys(checkedNames.names).map(Number).sort((a, b) => a - b);

  let rawState = null;
  try { rawState = JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch (_) {}
  const state = normalizeBookState(rawState, { cap: BOOK_CAP });
  const cursor = Number.isInteger(state.cursor) ? state.cursor % all.length : 0;
  const cohort = [];
  for (let i = 0; i < Math.min(PER_RUN, all.length); i++) cohort.push(all[(cursor + i) % all.length]);

  await cdp.connect();
  // Serial paced fetches; stop at the first 429 so we never dig into the rate-limit penalty.
  const res = await cdp.evaluate(`
    const kinds = ${JSON.stringify(cohort)};
    const ok = {}, fail = [];
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      try {
        const r = await api('/api/v3/market/0/' + k + '/');
        if (r.status === 200 && Array.isArray(r.json)) {
          ok[k] = r.json.map(o => [o.id, o.quantity, o.price]);
        } else {
          fail.push(k);
          if (r.status === 429) { fail.push(...kinds.slice(i + 1)); break; }
        }
      } catch (e) { fail.push(k); }
      if (i + 1 < kinds.length) await sleep(500);
    }
    return { ok, fail };
  `);
  cdp.close();

  if (!res || typeof res !== 'object' || Array.isArray(res) ||
      !res.ok || typeof res.ok !== 'object' || Array.isArray(res.ok) || !Array.isArray(res.fail)) {
    throw new Error('market-book collector returned a malformed result envelope');
  }

  const now = Math.floor(Date.now() / 1000);
  const u = {}, v = {}, amb = {}, t0ByKind = {};
  let diffed = 0, t0 = now;
  const failed = new Set();
  for (const value of res.fail) {
    const kind = canonicalKind(value);
    if (kind == null || !cohort.includes(kind) || failed.has(kind)) {
      throw new Error('market-book collector returned an invalid or duplicate failure kind');
    }
    failed.add(kind);
  }
  for (const kindText of Object.keys(res.ok)) {
    const kind = canonicalKind(kindText);
    if (kind == null || String(kind) !== kindText || !cohort.includes(kind)) {
      throw new Error('market-book collector returned an unexpected success kind');
    }
  }
  const accepted = new Set();
  const rejected = [];
  for (const kind of cohort) {
    const k = String(kind);
    if (!Object.prototype.hasOwnProperty.call(res.ok, k)) {
      failed.add(kind);
      continue;
    }
    if (failed.has(kind)) {
      rejected.push({ kind, reason: 'collector marked the same kind as both successful and failed' });
      continue;
    }
    const checkedRows = normalizeOrderRows(res.ok[k], { cap: BOOK_CAP });
    if (!checkedRows.ok) {
      failed.add(kind);
      rejected.push({ kind, reason: checkedRows.reason });
      continue;
    }
    const rows = checkedRows.rows;            // [[id, quantity, price], ...] price-ascending
    const prev = state.books[k];
    if (prev && suspiciousBookCollapse(prev, rows, { cap: BOOK_CAP })) {
      failed.add(kind);
      rejected.push({ kind, reason: 'suspicious collapse from a full book to fewer than half the cap' });
      continue;
    }
    // An unexpected empty 200 response after a non-empty snapshot cannot distinguish a real empty
    // market from a partial backend response. Preserve the last snapshot instead of fabricating a
    // mass fill; a later non-empty response self-heals this kind.
    if (prev && Object.keys(prev.o).length > 0 && rows.length === 0) {
      failed.add(kind);
      rejected.push({ kind, reason: 'suspicious empty book after a non-empty snapshot' });
      continue;
    }
    if (prev && prev.t >= now) {
      failed.add(kind);
      rejected.push({ kind, reason: 'previous snapshot timestamp is not earlier than this capture' });
      continue;
    }
    if (prev && prev.o) {
      const prevT = prev.t || state.t;        // pre-rotation snapshots carried no per-kind t
      const difference = diffOrderBooks(prev, rows, {
        currentFull: checkedRows.full,
        currentHigh: checkedRows.high,
      });
      if (!difference.ok) {
        failed.add(kind);
        rejected.push({ kind, reason: difference.reason });
        continue;
      }
      diffed++;
      t0ByKind[k] = prevT;
      if (prevT < t0) t0 = prevT;
      if (difference.units > 0) {
        u[k] = difference.units;
        v[k] = Math.round(difference.value * 100) / 100;
      }
      if (difference.ambiguousUnits > 0) amb[k] = difference.ambiguousUnits;
    }
    // Overwrite this kind's snapshot ONLY on success; each snapshot carries its own timestamp.
    state.books[k] = {
      t: now,
      full: checkedRows.full,
      top: checkedRows.low,
      last: checkedRows.high,
      o: Object.fromEntries(rows.map(r => [String(r[0]), [r[1], r[2]]])),
    };
    accepted.add(kind);
  }

  fs.mkdirSync(DATA, { recursive: true });
  // Advance the rotation regardless of failures (2b: failed kinds self-heal next sweep) and
  // publish the snapshot before its derived volume line. A crash can then lose one supporting
  // interval, but it cannot count the same vanished orders twice on the next run.
  state.cursor = (cursor + cohort.length) % all.length;
  state.t = now;
  atomicWriteJson(STATEFILE, state);
  if (diffed > 0) {
    appendJsonlBoundedAtomic(VOLFILE, {
      t0,
      t1: now,
      t0ByKind,
      u,
      v,
      amb,
      kinds: cohort.length,
      fail: [...failed].sort((a, b) => a - b),
    }, {
      keep: KEEP,
      normalize: normalizeVolumeRecord,
      timestamp: row => row.t1,
    });
  }

  const okN = accepted.size;
  console.log(`${new Date(now * 1000).toISOString()} cohort@${cursor} [${cohort[0]}..${cohort[cohort.length - 1]}]: ` +
    `${okN} ok, ${failed.size} fail, ${diffed} diffed` +
    (diffed ? ` (span ${now - t0}s, ${Object.keys(u).length} traded, ${Object.keys(amb).length} amb)` : ' (seeding)'));
  if (rejected.length) console.error(`rejected malformed/ambiguous books: ${JSON.stringify(rejected)}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { cdp.close(); } catch (x) {} process.exit(1); });
