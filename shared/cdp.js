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

async function goto(url) {
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 4000));
  for (let i = 0; i < 30; i++) {
    const state = await evaluate('return document.readyState');
    if (state === 'complete') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 2500)); // let the SPA render
  return evaluate('return { url: location.href, title: document.title }');
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

// Capture the JSON bodies the app itself fetches. Direct in-page fetch() to some
// /api/ paths trips a Cloudflare managed challenge, so observe the app's own traffic
// instead of re-issuing requests.
async function capture(url, seconds) {
  const bodies = {};
  const wanted = new Map();
  const listener = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.responseReceived' &&
        m.params.response.url.includes('/api/') &&
        !m.params.response.url.includes('amplitude')) {
      wanted.set(m.params.requestId, m.params.response.url);
    }
  };
  ws.addEventListener('message', listener);
  let enabled = false;
  try {
    await send('Network.enable');
    enabled = true;
    if (url) { await send('Page.navigate', { url }); }
    else { await send('Page.reload', { ignoreCache: false }); }
    await new Promise(r => setTimeout(r, (Number(seconds) || 14) * 1000));
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

module.exports = { connect, evaluate, goto, shot, capture, watch, send,
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
