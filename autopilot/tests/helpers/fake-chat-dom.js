'use strict';

const NODE = Object.freeze({ TEXT_NODE: 3, ELEMENT_NODE: 1 });

function splitOutsideBrackets(value, separator) {
  const parts = [];
  let start = 0;
  let bracketDepth = 0;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') bracketDepth += 1;
    else if (character === ']') bracketDepth -= 1;
    else if (bracketDepth === 0 && separator(character)) {
      const part = value.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function selectorLists(selector) {
  return splitOutsideBrackets(String(selector), character => character === ',');
}

function selectorTokens(selector) {
  return splitOutsideBrackets(String(selector), character => /\s/u.test(character));
}

function unquote(value) {
  if (value.length >= 2
      && ((value[0] === '"' && value.at(-1) === '"')
        || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function matchesSimple(element, selector) {
  if (!(element instanceof FakeElement)) return false;
  let remainder = String(selector).trim();
  const tagMatch = remainder.match(/^(\*|[a-z][a-z0-9-]*)/iu);
  if (tagMatch) {
    if (tagMatch[1] !== '*' && element.tagName !== tagMatch[1].toUpperCase()) return false;
    remainder = remainder.slice(tagMatch[0].length);
  }

  for (const match of remainder.matchAll(/#([a-z0-9_-]+)/giu)) {
    if (element.id !== match[1]) return false;
  }
  for (const match of remainder.matchAll(/\.([a-z0-9_-]+)/giu)) {
    if (!element.classList.includes(match[1])) return false;
  }
  for (const match of remainder.matchAll(/\[([^\]]+)\]/gu)) {
    const expression = match[1].trim();
    const attributeMatch = expression.match(/^([a-z0-9_-]+)(?:\s*(\*=|\^=|\$=|=)\s*(.+))?$/iu);
    if (!attributeMatch) throw new Error(`unsupported fake DOM attribute selector: ${expression}`);
    const [, name, operator, rawExpected] = attributeMatch;
    const actual = element.getAttribute(name);
    if (actual == null) return false;
    if (!operator) continue;
    const expected = unquote(rawExpected.trim());
    if (operator === '=' && actual !== expected) return false;
    if (operator === '*=' && !actual.includes(expected)) return false;
    if (operator === '^=' && !actual.startsWith(expected)) return false;
    if (operator === '$=' && !actual.endsWith(expected)) return false;
  }

  const residue = remainder
    .replace(/#[a-z0-9_-]+/giu, '')
    .replace(/\.[a-z0-9_-]+/giu, '')
    .replace(/\[[^\]]+\]/gu, '')
    .trim();
  if (residue) throw new Error(`unsupported fake DOM selector residue: ${residue}`);
  return true;
}

function matchesComplex(element, selector) {
  const tokens = selectorTokens(selector);
  if (!tokens.length || !matchesSimple(element, tokens.at(-1))) return false;
  let ancestor = element.parentElement;
  for (let index = tokens.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, tokens[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

class FakeTextNode {
  constructor(value = '') {
    this.nodeType = NODE.TEXT_NODE;
    this.parentElement = null;
    this.ownerDocument = null;
    this._value = String(value);
  }

  get textContent() { return this._value; }

  set textContent(value) { this._value = String(value); }

  cloneNode() { return new FakeTextNode(this._value); }

  replaceWith(replacement) {
    if (!this.parentElement) return;
    this.parentElement.replaceChild(this, replacement);
  }
}

class FakeElement {
  constructor(tagName, attributes = {}, children = []) {
    this.nodeType = NODE.ELEMENT_NODE;
    this.tagName = String(tagName).toUpperCase();
    this.parentElement = null;
    this.ownerDocument = null;
    this.childNodes = [];
    this._attributes = new Map();
    this._visible = attributes.visible !== false;
    this.style = { ...(attributes.style || {}) };
    this.value = attributes.value || '';
    this.scrollTop = Number(attributes.scrollTop || 0);
    this.scrollHeight = Number(attributes.scrollHeight || 0);
    this.clientHeight = Number(attributes.clientHeight || 0);
    for (const [name, value] of Object.entries(attributes)) {
      if (!['visible', 'style', 'value', 'scrollTop', 'scrollHeight', 'clientHeight', 'text'].includes(name)) {
        this.setAttribute(name, value);
      }
    }
    if (attributes.text != null) this.append(attributes.text);
    this.append(...children);
  }

  append(...nodes) {
    for (const rawNode of nodes.flat()) {
      const node = typeof rawNode === 'string' ? new FakeTextNode(rawNode) : rawNode;
      if (!node) continue;
      node.parentElement = this;
      node.ownerDocument = this.ownerDocument;
      this.childNodes.push(node);
      if (node instanceof FakeElement) node._adopt(this.ownerDocument);
    }
    return this;
  }

  _adopt(document) {
    this.ownerDocument = document;
    for (const node of this.childNodes) {
      node.ownerDocument = document;
      if (node instanceof FakeElement) node._adopt(document);
    }
  }

  replaceChild(existing, replacement) {
    const index = this.childNodes.indexOf(existing);
    if (index < 0) return;
    const node = typeof replacement === 'string' ? new FakeTextNode(replacement) : replacement;
    node.parentElement = this;
    node.ownerDocument = this.ownerDocument;
    if (node instanceof FakeElement) node._adopt(this.ownerDocument);
    existing.parentElement = null;
    this.childNodes[index] = node;
  }

  replaceWith(replacement) {
    if (this.parentElement) this.parentElement.replaceChild(this, replacement);
  }

  get children() { return this.childNodes.filter(node => node instanceof FakeElement); }

  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }

  set textContent(value) {
    this.childNodes = [];
    this.append(String(value));
  }

  get innerText() { return this.textContent; }

  get id() { return this.getAttribute('id') || ''; }

  get className() { return this.getAttribute('class') || ''; }

  get classList() { return this.className.split(/\s+/u).filter(Boolean); }

  get dataset() {
    const result = {};
    for (const [name, value] of this._attributes) {
      if (!name.startsWith('data-')) continue;
      const key = name.slice(5).replace(/-([a-z])/gu, (_, character) => character.toUpperCase());
      result[key] = value;
    }
    return result;
  }

  get href() {
    const value = this.getAttribute('href');
    if (!value) return '';
    return new URL(value, this.ownerDocument?.origin || 'https://www.simcompanies.com').href;
  }

  get alt() { return this.getAttribute('alt') || ''; }

  get offsetParent() {
    for (let node = this; node; node = node.parentElement) {
      if (!node._visible) return null;
    }
    return this.parentElement || {};
  }

  setAttribute(name, value) { this._attributes.set(String(name), String(value)); }

  getAttribute(name) { return this._attributes.has(String(name)) ? this._attributes.get(String(name)) : null; }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  matches(selector) {
    return selectorLists(selector).some(part => matchesComplex(this, part));
  }

  querySelectorAll(selector) {
    const descendants = [];
    const visit = node => {
      for (const child of node.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    const lists = selectorLists(selector);
    return descendants.filter(element => lists.some(part => matchesComplex(element, part)));
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (element.matches(selector)) return element;
    }
    return null;
  }

  cloneNode(deep = false) {
    const attributes = Object.fromEntries(this._attributes);
    const clone = new FakeElement(this.tagName, {
      ...attributes,
      visible: this._visible,
      style: { ...this.style },
      value: this.value,
      scrollTop: this.scrollTop,
      scrollHeight: this.scrollHeight,
      clientHeight: this.clientHeight,
    });
    if (deep) clone.append(...this.childNodes.map(node => node.cloneNode(true)));
    return clone;
  }

  dispatchEvent() { return true; }
}

class FakeDocument {
  constructor(body, origin = 'https://www.simcompanies.com') {
    this.body = body;
    this.origin = origin;
    body._adopt(this);
  }

  querySelectorAll(selector) {
    const matchesBody = selectorLists(selector).some(part => matchesComplex(this.body, part));
    return (matchesBody ? [this.body] : []).concat(this.body.querySelectorAll(selector));
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  createTextNode(value) {
    const node = new FakeTextNode(value);
    node.ownerDocument = this;
    return node;
  }
}

function element(tagName, attributes = {}, children = []) {
  return new FakeElement(tagName, attributes, children);
}

async function runAction(source, {
  body,
  href = 'https://www.simcompanies.com/messages/',
  windowProperties = {},
} = {}) {
  const location = { href, origin: new URL(href).origin };
  const document = new FakeDocument(body, location.origin);
  const window = { ...windowProperties };
  const all = selector => document.querySelectorAll(selector);
  const getComputedStyle = node => ({
    flexDirection: '',
    overflow: '',
    overflowY: '',
    textAlign: 'start',
    ...node.style,
  });
  class FakeEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  const execute = new Function(
    'window', 'document', 'location', 'sessionStorage', 'Event', 'Node', 'URL',
    'all', 'sleep', 'setInput', 'getComputedStyle',
    `return (async () => { ${source}\n })();`,
  );
  return execute(
    window,
    document,
    location,
    {},
    FakeEvent,
    NODE,
    URL,
    all,
    async () => {},
    () => {},
    getComputedStyle,
  );
}

module.exports = {
  FakeDocument,
  FakeElement,
  element,
  runAction,
};
