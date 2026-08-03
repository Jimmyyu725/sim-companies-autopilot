#!/usr/bin/env node
// Generic CDP driver for the persistent automation Chrome on 127.0.0.1:9222.
// Reuses (or creates) a single tab pinned to the target site so page state survives calls.
//
// Usage:
//   node cdp.js goto <url>              navigate the tab and wait for load
//   node cdp.js js <file.js>            evaluate a JS file in the page, print the JSON result
//   node cdp.js eval '<expression>'     evaluate an inline expression
//   node cdp.js shot <out.png>          screenshot the tab
//   node cdp.js text                    dump document.body.innerText
//
// Env: SC_TAB_MATCH (substring identifying the tab, default "simcompanies.com")

const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1:9222';
const TAB_MATCH = process.env.SC_TAB_MATCH || 'simcompanies.com';

// Injected before every evaluation so page scripts can use these helpers.
const PREAMBLE = `
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
function all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function byText(text, sel) {
  const t = norm(text).toLowerCase();
  return all(sel || 'button, a, div[role=button], span, li, td, th, h1, h2, h3, h4, p')
    .filter(e => norm(e.innerText).toLowerCase() === t);
}
function containsText(text, sel) {
  const t = norm(text).toLowerCase();
  return all(sel || 'button, a, div[role=button], span, li').
    filter(e => norm(e.innerText).toLowerCase().includes(t));
}
function clickText(text, sel) {
  const hits = byText(text, sel).concat(containsText(text, sel));
  const el = hits.find(e => e.offsetParent !== null) || hits[0];
  if (!el) return { ok: false, reason: 'not found: ' + text };
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { ok: true, tag: el.tagName, text: norm(el.innerText).slice(0, 80) };
}
// React-safe input setter: bypasses the controlled-component value cache.
function setInput(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return norm(el.value);
}
async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: 'include' }, opts || {}));
  const body = await r.text();
  try { return { status: r.status, json: JSON.parse(body) }; }
  catch (e) { return { status: r.status, text: body.slice(0, 2000) }; }
}
`;

// Scripts may reference __SC_EMAIL__ / __SC_PASSWORD__; the values are read from the
// 600-mode .creds file at run time so they never appear in argv or in a script file.
function substituteSecretPlaceholders(src, secrets) {
  let result = String(src);
  for (const [placeholder, value] of Object.entries(secrets)) {
    const token = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = JSON.stringify(String(value));
    result = result.replace(new RegExp(`(['"])${token}\\1`, 'g'), literal);
    result = result.replace(new RegExp(token, 'g'), literal);
  }
  return result;
}

function fillSecrets(src) {
  if (!/__SC_(EMAIL|PASSWORD)__/.test(src)) return src;
  const creds = fs.readFileSync(path.join(__dirname, '..', '.creds'), 'utf8');
  const get = (k) => (creds.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '';
  return substituteSecretPlaceholders(src, {
    __SC_EMAIL__: get('SC_EMAIL'),
    __SC_PASSWORD__: get('SC_PASSWORD'),
  });
}

let ws, msgId = 0;
const pending = new Map();

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      request.reject(new Error('timeout: ' + method));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function rejectPending(error) {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    pending.delete(id);
    request.reject(error);
  }
}

async function getTab() {
  const targets = await (await fetch(`http://${HOST}/json/list`)).json();
  const tab = targets.find(t => t.type === 'page' && t.url.includes(TAB_MATCH));
  if (tab) return tab;
  const r = await fetch(`http://${HOST}/json/new?about:blank`, { method: 'PUT' });
  return r.json();
}

async function connect() {
  const tab = await getTab();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('CDP WebSocket connection failed')); };
    const cleanup = () => {
      ws.removeEventListener('open', opened);
      ws.removeEventListener('error', failed);
    };
    ws.addEventListener('open', opened);
    ws.addEventListener('error', failed);
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  ws.addEventListener('close', () => rejectPending(new Error('CDP WebSocket closed')));
  ws.addEventListener('error', () => rejectPending(new Error('CDP WebSocket error')));
  await send('Page.enable');
  await send('Runtime.enable');
  // Native confirm()/alert() dialogs freeze the page until answered, and headless Chrome
  // will not answer on its own — a click that opens one silently does nothing.
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });
  return tab;
}

async function evaluate(expr) {
  expr = fillSecrets(expr);
  const wrapped = `(async () => { ${PREAMBLE}\n return await (async () => { ${expr} })(); })()`;
  const r = await send('Runtime.evaluate', {
    expression: wrapped, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error('page error: ' + (e.exception?.description || e.text));
  }
  return r.result.value;
}

// Ceilings, deliberately the same as the waits they replace, so a slow page behaves exactly as it
// did before. Only a fast page finishes sooner.
const NAV_READY_CEILING_MS = 34000;
// Raised from the 2500ms it replaced because the old code also slept a blind 4000ms BEFORE it
// began checking readiness, so a page effectively had ~6.5s to paint. Polling starts immediately
// now, so the settle phase needs the room. A fast page still leaves in a few hundred milliseconds.
const SPA_SETTLE_CEILING_MS = 4000;
const NAV_POLL_MS = 250;

// The path a navigation is expected to land on. Compared rather than the whole href because the
// app appends and rewrites query strings during boot.
function navigationTargetPath(url) {
  try { return new URL(String(url)).pathname.replace(/\/+$/, ''); }
  catch (_) { return null; }
}

// Reads the one probe the wait loops need. Errors are swallowed: mid-navigation the execution
// context is destroyed and re-created, and that is a reason to poll again, not to fail.
async function navigationProbe() {
  try {
    return await evaluate(
      'const t = ((document.body && document.body.innerText) || ""); ' +
      'return { href: location.href, state: document.readyState, len: t.length, ' +
      'text: t.slice(0, 4000) }');
  } catch (_) { return null; }
}

// `expect` is a substring or RegExp the finished page must show. Text stability alone proved too
// weak a signal: measured 2026-08-02, one building page in a batch of three settled at a stable
// body that did not yet contain its LEVEL line, and the inspection returned a null level. A caller
// that knows what its page must contain should say so; the ceiling is unchanged either way.
async function goto(url, options = {}) {
  await send('Page.navigate', { url });
  const wantedPath = navigationTargetPath(url);
  const expect = options && options.expect ? options.expect : null;
  const matchesExpectation = (text) => {
    if (!expect) return true;
    return expect instanceof RegExp ? expect.test(text) : String(text).includes(String(expect));
  };

  // The old code slept a blind 4s before it started checking readyState, even though the check
  // below is what actually decides. It also never verified WHICH page had loaded — a real hazard
  // on this shared tab, where a stale render has previously been read as the wrong building.
  const readyDeadline = Date.now() + NAV_READY_CEILING_MS;
  let landed = false;
  while (Date.now() < readyDeadline) {
    const probe = await navigationProbe();
    if (probe && probe.state === 'complete') {
      const here = navigationTargetPath(probe.href);
      // Landing on the requested path is proof. Without it, keep polling until the ceiling and
      // then proceed anyway: callers that depend on the exact page verify it themselves, and
      // failing here would be stricter than the behaviour this replaces.
      if (wantedPath == null || here === wantedPath) { landed = true; break; }
    }
    await new Promise(r => setTimeout(r, NAV_POLL_MS));
  }

  // The SPA paints after readyState completes, which is why a blind 2.5s used to follow. Wait for
  // the rendered text to stop growing instead; an unchanged non-empty body means the paint landed.
  const settleDeadline = Date.now() + SPA_SETTLE_CEILING_MS;
  let previousLength = -1;
  let expectationMet = !expect;
  while (Date.now() < settleDeadline) {
    const probe = await navigationProbe();
    const length = probe ? probe.len : -1;
    const seen = probe ? matchesExpectation(probe.text || '') : false;
    if (seen) expectationMet = true;
    // Both signals, not either. The expectation alone released too early — measured 2026-08-02, a
    // building page showed its LEVEL line while the wages line was still unpainted, and the
    // inspection recorded a null wage. Stability alone is what let an unpainted page through in
    // the first place. Requiring both is still far cheaper than the blind wait it replaces.
    const stable = length > 0 && length === previousLength;
    if (stable && seen) break;
    previousLength = length;
    await new Promise(r => setTimeout(r, 200));
  }

  const result = await evaluate('return { url: location.href, title: document.title }');
  if (!landed) result.landedOnRequestedPath = false;
  if (expect && !expectationMet) result.expectationMet = false;
  return result;
}

async function shot(out) {
  const win = await send('Browser.getWindowForTarget');
  await send('Browser.setWindowBounds', {
    windowId: win.windowId, bounds: { width: 1600, height: 1400 },
  });
  await new Promise(r => setTimeout(r, 800));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  return out;
}

// Record every network request URL while navigating — used to discover the game's API.
async function watch(url, seconds) {
  const urls = [];
  const listener = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent') urls.push(m.params.request.url);
  };
  ws.addEventListener('message', listener);
  let enabled = false;
  try {
    await send('Network.enable');
    enabled = true;
    if (url) await send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, (Number(seconds) || 12) * 1000));
    return [...new Set(urls)].filter(u => !/\.(png|jpg|svg|woff2?|css|js)(\?|$)/.test(u));
  } finally {
    ws.removeEventListener('message', listener);
    if (enabled) await send('Network.disable').catch(() => {});
  }
}

// How long to keep listening after the last required response completes, so a straggler the
// caller did not name still lands in the same capture.
const CAPTURE_SETTLE_MS = 500;

// True once every required path has a request that finished loading. Kept pure and exported so the
// early-return rule is testable without a browser: it decides when a capture may stop waiting, and
// getting it wrong either wastes the whole ceiling or hands back a half-loaded body.
function captureComplete(wanted, finished, required) {
  if (!Array.isArray(required) || !required.length) return false;
  return required.every(path => {
    for (const [requestId, url] of wanted) {
      if (String(url).includes(path) && finished.has(requestId)) return true;
    }
    return false;
  });
}

// Capture the JSON bodies the app itself fetches. Direct in-page fetch() to some
// /api/ paths trips a Cloudflare managed challenge, so observe the app's own traffic
// instead of re-issuing requests.
//
// `seconds` is a ceiling, not a schedule. Pass `until` — the API paths the caller actually reads —
// and the capture returns as soon as every one of them has finished loading, plus a short settle
// window. Measured live on 2026-08-02: the store page delivers all of state.js's endpoints in
// about 1.1s, so the old unconditional 15s wait spent roughly 13.7s per refresh_state doing
// nothing. Callers that pass no `until` keep the original fixed wait exactly.
//
// Completion is judged on Network.loadingFinished, never on responseReceived: the latter fires on
// response headers, and getResponseBody against a still-streaming request returns a partial body.
async function capture(url, seconds, until = null) {
  const bodies = {};
  const wanted = new Map();
  const finished = new Set();
  const listener = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.responseReceived' &&
        m.params.response.url.includes('/api/') &&
        !m.params.response.url.includes('amplitude')) {
      wanted.set(m.params.requestId, m.params.response.url);
    }
    if (m.method === 'Network.loadingFinished') finished.add(m.params.requestId);
  };
  ws.addEventListener('message', listener);
  let enabled = false;
  try {
    await send('Network.enable');
    enabled = true;
    if (url) { await send('Page.navigate', { url }); }
    else { await send('Page.reload', { ignoreCache: false }); }
    const ceilingMs = (Number(seconds) || 14) * 1000;
    const required = Array.isArray(until) ? until.filter(Boolean) : [];
    if (!required.length) {
      await new Promise(r => setTimeout(r, ceilingMs));
    } else {
      const deadline = Date.now() + ceilingMs;
      const complete = () => captureComplete(wanted, finished, required);
      while (Date.now() < deadline && !complete()) {
        await new Promise(r => setTimeout(r, 50));
      }
      // A satisfied wait still settles; a timed-out one does not, because the ceiling has already
      // been spent and the caller validates whatever arrived.
      if (complete()) {
        await new Promise(r => setTimeout(r, Math.min(CAPTURE_SETTLE_MS, Math.max(0, deadline - Date.now()))));
      }
    }
    for (const [reqId, u] of wanted) {
      try {
        const b = await send('Network.getResponseBody', { requestId: reqId });
        const key = u.replace(/^https:\/\/www\.simcompanies\.com/, '');
        try { bodies[key] = JSON.parse(b.body); } catch (e) { bodies[key] = b.body.slice(0, 400); }
      } catch (e) { /* body already evicted */ }
    }
    return bodies;
  } finally {
    ws.removeEventListener('message', listener);
    if (enabled) await send('Network.disable').catch(() => {});
  }
}

module.exports = { connect, evaluate, goto, shot, capture, captureComplete, navigationTargetPath, watch, send,
                   substituteSecretPlaceholders,
                   close: () => {
                     rejectPending(new Error('CDP connection closed by caller'));
                     if (ws) ws.close();
                   } };

if (require.main !== module) return;

(async () => {
  const [cmd, arg, arg2] = process.argv.slice(2);
  await connect();
  let result;
  if (cmd === 'goto') result = await goto(arg);
  else if (cmd === 'watch') result = await watch(arg, arg2);
  else if (cmd === 'capture') result = await capture(arg, arg2);
  else if (cmd === 'js') result = await evaluate(fs.readFileSync(arg, 'utf8'));
  else if (cmd === 'eval') result = await evaluate(arg);
  else if (cmd === 'shot') result = await shot(arg);
  else if (cmd === 'text') result = await evaluate('return document.body.innerText');
  else throw new Error('unknown command: ' + cmd);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  ws.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
