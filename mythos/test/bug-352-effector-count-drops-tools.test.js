'use strict';

// BUG-352 — the effector counter reported 147 tools while the capabilities
// manifest reported 179, and the 32-tool gap was invisible because every way a
// module could fail to yield its tools was swallowed by a bare `catch {}`.
//
// Measured 2026-08-27, before the fix, by walking src/core/effectors/ with the
// counter's own algorithm and printing what it discarded:
//
//   from-dashboard.js  28 tools  buildTools(ctx) threw
//                                "TypeError: Cannot convert object to primitive value"
//   from-mcp.js         3 tools  buildTools(ctx) returned { tools: [...] }
//   from-strix.js       1 tool   buildTools(ctx) returned { tools: [...] }
//                      -------
//   147 + 32        =  179      exactly the manifest's tool count
//
// Two independent causes, so two independent guards below:
//
//  1. The inert ctx the counter passes to a factory is a Proxy that returns
//     `undefined` for Symbol.toPrimitive, so ANY string coercion of it throws.
//     from-dashboard's buildTools coerces, so all 28 of its tools vanished.
//  2. The counter recognised a returned `{ TOOLS: [...] }` but not the
//     lowercase `{ tools: [...] }` that from-mcp and from-strix actually
//     return (and that their own registerFrom* functions read).
//
// The third guard is the class assertion. A silent zero is what let a 32-tool
// gap sit in the README for weeks, so a `build*Tools` export that cannot be
// counted is now a thrown error, not a shrug. That rule is deliberately NARROW
// — only the `build*Tools` idiom, which exists to declare tools. The `create*`
// probe stays tolerant because most `create*` exports in this directory are
// not tool factories at all and legitimately refuse an inert ctx.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  computeEffectorTools,
  computeEffectorCount,
} = require('../scripts/sync-test-count.js');

const EFFECTORS_DIR = path.join(__dirname, '..', 'src', 'core', 'effectors');

test('BUG-352: every module that declares tools is attributed its tools', async (t) => {
  const report = computeEffectorTools(EFFECTORS_DIR);

  await t.test('from-dashboard survives an inert ctx it has to string-coerce', () => {
    const tools = report.perFile['from-dashboard.js'] || [];
    // Named rather than counted: a count pins today's surface, whereas these
    // ids are the capabilities the node on the map is about, and the bug was
    // that ALL of them were missing.
    assert.ok(tools.includes('open_web'), 'open_web must be counted');
    assert.ok(tools.includes('camera_look'), 'camera_look must be counted');
    assert.ok(tools.length >= 28, `from-dashboard declared ${tools.length} tools, expected at least the 28 measured on 2026-08-27`);
  });

  await t.test('a buildTools that returns { tools } is read, not just { TOOLS }', () => {
    assert.ok((report.perFile['from-mcp.js'] || []).includes('mcp_call_tool'), 'MCP bridge tools must be counted');
    assert.ok((report.perFile['from-strix.js'] || []).includes('security_scan'), 'security_scan must be counted');
  });

  await t.test('the total is the sum of what was attributed, not a separate tally', () => {
    const summed = Object.values(report.perFile).reduce((n, ids) => n + ids.length, 0);
    assert.strictEqual(report.total, summed);
    assert.strictEqual(computeEffectorCount(EFFECTORS_DIR), report.total);
  });

  await t.test('nothing in the real directory is silently dropped', () => {
    assert.deepStrictEqual(report.unreadable, [],
      'a module that could not be read must be reported, never counted as zero');
  });
});

// ---------------------------------------------------------------------------
// The class assertion, on fixtures rather than on the real tree, so it keeps
// working when the real tree is healthy. Paths derive from os.tmpdir() because
// the AD-7 gate rejects absolute path literals in tracked files.
// ---------------------------------------------------------------------------

function fixtureDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug352-'));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), source, 'utf8');
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('BUG-352: a build*Tools export that cannot be counted fails loudly', async (t) => {
  await t.test('a throwing buildTools is an error that carries the real cause', () => {
    const dir = fixtureDir(t, {
      'from-broken.js': 'module.exports = { buildTools() { throw new Error("needs a real vault"); } };',
    });
    let caught;
    assert.throws(
      () => computeEffectorTools(dir),
      (err) => { caught = err; return /from-broken\.js/.test(err.message); },
      'the failing module must be named in the error',
    );
    // Asserting the DIAGNOSTIC, not just that something threw. Removing the
    // throw-on-throw arm does not make this test fail on its own — the
    // "returned no tool array" guard below still fires, names the same file,
    // and reads like a shape problem when the module actually blew up. That
    // substitution is what a mutation run on 2026-08-27 exposed: the two
    // guards are only distinguishable by whether the underlying reason
    // survives, so the reason is what this asserts.
    assert.match(caught.message, /needs a real vault/,
      'the underlying failure must survive into the message, not be replaced by a generic shape complaint');
  });

  await t.test('a buildTools returning no tool array is an error too', () => {
    const dir = fixtureDir(t, {
      'from-shapeless.js': 'module.exports = { buildTools() { return { autostart: 1 }; } };',
    });
    assert.throws(() => computeEffectorTools(dir), /from-shapeless\.js/);
  });

  await t.test('the guard is narrow: a create* export that refuses an inert ctx is still tolerated', () => {
    const dir = fixtureDir(t, {
      'helper.js': 'module.exports = { createThing() { throw new Error("needs a real vault"); } };',
      'from-fine.js': 'module.exports = { buildTools() { return [{ name: "a" }, { name: "b" }]; } };',
    });
    const report = computeEffectorTools(dir);
    assert.strictEqual(report.total, 2, 'the healthy module still counts');
    assert.deepStrictEqual(report.perFile['from-fine.js'], ['a', 'b']);
    assert.ok(!('helper.js' in report.perFile), 'a non-tool module contributes nothing and says nothing');
  });

  await t.test('a module that does not parse is still refused (pre-existing guard, kept)', () => {
    const dir = fixtureDir(t, { 'from-syntax.js': 'module.exports = { buildTools() { return [ ; } };' });
    assert.throws(() => computeEffectorTools(dir), /does not parse/);
  });
});
