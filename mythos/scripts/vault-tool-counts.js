'use strict';

/**
 * vault-tool-counts.js — per-tool ok/fail counts read from the audit log,
 * so the capability map stops carrying them by hand.
 *
 *   node mythos/scripts/vault-tool-counts.js            # human summary
 *   node mythos/scripts/vault-tool-counts.js --json      # machine-readable
 *
 * WHY THIS EXISTS
 *
 * `build-capability-map.js` regenerates the vitals and every cross-check, and
 * PRESERVES each node's status, prose and `ok`/`f` counts as curated human
 * text. That split is right for the prose — a human decides what a node means —
 * and wrong for the counts, which are not judgement at all. They are a count of
 * rows in vault/Audit/*.jsonl, and until 2026-08-27 nothing counted them.
 *
 * Measured that day: 43 of 91 nodes carried a hand-typed count and **29 of them
 * (67%) disagreed with the vault** — `goals` was written 118/2 against a real
 * 253/3. Two Track D dispositions had been reasoned about on sample sizes that
 * were wrong by 2x (`ui_click`, "10 calls" against a real 22) and 30x
 * (`cua-driver`, "two boots" against 59 recorded calls).
 *
 * ============================================================================
 * THERE IS NO SINGLE VAULT, AND ASKING FOR "THE" ONE GIVES A WRONG ANSWER
 * ============================================================================
 *
 * `triage-incidents.js:resolveVaultRoot()` returns `MYTHOS_VAULT_ROOT` or falls
 * back to the in-repo `mythos/vault`. On the operator's machine that fallback
 * WINS — no env var is set — so every vault-derived reading in this repo has
 * been taken from the in-repo copy while reporting `reachable: true`, which
 * reads as "I looked at the live vault".
 *
 * Measured 2026-08-27, one counter pointed at both roots:
 *
 *     in-repo mythos/vault  34 files   1464 completions   newest 2026-08-25
 *     %APPDATA%/MYTHOS      40 files   3183 completions   newest 2026-08-26
 *
 * and the in-repo copy has **never seen 21 tools at all** — `open_file`,
 * `timer_add`, `think_deeply`, `camera_look`, `forget_fact`, `write_file`,
 * `read_file` among them. That matters more than the totals: a `dark` or
 * `unknown` node asserts a MEASURED ZERO, so a checker reading only the in-repo
 * twin would confirm those labels while the real vault contradicts them. A
 * guard reading the wrong source fails OPEN, and this file exists partly to
 * make a guard that cannot.
 *
 * They are not stale-and-fresh, they are two populations: 1346 record ids are
 * common, the in-repo copy holds 118 the packaged app never wrote, and the
 * packaged app holds 1837 the other never saw. (Two vaults, one operator: the
 * batch launcher and the packaged Electron app write to different places, and
 * which one is canonical is an OPEN QUESTION this file deliberately does not
 * answer.)
 *
 * SO: read every root that exists and DEDUPE BY RECORD ID. Union = 3301. That
 * needs no ruling on which path is canonical, and it is strictly more truthful
 * than either root alone. Every audit row carries a unique `id` (`aud-…`), so
 * the dedupe is exact rather than heuristic.
 *
 * ============================================================================
 * WHY THE READ IS CHUNKED AND SYNCHRONOUS
 * ============================================================================
 *
 * One audit file is 133 MB. `readFileSync` on it costs ~266 MB of resident
 * string (V8 strings are UTF-16) inside the pre-commit hook, which already
 * holds a 6,600-test suite. So this reads 1 MB at a time and carries the
 * partial last line forward.
 *
 * Synchronous, not streamed, because `build-capability-map.js:generate()` is
 * sync and so is its `main()`. Making this async would ripple through that
 * script, its tests and the hook, to buy nothing: the work is bounded, and
 * `JSON.parse` only runs on lines that contain the literal `"completed"` —
 * 3,301 of 784,274 lines on the measured corpus.
 */

const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');

// Only lines carrying this literal are parsed. The rest of the audit log is
// `allow`/`confirm`/`heal` rows, which have no outcome to count.
const COMPLETED_MARKER = '"completed"';
const CHUNK = 1024 * 1024;

/**
 * Every place an audit log might live, in no particular order — they are all
 * read and merged, so precedence never arises.
 *
 * Portability (root CLAUDE.md): nothing here is a literal absolute path.
 * `APPDATA` is absent off Windows and that root is simply skipped, which is the
 * correct degradation — a machine with no packaged app has no packaged vault.
 */
function candidateVaultRoots(deps = {}) {
  if (deps.roots) return deps.roots;
  const env = deps.env || process.env;
  const out = [];
  const add = (label, dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (out.some((r) => r.dir === resolved)) return;
    out.push({ label, dir: resolved });
  };

  const explicit = env.MYTHOS_VAULT_ROOT;
  if (explicit && explicit.trim()) add('MYTHOS_VAULT_ROOT', explicit.trim());
  add('in-repo mythos/vault', path.join(MYTHOS_ROOT, 'vault'));
  if (env.APPDATA) add('packaged app (APPDATA)', path.join(env.APPDATA, 'MYTHOS', 'vault'));
  return out;
}

/** Read one file 1 MB at a time, handing whole lines to `onLine`. */
function eachLine(file, onLine, deps = {}) {
  const io = deps.fs || fs;
  const fd = io.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = '';
    for (;;) {
      const n = io.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const text = carry + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      // The last element is a partial line unless the chunk ended on a newline;
      // treating it as complete would truncate a JSON record and lose the row.
      carry = lines.pop();
      for (const line of lines) onLine(line);
    }
    if (carry) onLine(carry);
  } finally {
    io.closeSync(fd);
  }
}

/**
 * @returns {{reachable:boolean, counts:Map<string,{ok:number,fail:number,lastOk:number,lastFail:number}>,
 *            roots:Array, records:number, duplicates:number, reason?:string}}
 *
 * `reachable:false` means NOBODY COULD LOOK, and callers must treat it as such —
 * never as "there is nothing there". `counts` is empty in that case, and an
 * empty map is indistinguishable from a real zero unless the flag is honoured.
 */
function readToolCounts(deps = {}) {
  const io = deps.fs || fs;
  const roots = candidateVaultRoots(deps);
  const counts = new Map();
  const seen = new Set();
  const used = [];
  let duplicates = 0;

  for (const root of roots) {
    const dir = path.join(root.dir, 'Audit');
    let files;
    try {
      if (!io.existsSync(dir)) continue;
      files = io.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      continue;
    }
    if (!files.length) continue;
    let records = 0;
    for (const f of files) {
      eachLine(path.join(dir, f), (line) => {
        if (!line || line.indexOf(COMPLETED_MARKER) === -1) return;
        let row;
        try { row = JSON.parse(line); } catch { return; }
        if (row.decision !== 'completed' || !row.tool) return;
        // Exact dedupe on the row's own id. The two roots share 1346 records;
        // counting them twice would double every figure this map shows.
        if (row.id) {
          if (seen.has(row.id)) { duplicates += 1; return; }
          seen.add(row.id);
        }
        records += 1;
        let e = counts.get(row.tool);
        if (!e) { e = { ok: 0, fail: 0, lastOk: 0, lastFail: 0 }; counts.set(row.tool, e); }
        const ts = Number(row.ts) || 0;
        if (row.outcome === 'ok') { e.ok += 1; if (ts > e.lastOk) e.lastOk = ts; }
        else if (row.outcome === 'fail') { e.fail += 1; if (ts > e.lastFail) e.lastFail = ts; }
      }, deps);
    }
    used.push({ label: root.label, dir: root.dir, files: files.length, records });
  }

  if (!used.length) {
    return {
      reachable: false,
      reason: 'no vault Audit directory is readable from this checkout',
      counts, roots: [], records: 0, duplicates: 0,
    };
  }
  return { reachable: true, counts, roots: used, records: seen.size, duplicates };
}

/** Sum a node's tools into one row. Tools with no recorded call contribute nothing. */
function countsForTools(counts, tools) {
  const out = { ok: 0, fail: 0, lastOk: 0, lastFail: 0, measured: 0 };
  for (const id of tools || []) {
    const e = counts.get(id);
    if (!e) continue;
    out.measured += 1;
    out.ok += e.ok;
    out.fail += e.fail;
    if (e.lastOk > out.lastOk) out.lastOk = e.lastOk;
    if (e.lastFail > out.lastFail) out.lastFail = e.lastFail;
  }
  return out;
}

function main(argv) {
  const result = readToolCounts();
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      reachable: result.reachable,
      reason: result.reason,
      roots: result.roots.map((r) => ({ label: r.label, files: r.files, records: r.records })),
      records: result.records,
      duplicates: result.duplicates,
      counts: Object.fromEntries(result.counts),
    }, null, 2));
    return result.reachable ? 0 : 1;
  }
  if (!result.reachable) {
    console.log(`vault-tool-counts: ${result.reason}. No counts read — this is "could not look", not "nothing there".`);
    return 1;
  }
  // The resolved directory goes to the console and never into a tracked file:
  // AD-7 forbids machine-specific absolute paths in anything git can see.
  for (const r of result.roots) {
    console.log(`vault-tool-counts: ${r.label} — ${r.files} audit file(s), ${r.records} new completion(s) [${r.dir}]`);
  }
  let ok = 0, fail = 0;
  for (const e of result.counts.values()) { ok += e.ok; fail += e.fail; }
  console.log(`vault-tool-counts: ${result.counts.size} tools, ${result.records} completions `
    + `(${ok} ok / ${fail} fail), ${result.duplicates} duplicate row(s) skipped across roots.`);
  return 0;
}

module.exports = { candidateVaultRoots, eachLine, readToolCounts, countsForTools, main, COMPLETED_MARKER };

if (require.main === module) process.exit(main(process.argv.slice(2)));
