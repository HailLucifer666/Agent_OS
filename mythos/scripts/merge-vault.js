'use strict';

// scripts/merge-vault.js — fold a second vault into this one without losing or
// overwriting anything.
//
// WHY THIS EXISTS (2026-08-10). MYTHOS resolves its vault differently depending
// on how it was launched, so the same install can end up with two separate
// memories:
//
//   * the batch/dev launcher runs with cwd=mythos and MYTHOS_VAULT_ROOT=./vault
//     (mythos/.env), i.e. <repo>/mythos/vault
//   * the packaged Electron app forces MYTHOS_VAULT_ROOT to
//     app.getPath('userData')/vault (electron/vault-migration.js), and since
//     nothing calls app.setName(), getName() falls back to package.json's
//     "agent-os" — so on Windows that is %APPDATA%\agent-os\vault
//
// Both existed on the operator's machine, with the Electron one frozen at its
// last packaged launch. This script merges one into the other. It does NOT pick
// a canonical path or change any config — that decision is separate and
// deliberate, because getting it wrong factory-resets someone's memory (see the
// incident recorded in src/core/config/schema.js's header).
//
// Usage:
//   node scripts/merge-vault.js --from <dir>            # dry run, writes nothing
//   node scripts/merge-vault.js --from <dir> --write
//   node scripts/merge-vault.js --from <dir> --into <dir> --write
//
// --into defaults to MYTHOS_VAULT_ROOT, else <repo>/mythos/vault.
//
// Rules, in the order that matters:
//   JSONL stores (Episodic/Audit/Incidents) merge as a UNION keyed on each
//     record's `id`, then sort by `ts`. Append-only day files, so this is exact.
//   Markdown/JSON stores (Semantic/Lessons/Skills) copy only when the
//     destination has no file of that name. A name that exists on both sides
//     with different content is REPORTED, never overwritten or appended.
//   Identity/ is operator-authored and never written — differences are listed
//     for a human to read.
//   Index/*.vec.json is derived from the stores above and is skipped; it
//     rebuilds itself on the next run.

const fs = require('node:fs');
const path = require('node:path');

const JSONL_STORES = ['Episodic', 'Audit', 'Incidents'];
const COPY_IF_ABSENT_STORES = ['Semantic', 'Lessons', 'Skills', 'Goals', 'Engagements', 'Documents', 'Contacts', 'Checkpoints'];
const REPORT_ONLY_STORES = ['Identity'];
const SKIP_STORES = ['Index'];

function parseArgs(argv) {
  const out = { write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') out.write = true;
    else if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--into') out.into = argv[++i];
  }
  return out;
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

// A record with no parseable id cannot be de-duplicated, so it is kept and
// keyed on its own text — identical lines still collapse, distinct ones survive.
function keyOf(line) {
  try {
    const rec = JSON.parse(line);
    if (rec && typeof rec.id === 'string' && rec.id) return 'id:' + rec.id;
    return 'raw:' + line;
  } catch (_) {
    return 'raw:' + line;
  }
}

function tsOf(line) {
  try {
    const rec = JSON.parse(line);
    return typeof rec.ts === 'number' ? rec.ts : 0;
  } catch (_) { return 0; }
}

function mergeJsonlStore(fromDir, intoDir, store, plan) {
  const src = path.join(fromDir, store);
  if (!fs.existsSync(src)) return;
  for (const name of fs.readdirSync(src)) {
    if (!name.endsWith('.jsonl')) continue;
    const srcFile = path.join(src, name);
    const dstFile = path.join(intoDir, store, name);
    const srcLines = readLines(srcFile);
    const dstLines = fs.existsSync(dstFile) ? readLines(dstFile) : [];
    const seen = new Set(dstLines.map(keyOf));
    const added = srcLines.filter((l) => !seen.has(keyOf(l)));
    plan.push({
      kind: 'jsonl', store, name, target: dstFile,
      incoming: srcLines.length, existing: dstLines.length,
      added: added.length, duplicates: srcLines.length - added.length,
      apply() {
        const all = dstLines.concat(added).sort((a, b) => tsOf(a) - tsOf(b));
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.writeFileSync(dstFile, all.join('\n') + '\n', 'utf8');
      },
    });
  }
}

function copyStore(fromDir, intoDir, store, plan, reportOnly) {
  const src = path.join(fromDir, store);
  if (!fs.existsSync(src)) return;
  for (const name of fs.readdirSync(src)) {
    const srcFile = path.join(src, name);
    if (!fs.statSync(srcFile).isFile()) continue;
    const dstFile = path.join(intoDir, store, name);
    const exists = fs.existsSync(dstFile);
    const same = exists && fs.readFileSync(srcFile, 'utf8') === fs.readFileSync(dstFile, 'utf8');
    if (exists && same) continue;                       // nothing to say
    if (reportOnly) {
      plan.push({ kind: 'report', store, name, note: exists ? 'differs — read both, decide by hand' : 'absent here' });
      continue;
    }
    if (exists) {
      plan.push({ kind: 'collision', store, name, note: 'exists with different content — NOT touched' });
      continue;
    }
    plan.push({
      kind: 'copy', store, name, target: dstFile,
      apply() {
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
      },
    });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const into = path.resolve(args.into || process.env.MYTHOS_VAULT_ROOT || path.join(__dirname, '..', 'vault'));
  if (!args.from) {
    console.error('usage: node scripts/merge-vault.js --from <vault-dir> [--into <vault-dir>] [--write]');
    process.exitCode = 2;
    return;
  }
  const from = path.resolve(args.from);
  if (!fs.existsSync(from)) { console.error('source vault does not exist: ' + from); process.exitCode = 2; return; }
  if (!fs.existsSync(into)) { console.error('destination vault does not exist: ' + into); process.exitCode = 2; return; }
  if (from === into) { console.error('source and destination are the same vault'); process.exitCode = 2; return; }

  console.log('from: ' + from);
  console.log('into: ' + into);
  console.log(args.write ? 'mode: WRITE' : 'mode: dry run (pass --write to apply)');
  console.log('');

  const plan = [];
  for (const store of JSONL_STORES) mergeJsonlStore(from, into, store, plan);
  for (const store of COPY_IF_ABSENT_STORES) copyStore(from, into, store, plan, false);
  for (const store of REPORT_ONLY_STORES) copyStore(from, into, store, plan, true);

  let records = 0, dupes = 0, copies = 0, collisions = 0, reports = 0;
  for (const item of plan) {
    if (item.kind === 'jsonl') {
      records += item.added; dupes += item.duplicates;
      console.log('  ' + item.store + '/' + item.name + ': +' + item.added + ' new, ' +
        item.duplicates + ' already present (' + item.existing + ' here, ' + item.incoming + ' incoming)');
    } else if (item.kind === 'copy') {
      copies += 1; console.log('  ' + item.store + '/' + item.name + ': copy (absent here)');
    } else if (item.kind === 'collision') {
      collisions += 1; console.log('  COLLISION ' + item.store + '/' + item.name + ': ' + item.note);
    } else {
      reports += 1; console.log('  REVIEW ' + item.store + '/' + item.name + ': ' + item.note);
    }
  }

  const skipped = SKIP_STORES.filter((s) => fs.existsSync(path.join(from, s)));
  if (skipped.length) console.log('  skipped (derived, rebuilds itself): ' + skipped.join(', '));

  console.log('');
  console.log('records to add: ' + records + ' | duplicates skipped: ' + dupes +
    ' | files to copy: ' + copies + ' | collisions: ' + collisions + ' | to review by hand: ' + reports);

  if (!args.write) { console.log('\nnothing written. re-run with --write to apply.'); return; }

  for (const item of plan) { if (item.apply) item.apply(); }
  console.log('\nwritten.');
}

if (require.main === module) main();

module.exports = { keyOf, tsOf };
