#!/usr/bin/env node
// Dependency-free HTTP server for the exchange price tracker. Serves index.html and /api/data,
// which returns the kind->name map plus the downsampled price time-series for a requested window.
// The page does the per-product current/%-change/chart maths client-side. Bound to localhost;
// exposed by Caddy at /prices/ with the same LAN/Tailscale allowlist as /money.
const http = require('http'), fs = require('fs'), path = require('path');
const DIR = __dirname;
const FILE = path.join(DIR, 'data', 'prices.jsonl');
const NAMES = path.join(DIR, 'data', 'names.json');
const VOLFILE = path.join(DIR, 'data', 'volume.jsonl');
const PORT = 8090;
const MAXPTS = 200;   // downsample any window to at most this many points
const {
  aggregateVolumeRecords,
  downsample,
  normalizeNameMap,
  selectPriceSamples,
} = require(path.join(DIR, 'data-quality.js'));

function readNames() {
  try {
    const checked = normalizeNameMap(JSON.parse(fs.readFileSync(NAMES, 'utf8')), { minimumKinds: 100 });
    return checked.ok ? { names: checked.names, status: 'ok' }
      : { names: {}, status: 'invalid' };
  } catch (_) {
    return { names: {}, status: 'missing-or-invalid' };
  }
}

function readSamples(windowSec, now, expectedKinds) {
  try {
    return selectPriceSamples(fs.readFileSync(FILE, 'utf8'), {
      cutoff: now - windowSec,
      now,
      expectedKinds,
    });
  } catch (_) {
    return { samples: [], invalidLines: 0, duplicateTimestamps: 0 };
  }
}

// Per-kind traded volume over the exact requested window. Intervals that cross the window edge
// are prorated; non-numeric maps and malformed lines are rejected instead of string-concatenated.
function readVolume(windowSec, now) {
  try {
    return aggregateVolumeRecords(fs.readFileSync(VOLFILE, 'utf8'), {
      cutoff: now - windowSec,
      now,
    });
  } catch (_) {
    return {
      u: {}, v: {}, amb: {}, intervals: 0, prorated: true,
      invalidLines: 0, duplicateIntervals: 0,
    };
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/data') {
    const win = Math.max(60, Math.min(30 * 86400, Number(u.searchParams.get('window')) || 3600));
    const now = Math.floor(Date.now() / 1000);
    const nameResult = readNames();
    const priceResult = readSamples(win, now, Object.keys(nameResult.names));
    const samples = downsample(priceResult.samples, MAXPTS);
    const volume = readVolume(win, now);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(JSON.stringify({
      now,
      window: win,
      names: nameResult.names,
      samples,
      vol: volume,
      quality: {
        names: nameResult.status,
        invalidPriceLines: priceResult.invalidLines,
        duplicatePriceTimestamps: priceResult.duplicateTimestamps,
        invalidVolumeLines: volume.invalidLines,
        duplicateVolumeIntervals: volume.duplicateIntervals,
      },
    }));
    return;
  }
  // static: only index.html (+ favicon no-op)
  if (u.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
  const fp = path.join(DIR, 'index.html');
  fs.readFile(fp, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('price-tracker on http://127.0.0.1:' + PORT));
