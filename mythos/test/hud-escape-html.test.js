'use strict';

// test/hud-escape-html.test.js — Track E1 of the 2026-09-16 plan: one home for
// the HUD's HTML escaping.
//
// MEASURED before the change: `function escapeHtml(` defined 17 times under
// ui/public/js with three different bodies — `& < >` null-safe, `& < >` with
// no null guard (String(undefined) -> "undefined" on the screen), and a
// textContent/innerHTML round trip that needs a document — plus one copy that
// also escaped `"`. Four call sites interpolated escapeHtml output into an
// ATTRIBUTE (three data-id values in forge.js/proposals.js, one href in
// news.js); with the DOM-based body a `"` in the value ends the attribute. The
// ids are server-generated and no `"`-bearing id was reproduced, so this is a
// consolidation with the attribute sites moved to escapeAttr by construction,
// not a security fix (the 2026-09-16 review's ruling).
//
// url.js already owned escapeAttr with the doctrine "one home, one test"
// (its header records the engagements.js copy nothing rendered). escapeHtml
// joins it. The house distinction stays: escapeHtml is for TEXT position
// (`& < >`), escapeAttr for a double-quoted attribute (adds `"`) — several
// tests' comments rely on escapeHtml NOT escaping quotes, and they stay true.
//
// Mutation 2026-09-16: (i) re-add a local `function escapeHtml` to one view ->
// (c) red naming the file; (ii) `="${escapeHtml(` put back in forge.js -> (d)
// red; (iii) drop `.replace(/>/g, '&gt;')` from url.js's escapeHtml -> (a) red.
// Each restored sha256-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS = path.join(__dirname, '..', 'ui', 'public', 'js');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(JS, f).replace(/\\/g, '/');
// Prose about the rule must not fail the rule: three files remark on "the
// hand-rolled escapeHtml() pattern" they replaced, and url.js's own comment
// quotes the forbidden attribute shape. Scan code, not comments.
const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1 ');

test('(a) escapeHtml escapes & < > for text position, null-safe, and leaves quotes alone', async () => {
  const { escapeHtml, escapeAttr } = await import(path.join(JS, 'url.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const table = [
    ['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '"'], ["'", "'"],
    ['<b>&"x"</b>', '&lt;b&gt;&amp;"x"&lt;/b&gt;'],
    [null, ''], [undefined, ''], [0, '0'], [false, 'false'],
  ];
  for (const [input, want] of table) assert.equal(escapeHtml(input), want, 'escapeHtml(' + JSON.stringify(input) + ')');
  assert.equal(escapeAttr('a"b<c>&'), 'a&quot;b&lt;c&gt;&amp;', 'escapeAttr adds the quote for attribute position');
  assert.equal(escapeAttr(null), '');
});

test('(b) the two escapers are the same function up to the quote', async () => {
  const { escapeHtml, escapeAttr } = await import(path.join(JS, 'url.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  for (const s of ['plain', '<&>', 'q"q', 'it\'s']) assert.equal(escapeAttr(s), escapeHtml(s).replace(/"/g, '&quot;'));
});

test('(c) exactly one escapeHtml and one escapeAttr definition exist under ui/public/js, both in url.js', () => {
  const defs = [];
  for (const f of walk(JS)) {
    const src = code(f);
    for (const m of src.matchAll(/^[ \t]*(?:export )?function (escapeHtml|escapeAttr)\(/gm)) defs.push(rel(f) + ':' + m[1]);
  }
  assert.deepEqual(defs.sort(), ['url.js:escapeAttr', 'url.js:escapeHtml'],
    'a second copy is how 17 of them happened — import from url.js instead: ' + defs.join(', '));
});

test('(d) no HUD file interpolates escapeHtml into an attribute value', () => {
  const offenders = [];
  for (const f of walk(JS)) {
    const src = code(f);
    for (const m of src.matchAll(/=["']\$\{escapeHtml\(/g)) offenders.push(rel(f) + '@' + src.slice(0, m.index).split('\n').length);
  }
  assert.deepEqual(offenders, [], 'escapeHtml does not escape `"`; use escapeAttr (or safeHref for a URL) in attribute position');
});

test('(e) every HUD file that calls escapeHtml or escapeAttr imports it from url.js', () => {
  const missing = [];
  for (const f of walk(JS)) {
    if (rel(f) === 'url.js') continue;
    const src = code(f);
    for (const name of ['escapeHtml', 'escapeAttr']) {
      if (!new RegExp('\\b' + name + '\\(').test(src)) continue;
      const imported = new RegExp("import \\{[^}]*\\b" + name + "\\b[^}]*\\} from '(?:/js/|(?:\\.\\./)+|\\./)url\\.js'").test(src);
      if (!imported) missing.push(rel(f) + ':' + name);
    }
  }
  assert.deepEqual(missing, [], 'the browser resolves imports at runtime with no build step — a missing import is a ReferenceError on first render');
});
