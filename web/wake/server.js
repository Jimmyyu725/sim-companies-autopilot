'use strict';

// Read-only observer for the Sim Companies autopilot. It follows autopilot/brain.log and the
// alarm files and pushes panel state to browsers over Server-Sent Events.
//
// It never calls the game API, never takes .tick.lock, and writes nothing. If this process dies
// the autopilot does not notice; that is the whole point of keeping the observer outside.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { projectPanels } = require('./parse.js');

const SIM = path.join(__dirname, '..', '..');
const LOG_PATH = path.join(SIM, 'autopilot', 'brain.log');
const NEXT_WAKE_PATH = path.join(SIM, 'autopilot', 'next-wake.json');
const LAST_WAKE_PATH = path.join(SIM, 'autopilot', '.last-wake.json');
const STATE_PATH = path.join(SIM, 'autopilot', '.state.json');
const PAGE_PATH = path.join(__dirname, 'index.html');
const PORT = Number(process.env.WAKE_PORT) || 8091;
const POLL_MS = 1000;

// One wake is a few hundred lines. This is generous enough to hold two of them and small enough
// that re-reading it every second is free.
const TAIL_BYTES = 512 * 1024;

function readTail(logPath, tailBytes) {
  let fd;
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    // A byte offset almost never lands on a line boundary. Drop whatever precedes the first
    // newline: parsing half a line produces a bogus first entry on every read.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// The runtime rewrites .state.json at the open and the close of every wake, so mid-wake this is
// the opening position. That is honest: it is labelled a level, not a delta.
function readWarehouse(statePath) {
  const state = readJsonOrNull(statePath);
  if (!state || !Array.isArray(state.stock)) return [];
  return state.stock
    .filter(row => Number(row && row.amount) > 0)
    .map(row => ({ name: row.name || String(row.kind), amount: Number(row.amount) }));
}

function readState({
  logPath = LOG_PATH,
  nextWakePath = NEXT_WAKE_PATH,
  lastWakePath = LAST_WAKE_PATH,
  statePath = STATE_PATH,
  tailBytes = TAIL_BYTES,
  nowMs = Date.now(),
} = {}) {
  return projectPanels({
    text: readTail(logPath, tailBytes),
    nextWake: readJsonOrNull(nextWakePath),
    lastWake: readJsonOrNull(lastWakePath),
    warehouse: readWarehouse(statePath),
    nowMs,
  });
}

function startServer(port = PORT) {
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(readState()));
      return;
    }

    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(readState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/' || url === '/index.html') {
      fs.readFile(PAGE_PATH, (error, body) => {
        if (error) { res.writeHead(500).end('page missing'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      });
      return;
    }

    res.writeHead(404).end('not found');
  });

  // Push only when the state actually changed. An idle company would otherwise send an identical
  // payload every second to every open tab for hours.
  let previous = '';
  const timer = setInterval(() => {
    if (clients.size === 0) return;
    const payload = JSON.stringify(readState());
    if (payload === previous) return;
    previous = payload;
    for (const client of clients) client.write(`data: ${payload}\n\n`);
  }, POLL_MS);
  timer.unref();

  server.listen(port, '127.0.0.1');
  return server;
}

if (require.main === module) startServer();

module.exports = { readState, readTail, readWarehouse, startServer, TAIL_BYTES, PORT };
