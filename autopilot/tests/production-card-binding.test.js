'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  bindExactProductionCard,
  buildProductionCardBindingPagePrelude,
} = require('../production-card-binding.js');

class FakeElement {
  constructor(tagName, ownText = '', attributes = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.ownText = ownText;
    this.attributes = { ...attributes };
    this.children = [];
    this.parentElement = null;
    this.disabled = attributes.disabled === true;
    this.type = attributes.type || '';
    this.src = attributes.src || '';
    this.currentSrc = attributes.currentSrc || '';
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  get innerText() {
    return [this.ownText, ...this.children.map(child => child.innerText)].filter(Boolean).join('\n');
  }

  get textContent() {
    return this.innerText;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  contains(other) {
    return this === other || this.children.some(child => child.contains(other));
  }

  querySelectorAll(selector) {
    const wanted = String(selector).toUpperCase();
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (wanted === '*' || child.tagName === wanted) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

class FakeDocument extends FakeElement {
  constructor(...children) {
    super('#document');
    this.append(...children);
  }
}

function productionCard({ name, slug, abundance = null, rate = '100/h', hashed = false }) {
  const filename = hashed ? `${slug}.0a1b2c3d.png` : `${slug}.png`;
  const image = new FakeElement('img', '', { src: `https://www.simcompanies.com/images/resources/${filename}?v=1` });
  const title = new FakeElement('div', name);
  const details = new FakeElement('div', abundance == null ? '' : `Abundance: ${abundance}`)
    .append(new FakeElement('div', `Production: ${rate}`));
  const input = new FakeElement('input', '', { type: 'number' });
  const card = new FakeElement('div').append(image, title, details, input);
  return { card, input, image };
}

test('Quarry, Mine, and Rig Abundance layouts bind the exact resource card', () => {
  for (const example of [
    { name: 'SAND', slug: 'sand', kind: 44 },
    { name: 'IRON ORE', slug: 'iron-ore', kind: 42 },
    { name: 'CRUDE OIL', slug: 'crude-oil', kind: 40 },
  ]) {
    const target = productionCard({ ...example, abundance: '80.93% Good', rate: '1,172.19/h' });
    const other = productionCard({ name: 'CLAY', slug: 'clay', abundance: '54.87% Poor', rate: '603.97/h' });
    const result = bindExactProductionCard({
      document: new FakeDocument(target.card, other.card),
      name: example.name,
      kind: example.kind,
      resourceSlug: example.slug,
    });
    assert.equal(result.ok, true, example.name);
    assert.equal(result.card, target.card);
    assert.equal(result.input, target.input);
    assert.equal(result.matchedKind, example.kind);
    assert.equal(result.matchedResourceSlug, example.slug);
  }
});

test('hashed production asset filenames preserve the exact resource slug', () => {
  const target = productionCard({
    name: 'SAND',
    slug: 'sand',
    abundance: '80.93% Good',
    rate: '1,172.19/h',
    hashed: true,
  });
  const result = bindExactProductionCard({
    document: new FakeDocument(target.card),
    name: 'SAND',
    kind: 44,
    resourceSlug: 'sand',
  });
  assert.equal(result.ok, true);
  assert.equal(result.card, target.card);
  assert.equal(result.matchedResourceSlug, 'sand');
});

test('normal Coffee Powder layout still binds by coffee-ground image identity', () => {
  const target = productionCard({ name: 'COFFEE POWDER', slug: 'coffee-ground', rate: '70.28/h' });
  const context = vm.createContext({ window: {}, document: new FakeDocument(target.card) });
  vm.runInContext(buildProductionCardBindingPagePrelude(), context);
  const result = context.window.__bindExactProductionCard({
    name: 'COFFEE POWDER', kind: 119, resourceSlug: 'coffee-ground',
  });
  assert.equal(result.ok, true);
  assert.equal(result.card, target.card);
  assert.equal(result.input, target.input);
});

test('wrong resource slug and duplicate exact cards fail closed with diagnostics', () => {
  const sand = productionCard({ name: 'SAND', slug: 'sand', abundance: '80% Good' });
  const wrong = bindExactProductionCard({
    document: new FakeDocument(sand.card),
    name: 'SAND', kind: 104, resourceSlug: 'clay',
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.targetImageCount, 0);
  assert.ok(wrong.observedResourceSlugs.includes('sand'));

  const sand2 = productionCard({ name: 'SAND', slug: 'sand', abundance: '79% Good' });
  const duplicate = bindExactProductionCard({
    document: new FakeDocument(sand.card, sand2.card),
    name: 'SAND', kind: 44, resourceSlug: 'sand',
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.matchingCardCount, 2);
  assert.match(duplicate.reason, /multiple cards/);
});

test('a multi-product parent is never accepted as one production card', () => {
  const parent = new FakeElement('div', 'SAND')
    .append(
      new FakeElement('img', '', { src: '/images/resources/sand.png' }),
      new FakeElement('div', 'Production: 100/h'),
      new FakeElement('div', 'Production: 50/h'),
      new FakeElement('input', '', { type: 'number' }),
    );
  const result = bindExactProductionCard({
    document: new FakeDocument(parent),
    name: 'SAND', kind: 44, resourceSlug: 'sand',
  });
  assert.equal(result.ok, false);
  assert.equal(result.multiProductAncestorRejected, true);
  assert.equal(result.observedProductionTexts.length, 2);
});

test('a target resource used only as another card requirement cannot be mistaken for the product', () => {
  const requirementImage = new FakeElement('img', '', { src: '/images/resources/coffee-beans.png' });
  const powder = productionCard({ name: 'COFFEE POWDER', slug: 'coffee-ground', rate: '70.28/h' });
  powder.card.append(requirementImage);
  const result = bindExactProductionCard({
    document: new FakeDocument(powder.card),
    name: 'COFFEE BEANS', kind: 118, resourceSlug: 'coffee-beans',
  });
  assert.equal(result.ok, false);
  assert.equal(result.targetImageCount, 1);
  assert.equal(result.matchingCardCount, 0);
});
