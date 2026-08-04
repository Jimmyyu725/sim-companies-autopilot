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

module.exports = { splitWakes, classify };
