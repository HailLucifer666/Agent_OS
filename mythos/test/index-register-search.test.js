'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped filter body, not a copied matcher. Browser reproduction:
// the displayed full ticket ID returned zero rows while its numeric form worked.
const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
const body = html.match(/var rows = REG\.bugs\.filter\(function\(b\)\{([\s\S]*?)\n    \}\);/);
assert.ok(body, 'the production register filter must be located');
function matches(query, ticket, enabled = true) {
  return vm.runInNewContext('(function(b){' + body[1] + '\n})', {
    q: query.trim().toLowerCase(), on: { open: enabled },
  })(ticket);
}
const ticket = { n: 402, state: 'open', title: 'Packaged engine lookup fails' };
for (const query of ['BUG-402', 'bug-0402', '  BUG-00402  ', '402', 'engine']) {
  test('register finds displayed ticket using ' + JSON.stringify(query), () => {
    assert.equal(matches(query, ticket), true);
  });
}
for (const query of ['BUG-40', 'BUG-' + '4020', 'xBUG-402', 'not found']) {
  test('register rejects nonmatching query ' + JSON.stringify(query), () => {
    assert.equal(matches(query, ticket), false);
  });
}
test('state filter remains authoritative even for an exact ID', () => {
  assert.equal(matches('BUG-402', ticket, false), false);
});

test('exact ID does not also match another ticket that references it in its title', () => {
  assert.equal(matches('BUG-402', { ...ticket, n: 403, title: 'BUG-402 follow-on' }), false);
});
