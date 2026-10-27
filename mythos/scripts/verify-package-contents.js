#!/usr/bin/env node
'use strict';

// scripts/verify-package-contents.js — prove a finished Windows build carries no
// credential or scratch file, by reading the ARTIFACT rather than the config.
//
// Why the artifact and not package.json: build.files is an intention. What an
// installer holds is decided by electron-builder's matcher over the working
// directory at build time, and on 2026-09-23 that put four .env backups into
// dist/win-unpacked while every config-level check was green (2026-09-29 audit,
// B1). The rules are electron/package-policy.js — the same ones build.files and
// mythos/.dockerignore are generated from — so this and the build agree on what
// "forbidden" means; test/package-policy.test.js proves the build half.
//
// Four layers, each normalised to the same relative spelling first:
//   app.asar            listed from its header (@electron/asar)
//   app.asar.unpacked   walked on disk (lstat, so links are seen, not followed)
//   extraResources      every other entry under resources/
//   the NSIS installer  listed with 7za (the app payload it embeds — see
//                       scanInstaller for what that reading cannot see), then the
//                       app.asar inside it — extracting ONLY containers, never a
//                       member the policy forbids
//
// Outcomes are distinct on purpose, because "false" on a multi-way failure hides
// which way it failed:
//   clean       exit 0  every layer read, nothing forbidden
//   forbidden   exit 1  at least one forbidden path (named, with its rule)
//   unreadable  exit 2  an archive or tool could not be read — nothing proven
//   layout      exit 2  an expected file is missing — this may not be our build
//   link        exit 2  a symlink/junction — its target is outside what we read
// Output is relative names and reasons only. No file content is ever read,
// printed or hashed except the three upload artifacts in --receipt mode.
//
// Usage:
//   node scripts/verify-package-contents.js --unpacked <dir> [--installer <exe>]
//   node scripts/verify-package-contents.js --dist <dir> --receipt <file>
//     (--dist resolves win-unpacked, the installer latest.yml names, and its
//      .blockmap; the receipt pins their sha256 for scripts/publish-scanned-release.js)
// 7za: MYTHOS_7ZA_PATH, else electron-builder's own toolset (cached under
// ELECTRON_BUILDER_CACHE, defaulting to <repo>/.electron-builder-cache).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const policy = require(path.join(REPO_ROOT, 'electron', 'package-policy.js'));

const EXIT = Object.freeze({ clean: 0, forbidden: 1, unreadable: 2, layout: 2, link: 2 });
// What must exist for a directory to be one of OUR builds. Checked in every
// app layer (unpacked dir and the copy inside the installer).
const EXPECTED_IN_ASAR = Object.freeze(['package.json', 'electron/main.js']);
const EXPECTED_UNPACKED = Object.freeze(['mythos/package.json', 'mythos/src/main.js']);
const INNER_APP_ARCHIVE = /^\$PLUGINSDIR\/app-[a-z0-9]+\.7z$/i;
// The six bytes every 7z archive starts with ("7z\xBC\xAF\x27\x1C").
const SEVEN_Z_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SIGNATURE_READ_CHUNK = 8 * 1024 * 1024;

function toRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '');
}

// ---- listers ------------------------------------------------------------------

// Entries of an asar archive from its header alone. Throws on an unreadable
// archive; the caller turns that into "unreadable", never into "clean".
function listAsarEntries(archivePath) {
  const asar = require('@electron/asar');
  const { header } = asar.getRawHeader(archivePath);
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.link !== undefined) out.push({ path: rel, type: 'link' });
      else if (child.files) { out.push({ path: rel, type: 'dir' }); walk(child, rel); }
      else out.push({ path: rel, type: 'file' });
    }
  };
  walk(header, '');
  return out;
}

// Entries under a directory, relative to it. lstat, so a symlink or junction is
// reported as a link and never followed.
function walkDir(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = toRel(path.relative(root, abs));
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out.push({ path: rel, type: 'link' });
      else if (st.isDirectory()) { out.push({ path: rel, type: 'dir' }); walk(abs); }
      else out.push({ path: rel, type: 'file' });
    }
  };
  walk(root);
  return out;
}

// The archive-level "Type = …" line, from the block between "--" and the dashed
// separator. This decides how an installer listing is read (see scanInstaller).
function archiveTypeOf(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '--');
  const end = lines.findIndex((l) => /^-{10,}$/.test(l.trim()));
  if (start < 0 || end < start) throw new Error('7za listing has no archive header');
  const typeLine = lines.slice(start, end).find((l) => /^Type = /.test(l));
  if (!typeLine) throw new Error('7za listing does not state the archive type');
  return typeLine.slice('Type = '.length).trim();
}

// Parses `7za l -slt` output: a header, a line of dashes, then one blank-line
// separated block of "Key = Value" lines per entry.
function parse7zSlt(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{10,}$/.test(l.trim()));
  if (start < 0) throw new Error('7za listing has no entry table');
  const entries = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.Path !== undefined) {
      const isDir = cur.Folder === '+' || /D/.test(cur.Attributes || '');
      const isLink = Boolean(cur['Symbolic Link']);
      entries.push({ path: toRel(cur.Path), type: isLink ? 'link' : isDir ? 'dir' : 'file' });
    }
    cur = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') { flush(); continue; }
    const m = /^([^=]+?) = (.*)$/.exec(line);
    if (!m) continue;
    cur = cur || {};
    cur[m[1]] = m[2];
  }
  flush();
  return entries;
}

// ---- classification -----------------------------------------------------------

function problemsFor(layer, entries) {
  const problems = [];
  for (const e of entries) {
    if (e.type === 'link') {
      problems.push({ kind: 'link', layer, path: e.path, reason: 'symlink or junction; its target was not read' });
      continue;
    }
    const verdict = policy.classifyPackagedPath(e.path);
    if (verdict.forbidden) {
      problems.push({ kind: 'forbidden', layer, path: e.path, reason: `package-policy rule "${verdict.rule}"` });
    }
  }
  return collapseForbiddenDirs(problems);
}

// A forbidden directory makes every entry under it forbidden too. Report the
// directory once, with a count, instead of every child — listing each file of a
// test vault buries the four lines that matter. Order-independent, because a
// 7za listing does not promise parents before children.
function collapseForbiddenDirs(problems) {
  const forbidden = problems.filter((p) => p.kind === 'forbidden');
  const paths = new Set(forbidden.map((p) => p.path));
  const ancestorOf = (p) => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const up = parts.slice(0, i).join('/');
      if (paths.has(up)) return up;
    }
    return null;
  };
  const inside = new Map();
  const kept = [];
  for (const p of problems) {
    const up = p.kind === 'forbidden' ? ancestorOf(p.path) : null;
    if (up) inside.set(up, (inside.get(up) || 0) + 1);
    else kept.push(p);
  }
  return kept.map((p) => (inside.has(p.path) ? { ...p, reason: `${p.reason}; ${inside.get(p.path)} entries inside` } : p));
}

function missingFrom(layer, entries, expected) {
  const have = new Set(entries.map((e) => e.path.toLowerCase()));
  return expected.filter((p) => !have.has(p.toLowerCase()))
    .map((p) => ({ kind: 'layout', layer, path: p, reason: 'expected in every MYTHOS build, not found' }));
}

function unreadable(layer, where, err) {
  return { kind: 'unreadable', layer, path: toRel(where), reason: String((err && err.message) || err).split('\n')[0] };
}

// Splits a resources/ subtree into its three layers. `entries` are relative to
// the resources directory.
function splitResources(entries) {
  const unpacked = [];
  const extra = [];
  for (const e of entries) {
    if (e.path === 'app.asar' || e.path === 'app.asar.unpacked') continue;
    if (e.path.startsWith('app.asar.unpacked/')) unpacked.push({ ...e, path: e.path.slice('app.asar.unpacked/'.length) });
    else extra.push(e);
  }
  return { unpacked, extra };
}

// ---- layers -------------------------------------------------------------------

function scanAsar(layer, archivePath) {
  let entries;
  try {
    entries = listAsarEntries(archivePath);
  } catch (err) {
    return [unreadable(layer, 'app.asar', err)];
  }
  return problemsFor(layer, entries).concat(missingFrom(layer, entries, EXPECTED_IN_ASAR));
}

function scanUnpacked(dir) {
  const resources = path.join(dir, 'resources');
  const asarPath = path.join(resources, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    return [{ kind: 'layout', layer: 'unpacked', path: 'resources/app.asar', reason: 'not found — is this a win-unpacked directory?' }];
  }
  let all;
  try {
    all = walkDir(dir);
  } catch (err) {
    return [unreadable('unpacked', dir, err)];
  }
  const runtime = all.filter((e) => e.path !== 'resources' && !e.path.startsWith('resources/'));
  const inResources = all.filter((e) => e.path.startsWith('resources/'))
    .map((e) => ({ ...e, path: e.path.slice('resources/'.length) }));
  const { unpacked, extra } = splitResources(inResources);
  return scanAsar('app.asar', asarPath)
    .concat(problemsFor('app.asar.unpacked', unpacked))
    .concat(missingFrom('app.asar.unpacked', unpacked, EXPECTED_UNPACKED))
    .concat(problemsFor('extraResources', extra))
    .concat(problemsFor('runtime', runtime));
}

// ---- 7za ------------------------------------------------------------------------

function real7z(exe) {
  const run = (args) => {
    const res = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (res.error) throw new Error(`7za did not start: ${res.error.code || res.error.message}`);
    if (res.status !== 0) throw new Error(`7za exited ${res.status}: ${String(res.stderr || '').trim().split('\n')[0]}`);
    return res.stdout;
  };
  return {
    list: (archive) => {
      const text = run(['l', '-slt', archive]);
      return { type: archiveTypeOf(text), entries: parse7zSlt(text) };
    },
    // "e" flattens, so the extracted container lands at outDir/<basename>.
    extract: (archive, member, outDir) => {
      run(['e', archive, member.replace(/\//g, path.sep), `-o${outDir}`, '-y']);
      return path.join(outDir, path.basename(member));
    },
  };
}

async function resolve7za() {
  if (process.env.MYTHOS_7ZA_PATH) return process.env.MYTHOS_7ZA_PATH;
  if (!process.env.ELECTRON_BUILDER_CACHE) {
    process.env.ELECTRON_BUILDER_CACHE = path.join(REPO_ROOT, '.electron-builder-cache');
  }
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
  return getPath7za();
}

// The app payload — the packed win-unpacked tree — whichever archive holds it.
// `archive` is what 7za extracts resources/app.asar from.
function scanAppPayload(sevenZip, archive, entries, workDir, layer) {
  const runtime = entries.filter((e) => e.path !== 'resources' && !e.path.startsWith('resources/'));
  const inResources = entries.filter((e) => e.path.startsWith('resources/'))
    .map((e) => ({ ...e, path: e.path.slice('resources/'.length) }));
  const { unpacked, extra } = splitResources(inResources);
  const problems = problemsFor(`${layer}:app.asar.unpacked`, unpacked)
    .concat(missingFrom(`${layer}:app.asar.unpacked`, unpacked, EXPECTED_UNPACKED))
    .concat(problemsFor(`${layer}:extraResources`, extra))
    .concat(problemsFor(`${layer}:runtime`, runtime));
  if (!inResources.some((e) => e.path === 'app.asar')) {
    return problems.concat([{ kind: 'layout', layer, path: 'resources/app.asar', reason: 'not in the installer\'s app archive' }]);
  }
  let asarCopy;
  try {
    asarCopy = sevenZip.extract(archive, 'resources/app.asar', path.join(workDir, `${path.basename(archive)}-asar`));
  } catch (err) {
    return problems.concat([unreadable(layer, 'resources/app.asar', err)]);
  }
  return problems.concat(scanAsar(`${layer}:app.asar`, asarCopy));
}

// A full 7-Zip reads the NSIS container (Type = Nsis) and lists its members,
// among them $PLUGINSDIR/app-64.7z, which is then extracted and listed.
function scanNsisContainer(sevenZip, installerPath, outer, workDir) {
  const inner = outer.filter((e) => INNER_APP_ARCHIVE.test(e.path));
  let problems = problemsFor('installer', outer);
  if (inner.length === 0) {
    return problems.concat([{ kind: 'layout', layer: 'installer', path: '$PLUGINSDIR/app-*.7z', reason: 'no app archive inside the installer' }]);
  }
  for (const entry of inner) {
    const layer = `installer:${path.basename(entry.path)}`;
    let innerArchive;
    let listing;
    try {
      innerArchive = sevenZip.extract(installerPath, entry.path, path.join(workDir, path.basename(entry.path, '.7z')));
      listing = sevenZip.list(innerArchive);
    } catch (err) {
      problems = problems.concat([unreadable(layer, entry.path, err)]);
      continue;
    }
    problems = problems.concat(scanAppPayload(sevenZip, innerArchive, listing.entries, workDir, layer));
  }
  return problems;
}

// Which reading applies is decided by the archive type 7-Zip REPORTS, never
// assumed. Measured 2026-09-29 on a real `MYTHOS Setup 0.1.12.exe`: the
// standalone 7za electron-builder ships has no NSIS reader, so it finds the app
// archive NSIS embeds and opens that directly, reporting "Type = 7z" with
// locales/, resources/app.asar and resources/app.asar.unpacked/ at its root.
// What that reading cannot see: NSIS's own members — its plugins, the
// uninstaller, and anything build/installer.nsh adds with a File directive
// (none, as of this writing). An unexpected type is refused, not guessed at.
//
// The "Type = 7z" reading opens only the FIRST embedded archive. An installer
// built for two architectures embeds two, and 7za would leave the second unread
// in what it reports as data after the end of the archive. So that reading is
// accepted only when the installer holds exactly one 7z signature (independent
// review, 2026-09-29; the real 0.1.12 installer holds one, at byte 195316).
function count7zSignatures(file, chunkSize) {
  const size = chunkSize || SIGNATURE_READ_CHUNK;
  const keep = SEVEN_Z_SIGNATURE.length - 1;
  const buf = Buffer.alloc(size + keep);
  const fd = fs.openSync(file, 'r');
  let found = 0;
  let carried = 0;
  try {
    let n;
    while ((n = fs.readSync(fd, buf, carried, size, null)) > 0) {
      const view = buf.subarray(0, carried + n);
      for (let at = view.indexOf(SEVEN_Z_SIGNATURE); at !== -1; at = view.indexOf(SEVEN_Z_SIGNATURE, at + 1)) found += 1;
      // Carry the tail that could be the start of a signature split across reads.
      // It is shorter than a signature, so nothing in it was counted already.
      carried = Math.min(keep, view.length);
      view.copy(buf, 0, view.length - carried);
    }
  } finally {
    fs.closeSync(fd);
  }
  return found;
}

function scanInstaller(installerPath, sevenZip, workRoot) {
  const workDir = fs.mkdtempSync(path.join(workRoot || os.tmpdir(), 'mythos-pkg-scan-'));
  try {
    let listing;
    try {
      listing = sevenZip.list(installerPath);
    } catch (err) {
      return [unreadable('installer', path.basename(installerPath), err)];
    }
    if (listing.type === '7z') {
      const archives = count7zSignatures(installerPath);
      if (archives !== 1) {
        return [unreadable('installer', path.basename(installerPath),
          `it embeds ${archives} 7z archives and this reading sees only the first — scan one architecture per installer`)];
      }
      return scanAppPayload(sevenZip, installerPath, listing.entries, workDir, 'installer');
    }
    if (listing.type === 'Nsis') return scanNsisContainer(sevenZip, installerPath, listing.entries, workDir);
    return [unreadable('installer', path.basename(installerPath), `7-Zip reads it as "${listing.type}", which is neither the NSIS container nor its app archive`)];
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---- outcome and receipt ----------------------------------------------------------

function outcomeOf(problems) {
  if (problems.length === 0) return { status: 'clean', problems };
  // "forbidden" wins the headline because it is the actionable one; every
  // problem is still listed, so an incomplete read is never hidden behind it.
  const status = problems.some((p) => p.kind === 'forbidden') ? 'forbidden' : problems[0].kind;
  return { status, problems };
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// The upload set, derived from latest.yml — the file electron-updater actually
// reads — rather than recomputed from productName. `path` there is the asset
// name the updater will request, so it is also the name the upload must use.
function artifactsFromDist(distDir) {
  const latestPath = path.join(distDir, 'latest.yml');
  const text = fs.readFileSync(latestPath, 'utf8');
  const version = (/^version:\s*(\S+)\s*$/m.exec(text) || [])[1];
  const assetName = (/^path:\s*(\S+)\s*$/m.exec(text) || [])[1];
  if (!version || !assetName) throw new Error('dist/latest.yml has no version/path line');
  // On disk the installer keeps electron-builder's spaced name; the dashed one
  // exists only as the upload name. Match either, and demand exactly one.
  const candidates = fs.readdirSync(distDir).filter((n) => n.endsWith('.exe')
    && n.replace(/ /g, '-') === assetName);
  if (candidates.length !== 1) throw new Error(`expected one installer matching ${assetName} in ${distDir}, found ${candidates.length}`);
  const installer = path.join(distDir, candidates[0]);
  const blockmap = `${installer}.blockmap`;
  if (!fs.existsSync(blockmap)) throw new Error(`${path.basename(blockmap)} not found beside the installer`);
  return {
    version,
    installer,
    upload: [
      { file: installer, name: assetName },
      { file: blockmap, name: `${assetName}.blockmap` },
      { file: latestPath, name: 'latest.yml' },
    ],
  };
}

function buildReceipt(version, upload) {
  return {
    schema: 1,
    status: 'clean',
    version,
    scannedAt: new Date().toISOString(),
    artifacts: upload.map((a) => ({
      name: a.name,
      file: path.basename(a.file),
      size: fs.statSync(a.file).size,
      sha256: sha256File(a.file),
    })),
  };
}

// ---- cli --------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--unpacked', '--installer', '--dist', '--receipt'].includes(key)) throw new Error(`unknown argument ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} needs a value`);
    out[key.slice(2)] = value;
    i += 1;
  }
  // --installer alone reads a published installer that has no unpacked tree
  // beside it (B0's inspection of the 0.1.10/0.1.11 release assets).
  if (!out.unpacked && !out.dist && !out.installer) throw new Error('pass --unpacked <dir>, --dist <dir> or --installer <file>');
  if (out.receipt && !out.dist) throw new Error('--receipt needs --dist, which names the artifacts it pins');
  return out;
}

async function run(argv, deps) {
  const d = deps || {};
  const log = d.log || ((line) => console.log(line));
  const args = parseArgs(argv);
  // Removed before anything else runs, so no early return below can leave an
  // earlier clean build's receipt vouching for this one. The first version
  // removed it after the dist layout check — which returns early (independent
  // review, 2026-09-29).
  if (args.receipt) fs.rmSync(args.receipt, { force: true });
  let dist = null;
  if (args.dist) {
    try {
      dist = artifactsFromDist(args.dist);
    } catch (err) {
      return report({ status: 'layout', problems: [{ kind: 'layout', layer: 'dist', path: toRel(args.dist), reason: err.message }] }, log);
    }
  }
  const unpackedDir = args.unpacked || (args.dist ? path.join(args.dist, 'win-unpacked') : null);
  const installer = args.installer || (dist && dist.installer);
  let problems = unpackedDir ? scanUnpacked(unpackedDir) : [];
  if (installer) {
    let sevenZip;
    try {
      sevenZip = d.sevenZip || real7z(await resolve7za());
    } catch (err) {
      problems = problems.concat([unreadable('installer', '7za', err)]);
    }
    if (sevenZip) problems = problems.concat(scanInstaller(installer, sevenZip, d.workRoot));
  }
  const outcome = outcomeOf(problems);
  // Written only for a clean scan (the stale one is already gone, above).
  if (args.receipt && outcome.status === 'clean') {
    fs.writeFileSync(args.receipt, JSON.stringify(buildReceipt(dist.version, dist.upload), null, 2) + '\n');
  }
  return report(outcome, log);
}

function report(outcome, log) {
  log(`verify-package-contents: ${outcome.status}`);
  for (const p of outcome.problems) log(`  ${p.kind.padEnd(10)} ${p.layer}  ${p.path}  (${p.reason})`);
  return { ...outcome, exitCode: EXIT[outcome.status] };
}

if (require.main === module) {
  run(process.argv.slice(2)).then((o) => { process.exitCode = o.exitCode; }, (err) => {
    console.error(`verify-package-contents: ${err.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  EXIT,
  listAsarEntries,
  walkDir,
  archiveTypeOf,
  parse7zSlt,
  scanUnpacked,
  scanInstaller,
  count7zSignatures,
  outcomeOf,
  artifactsFromDist,
  sha256File,
  run,
};
