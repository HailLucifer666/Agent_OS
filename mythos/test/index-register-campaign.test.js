'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gen = require('../scripts/build-index');
const B = 'BUG-';
const heading = '### Individual declared-ticket dispositions';
const header = '| Ticket | Recorded state | Campaign disposition | Current evidence / missing proof | Candidate test or source |\n|---|---|---|---|---|\n';
const base = '\n## OPEN WORK filed fixture\n\n- ' + B + '402 — open\n\n## ' + B + '402 — historical title\n\n**Status:** diagnosed, no code change yet.\n';
function table(rows) { return heading + '\n\n' + header + rows.join('\n') + '\n'; }
function row(id = 402, disposition = 'blocked', evidence = 'Code repaired; live proof missing.', source = 'source.js') {
  return `| ${B}${id} | verified | ${disposition} | ${evidence} | ${source} |`;
}
const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');

test('campaign table adds evidence without changing historical states or allocating wrong IDs', () => {
  const old = gen.buildRegister({ bugsText: base });
  const next = gen.buildRegister({ bugsText: table([row(), row(999)]) + base });
  assert.deepEqual(next.counts, old.counts);
  assert.deepEqual(next.bugs.map((b) => [b.n, b.state]), old.bugs.map((b) => [b.n, b.state]));
  assert.deepEqual(next.bugs[0].campaign, { disposition: 'blocked', evidence: 'Code repaired; live proof missing.', source: 'source.js' });
  assert.match(next.bugs[0].excerpt, /no code change yet/);
});

test('missing, malformed, duplicate and out-of-section evidence never invents an assessment', () => {
  for (const text of [base, table([row(402, 'fixed')]) + base,
    table([row()]).replace('|---|---|---|---|---|', '|---|') + base,
    table([row(), row()]) + base, table([row()]) + table([row()]) + base,
    heading + '\n## Another section\n' + header + row() + base]) {
    assert.equal(gen.buildRegister({ bugsText: text }).bugs.find((b) => b.n === 402).campaign, undefined);
  }
});

test('embedded data and actual drawer preserve evidence as safe text including escaped pipes', () => {
  const hostile = '</script><img src=x onerror=alert(1)> \\| measured';
  const generated = gen.generate({ html, bugsText: table([row(402, 'blocked', hostile)]) + base });
  const ticket = gen.readIsland(generated.nextHtml).data.register.bugs[0];
  assert.equal(ticket.campaign.evidence, hostile.replace('\\|', '|'));
  assert.ok(!generated.nextHtml.includes('</script><img'));
  const drawer = html.match(/    if\(b\.campaign\)\{[\s\S]*?(?=    var det = b\.detail)/);
  assert.ok(drawer, 'test runs actual shipped drawer branch');
  function element() { return { children: [], textContent: '', appendChild(child) { this.children.push(child); },
    set innerHTML(_) { assert.fail('untrusted campaign text must not use innerHTML'); } }; }
  const body = element();
  vm.runInNewContext(drawer[0], { b: ticket, body, document: { createElement: element } });
  assert.deepEqual(body.children[0].children.map((el) => el.textContent),
    ['Campaign assessment', ticket.campaign.disposition, ticket.campaign.evidence, ticket.campaign.source]);
  const absent = element();
  vm.runInNewContext(drawer[0], { b: {}, body: absent, document: { createElement: element } });
  assert.equal(absent.children.length, 0);
});

test('real register retains all historical states and counts independently of campaign table', () => {
  const bugsText = fs.readFileSync(path.resolve(__dirname, '../../BUGS.md'), 'utf8');
  const original = gen.buildRegister({ bugsText });
  const without = gen.buildRegister({ bugsText: bugsText.replace(heading, '### Campaign table omitted for comparison') });
  assert.equal(original.total, 261);
  assert.deepEqual(original.counts, without.counts);
  assert.deepEqual(original.bugs.map((b) => [b.n, b.state]), without.bugs.map((b) => [b.n, b.state]));
  assert.equal(original.bugs.filter((b) => b.campaign).length, original.total,
    'every declared ticket must retain its separate campaign assessment');
});
