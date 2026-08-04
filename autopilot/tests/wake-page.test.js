'use strict';

// web/wake/index.html is a static file with no exported functions, so these tests read it as
// text and reason about its markup and its inline <script> rather than executing it. That is
// enough to enforce the one property the review actually cares about: no value that ultimately
// comes from the autopilot's own state (a guard's blocked reason, a warehouse row's name — both
// capable of echoing chat text some day, per autopilot/chat/schemas.js labelling inbound chat
// 'untrusted-external') is ever woven into a string that gets inserted as markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAGE_PATH = path.join(__dirname, '..', '..', 'web', 'wake', 'index.html');

function readPage() {
  return fs.readFileSync(PAGE_PATH, 'utf8');
}

// Scope most checks to the inline script rather than the whole document: the header has its own
// static `<span id="dot" ...>` markup that has nothing to do with interpolated state, and a
// whole-file scan would either have to special-case it or risk false positives against it.
function scriptBlock(html) {
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'expected a <script> block in web/wake/index.html');
  return match[1];
}

test('the page never assigns to .innerHTML', () => {
  const html = readPage();
  // A stored-injection sink needs an .innerHTML assignment to exist somewhere. Forbidding it
  // outright is the actual fix — it does not depend on every future guard staying well-behaved.
  assert.doesNotMatch(html, /\.innerHTML\s*=/,
    'found an .innerHTML assignment; status rows must be built as DOM nodes via textContent instead');
});

test('s.blocked.reason is still rendered, but never as part of a markup string', () => {
  const script = scriptBlock(readPage());

  // Sanity check first, so the assertion below cannot pass simply because the field was deleted
  // rather than made safe.
  assert.match(script, /s\.blocked\.reason/,
    'expected the blocked reason to still be read from state');

  // Every backtick template literal that mentions the field must contain no `<`. That is exactly
  // the shape of the vulnerable line the review flagged:
  //   `<span class="warn">blocked: ${s.blocked.reason}</span>`
  // A safe rewrite only ever produces plain text, e.g. `blocked: ${s.blocked.reason}`, which a
  // textContent assignment (or a Text node) then renders literally, HTML-escaping included.
  const literalsWithReason = (script.match(/`[^`]*`/g) || [])
    .filter(literal => literal.includes('s.blocked.reason'));
  assert.ok(literalsWithReason.length > 0,
    'expected a template literal that interpolates s.blocked.reason');
  for (const literal of literalsWithReason) {
    assert.doesNotMatch(literal, /</, `blocked.reason must not be woven into markup: ${literal}`);
  }
});

test('warehouse names are still rendered, but the row holding them never reaches .innerHTML', () => {
  const script = scriptBlock(readPage());

  // Sanity check: the warehouse-name interpolation must still be present, so the guarantee below
  // is not vacuous by virtue of the feature having been removed.
  assert.match(script, /warehouse/, 'expected warehouse rows to still be rendered');
  assert.match(script, /\bw\.name\b/,
    'expected the warehouse row to still read .name from each entry');

  // Unlike the blocked-reason row, the warehouse row was never individually wrapped in a tag —
  // the danger was that the whole rows collection (including this row) was joined and handed to
  // .innerHTML. The 'the page never assigns to .innerHTML' test above already forbids that
  // outright, for every row, everywhere in the file. What is left to confirm here is that the
  // historically dangerous shape — collected rows joined into one string and assigned to
  // .innerHTML — is actually gone, not just that some unrelated .innerHTML call elsewhere was
  // removed.
  assert.doesNotMatch(script, /\.innerHTML\s*=[^\n;]*\.join\(/,
    'found rows joined into a string and assigned to .innerHTML');
});

test('the blocked-reason and unparsed-count rows still set className to the warn class', () => {
  const script = scriptBlock(readPage());
  const warnClassNameAssignments = script.match(/\.className\s*=\s*(['"])warn\1/g) || [];
  assert.ok(warnClassNameAssignments.length >= 2,
    `expected at least 2 elements with className set to 'warn', found ${warnClassNameAssignments.length}`);
});
