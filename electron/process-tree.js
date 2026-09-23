'use strict';

// process-tree.js — who did we actually kill?
//
// BUG-437 (2026-09-18). `killTree()` in child-exit.js spawns
// `taskkill /PID <pid> /T /F`, unrefs it and returns. Its return proves that a
// killer was STARTED, not that anything died — and the quit path used that
// return as if it were proof. This module supplies the missing half: record the
// identity of the server child and of every descendant reachable from it BEFORE
// asking it to stop, then re-query afterwards and say, honestly, one of three
// things: they are gone, some survived, or the question could not be answered.
//
// THE IDENTITY IS A PAIR, NEVER A PID. Windows reuses process identifiers, and
// parent-pid metadata outlives the parent, so "pid 17996 is still in the list"
// is not evidence that our child survived — it may be somebody else's brand new
// process wearing a recycled number. Every row here is keyed on
// (ProcessId, CreationDate). `tasklist /V` cannot supply the second half, which
// is why this is a CIM query rather than the cheaper command.
//
// IT IS ASYNCHRONOUS ON PURPOSE, AND THAT IS A DELIBERATE DIFFERENCE FROM
// browser-process.js. That module runs the same class of query through
// `execFileSync`, which is right for its caller and fatal for this one: this
// runs on the quit path, where a blocking spawn is precisely the class of bug
// BUG-225's watchdog exists to cut short and precisely the class it CANNOT cut
// short, because a JavaScript timer does not fire while spawnSync holds the
// loop. Everything here is bounded and awaited instead.
//
// null means "could not determine". An empty array means "none". A caller that
// collapses those two reports ignorance as a clean result, which is the single
// most expensive mistake this repository has made repeatedly.

const { execFile } = require('node:child_process');

// One CIM query's ceiling, and the number is load-bearing. The quit budget is
// snapshot 1000 + child stop 7000 (CHILD_EXIT_DEADLINE_MS) + verify 1000 + a
// 1000 ms cleanup reserve = exactly the 10 s watchdog, so the worst case lands
// ON the backstop rather than past it. Raising this silently eats the reserve.
const QUERY_TIMEOUT_MS = 1000;

// -Property keeps the provider from materialising every column of every
// process; CreationDate is converted to a file-time integer because a localised
// DateTime rendering is not parseable across machines, and 0 stands for "the
// provider did not give us one" rather than for a real timestamp.
const PS_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | '
  + 'ForEach-Object { "$($_.ProcessId)=$($_.ParentProcessId)='
  + '$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }';

function runPowerShell(deps) {
  const run = (deps && deps.execFile) || execFile;
  const timeoutMs = (deps && deps.timeoutMs) || QUERY_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          // Absent PowerShell, a policy block, a timeout, or a truncated buffer
          // all mean the same thing to every caller below: we could not look.
          if (err) return done(null);
          done(String(stdout || ''));
        });
    } catch (_) {
      done(null);
    }
  });
}

// Tolerant by construction: a row that does not parse is skipped rather than
// turned into a pid of NaN. A NaN pid reaching a kill path would be a very bad
// kind of surprise, and this module is read by one.
function parseRows(out) {
  if (typeof out !== 'string' || !out.trim()) return [];
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)=(\d+)=(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid, createdAt: m[3] });
  }
  return rows;
}

function identityOf(row) { return row.pid + ':' + row.createdAt; }

// Everything reachable downward from rootPid in one snapshot, root included.
// Walks the parent links breadth-first over the rows we already have rather
// than issuing a query per level — one round trip, and a cycle in the reported
// parent links (which the provider can produce when pids have been recycled)
// terminates because a pid is only ever expanded once.
function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const root = rows.find((r) => r.pid === rootPid);
  const seen = new Set();
  const out = [];
  const queue = [rootPid];
  if (root) { out.push(root); seen.add(root.pid); }
  while (queue.length) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

// Returns { rootPid, members: [{pid, ppid, createdAt}] } or null when the tree
// could not be read. A root that is already gone yields an empty member list,
// which is a fact and not an error: the child exited before we looked.
async function snapshotTree(rootPid, deps) {
  const pid = Number(rootPid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (((deps && deps.platform) || process.platform) !== 'win32') return null;
  const out = await runPowerShell(deps);
  if (out === null) return null;
  return { rootPid: pid, members: descendantsOf(parseRows(out), pid) };
}

// After the kill. Three outcomes, deliberately distinct:
//
//   terminated-confirmed    every recorded identity is gone, and nothing new
//                           has appeared under a recorded pid
//   survivors               at least one is still there — reported WITH the
//                           identities, because "some survived" without saying
//                           which is not actionable
//   terminated-unconfirmed  the snapshot was missing, or the re-query failed
//
// The third is not a failure of the kill. It is a failure to observe one, and
// saying so is the whole point of this module.
//
// Descendants born AFTER the snapshot are covered by the second clause: a
// process whose parent is one of the pids we recorded is ours even though we
// never saw it, because the only thing that could have spawned it is something
// inside the tree we were killing.
async function verifyGone(snapshot, deps) {
  if (!snapshot || !Array.isArray(snapshot.members)) {
    return { outcome: 'terminated-unconfirmed', survivors: [], reason: 'no snapshot was taken' };
  }
  if (((deps && deps.platform) || process.platform) !== 'win32') {
    return { outcome: 'terminated-unconfirmed', survivors: [], reason: 'not win32' };
  }
  const out = await runPowerShell(deps);
  if (out === null) {
    return { outcome: 'terminated-unconfirmed', survivors: [], reason: 'the process query did not answer' };
  }
  const current = parseRows(out);
  const recordedIdentities = new Set(snapshot.members.map(identityOf));
  const recordedPids = new Set(snapshot.members.map((m) => m.pid));
  const survivors = [];
  for (const row of current) {
    if (recordedIdentities.has(identityOf(row))) { survivors.push(row); continue; }
    // Born after the snapshot, under one of ours. Its parent identity is gone
    // by now, so the pid link is all there is — and a false positive here costs
    // a log line, while a false negative costs the evidence this ticket needs.
    if (recordedPids.has(row.ppid) && !recordedIdentities.has(identityOf(row))) survivors.push(row);
  }
  if (survivors.length) return { outcome: 'survivors', survivors, reason: survivors.length + ' process(es) still present' };
  return { outcome: 'terminated-confirmed', survivors: [], reason: 'every recorded identity is gone' };
}

module.exports = {
  snapshotTree,
  verifyGone,
  // exported for tests; not part of the quit path's vocabulary
  parseRows,
  descendantsOf,
  QUERY_TIMEOUT_MS,
};
