'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { substituteSecretPlaceholders } = require('../../shared/cdp.js');

test('CDP secret substitution creates valid JavaScript string literals', () => {
  const email = "owner'o\\example.test";
  const password = 'line one\\line two\n"quoted"';
  const source = `return ['__SC_EMAIL__', "__SC_PASSWORD__", __SC_EMAIL__];`;
  const replaced = substituteSecretPlaceholders(source, {
    __SC_EMAIL__: email,
    __SC_PASSWORD__: password,
  });

  assert.doesNotMatch(replaced, /__SC_(EMAIL|PASSWORD)__/);
  assert.deepEqual(new Function(replaced)(), [email, password, email]);
});
