#!/usr/bin/env node
'use strict';

/**
 * measure-skill-usage.js — BUG-358's measurement, made repeatable.
 *
 *   node mythos/scripts/measure-skill-usage.js
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. BUG-358's own closing line says what
 * ships is "the measurement and this record, so the next decision starts from
 * numbers instead of folklore" — and a number written into prose is a number
 * nobody updates. This file makes it regenerable.
 *
 * It is deliberately NOT a test. Every figure here comes from the LIVE vault
 * (%APPDATA%/MYTHOS/vault), which a CI runner and a fresh worktree do not have,
 * and this repo's baseline is `skipped=0` — so a vault-gated test would either
 * break that baseline or pass vacuously against an empty directory. Both are
 * worse than a script somebody runs.
 *
 * WHAT IT ANSWERS, which is exactly BUG-358's three claims:
 *   1. How many recorded actions carry a skillRef?  (the layer's usage)
 *   2. How many code seams consult skills.recall()? (the wiring)
 *   3. How replayable is the store as recorded?      (the data quality)
 *
 * MEASURED ERRORS THIS SCRIPT EXISTS TO PREVENT, both made on 2026-09-02 while
 * re-checking the ticket by hand:
 *   * The per-skill metadata is an HTML comment INSIDE the .md
 *     (`<!-- {"id":"sk-…","uses":0,"successRate":0} -->`), not a sibling .json.
 *     Looking for `.json` files reported "0 sidecars" and the ticket says every
 *     file has one — the ticket was right.
 *   * The baked process id is written `{"pid":4668}`. A `\bpid\s*:` pattern does
 *     not match it, because the quote sits between. That reported zero baked
 *     pids in a store where the ticket's named example is real.
 * Both are the substring/shape traps this repo keeps paying for, so the patterns
 * below are written against the real text and the counts print their evidence.
 */

const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');

function vaultRoots() {
  const roots = [];
  if (process.env.MYTHOS_VAULT_ROOT) roots.push(process.env.MYTHOS_VAULT_ROOT);
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'MYTHOS', 'vault'));
  roots.push(path.join(MYTHOS_ROOT, 'vault'));
  return roots.filter((r) => fs.existsSync(r));
}

function countSkillRefs(roots) {
  let withRef = 0, without = 0;
  const days = new Set();
  for (const root of roots) {
    const dir = path.join(root, 'Episodic');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      days.add(file);
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || rec.kind !== 'action') continue;
        if (rec.skillRef || (rec.detail && rec.detail.skillRef)) withRef++; else without++;
      }
    }
  }
  return { withRef, without, days: days.size };
}

function recallCallers() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(p, 'utf8');
      const re = /skills\s*\.\s*recall\s*\(/g;
      let m;
      while ((m = re.exec(text))) {
        out.push(path.relative(MYTHOS_ROOT, p).replace(/\\/g, '/')
          + ':' + text.slice(0, m.index).split(/\r?\n/).length);
      }
    }
  };
  walk(path.join(MYTHOS_ROOT, 'src'));
  walk(path.join(MYTHOS_ROOT, 'server'));
  return out;
}

// A recorded step is un-replayable when it bakes a value that was only true at
// record time. A process id is the clearest case and the one BUG-358 names.
const BAKED_PID_RE = /"pid"\s*:\s*\d+/;
// A When-section holding pseudo-code cannot be matched by a recall QUERY, which
// is prose from a goal title.
const PSEUDOCODE_RE = /^\s*-\s*\w+\(\s*\)\s*(==|!=|>|<)/m;

function storeHealth(roots) {
  const stores = [];
  for (const root of roots) {
    const dir = path.join(root, 'Skills');
    if (!fs.existsSync(dir)) continue;
    let total = 0, withMeta = 0, bakedPid = 0, pseudo = 0, everUsed = 0;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      total++;
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      const meta = /^<!--\s*(\{.*\})\s*-->/m.exec(body);
      if (meta) {
        withMeta++;
        try { if (JSON.parse(meta[1]).uses > 0) everUsed++; } catch { /* unparseable meta */ }
      }
      if (BAKED_PID_RE.test(body)) bakedPid++;
      if (PSEUDOCODE_RE.test(body)) pseudo++;
    }
    stores.push({ dir, total, withMeta, bakedPid, pseudo, everUsed });
  }
  return stores;
}

function main() {
  const roots = vaultRoots();
  console.log('measure-skill-usage (BUG-358). Vault roots found: ' + roots.length);
  for (const r of roots) console.log('   ' + r);
  if (!roots.length) {
    console.log('No vault reachable — nothing to measure. This is the normal state on CI '
      + 'and in a fresh worktree, and is why this is a script rather than a test.');
    return 0;
  }

  const refs = countSkillRefs(roots);
  console.log('');
  console.log('1. USAGE — episodic action rows across ' + refs.days + ' day files');
  console.log('   with a skillRef : ' + refs.withRef);
  console.log('   without         : ' + refs.without);
  const total = refs.withRef + refs.without;
  console.log('   share using a stored procedure: '
    + (total ? ((refs.withRef / total) * 100).toFixed(2) + '%' : 'n/a'));

  const callers = recallCallers();
  console.log('');
  console.log('2. WIRING — seams that consult skills.recall()');
  if (!callers.length) console.log('   (none)');
  for (const c of callers) console.log('   ' + c);
  console.log('   Note: the Live/spoken path, the voice batch path, the HUD confirm path and');
  console.log('   the cortex loop are all absent from this list by design as of BUG-358.');

  console.log('');
  console.log('3. STORE — how replayable the recordings are as recorded');
  for (const s of storeHealth(roots)) {
    console.log('   ' + s.dir);
    console.log('     recordings: ' + s.total
      + '   with metadata comment: ' + s.withMeta
      + '   ever used (uses>0): ' + s.everUsed);
    console.log('     bake a literal pid: ' + s.bakedPid
      + '   have a pseudo-code When: ' + s.pseudo);
  }
  console.log('');
  console.log('BUG-358 is a DIAGNOSIS awaiting an operator decision on what skills are FOR in');
  console.log('a voice-first system. Do not wire a procedural replay channel from this script.');
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { countSkillRefs, recallCallers, storeHealth, vaultRoots };
