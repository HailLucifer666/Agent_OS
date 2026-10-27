'use strict';

// test/read-access-policy.test.js — the file tools never read, list, walk or
// index a credential path, inside ANY root (2026-09-29 audit, B2d, part 1).
//
// THE DEFECT: resolveSandboxed() confined paths to "allowed roots" that were the
// whole user profile (VOICE_ALLOWED_DIRS defaulted to %USERPROFILE%) plus the
// REPOSITORY root (documented as mythos/, resolved four levels up), and nothing
// inside a root was off limits. read_file and search_files are tier 0 and
// index_project tier 1 — no confirmation — so mythos/.env, Electron's
// keys.json, auth-sessions.json, ~/.ssh and browser profiles were all readable,
// and whatever they returned could leave the machine through web_fetch.
//
// These plant real files in a project-local temp directory (TEMP), point
// VOICE_ALLOWED_DIRS at it, and drive the real tools. Every refusal is also
// checked for the canary: a refusal that echoed the content would still leak.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/core/effectors/read-access-policy');
const computer = require('../src/core/effectors/from-computer');
const CANARY = 'CANARY-B2D-7f3e9a';
// Shapes for the pure classifier are built on a real drive root at run time: a
// drive-letter path typed into tracked source fails the AD-7 gate.
const at = (p) => path.join(path.parse(process.cwd()).root, ...p.split('/'));

let root;
let savedDirs;
function plant(rel, body) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body === undefined ? `SECRET=${CANARY}\n` : body);
  return abs;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b2d-'));
  savedDirs = process.env.VOICE_ALLOWED_DIRS;
  process.env.VOICE_ALLOWED_DIRS = root;
  plant('.env');
  plant('sub/.env.local');
  plant('Nvidia NIM.env');
  plant('keys.json', `{"GEMINI_API_KEY":"${CANARY}"}`);
  plant('auth-sessions.json', `{"s":"${CANARY}"}`);
  plant('.ssh/id_rsa');
  plant('.ssh/notes-about-keys.txt');
  plant('.ssh/server.pem');
  plant('Google/Chrome/User Data/Default/Cookies');
  plant('notes.txt', 'ordinary notes\n');
  plant('env.js', 'module.exports = {};\n');
  plant('certs/server.pem', 'an ordinary project certificate\n');
  // A folder link (a junction needs no privilege on Windows) into the key folder:
  // its lexical path names nothing protected, its canonical path does.
  fs.symlinkSync(path.join(root, '.ssh'), path.join(root, 'innocent-folder'), 'junction');
});
after(() => {
  if (savedDirs === undefined) delete process.env.VOICE_ALLOWED_DIRS; else process.env.VOICE_ALLOWED_DIRS = savedDirs;
  fs.rmSync(root, { recursive: true, force: true });
});

const text = (r) => JSON.stringify(r);

describe('read_file refuses every credential shape, and never echoes it', () => {
  for (const rel of ['.env', 'sub/.env.local', 'Nvidia NIM.env', 'keys.json', 'auth-sessions.json', '.ssh/id_rsa',
    '.ssh/notes-about-keys.txt', '.ssh/server.pem', 'Google/Chrome/User Data/Default/Cookies']) {
    test(rel, async () => {
      const r = await computer.read_file({ path: path.join(root, rel) });
      assert.equal(r.ok, false, text(r));
      assert.match(String(r.result), /protected/);
      assert.doesNotMatch(text(r), new RegExp(CANARY));
    });
  }

  test('through a folder link: the lexical path looks innocent, the real one is .ssh', async () => {
    const r = await computer.read_file({ path: path.join(root, 'innocent-folder', 'notes-about-keys.txt') });
    assert.equal(r.ok, false, text(r));
    assert.match(String(r.result), /key-directory/);
    assert.doesNotMatch(text(r), new RegExp(CANARY));
  });

  test('ADJACENT: ordinary files — including env.js and a certificate outside a key folder — still read', async () => {
    for (const rel of ['notes.txt', 'env.js', 'certs/server.pem']) {
      const r = await computer.read_file({ path: path.join(root, rel) });
      assert.equal(r.ok, true, rel + ': ' + text(r));
    }
  });
});

describe('listings and walks leave protected paths out', () => {
  test('list_folder hides them and reports only how many', async () => {
    const r = await computer.list_folder({ path: root });
    assert.equal(r.ok, true, text(r));
    const names = r.result.entries.map((e) => e.name);
    for (const hidden of ['.env', 'Nvidia NIM.env', 'keys.json', 'auth-sessions.json', '.ssh']) assert.equal(names.includes(hidden), false, hidden);
    for (const shown of ['notes.txt', 'env.js', 'certs', 'sub']) assert.equal(names.includes(shown), true, shown);
    assert.equal(r.result.protectedHidden, 5);
  });

  test('search_files neither reports nor walks into them', async () => {
    const r = await computer.search_files({ root, pattern: '*' });
    assert.equal(r.ok, true, text(r));
    const paths = r.result.entries.map((e) => e.path.replace(/\\/g, '/'));
    assert.equal(paths.some((p) => /\/\.ssh(\/|$)|\.env|keys\.json|auth-sessions|User Data/.test(p)), false, paths.join('\n'));
    assert.ok(paths.some((p) => p.endsWith('/notes.txt')));
  });
});

describe('the roots', () => {
  test('with no VOICE_ALLOWED_DIRS: mythos/ first, then only content folders — never the repository, the profile or AppData', () => {
    const saved = process.env.VOICE_ALLOWED_DIRS;
    delete process.env.VOICE_ALLOWED_DIRS;
    try {
      const roots = computer.allowedRoots();
      assert.equal(roots[0], path.resolve(__dirname, '..'));
      const home = os.homedir().toLowerCase();
      for (const r of roots.slice(1)) {
        assert.notEqual(r.toLowerCase(), home, 'the whole profile is not a root any more');
        assert.equal(/appdata|[\\/]\./i.test(r), false, r);
        assert.ok(policy.CONTENT_FOLDERS.includes(path.basename(r)), r + ' is not a content folder');
      }
    } finally { process.env.VOICE_ALLOWED_DIRS = saved; }
  });

  test('computeRoots: the vault is a root wherever it lives; VOICE_ALLOWED_DIRS replaces the content folders; boundaries.md adds', () => {
    const exists = (p) => /Documents$|Downloads$/.test(p);
    const base = { mythosRoot: 'C:\\m', vaultRoot: 'C:\\data\\MYTHOS\\vault', homedir: 'C:\\home', exists };
    assert.deepEqual(policy.computeRoots(base).roots, ['C:\\m', 'C:\\data\\MYTHOS\\vault', 'C:\\home\\Documents', 'C:\\home\\Downloads']);
    assert.deepEqual(policy.computeRoots({ ...base, envValue: '%USERPROFILE%\\Work' }).roots, ['C:\\m', 'C:\\data\\MYTHOS\\vault', 'C:\\home\\Work']);
    const withIdentity = policy.computeRoots({ ...base, envValue: 'C:\\w', identityDirs: ['%USERPROFILE%\\Notes', 'C:\\'] });
    assert.deepEqual(withIdentity.roots, ['C:\\m', 'C:\\data\\MYTHOS\\vault', 'C:\\w', 'C:\\home\\Notes'], 'boundaries.md entries get %USERPROFILE% expanded too');
    assert.deepEqual(withIdentity.rejected.map((r) => r.reason), ['a whole drive'], 'what was ignored is returned, not dropped');
  });

  test('extra roots are validated: a drive, a network path, a relative path and a credential folder are refused', () => {
    const drive = path.parse(process.cwd()).root;
    const { ok, rejected } = policy.validateExtraRoots([drive, '\\\\server\\share', 'relative\\dir', path.join(root, '.ssh'), root]);
    assert.deepEqual(ok, [path.resolve(root)]);
    assert.deepEqual(rejected.map((r) => r.reason).sort(), ['a whole drive', 'network path', 'not an absolute path', 'protected (key-directory)'].sort());
  });
});

describe('the classifier', () => {
  test('protected shapes', () => {
    const P = (p, o) => policy.protectedReason(p, o);
    assert.equal(P(at('x/.env')).rule, 'env-file');
    assert.equal(P(at('x/prod.env.bak')).rule, 'env-file');
    assert.equal(P(at('x/.ENV.Local')).rule, 'env-file');
    assert.equal(P(at('Users/u/.ssh')).rule, 'key-directory');
    assert.equal(P(at('Users/u/.aws/credentials')).rule, 'key-directory');
    assert.equal(P(at('x/KEYS.JSON')).rule, 'credential-file');
    assert.equal(P(at('x/auth-sessions.json.tmp-1')).rule, 'auth-sessions');
    assert.equal(P(at('Users/u/AppData/Local/Microsoft/Edge/User Data/Default/Login Data')).rule, 'browser-profile');
    assert.equal(P(at('Users/u/AppData/Roaming/Mozilla/Firefox/Profiles/abc/logins.json')).rule, 'browser-profile');
    assert.equal(P(at('u/MYTHOS/config.json'), { settingsDir: at('u/MYTHOS') }).rule, 'settings-file');
  });

  test('ADJACENT: look-alikes stay readable', () => {
    for (const p of [at('x/env.js'), at('x/.venv/lib/site.py'), at('x/dotenv/index.js'), at('x/id_generator.js'), at('x/certs/server.pem'),
      at('x/skills/web/config.json'), at('x/keys.js'), at('x/Google/Chrome/notes.txt')]) {
      assert.equal(policy.protectedReason(p, { settingsDir: at('u/MYTHOS') }), null, p);
    }
  });
});

// ---- the independent review's findings (Opus, 2026-09-29) --------------------
// Probes, 2026-09-29, each applied and restored, each red here: the ":" refusal
// in resolveSandboxed removed (the ::$DATA reads succeed — the stream-strip in
// protectedReason still catches keys.json, so the plain-file case is what
// fails); segmentsOf not stripping streams (the protectedReason unit fails);
// realpathOrNull back to the JS walk (the .native pin fails); the new credential
// names removed; the vault dropped from computeRoots; boundariesRefusal removed
// from write_file; readHead replaced by a whole-file read (the bounded-read
// test fails). 8.3 short names cannot be created on this test drive (short names
// are off on D:), so .native is pinned by source; the reviewer measured that it
// expands SSH~1 to .ssh.
describe('review: other names for the same file', () => {
  test('an NTFS stream suffix is refused before any rule runs — ::$DATA and ::$INDEX_ALLOCATION', async () => {
    for (const rel of ['keys.json::$DATA', 'notes.txt::$DATA', '.ssh::$INDEX_ALLOCATION/id_rsa', 'notes.txt:hidden']) {
      const r = await computer.read_file({ path: path.join(root, rel) });
      assert.equal(r.ok, false, rel + ': ' + text(r));
      assert.doesNotMatch(text(r), new RegExp(CANARY), rel);
    }
    const l = await computer.list_folder({ path: path.join(root, 'sub') + '::$INDEX_ALLOCATION' });
    assert.equal(l.ok, false);
  });

  test('ADJACENT: the drive letter\'s own colon is fine', async () => {
    assert.equal((await computer.read_file({ path: path.join(root, 'notes.txt') })).ok, true);
  });

  test('the rule itself strips a stream suffix (a second line behind the ":" refusal)', () => {
    assert.equal(policy.protectedReason(at('x/keys.json::$DATA')).rule, 'credential-file');
    assert.equal(policy.protectedReason(at('u/.ssh::$INDEX_ALLOCATION/config')).rule, 'key-directory');
    assert.equal(policy.protectedReason(at('u/MYTHOS/config.json::$DATA'), { settingsDir: at('u/MYTHOS') }).rule, 'settings-file');
  });

  test('the canonical path is the NATIVE one, which expands 8.3 short names like SSH~1', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'file-walk.js'), 'utf8');
    assert.match(src, /function realpathOrNull\(p\) \{\s*try \{ return fs\.realpathSync\.native\(p\);/);
  });
});

describe('review: credential files the first list missed', () => {
  test('registry tokens, CLI token folders, Electron web storage, more browser channels', () => {
    const P = (p) => policy.protectedReason(p);
    for (const p of [at('u/.npmrc'), at('u/.pypirc'), at('u/.docker/config.json'), at('u/.config/gh/hosts.yml'),
      at('u/AppData/Roaming/GitHub CLI/hosts.yml'), at('u/AppData/Roaming/Slack/Local Storage/leveldb/000003.log'),
      at('u/AppData/Local/Google/Chrome Beta/User Data/Default/Preferences'), at('u/AppData/Local/Vivaldi/User Data/Default/Bookmarks'),
      at('u/AppData/Roaming/SomeApp/Cookies'), at('tmp/MYTHOS/chrome-debug-profile/Default/History')]) {
      assert.ok(P(p), p);
    }
  });

  test('ADJACENT: a folder called Cookies full of recipes, and an ordinary config.json, stay readable', () => {
    for (const p of [at('u/Documents/Recipes/Cookies/chocolate-chip.txt'), at('u/Documents/project/config.json'), at('u/Documents/gh/notes.md')]) {
      assert.equal(policy.protectedReason(p), null, p);
    }
  });
});

describe('review: the vault, the refusal text, boundaries.md, and a bounded read', () => {
  const vault = () => path.join(root, 'vault');
  before(() => {
    fs.mkdirSync(path.join(vault(), 'Identity'), { recursive: true });
    fs.writeFileSync(path.join(vault(), 'Identity', 'boundaries.md'), '# boundaries\n');
    fs.writeFileSync(path.join(vault(), 'note.md'), 'vault note\n');
    computer.registerFromComputer({ register() {} }, { config: { MYTHOS_VAULT_ROOT: vault() } });
  });

  test('a path outside every root: the refusal says how to add one, and names what was ignored', async () => {
    const saved = process.env.VOICE_ALLOWED_DIRS;
    process.env.VOICE_ALLOWED_DIRS = root + ';C:\\';
    try {
      const r = await computer.read_file({ path: path.join(os.homedir(), 'nowhere-b2d.txt') });
      assert.equal(r.ok, false);
      assert.match(String(r.result), /VOICE_ALLOWED_DIRS/);
      assert.match(String(r.result), /boundaries\.md/);
      assert.match(String(r.result), /Ignored as unsafe: C:\\ \(a whole drive\)/);
    } finally { process.env.VOICE_ALLOWED_DIRS = saved; }
  });

  test('file tools never write, move or delete boundaries.md or its folder — reading it is fine', async () => {
    const b = path.join(vault(), 'Identity', 'boundaries.md');
    for (const r of [computer.write_file({ path: b, content: 'allowed_dirs: C:\\' }), computer.delete_file({ path: b }),
      computer.move_file({ from: path.join(vault(), 'Identity'), to: path.join(root, 'moved-identity') }),
      computer.copy_file({ from: path.join(root, 'notes.txt'), to: b })]) {
      assert.equal(r.ok, false, text(r));
      assert.match(String(r.result), /human-editable only/);
    }
    assert.equal(fs.readFileSync(b, 'utf8'), '# boundaries\n', 'untouched');
    assert.equal((await computer.read_file({ path: b })).ok, true);
    assert.equal(computer.write_file({ path: path.join(vault(), 'Identity', 'other.md'), content: 'x' }).ok, true, 'ADJACENT: a sibling file is writable');
  });

  test('read_file says how many values it redacted, and reads only the head plus a margin', async () => {
    plant('redact-me.txt', 'plain line\nDB_PASSWORD=' + CANARY + '\n');
    const r = await computer.read_file({ path: path.join(root, 'redact-me.txt') });
    assert.equal(r.ok, true);
    assert.match(r.result.redacted, /^1 secret-looking value/);
    // A secret far past head + margin is never READ, so it is not counted.
    plant('big.txt', 'a'.repeat(200 * 1024) + '\nDB_PASSWORD=' + CANARY + '\n');
    const big = await computer.read_file({ path: path.join(root, 'big.txt') });
    assert.equal(big.ok, true);
    assert.equal(big.result.truncated, true);
    assert.equal(big.result.redacted, undefined, 'the whole file was read, not the head');
  });
});

describe('review: an upload sends a file, so the policy applies to it', () => {
  test('browser_upload_file refuses a credential file even inside the upload folder; an ordinary file still goes', () => {
    const saved = process.env.BROWSER_UPLOAD_DIR;
    process.env.BROWSER_UPLOAD_DIR = root;
    const FB = require.resolve('../src/core/effectors/from-browser');
    delete require.cache[FB];
    try {
      const fb = require(FB);
      for (const rel of ['.env', 'keys.json', 'auth-sessions.json']) {
        const r = fb.resolveUploadPath(path.join(root, rel));
        assert.equal(r.ok, false, rel);
        assert.match(r.reason, /protected/, rel);
      }
      assert.equal(fb.resolveUploadPath(path.join(root, 'notes.txt')).ok, true);
    } finally {
      if (saved === undefined) delete process.env.BROWSER_UPLOAD_DIR; else process.env.BROWSER_UPLOAD_DIR = saved;
      delete require.cache[FB];
    }
  });
});
