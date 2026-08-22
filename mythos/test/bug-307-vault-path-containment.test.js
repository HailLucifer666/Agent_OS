'use strict';

// test/bug-307-vault-path-containment.test.js — BUG-307.
//
// THE BUG. `vaultPath()` is the one helper that turns a short name into a full
// path inside MYTHOS's data folder, and it was:
//
//     function vaultPath(...segments) { return path.resolve(root(), ...segments); }
//
// path.resolve does not contain anything. It cheerfully walks out of the vault
// on '..', and an absolute segment discards the root entirely. MEASURED at HEAD
// against a temp vault:
//
//     ".."               -> the vault's parent                  (out)
//     "../.."            -> two levels above the vault           (out)
//     "../../etc/passwd" -> two levels up, then etc/passwd       (out)
//     "/etc/passwd"      -> the drive root, then etc/passwd      (out, root discarded)
//     "a/../../.."       -> two levels above the vault           (out)
//
// (Written as prose rather than as the real resolved paths: AD-7 forbids a
// drive-rooted two-segment path in a tracked file, and the first draft of this
// table contained one. The commit gate caught it.)
//
// HONEST BOUNDING OF THE RISK, both halves, because this is the part that
// decides whether the fix is worth the churn. Nothing can currently exploit it:
// no model tool and no web route reaches the two unguarded call sites with a
// name it controls. Four other call sites each hand-rolled their own protection,
// in three different styles, and two wrote none. So the defect is not a live
// hole — it is one careless parameter away from being one, and it is the same
// invariant implemented five times, which is this repo's most-repeated defect
// class.
//
// The fix is therefore in the helper, and the two redundant hand-rolled checks
// come out in the same commit. Leaving five implementations of one rule is how
// they drift apart.
//
// WHAT IS DELIBERATELY LEFT ALONE. from-okf.js's badSegment() stays. It rejects
// a bad name with a helpful message BEFORE anything touches the filesystem,
// which is a different and better-placed job than containment — reject at the
// edge, contain at the door. Removing it would trade a good error message for a
// stack trace.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFsStore } = require('../src/core/memory/fs-store');

// A real directory, derived from os.tmpdir() — a tracked test may not name a
// machine-specific path (AD-7).
function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug307-'));
  return { root, store: createFsStore(root) };
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

test('a name that walks out of the vault is refused', () => {
  const { store } = makeStore();
  for (const hostile of [
    '..',
    '../..',
    '../../etc/passwd',
    'builds/../../secrets',
    'a/../../..',
  ]) {
    assert.throws(() => store.vaultPath(hostile), (err) => {
      assert.match(err.message, /vault/i, 'the refusal must say what boundary was crossed');
      assert.ok(err.message.includes(hostile.split('/')[0]) || /escape/i.test(err.message),
        'the refusal should be traceable to the input: ' + err.message);
      return true;
    }, JSON.stringify(hostile) + ' resolved outside the vault instead of throwing');
  }
});

test('an absolute path is refused, because it discards the root entirely', () => {
  // This is the one that surprises people: path.resolve(root, '/etc/passwd')
  // is '/etc/passwd'. The root is not a prefix, it is a starting point that any
  // absolute segment throws away.
  const { store } = makeStore();
  const absolutes = ['/etc/passwd', path.sep + 'etc' + path.sep + 'passwd'];
  if (process.platform === 'win32') {
    // Built from THIS machine's drive root at runtime, never written as a
    // literal. Two reasons, and both bit during this fix:
    //   - AD-7 forbids a drive-rooted two-segment path in any tracked file, and
    //     the first version of this fixture was a literal one. The commit gate
    //     caught it, which is the gate working.
    //   - A drive path written as a shell-escaped string can silently lose its
    //     separators and become a RELATIVE name, which makes the case look
    //     already-contained and the test look green. That happened while
    //     measuring this bug.
    const driveRoot = path.parse(os.tmpdir()).root;
    absolutes.push(path.join(driveRoot, 'Windows', 'win.ini'));
    absolutes.push(driveRoot.replace(/\\/g, '/') + 'Windows/win.ini');
  }
  for (const abs of absolutes) {
    assert.throws(() => store.vaultPath(abs),
      JSON.stringify(abs) + ' escaped the vault');
  }
});

test('a sibling directory with a similar name cannot sneak through', () => {
  // The classic off-by-one in this check: comparing with startsWith(root) alone
  // accepts '<root>-evil', because it really does start with the root string.
  // The comparison has to be against the root plus a separator.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug307-'));
  const sibling = root + '-evil';
  fs.mkdirSync(sibling, { recursive: true });
  const store = createFsStore(root);
  assert.throws(() => store.vaultPath(sibling + path.sep + 'x.txt'),
    'a sibling directory whose name merely starts with the vault root was accepted');
});

// ---------------------------------------------------------------------------
// The other direction: the check must not break the vault
// ---------------------------------------------------------------------------

test('calling it with no arguments still returns the vault root', () => {
  // A real and load-bearing use — from-runner.js derives its expected prefix
  // this way. A containment check that refuses the root refuses everything.
  const { root, store } = makeStore();
  assert.equal(store.vaultPath(), path.resolve(root));
});

test('ordinary names still resolve, including nested ones and dot segments', () => {
  const { root, store } = makeStore();
  assert.equal(store.vaultPath('Conversation', 'session.json'),
    path.join(path.resolve(root), 'Conversation', 'session.json'));
  assert.equal(store.vaultPath('builds/page/x.html'),
    path.join(path.resolve(root), 'builds', 'page', 'x.html'));
  assert.equal(store.vaultPath('.'), path.resolve(root),
    "'.' is the vault root, not an escape");
  assert.equal(store.vaultPath('builds', '..', 'Conversation'),
    path.join(path.resolve(root), 'Conversation'),
    'a .. that stays inside the vault is legitimate and must still work');
});

test('an absolute path that is already inside the vault is accepted', () => {
  // Several callers pass a full path back in. Refusing those would be a
  // containment check that breaks containment-respecting code.
  const { root, store } = makeStore();
  const inside = path.join(path.resolve(root), 'builds', 'ok.html');
  assert.equal(store.vaultPath(inside), inside);
});

test('the everyday vault operations still work end to end', () => {
  // The check sits in the one function every read and write goes through, so
  // "does the vault still function" is the real regression risk, not the hostile
  // inputs above.
  const { store } = makeStore();
  store.writeText('Conversation/notes.md', 'hello');
  assert.equal(store.readText('Conversation/notes.md', ''), 'hello');
  store.writeJSON('Conversation/session.json', { turns: [] });
  assert.deepEqual(store.readJSON('Conversation/session.json', null), { turns: [] });
  assert.equal(store.exists('Conversation/notes.md'), true);
  assert.equal(store.exists('Conversation/missing.md'), false);
});

// ---------------------------------------------------------------------------
// One rule, one implementation
// ---------------------------------------------------------------------------

test('the callers that hand-rolled this check no longer carry their own copy', () => {
  // Source assertion, because the failure being guarded against is a second
  // implementation existing — which no behavioural test can see, since both
  // copies agree on the day they are written.
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  const runner = read('src/core/effectors/from-runner.js');
  assert.ok(!/cwd escapes vault/.test(runner),
    'from-runner still re-derives the vault prefix and compares by hand; vaultPath does it now');

  const docs = read('src/core/effectors/from-docs.js');
  assert.ok(!/path traversal blocked/.test(docs),
    'from-docs still carries its own prefix comparison; vaultPath does it now');
});

test('from-okf keeps its own segment check, deliberately', () => {
  // Pinning a NON-fix. badSegment() rejects a bad name at the edge with a
  // message a user can act on, before the filesystem is involved. Containment in
  // vaultPath is the last line, not a replacement for a good error, and this
  // repo's rule is that a deliberate non-fix is written down with a test rather
  // than left implicit.
  const okf = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-okf.js'), 'utf8');
  assert.match(okf, /badSegment/,
    'from-okf.js lost badSegment(); it is a different job from containment and was kept on purpose');
});
