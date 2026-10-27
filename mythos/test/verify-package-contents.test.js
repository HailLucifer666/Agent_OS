'use strict';

// test/verify-package-contents.test.js — the artifact scanner must go red on a
// build that carries a forbidden file, and must never report "clean" when it
// could not actually read something (2026-09-29 audit, B1).
//
// The fake builds are REAL archives: app.asar is written by @electron/asar with
// mythos/ unpacked beside it, the same shape electron-builder produces, so the
// scanner reads a genuine asar header rather than a stub. The installer layer
// uses an injected 7za (list/extract) because a real NSIS build takes minutes;
// the real 7za path is exercised by the proof build recorded in the PR, and the
// -slt parser is pinned below against a captured listing.
//
// Reference run against the operator's real 2026-09-23 dist/win-unpacked (names
// only, nothing opened): exit 1, 22 lines, naming the four .env backups, the
// pidfile, .env.example, .tmp-test and four vault_test_audit_* directories in
// both the asar header and the unpacked tree.
//
// End-to-end, 2026-09-29, on two real unpublished builds from one worktree with
// fake canaries planted (.env.bak-canary-b1, "Canary NIM.env", .ENV.Local,
// auth-sessions.json, vault_test_audit_canary/, .tmp-canary/): the build from
// this branch's config scanned CLEAN on all layers, installer included, and its
// installer's app.asar was byte-identical to win-unpacked's; the same tree built
// with the policy tail removed scanned FORBIDDEN, 28 findings across app.asar,
// app.asar.unpacked, installer:app.asar and installer:app.asar.unpacked.
//
// PROVEN ABLE TO FAIL, same day: twelve scanner mutations — never flag a
// forbidden path; swallow an unreadable asar; follow links; keep a stale
// receipt; treat an empty 7za listing as clean; drop the layout check; miss the
// inner NSIS archive; skip the installer's asar; let a layout problem hide a
// forbidden one; ignore 7za's direct (Type = 7z) reading; guess a missing type;
// treat an unknown type as payload — each turned a named test here red.
//
// After independent review (Opus), same day, three more: remove the stale
// receipt only after the layout check (the old placement — its test had asserted
// the absence of a file that never existed, and passed vacuously); accept an
// installer embedding two app archives; drop the read-to-read carry so a
// signature split across two reads is missed. Each red here.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scanner = require('../scripts/verify-package-contents.js');

const CANARY = 'CANARY-SECRET-VALUE-4f1c9e';

const BASE_APP = {
  'package.json': '{"name":"mythos-shell"}',
  'electron/main.js': 'x',
  'mythos/package.json': '{}',
  'mythos/src/main.js': 'x',
  'mythos/ui/public/index.html': '<!doctype html>',
  'mythos/skills/web/config.json': '{}',
};

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-scan-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

// dist/win-unpacked the way electron-builder lays it out: runtime files at the
// top, resources/app.asar, resources/app.asar.unpacked/mythos/**, and
// extraResources beside them.
async function fakeUnpacked(root, { app = {}, drop = [], extraResources = {}, runtime = {} } = {}) {
  const asar = require('@electron/asar');
  const src = path.join(root, 'app-src');
  const files = { ...BASE_APP, ...app };
  for (const rel of drop) delete files[rel];
  writeTree(src, files);
  const unpacked = path.join(root, 'win-unpacked');
  const resources = path.join(unpacked, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  await asar.createPackageWithOptions(src, path.join(resources, 'app.asar'), { unpackDir: 'mythos' });
  writeTree(resources, { 'mythos-browser-host.exe': 'x', ...extraResources });
  writeTree(unpacked, { 'MYTHOS.exe': 'x', 'locales/en-US.pak': 'x', ...runtime });
  return unpacked;
}

function quiet() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
}

describe('scanning an unpacked build', () => {
  test('a clean build is clean, exit 0', async (t) => {
    const dir = await fakeUnpacked(tmpRoot(t));
    const out = quiet();
    const res = await scanner.run(['--unpacked', dir], { log: out.log });
    assert.deepEqual({ status: res.status, problems: res.problems, exitCode: res.exitCode },
      { status: 'clean', problems: [], exitCode: 0 });
  });

  test('a planted .env backup is named in BOTH the asar header and the unpacked tree, by name only', async (t) => {
    const dir = await fakeUnpacked(tmpRoot(t), { app: { 'mythos/.env.bak-canary': `MISTRAL_API_KEY=${CANARY}` } });
    const out = quiet();
    const res = await scanner.run(['--unpacked', dir], { log: out.log });
    assert.equal(res.status, 'forbidden');
    assert.equal(res.exitCode, 1);
    const hits = res.problems.filter((p) => p.path === 'mythos/.env.bak-canary').map((p) => p.layer).sort();
    assert.deepEqual(hits, ['app.asar', 'app.asar.unpacked']);
    // The report is names and reasons. The secret itself must never be read into it.
    assert.equal(JSON.stringify(res).includes(CANARY), false, 'the result must not carry file content');
    assert.equal(out.lines.join('\n').includes(CANARY), false, 'the log must not carry file content');
  });

  test('extraResources and the runtime root are scanned too', async (t) => {
    const dir = await fakeUnpacked(tmpRoot(t), { extraResources: { '.env': 'x' }, runtime: { 'prod.env': 'x' } });
    const res = await scanner.run(['--unpacked', dir], quiet());
    const layers = res.problems.map((p) => `${p.layer} ${p.path}`).sort();
    assert.deepEqual(layers, ['extraResources .env', 'runtime prod.env']);
  });

  test('a forbidden directory is reported once, with its count', async (t) => {
    const dir = await fakeUnpacked(tmpRoot(t), {
      app: { 'mythos/vault_test_audit_1/Audit/a.jsonl': 'x', 'mythos/vault_test_audit_1/Audit/b.jsonl': 'x' },
    });
    const res = await scanner.run(['--unpacked', dir], quiet());
    const unpackedHits = res.problems.filter((p) => p.layer === 'app.asar.unpacked');
    assert.equal(unpackedHits.length, 1);
    assert.equal(unpackedHits[0].path, 'mythos/vault_test_audit_1');
    assert.match(unpackedHits[0].reason, /3 entries inside/);
  });

  test('a junction is refused as unprovable, never followed', async (t) => {
    const root = tmpRoot(t);
    const dir = await fakeUnpacked(root);
    const outside = path.join(root, 'outside');
    writeTree(outside, { '.env': 'x' });
    fs.symlinkSync(outside, path.join(dir, 'resources', 'app.asar.unpacked', 'mythos', 'linked'), 'junction');
    const res = await scanner.run(['--unpacked', dir], quiet());
    assert.equal(res.status, 'link');
    assert.equal(res.exitCode, 2);
    assert.ok(res.problems.some((p) => p.kind === 'link' && p.path === 'mythos/linked'));
    assert.equal(res.problems.some((p) => p.path.endsWith('.env')), false, 'the link target must not have been walked');
  });

  test('a build missing the server entry point is a layout failure, not clean', async (t) => {
    const dir = await fakeUnpacked(tmpRoot(t), { drop: ['mythos/src/main.js'] });
    const res = await scanner.run(['--unpacked', dir], quiet());
    assert.equal(res.status, 'layout');
    assert.equal(res.exitCode, 2);
  });

  test('an unreadable app.asar is "unreadable", never clean', async (t) => {
    const dir = await fakeUnpacked(tmpRoot(t));
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'not an asar archive');
    const res = await scanner.run(['--unpacked', dir], quiet());
    assert.equal(res.status, 'unreadable');
    assert.equal(res.exitCode, 2);
  });

  test('a directory that is not a build at all is a layout failure', async (t) => {
    const root = tmpRoot(t);
    const res = await scanner.run(['--unpacked', root], quiet());
    assert.equal(res.status, 'layout');
  });

  test('"forbidden" is the headline even when something else was also wrong — and nothing is dropped', () => {
    const o = scanner.outcomeOf([
      { kind: 'layout', layer: 'x', path: 'a', reason: 'r' },
      { kind: 'forbidden', layer: 'x', path: 'b', reason: 'r' },
    ]);
    assert.equal(o.status, 'forbidden');
    assert.equal(o.problems.length, 2);
  });
});

// ---- the installer layer ------------------------------------------------------

// A stand-in 7za: `outer` and `inner` are entry lists; extracting the inner
// archive or its app.asar copies a real asar made by fakeUnpacked().
// `outerType` is the archive type 7-Zip reports for the .exe: "Nsis" from a full
// 7-Zip, "7z" from the standalone 7za electron-builder ships (measured on a real
// installer — see scanInstaller), where the listing IS the app payload.
function fake7z({ outer, inner, asarPath, failOn = null, outerType = 'Nsis' }) {
  return {
    list: (archive) => {
      if (failOn === 'list-outer' && /\.exe$/.test(archive)) throw new Error('7za exited 2: Can not open the file as archive');
      if (failOn === 'list-inner' && /\.7z$/.test(archive)) throw new Error('7za exited 2: Data Error');
      return /\.exe$/.test(archive) ? { type: outerType, entries: outer } : { type: '7z', entries: inner };
    },
    extract: (archive, member, outDir) => {
      if (failOn === 'extract') throw new Error('7za exited 2: CRC Failed');
      fs.mkdirSync(outDir, { recursive: true });
      const dest = path.join(outDir, path.basename(member));
      if (member.endsWith('app.asar')) fs.copyFileSync(asarPath, dest);
      else fs.writeFileSync(dest, 'inner archive placeholder');
      return dest;
    },
  };
}

const OUTER_OK = [
  { path: '$PLUGINSDIR/app-64.7z', type: 'file' },
  { path: '$PLUGINSDIR/nsis7z.dll', type: 'file' },
  { path: 'Uninstall MYTHOS.exe', type: 'file' },
];
const INNER_OK = [
  { path: 'MYTHOS.exe', type: 'file' },
  { path: 'resources', type: 'dir' },
  { path: 'resources/app.asar', type: 'file' },
  { path: 'resources/app.asar.unpacked', type: 'dir' },
  { path: 'resources/app.asar.unpacked/mythos', type: 'dir' },
  { path: 'resources/app.asar.unpacked/mythos/package.json', type: 'file' },
  { path: 'resources/app.asar.unpacked/mythos/src/main.js', type: 'file' },
  { path: 'resources/mythos-browser-host.exe', type: 'file' },
];

// A stub, then one embedded 7z archive — the shape of a real single-arch
// installer (measured: one signature, at byte 195316 of MYTHOS Setup 0.1.12.exe).
const SIG = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const ONE_ARCHIVE = Buffer.concat([Buffer.from('MZ nsis stub '), SIG, Buffer.from(' payload')]);

async function installerCase(t, { outer = OUTER_OK, inner = INNER_OK, app = {}, failOn = null, outerType = 'Nsis', bytes = ONE_ARCHIVE } = {}) {
  const root = tmpRoot(t);
  const dir = await fakeUnpacked(root, { app });
  const installer = path.join(root, 'MYTHOS Setup 9.9.9.exe');
  fs.writeFileSync(installer, bytes);
  const sevenZip = fake7z({ outer, inner, asarPath: path.join(dir, 'resources', 'app.asar'), failOn, outerType });
  const cleanDir = await fakeUnpacked(path.join(root, 'clean'));
  return scanner.run(['--unpacked', cleanDir, '--installer', installer], { log: () => {}, sevenZip, workRoot: root });
}

describe('scanning the installer', () => {
  test('a clean installer is clean', async (t) => {
    const res = await installerCase(t);
    assert.deepEqual(res.problems, []);
    assert.equal(res.status, 'clean');
  });

  test('a forbidden file in the installer\'s unpacked tree is named with its layer', async (t) => {
    const res = await installerCase(t, {
      inner: INNER_OK.concat([{ path: 'resources/app.asar.unpacked/mythos/.env.bak-2026-08-15', type: 'file' }]),
    });
    assert.equal(res.status, 'forbidden');
    assert.deepEqual(res.problems.map((p) => `${p.layer} ${p.path}`),
      ['installer:app-64.7z:app.asar.unpacked mythos/.env.bak-2026-08-15']);
  });

  test('a forbidden file inside the installer\'s app.asar is found by reading that header', async (t) => {
    const res = await installerCase(t, { app: { 'mythos/keys.json': '{}' } });
    assert.equal(res.status, 'forbidden');
    assert.ok(res.problems.some((p) => p.layer === 'installer:app-64.7z:app.asar' && p.path === 'mythos/keys.json'));
  });

  test('an installer with no inner app archive is a layout failure', async (t) => {
    const res = await installerCase(t, { outer: OUTER_OK.slice(1) });
    assert.equal(res.status, 'layout');
  });

  test('an inner archive without app.asar is a layout failure', async (t) => {
    const res = await installerCase(t, { inner: INNER_OK.filter((e) => e.path !== 'resources/app.asar') });
    assert.equal(res.status, 'layout');
  });

  for (const failOn of ['list-outer', 'list-inner', 'extract']) {
    test(`a 7za failure (${failOn}) is "unreadable", never clean`, async (t) => {
      const res = await installerCase(t, { failOn });
      assert.equal(res.status, 'unreadable');
      assert.equal(res.exitCode, 2);
    });
  }

  // The reading the real toolchain produces: 7za has no NSIS reader and opens the
  // embedded app archive directly, so the .exe listing is the payload itself.
  test("7za's direct reading (Type = 7z): a clean payload is clean", async (t) => {
    const res = await installerCase(t, { outerType: '7z', outer: INNER_OK });
    assert.deepEqual(res.problems, []);
  });

  test("7za's direct reading (Type = 7z): a forbidden payload entry and a forbidden asar entry are both named", async (t) => {
    const res = await installerCase(t, {
      outerType: '7z',
      outer: INNER_OK.concat([{ path: 'resources/app.asar.unpacked/mythos/.env.bak-voicenodes', type: 'file' }]),
      app: { 'mythos/.env.pre-attended-2026-09-21.bak': 'x' },
    });
    assert.equal(res.status, 'forbidden');
    const named = res.problems.map((p) => `${p.layer} ${p.path}`).sort();
    assert.deepEqual(named, [
      'installer:app.asar mythos/.env.pre-attended-2026-09-21.bak',
      'installer:app.asar.unpacked mythos/.env.bak-voicenodes',
    ]);
  });

  // Independent review, 2026-09-29: the direct reading sees only the first
  // embedded archive, so a two-architecture installer would scan half.
  test("7za's direct reading refuses an installer embedding two app archives", async (t) => {
    const two = Buffer.concat([ONE_ARCHIVE, Buffer.from(' arm64 '), SIG, Buffer.from(' payload')]);
    const res = await installerCase(t, { outerType: '7z', outer: INNER_OK, bytes: two });
    assert.equal(res.status, 'unreadable');
    assert.match(res.problems[0].reason, /embeds 2 7z archives/);
  });

  test('the signature count finds a signature split across two reads, and counts none twice', (t) => {
    const root = tmpRoot(t);
    const file = path.join(root, 'x.exe');
    // chunk size 8: the first signature straddles bytes 5..10, the second sits whole in one read.
    fs.writeFileSync(file, Buffer.concat([Buffer.from('abcde'), SIG, Buffer.from('fghijklmnopq'), SIG, Buffer.from('rs')]));
    assert.equal(scanner.count7zSignatures(file, 8), 2);
    assert.equal(scanner.count7zSignatures(file), 2);
    fs.writeFileSync(file, Buffer.from('no archive here'));
    assert.equal(scanner.count7zSignatures(file, 4), 0);
  });

  test('--installer alone reads a published installer with no unpacked tree beside it', async (t) => {
    const root = tmpRoot(t);
    const dir = await fakeUnpacked(root, { app: {} });
    const installer = path.join(root, 'MYTHOS-Setup-9.9.9.exe');
    fs.writeFileSync(installer, ONE_ARCHIVE);
    const sevenZip = fake7z({
      outer: INNER_OK.concat([{ path: 'resources/app.asar.unpacked/mythos/.env.bak-voicenodes', type: 'file' }]),
      inner: INNER_OK, asarPath: path.join(dir, 'resources', 'app.asar'), outerType: '7z',
    });
    const res = await scanner.run(['--installer', installer], { log: () => {}, sevenZip, workRoot: root });
    assert.equal(res.status, 'forbidden');
    assert.deepEqual(res.problems.map((p) => `${p.layer} ${p.path}`), ['installer:app.asar.unpacked mythos/.env.bak-voicenodes']);
  });

  test('an archive type that is neither NSIS nor its payload is refused, not guessed at', async (t) => {
    const res = await installerCase(t, { outerType: 'PE', outer: INNER_OK });
    assert.equal(res.status, 'unreadable');
    assert.match(res.problems[0].reason, /"PE"/);
  });
});

describe('parse7zSlt', () => {
  // Shape of `7za l -slt` output: archive header, a dashed separator, then one
  // blank-line separated block per entry.
  // Header lines captured verbatim from 7-Zip 24.09's standalone 7za listing a
  // real "MYTHOS Setup 0.1.12.exe" (2026-09-29), entries trimmed. Note the
  // WARNINGS lines: 7za found the app archive embedded in the NSIS stub.
  const SAMPLE = [
    '7-Zip (a) 24.09 (x86) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29',
    '',
    'Scanning the drive for archives:',
    '1 file, 270752115 bytes (259 MiB)',
    '',
    'Listing archive: dist\\MYTHOS Setup 0.1.12.exe',
    '',
    '--',
    'Path = dist\\MYTHOS Setup 0.1.12.exe',
    'Type = 7z',
    'WARNINGS:',
    'There are data after the end of archive',
    'Offset = 195316',
    'Physical Size = 270147672',
    'Tail Size = 409127',
    'Headers Size = 60794',
    'Method = Delta ARM64 LZMA2:20 LZMA:20 BCJ2',
    'Solid = -',
    'Blocks = 4665',
    '',
    '----------',
    'Path = resources\\app.asar',
    'Size = 5990440',
    'Packed Size = 773558',
    'Modified = ',
    'Attributes = A',
    'CRC = 8807966C',
    'Encrypted = -',
    'Method = LZMA2:20',
    'Block = 61',
    '',
    'Path = $PLUGINSDIR\\app-64.7z',
    'Folder = -',
    'Size = 270000000',
    '',
    'Path = $PLUGINSDIR',
    'Folder = +',
    '',
    'Path = resources\\app.asar.unpacked\\mythos\\linked',
    'Attributes = A',
    'Symbolic Link = C:\\elsewhere',
    '',
  ].join('\r\n');

  test('reads paths, folders and links, normalised to forward slashes', () => {
    assert.deepEqual(scanner.parse7zSlt(SAMPLE), [
      { path: 'resources/app.asar', type: 'file' },
      { path: '$PLUGINSDIR/app-64.7z', type: 'file' },
      { path: '$PLUGINSDIR', type: 'dir' },
      { path: 'resources/app.asar.unpacked/mythos/linked', type: 'link' },
    ]);
  });

  test('reads the archive type from the header, never from an entry', () => {
    assert.equal(scanner.archiveTypeOf(SAMPLE), '7z');
    assert.equal(scanner.archiveTypeOf(SAMPLE.replace('Type = 7z', 'Type = Nsis')), 'Nsis');
    assert.throws(() => scanner.archiveTypeOf(['7-Zip', '----------', 'Path = x', ''].join('\r\n')), /no archive header/);
    assert.throws(() => scanner.archiveTypeOf(SAMPLE.replace('Type = 7z\r\n', '')), /does not state the archive type/);
  });

  test('refuses output with no entry table instead of returning an empty (clean-looking) list', () => {
    assert.throws(() => scanner.parse7zSlt('7-Zip\r\nERROR: cannot open file\r\n'), /no entry table/);
  });
});

// ---- the receipt the upload step trusts -------------------------------------------

async function fakeDist(t, app = {}) {
  const root = tmpRoot(t);
  const distDir = path.join(root, 'dist');
  const unpacked = await fakeUnpacked(distDir, { app });
  assert.equal(unpacked, path.join(distDir, 'win-unpacked'));
  writeTree(distDir, {
    'MYTHOS Setup 9.9.9.exe': 'installer-bytes',
    'MYTHOS Setup 9.9.9.exe.blockmap': 'blockmap-bytes',
    'latest.yml': 'version: 9.9.9\nfiles:\n  - url: MYTHOS-Setup-9.9.9.exe\npath: MYTHOS-Setup-9.9.9.exe\n',
  });
  return { root, distDir };
}

describe('the scan receipt', () => {
  test('upload names come from latest.yml, the file the updater reads', async (t) => {
    const { distDir } = await fakeDist(t);
    const a = scanner.artifactsFromDist(distDir);
    assert.equal(a.version, '9.9.9');
    assert.deepEqual(a.upload.map((u) => [path.basename(u.file), u.name]), [
      ['MYTHOS Setup 9.9.9.exe', 'MYTHOS-Setup-9.9.9.exe'],
      ['MYTHOS Setup 9.9.9.exe.blockmap', 'MYTHOS-Setup-9.9.9.exe.blockmap'],
      ['latest.yml', 'latest.yml'],
    ]);
  });

  test('a clean scan writes a receipt pinning each artifact\'s sha256', async (t) => {
    const { root, distDir } = await fakeDist(t);
    const receipt = path.join(distDir, 'package-scan.json');
    const sevenZip = fake7z({ outer: OUTER_OK, inner: INNER_OK, asarPath: path.join(distDir, 'win-unpacked', 'resources', 'app.asar') });
    const res = await scanner.run(['--dist', distDir, '--receipt', receipt], { log: () => {}, sevenZip, workRoot: root });
    assert.equal(res.status, 'clean');
    const r = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(r.status, 'clean');
    assert.equal(r.version, '9.9.9');
    assert.deepEqual(r.artifacts.map((a) => a.name), ['MYTHOS-Setup-9.9.9.exe', 'MYTHOS-Setup-9.9.9.exe.blockmap', 'latest.yml']);
    assert.equal(r.artifacts[0].sha256, scanner.sha256File(path.join(distDir, 'MYTHOS Setup 9.9.9.exe')));
  });

  test('a forbidden scan writes NO receipt, and removes a stale one from an earlier clean build', async (t) => {
    const { root, distDir } = await fakeDist(t, { 'mythos/.env.local': 'x' });
    const receipt = path.join(distDir, 'package-scan.json');
    fs.writeFileSync(receipt, JSON.stringify({ schema: 1, status: 'clean', version: '9.9.9', artifacts: [] }));
    const sevenZip = fake7z({ outer: OUTER_OK, inner: INNER_OK, asarPath: path.join(distDir, 'win-unpacked', 'resources', 'app.asar') });
    const res = await scanner.run(['--dist', distDir, '--receipt', receipt], { log: () => {}, sevenZip, workRoot: root });
    assert.equal(res.status, 'forbidden');
    assert.equal(fs.existsSync(receipt), false, 'a stale clean receipt must not survive a red scan');
  });

  // Independent review, 2026-09-29: this test used to assert that r.json was
  // absent — a file that had never existed, so it passed without testing
  // anything while the layout failure's early return left a real stale receipt
  // in place. The fixture now starts with a clean receipt on disk.
  test('a dist with no latest.yml cannot be vouched for, and an earlier receipt does not survive it', async (t) => {
    const { distDir } = await fakeDist(t);
    const receipt = path.join(distDir, 'package-scan.json');
    fs.writeFileSync(receipt, JSON.stringify({ schema: 1, status: 'clean', version: '9.9.9', artifacts: [] }));
    fs.rmSync(path.join(distDir, 'latest.yml'));
    const res = await scanner.run(['--dist', distDir, '--receipt', receipt], { log: () => {} });
    assert.equal(res.status, 'layout');
    assert.equal(fs.existsSync(receipt), false, 'the stale clean receipt must be gone');
  });

  test('the cli refuses arguments it does not know rather than scanning nothing', async () => {
    await assert.rejects(scanner.run(['--unpacked'], { log: () => {} }), /needs a value/);
    await assert.rejects(scanner.run(['--frobnicate', 'x'], { log: () => {} }), /unknown argument/);
    await assert.rejects(scanner.run([], { log: () => {} }), /--unpacked <dir>, --dist <dir> or --installer <file>/);
    await assert.rejects(scanner.run(['--unpacked', 'x', '--receipt', 'y'], { log: () => {} }), /--receipt needs --dist/);
  });
});
