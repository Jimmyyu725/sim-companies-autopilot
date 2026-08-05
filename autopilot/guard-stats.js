'use strict';

// Why guard rejections cost rounds, counted rather than guessed.
//
// A wake that runs out of rounds is not doing more work than one that closes cleanly. It is doing
// the same work twice: on 2026-08-05 every tool was inflated by the same ~1.8x, which is the shape
// of retry, not of ambition. The expensive retries are the ones a guard refuses, because a refused
// attempt still spends a round. This groups those refusals so a fix can be aimed at the largest one
// and then confirmed against the same measurement instead of a commit message.
//
//   node autopilot/guard-stats.js                  # every wake in brain.log
//   node autopilot/guard-stats.js --last 20        # the most recent 20 wakes
//   node autopilot/guard-stats.js --since 2026-08-05T04:00:00Z
//   node autopilot/guard-stats.js --log autopilot/brain.log.1
//
// Reads only. Never touches the runtime.

const fs = require('node:fs');
const path = require('node:path');

const WAKE_BOUNDARY = /BRAIN WAKE/;
const DONE = /BRAIN done rc=(\d+)/;
const USAGE = /USAGE wake=(\S+) calls=(\d+) tokens=(\d+) cost=\$([\d.]+)/;
const TOOL_CALL = /^(\S+)\s+TOOL\s+(\w+)\b/;
const EXHAUSTED = /exhausted (\d+) rounds/;
const PROVIDER = /BRAIN_PROVIDER=(\w+)|provider[= ]"?(\w+)"?/;

// A guard result is a `-> {...}` line carrying "guard":true. The reason is free text that ends up
// too specific to group on — building ids, quantities, timestamps — so it is normalised down to the
// stable clause before counting.
const GUARD_LINE = /"guard"\s*:\s*true/;
const REASON = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/;
// run-brain.sh elides long tool results, so a guard's reason often has no closing quote — the line
// ends mid-sentence at `…[N chars omitted]`. The strict pattern above misses every one of those, and
// they were being counted as a category of their own: "(guard with no reason)" was the third most
// frequent entry in the baseline at 17 occurrences, which read like a real class of guard rather
// than 17 reasons this parser could not finish reading. Every such line does carry its reason; the
// prefix that survives is more than enough to group on, since normaliseReason truncates anyway.
const TRUNCATED_REASON = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)$/;

function normaliseReason(reason) {
  return reason
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
    .replace(/\b\d{6,}\b/g, '<id>')
    .replace(/\b\d[\d,]*\.?\d*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

function parseArgs(argv) {
  const opts = { log: 'autopilot/brain.log', last: null, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log') opts.log = argv[++i];
    else if (arg === '--last') opts.last = Number.parseInt(argv[++i], 10);
    else if (arg === '--since') opts.since = Date.parse(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.last != null && !Number.isSafeInteger(opts.last)) throw new Error('--last needs an integer');
  if (opts.since != null && Number.isNaN(opts.since)) throw new Error('--since needs an ISO timestamp');
  return opts;
}

function splitWakes(text) {
  const wakes = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (WAKE_BOUNDARY.test(line)) {
      if (current) wakes.push(current);
      current = { header: line, lines: [], tools: new Map(), lastTool: null, guards: new Map(), rc: null, calls: null, cost: null, exhausted: null, startedAt: null };
      const stamp = Date.parse(line.slice(9, 28).replace(' ', 'T'));
      current.startedAt = Number.isNaN(stamp) ? null : stamp;
      continue;
    }
    if (!current) continue;
    current.lines.push(line);

    const tool = TOOL_CALL.exec(line);
    if (tool) {
      current.lastTool = tool[2];
      current.tools.set(tool[2], (current.tools.get(tool[2]) || 0) + 1);
    }

    if (GUARD_LINE.test(line)) {
      const reason = REASON.exec(line) || TRUNCATED_REASON.exec(line);
      const key = reason
        ? normaliseReason(reason[1].replace(/…\[\d+ chars omitted\]?.*$/u, ''))
        : '(guard with no reason)';
      // The tool a guard refused is the most recent TOOL line above it.
      const refused = current.lastTool || '?';
      // NUL joins the two halves because every other plausible separator occurs inside a reason.
      const composite = `${refused}\u0000${key}`;
      current.guards.set(composite, (current.guards.get(composite) || 0) + 1);
    }

    const done = DONE.exec(line);
    if (done) current.rc = Number(done[1]);
    const usage = USAGE.exec(line);
    if (usage) { current.calls = Number(usage[2]); current.cost = Number(usage[4]); }
    const exhausted = EXHAUSTED.exec(line);
    if (exhausted) current.exhausted = Number(exhausted[1]);
  }
  if (current) wakes.push(current);
  return wakes;
}

function pad(value, width) { return String(value).padStart(width); }

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = path.resolve(opts.log);
  if (!fs.existsSync(file)) {
    process.stderr.write(`no such log: ${file}\n`);
    process.exitCode = 1;
    return;
  }
  let wakes = splitWakes(fs.readFileSync(file, 'utf8'));
  if (opts.since != null) wakes = wakes.filter(wake => wake.startedAt != null && wake.startedAt >= opts.since);
  if (opts.last != null) wakes = wakes.slice(-opts.last);
  if (!wakes.length) { process.stdout.write('no wakes in range\n'); return; }

  const finished = wakes.filter(wake => wake.rc != null);
  const exhausted = wakes.filter(wake => wake.exhausted != null);
  const clean = finished.filter(wake => wake.rc === 0 && wake.exhausted == null);

  const avg = (list, pick) => {
    const values = list.map(pick).filter(value => typeof value === 'number' && Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const fmt = value => (value == null ? '   -' : value.toFixed(1).padStart(5));

  process.stdout.write(`\n${wakes.length} wakes  (${clean.length} clean, ${exhausted.length} exhausted, ${finished.filter(w => w.rc !== 0).length} rc!=0)\n`);
  process.stdout.write(`  tool calls  clean ${fmt(avg(clean, w => w.calls))}   exhausted ${fmt(avg(exhausted, w => w.calls))}\n`);
  process.stdout.write(`  cost $      clean ${fmt(avg(clean, w => w.cost))}   exhausted ${fmt(avg(exhausted, w => w.cost))}\n`);

  const guardTotals = new Map();
  for (const wake of wakes) {
    for (const [composite, count] of wake.guards) {
      const entry = guardTotals.get(composite) || { count: 0, wakes: 0 };
      entry.count += count;
      entry.wakes += 1;
      guardTotals.set(composite, entry);
    }
  }
  const ranked = [...guardTotals.entries()].sort((left, right) => right[1].count - left[1].count);
  const totalGuards = ranked.reduce((sum, [, entry]) => sum + entry.count, 0);

  process.stdout.write(`\n${totalGuards} guard rejections, ${(totalGuards / wakes.length).toFixed(1)} per wake\n\n`);
  process.stdout.write('  count  wakes  refused tool     reason\n');
  for (const [composite, entry] of ranked.slice(0, 15)) {
    const [tool, reason] = composite.split('\u0000');
    process.stdout.write(`  ${pad(entry.count, 5)}  ${pad(entry.wakes, 5)}  ${tool.padEnd(16)} ${reason}\n`);
  }
  process.stdout.write('\n');
}

if (require.main === module) main();

module.exports = { splitWakes, normaliseReason };
