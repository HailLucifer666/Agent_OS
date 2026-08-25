'use strict';

// scripts/audit-licences.js — the mechanical half of merged-order step 6.6.
//
// WHY THIS EXISTS. The release gate (BUGS.md, BUG-274) has a line reading "no NC or
// copyleft dependency in the shipped artifact and THIRD_PARTY_NOTICES.md matching what
// actually ships". Until this script that line had no oracle: the notices file was
// written by hand, from memory, about a dependency tree nobody had ever enumerated.
// That is precisely the shape BUG-274's closing note condemns — a mechanism that looks
// like coverage and does nothing.
//
// WHAT IT MEASURES, AND WHY THAT SOURCE. "What ships" is not `node_modules` — that tree
// holds electron and electron-builder, which do not ship. It is the set of non-dev
// entries in the two lockfiles, because electron-builder prunes devDependencies and
// then packs `mythos/**/*` plus the root production tree (`includeSubNodeModules:
// true`). So each lockfile's own `dev` flag is the authority on membership, and the
// installed package.json supplies the licence for every surviving entry.
//
// A lockfile entry with nothing installed is REPORTED, not skipped. "I could not read
// it" and "it is fine" must never look the same — that is the fabricated-PASS shape
// this repo has now hit four times.
//
// WHAT IT IS NOT. Not legal advice, and it decides nothing. Every non-permissive
// package must appear in EXCEPTIONS with its obligation written out AND be named in
// THIRD_PARTY_NOTICES.md; the script's only judgement is "recorded" vs "unrecorded".
// CLAUDE.md forbids writing a confident legal conclusion into a tracked file, so the
// notes state the obligation and whose call it is, and stop there.
//
// THE DRIFT GUARD. Every EXCEPTIONS key must also appear in THIRD_PARTY_NOTICES.md.
// Without it the map becomes a place to silence findings while the notices file drifts
// — the two-places bug that has bitten this repo three times on the capture-suspend
// allowlist alone.
//
// Run:
//   cd mythos && node scripts/audit-licences.js            # report
//   cd mythos && node scripts/audit-licences.js --check     # exit 1 on unrecorded

const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');
const NOTICES = path.join(MYTHOS_ROOT, 'THIRD_PARTY_NOTICES.md');

// The two trees that end up inside the installer, each a lockfile + node_modules pair.
const TREES = [
  { label: 'root', dir: REPO_ROOT },
  { label: 'mythos', dir: MYTHOS_ROOT },
];

// Licences carrying no obligation beyond attribution. Anything absent from this list is
// flagged and must be recorded — including "unusual but harmless", because the point of
// the gate is that a human looked at it once.
const PERMISSIVE = new Set([
  '0BSD', 'APACHE-2.0', 'BLUEOAK-1.0.0', 'BSD', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE',
  'CC0-1.0', 'CC-BY-4.0', 'ISC', 'MIT', 'MIT-0', 'MIT/X11', 'PYTHON-2.0',
  'UNLICENSE', 'WTFPL', 'ZLIB',
]);

// Non-permissive or undeclared packages that DO ship, each with the obligation it
// creates. `elect` records which operand of an OR-expression the project relies on.
const EXCEPTIONS = {
  '@img/sharp-win32-x64': {
    licence: 'Apache-2.0 AND LGPL-3.0-or-later',
    why:
      'The Windows prebuilt bundles eight LGPLv3 libraries (fribidi, glib, libexif, '
      + 'libheif, librsvg, libvips, pango, proxy-libintl) per the package README. It '
      + 'ships and it LOADS: require("kokoro-js") pulls 14 sharp modules and libvips '
      + '8.17.3 initialises, measured 2026-08-19. Obligation is notice plus the ability '
      + 'to replace the library; it is a dynamically loaded .node so no MYTHOS source is '
      + 'implicated. Whether that suffices for a sold product is a lawyer call.',
  },
  jszip: {
    licence: '(MIT OR GPL-3.0-or-later)',
    elect: 'MIT',
    why:
      'Dual-licensed, so the project elects MIT and the GPL operand is never entered. '
      + 'Recorded because an election left unstated is indistinguishable from not having '
      + 'noticed the GPL half. Reached via exceljs and pptxgenjs.',
  },
  buffers: {
    licence: 'UNDECLARED',
    why:
      'No `license` field, no LICENSE/COPYING file, and no licence line in its README '
      + '(v0.1.1, read in the installed package 2026-08-19). An absent grant is not a '
      + 'permissive grant. Reached only as exceljs > unzipper > binary > buffers, and '
      + 'exceljs has exactly one first-party consumer (src/core/effectors/from-docs.js), '
      + 'so removal is a bounded option if the grant cannot be established.',
  },
};

// The @ghostery/* and @remusao/* adblocker packages are MPL-2.0: file-level weak
// copyleft, satisfied by shipping unmodified with notice. They are recorded as a group
// in THIRD_PARTY_NOTICES.md rather than as 12 near-identical exception entries.
const MPL_GROUP = /^@(ghostery|remusao)\//;

function normalise(raw) {
  if (!raw) return 'UNDECLARED';
  if (typeof raw === 'object') return String(raw.type || 'UNDECLARED');
  return String(raw);
}

// SPDX-ish evaluation. AND: every operand must be permissive. OR: a permissive operand
// makes it usable, but an election only has to be RECORDED when the alternative is not
// permissive — "MIT OR CC0-1.0" is a free choice between two harmless licences and
// asking a human to sign off on it is noise, which is how a gate gets ignored.
function classifyExpression(expr) {
  const cleaned = expr.replace(/[()]/g, ' ').trim();
  const upper = cleaned.toUpperCase();
  if (/\bOR\b/.test(upper)) {
    const operands = cleaned.split(/\s+OR\s+/i).map((s) => s.trim());
    const permissive = operands.find((o) => PERMISSIVE.has(o.toUpperCase()));
    if (!permissive) return { verdict: 'flagged' };
    const allPermissive = operands.every((o) => PERMISSIVE.has(o.toUpperCase()));
    return allPermissive ? { verdict: 'ok' } : { verdict: 'elected', elect: permissive };
  }
  if (/\bAND\b/.test(upper)) {
    const operands = cleaned.split(/\s+AND\s+/i).map((s) => s.trim());
    return { verdict: operands.every((o) => PERMISSIVE.has(o.toUpperCase())) ? 'ok' : 'flagged' };
  }
  return { verdict: PERMISSIVE.has(upper) ? 'ok' : 'flagged' };
}

function lockfileProduction(treeDir) {
  const lockPath = path.join(treeDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    return { error: `no package-lock.json at ${path.relative(REPO_ROOT, lockPath)}`, entries: [] };
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entries = [];
  const marker = 'node_modules/';
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    if (!key) continue;      // the project itself
    if (meta.dev) continue;  // pruned by electron-builder before packing
    const name = key.slice(key.lastIndexOf(marker) + marker.length);
    entries.push({ name, dir: path.join(treeDir, key), optional: Boolean(meta.optional) });
  }
  return { entries };
}

function audit(options = {}) {
  const exceptions = options.exceptions || EXCEPTIONS;
  const seen = new Map();
  const problems = [];
  const treeErrors = [];

  for (const tree of TREES) {
    const { error, entries } = lockfileProduction(tree.dir);
    if (error) { treeErrors.push(error); continue; }
    for (const entry of entries) {
      if (seen.has(entry.name)) continue;
      const pkgJson = path.join(entry.dir, 'package.json');
      if (!fs.existsSync(pkgJson)) {
        // electron-builder packs files off disk, so what is not installed cannot be in
        // the artifact and carries no licence obligation. The 24 @img/sharp-* prebuilts
        // for other platforms live here. An entry that is NOT optional and still absent
        // is a broken tree, though, and that must fail rather than read as "clean".
        const verdict = entry.optional ? 'absent-optional' : 'unreadable';
        seen.set(entry.name, { licence: 'NOT-INSTALLED', verdict, tree: tree.label });
        if (!entry.optional) {
          problems.push({
            name: entry.name,
            licence: 'NOT-INSTALLED',
            reason: 'a non-optional lockfile entry is not installed, so its licence could not be read — the tree is incomplete',
          });
        }
        continue;
      }
      let licence;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        const declared = pkg.license
          || (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type || l).join(' OR ') : null);
        licence = normalise(declared);
      } catch (err) {
        seen.set(entry.name, { licence: 'UNREADABLE', verdict: 'unreadable', tree: tree.label });
        problems.push({ name: entry.name, licence: 'UNREADABLE', reason: `package.json could not be parsed: ${err.message}` });
        continue;
      }

      const { verdict, elect } = classifyExpression(licence);
      const record = exceptions[entry.name];
      const grouped = MPL_GROUP.test(entry.name) && /MPL-2\.0/i.test(licence);

      if (verdict === 'ok') {
        seen.set(entry.name, { licence, verdict: 'ok', tree: tree.label });
      } else if (record) {
        seen.set(entry.name, { licence, verdict: 'recorded', tree: tree.label, elect: record.elect });
      } else if (verdict === 'elected') {
        // An election nobody wrote down is a decision nobody made.
        seen.set(entry.name, { licence, verdict: 'unrecorded', tree: tree.label });
        problems.push({
          name: entry.name,
          licence,
          reason: `dual-licensed; the permissive operand (${elect}) is available but the election is not recorded`,
        });
      } else if (grouped) {
        seen.set(entry.name, { licence, verdict: 'recorded-group', tree: tree.label });
      } else {
        seen.set(entry.name, { licence, verdict: 'unrecorded', tree: tree.label });
        problems.push({ name: entry.name, licence, reason: 'not permissive and not recorded in EXCEPTIONS / THIRD_PARTY_NOTICES.md' });
      }
    }
  }

  // Drift guard: an exception the notices file has never heard of is a silencer.
  const noticesText = fs.existsSync(NOTICES) ? fs.readFileSync(NOTICES, 'utf8') : '';
  const undocumented = Object.keys(exceptions).filter((name) => !noticesText.includes(name));
  const mplDocumented = /MPL-2\.0/.test(noticesText);
  const groupCount = [...seen.values()].filter((m) => m.verdict === 'recorded-group').length;

  // Staleness guard, the other direction. An exception for a package that no longer
  // ships is the exact "mechanism that looks like coverage" shape BUG-274 was opened
  // over: it reads as due diligence while protecting nothing, and it keeps a paragraph
  // in THIRD_PARTY_NOTICES.md describing an obligation the artifact does not have.
  const stale = Object.keys(exceptions).filter((name) => !seen.has(name));

  return { packages: seen, problems, treeErrors, undocumented, mplDocumented, groupCount, stale };
}

function failuresOf(result) {
  const failures = [...result.problems];
  for (const err of result.treeErrors) failures.push({ name: '(tree)', licence: '-', reason: err });
  for (const name of result.undocumented) {
    failures.push({ name, licence: '-', reason: 'listed in EXCEPTIONS but not named in THIRD_PARTY_NOTICES.md' });
  }
  for (const name of result.stale || []) {
    failures.push({
      name,
      licence: '-',
      reason: 'listed in EXCEPTIONS but no longer in the shipped tree — remove the entry and its THIRD_PARTY_NOTICES.md section instead of leaving a guard that protects nothing',
    });
  }
  if (result.groupCount && !result.mplDocumented) {
    failures.push({
      name: '@ghostery/* + @remusao/*',
      licence: 'MPL-2.0',
      reason: 'MPL-2.0 packages ship but THIRD_PARTY_NOTICES.md does not mention MPL-2.0',
    });
  }
  return failures;
}

function main(argv) {
  const check = argv.includes('--check');
  const result = audit();

  const tally = {};
  for (const meta of result.packages.values()) tally[meta.verdict] = (tally[meta.verdict] || 0) + 1;

  console.log(`Shipped production packages examined: ${result.packages.size}`);
  for (const [verdict, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${verdict}`);
  }

  const recorded = [...result.packages.entries()].filter(([, m]) => m.verdict === 'recorded');
  if (recorded.length) {
    console.log('\nRecorded exceptions (shipped, non-permissive, obligation written down):');
    for (const [name, meta] of recorded) {
      console.log(`  ${name}  ${meta.licence}${meta.elect ? `  [elects ${meta.elect}]` : ''}`);
    }
  }

  const failures = failuresOf(result);
  if (failures.length) {
    console.log('\nUNRECORDED / UNREADABLE:');
    for (const f of failures) console.log(`  ${f.name}  ${f.licence}\n      ${f.reason}`);
    console.log(`\n${failures.length} item(s) need a human: add the obligation to THIRD_PARTY_NOTICES.md plus an EXCEPTIONS entry, or remove the dependency.`);
    if (check) process.exitCode = 1;
    return;
  }

  console.log('\nEvery shipped package is permissive or has its obligation recorded in THIRD_PARTY_NOTICES.md.');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { audit, failuresOf, classifyExpression, EXCEPTIONS, PERMISSIVE, MPL_GROUP };
