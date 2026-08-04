'use strict';

// Reads autopilot/brain.log. The log is a human-facing artifact, not a promised interface,
// so every shape below is optional: an unrecognised line becomes an 'unknown' event and is
// counted, never thrown. A visualiser that dies on one odd line is worse than one that
// shows slightly less.

const BANNER = /^═+ (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z]{2,4}) BRAIN WAKE ═+$/;
const PROVIDER = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,4} provider=(\S+) model=(\S+) effort=(\S+)/;
const TOOL = /^(\d{4}-\d{2}-\d{2}T\S+Z) TOOL ([a-z_]+) ?(.*)$/;
const RESULT = /^(\d{4}-\d{2}-\d{2}T\S+Z)\s+-> (.*)$/;
const THINK = /^(\d{4}-\d{2}-\d{2}T\S+Z) THINK: (.*)$/;
const FORCED = /^(\d{4}-\d{2}-\d{2}T\S+Z) DEEPSEEK_NEXT_TOOL_FORCED (\S+)(.*)$/;
const RETRY = /^(\d{4}-\d{2}-\d{2}T\S+Z) MODEL_REQUEST_RETRY (.*)$/;
const USAGE = /^USAGE wake=(\S+) calls=(\d+) tokens=(\d+) cost=(.*)$/;
const DONE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,4} BRAIN done rc=(\d+)/;
const SNAPSHOT = /^\{"ok":true,"money":(\d+),"level":(\d+),"buildings":(\d+)\}$/;

function classify(line) {
  let m;
  if ((m = line.match(TOOL))) return { t: m[1], kind: 'tool', name: m[2], args: m[3] };
  if ((m = line.match(RESULT))) return { t: m[1], kind: 'result', raw: m[2] };
  if ((m = line.match(THINK))) return { t: m[1], kind: 'think', text: m[2] };
  if ((m = line.match(FORCED))) return { t: m[1], kind: 'forced', tool: m[2] };
  if ((m = line.match(RETRY))) return { t: m[1], kind: 'retry', text: m[2] };
  if ((m = line.match(USAGE))) {
    return { t: null, kind: 'usage', calls: Number(m[2]), tokens: Number(m[3]), cost: m[4] };
  }
  if ((m = line.match(DONE))) return { t: null, kind: 'done', rc: Number(m[1]) };
  if ((m = line.match(SNAPSHOT))) {
    return { t: null, kind: 'snapshot', money: Number(m[1]), level: Number(m[2]), buildings: Number(m[3]) };
  }
  return { t: null, kind: 'unknown', text: line };
}

function splitWakes(text) {
  const wakes = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const banner = line.match(BANNER);
    if (banner) {
      current = {
        banner: line,
        startedAtLocal: `${banner[1]} ${banner[2]} ${banner[3]}`,
        provider: null,
        model: null,
        effort: null,
        events: [],
      };
      wakes.push(current);
      continue;
    }
    if (!current || line === '') continue;
    const provider = line.match(PROVIDER);
    if (provider) {
      current.provider = provider[1];
      current.model = provider[2];
      current.effort = provider[3];
      continue;
    }
    current.events.push(classify(line));
  }
  return wakes;
}

const SILENCE_MS = 3 * 60 * 1000;
const MAX_ROUNDS = 40;

function safeJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// A result belongs to the tool call above it. Outcome is read from the parsed body when it is
// valid JSON; a truncated body (the log elides long payloads) still counts as a reply, so an
// unreadable result is 'ok' rather than 'failed' — claiming failure we cannot see would be worse.
function pairActions(events) {
  const actions = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind !== 'tool') continue;
    const result = events.slice(i + 1).find(e => e.kind === 'result' || e.kind === 'tool');
    let outcome = 'pending';
    if (result && result.kind === 'result') {
      const body = safeJson(result.raw);
      if (body === null) outcome = 'ok';
      else if (body.guard === true) outcome = 'blocked';
      else if (body.ok === false) outcome = 'failed';
      else outcome = 'ok';
    }
    actions.push({ t: events[i].t, name: events[i].name, outcome, result: result || null });
  }
  return actions;
}

function lastLineMs(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ms = Date.parse(events[i].t);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// lastWake is the CONSUMED alarm (autopilot/.last-wake.json); its `reason` is the only place the
// running wake's purpose is recorded. warehouse comes from autopilot/.state.json because brain.log
// elides long tool results — 6,504 of them carry "[N chars omitted]", so refresh_state bodies are
// not valid JSON and stock cannot be recovered from the log at all.
function projectPanels({ text = '', nextWake = null, lastWake = null, warehouse = null,
                         nowMs = Date.now() } = {}) {
  const wakes = splitWakes(text);
  const wake = wakes[wakes.length - 1] || null;

  if (!wake) {
    const atMs = nextWake ? Date.parse(nextWake.atIso) : NaN;
    return {
      status: 'idle',
      silentForMs: null,
      wake: null,
      nextWake: nextWake
        ? { atIso: nextWake.atIso, reason: nextWake.reason || null,
            inMs: Number.isFinite(atMs) ? atMs - nowMs : null }
        : null,
      money: { cash: null, deltaSinceStart: null, level: null, buildings: null },
      warehouse: Array.isArray(warehouse) ? warehouse : [],
      thinking: { latest: null, previous: null },
      council: { calls: 0, latest: null },
      progress: { step: 0, max: MAX_ROUNDS, elapsedMs: null, cost: null, calls: null, tokens: null, rc: null },
      lastActions: [],
      blocked: null,
      unparsed: 0,
      lastLineAtMs: null,
    };
  }

  const events = wake.events;
  const actions = pairActions(events);
  const thinks = events.filter(e => e.kind === 'think');
  const snapshots = events.filter(e => e.kind === 'snapshot');
  const usage = events.filter(e => e.kind === 'usage').pop() || null;
  const done = events.filter(e => e.kind === 'done').pop() || null;

  const blockedAction = [...actions].reverse().find(a => a.outcome === 'blocked');
  const blockedBody = blockedAction ? safeJson(blockedAction.result.raw) : null;

  const lastMs = lastLineMs(events);
  const silentForMs = lastMs == null ? null : nowMs - lastMs;
  let status = 'running';
  if (done) status = 'done';
  else if (silentForMs != null && silentForMs >= SILENCE_MS) status = 'silent';

  const councilCalls = actions.filter(a => a.name === 'strategy_council' || a.name === 'council');

  return {
    status,
    silentForMs,
    wake: {
      startedAtLocal: wake.startedAtLocal,
      provider: wake.provider,
      model: wake.model,
      reason: lastWake && lastWake.reason ? String(lastWake.reason) : null,
    },
    warehouse: Array.isArray(warehouse) ? warehouse : [],
    nextWake: null,
    money: {
      cash: snapshots.length ? snapshots[snapshots.length - 1].money : null,
      deltaSinceStart: snapshots.length >= 2
        ? snapshots[snapshots.length - 1].money - snapshots[0].money
        : null,
      level: snapshots.length ? snapshots[snapshots.length - 1].level : null,
      buildings: snapshots.length ? snapshots[snapshots.length - 1].buildings : null,
    },
    thinking: {
      latest: thinks.length ? thinks[thinks.length - 1].text : null,
      previous: thinks.length >= 2 ? thinks[thinks.length - 2].text : null,
    },
    council: { calls: councilCalls.length, latest: councilCalls.length ? councilCalls[councilCalls.length - 1].outcome : null },
    progress: {
      step: actions.length,
      max: MAX_ROUNDS,
      elapsedMs: lastMs == null ? null : lastMs - (Date.parse(events.find(e => e.t)?.t) || lastMs),
      cost: usage ? (usage.cost.match(/\$[\d.]+/) || [null])[0] : null,
      calls: usage ? usage.calls : null,
      tokens: usage ? usage.tokens : null,
      rc: done ? done.rc : null,
    },
    lastActions: actions.slice(-3).reverse().map(a => ({ name: a.name, outcome: a.outcome, t: a.t })),
    blocked: blockedBody && blockedBody.reason ? { reason: String(blockedBody.reason) } : null,
    unparsed: events.filter(e => e.kind === 'unknown').length,
    lastLineAtMs: lastMs,
  };
}

module.exports = { splitWakes, classify, projectPanels, SILENCE_MS, MAX_ROUNDS };
