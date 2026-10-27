'use strict';

// file-walk.js — the directory traversal behind search_files, and the one
// skip-list both file walkers share.
//
// WHY THIS EXISTS. Two sibling tools walked the tree with two different sets of
// rules and neither knew about the other (BUG-362, BUG-368):
//
//   from-computer.js   search_files    depth-first, budget on ENTRIES EXAMINED,
//                                      no skip-list at all
//   from-code-search.js index_project  depth-first, budget on FILES MATCHED,
//                                      skip-list without `.venv`
//
// Both starved on the same repo for the same underlying reason, and the fix for
// one would not have fixed the other. The list now lives in one place so the
// next person adding a directory to it fixes both tools at once.
//
// THE TWO MECHANISMS BELOW ARE NOT EQUALLY LOAD-BEARING, and confusing them is
// how this bug comes back:
//
//   * BREADTH-FIRST IS THE CORRECTNESS MECHANISM. Every entry at the current
//     depth is tested before ANY recursion, so a shallow match cannot be starved
//     by a deep sibling — whatever that sibling happens to be called. It is a
//     property of the traversal, not a list anybody has to keep current.
//   * SKIP_DIRS IS AN OPTIMISATION for result QUALITY. It is why searching a
//     project root for `package.json` returns the one you meant instead of fifty
//     from dependency trees. It is NOT what makes the search correct. Do not add
//     a directory here believing it fixes a starvation bug — measure first,
//     because a list is only ever complete for the machine it was written on.
//
// Measured on the MAIN CHECKOUT, 2026-08-27 (the location matters — see the
// worktree note below), searching mythos/ with a 5,000-entry budget:
//
//   pattern            depth-first   depth-first + skip node_modules/.git   breadth-first
//   package.json            0                      0                             50
//   ROADMAP.md              0                      0                              1
//   from-pc.js              0                      0                              1
//   doctor.js               0                      0                              1
//   lanes.default.js        0                      0                              1
//
// The middle column is the remedy BUG-362 originally proposed, and it changes
// nothing: `.venv` is 5,202 entries within depth 6 and exhausts a 5,000 budget
// on its own, before `node_modules` is even reached.
//
// THIS DOES NOT REPRODUCE IN A GIT WORKTREE, and a fix "verified" there is not
// verified. setup-worktree.js links `.venv` (and five other paths) as junctions,
// and a Dirent for a junction reports isDirectory() === false — so a worktree
// charges one entry for `.venv` and never recurses. The budget survives, both
// bugs vanish, and the fix passes for a reason unrelated to the fix. Every
// number above is from the main checkout, and the regression tests build their
// own fixture tree instead of walking this repo, so they cannot inherit the
// answer from whichever checkout they run in.

const fs = require('fs');
const path = require('path');

// Directories excluded from both walkers. The JS-side entries are inherited
// verbatim from from-code-search.js, which had them first; `.venv`, `venv` and
// `__pycache__` were added by BUG-368 because this repo has a Python virtualenv
// at mythos/.venv holding 94% of what index_project was indexing.
//
// `env` is deliberately NOT here: unlike the rest it is a plausible name for a
// real source directory, and a skip-list that swallows project content fails in
// the direction nobody checks.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vault', '.vscode', 'dist', 'build', 'coverage',
  '.next', '_archive',
  '.venv', 'venv', '__pycache__',
]);

// Breadth-first walk. Returns { entries, truncated, scanned }; `entries` holds
// { name, full, dirent } for each match, shallowest first, and shaping them into
// a tool result is the caller's job.
//
// `truncated` means STOPPED EARLY — either budget or result cap — and says
// nothing about whether anything was found. The caller must not report
// truncated-with-zero-results as an honest miss; see search_files.
function walkBreadthFirst(root, opts) {
  const o = opts || {};
  const match = o.match || (() => false);
  const maxDepth = typeof o.maxDepth === 'number' ? o.maxDepth : 6;
  const maxScan = typeof o.maxScan === 'number' ? o.maxScan : 5000;
  const maxEntries = typeof o.maxEntries === 'number' ? o.maxEntries : 50;
  const skip = o.skipDirs || SKIP_DIRS;
  // B2d: a path the caller excludes (a protected credential path) is neither
  // reported nor descended into.
  const exclude = o.exclude || (() => false);

  const entries = [];
  let scanned = 0;
  let truncated = false;
  let frontier = [[root, 0]];

  while (frontier.length && !truncated) {
    const next = [];
    for (let i = 0; i < frontier.length && !truncated; i++) {
      const dir = frontier[i][0];
      const depth = frontier[i][1];
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions, race) — best-effort, skip it
      }
      for (const entry of dirEntries) {
        scanned++;
        if (scanned > maxScan) { truncated = true; break; }
        const full = path.join(dir, entry.name);
        if (exclude(full)) continue;
        if (match(entry.name)) {
          if (entries.length >= maxEntries) { truncated = true; break; }
          entries.push({ name: entry.name, full: full, dirent: entry });
        }
        // entry.isDirectory(), NEVER statSync(full).isDirectory(). A Dirent
        // reports false for a junction/symlink, so links are not descended into
        // and a link planted inside the sandbox cannot walk out of it. That
        // containment is currently a PROPERTY OF THIS LINE and nothing else —
        // switching to statSync reads like a robustness improvement and would
        // open a real sandbox escape. Pinned by a junction test.
        if (entry.isDirectory() && depth + 1 <= maxDepth && !skip.has(entry.name)) {
          next.push([full, depth + 1]);
        }
      }
    }
    frontier = next;
  }

  return { entries, truncated, scanned };
}

// The first maxBytes of a file as UTF-8 — read with a bounded buffer, so a file
// that grew after its size was checked is still read only this far (B2d).
function readHead(file, maxBytes) {
  const buf = Buffer.alloc(maxBytes);
  const fd = fs.openSync(file, 'r');
  try { return buf.subarray(0, fs.readSync(fd, buf, 0, maxBytes, 0)).toString('utf8'); } finally { fs.closeSync(fd); }
}

// The canonical path, or null. .native (GetFinalPathNameByHandle), not the JS
// walk: the JS walk keeps an 8.3 short name ("SSH~1") and a stream suffix
// ("::$DATA") exactly as typed, so the canonical path named neither .ssh nor the
// real file (B2d review, 2026-09-29). Moved here from from-computer.js.
function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

// The nearest ancestor of dir (or dir itself) that exists. Moved here from
// from-computer.js, where the reasoning for walking all the way up is kept.
function nearestExistingAncestor(dir) {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break; // reached a filesystem root; stop
    probe = parent;
  }
  return probe;
}

module.exports = { SKIP_DIRS, walkBreadthFirst, readHead, realpathOrNull, nearestExistingAncestor };
