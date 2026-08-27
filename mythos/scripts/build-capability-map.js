#!/usr/bin/env node
'use strict';

/**
 * build-capability-map.js — the capability map stops being hand-typed.
 *
 *   node mythos/scripts/build-capability-map.js --check   # exit 1 on drift
 *   node mythos/scripts/build-capability-map.js --write   # regenerate
 *   node mythos/scripts/build-capability-map.js --json    # machine-readable
 *
 * WHY THIS EXISTS
 *
 * MYTHOS-CAPABILITY-MAP.html is the surface the whole closure campaign is
 * measured against — "everything green" means green on that map. It was 73
 * hand-typed nodes, and measurement on 2026-08-27 found it wrong in three ways
 * that no test could see:
 *
 *   - Its header read 6333 tests when the suite was at 6436, and "74 withheld"
 *     when the real figure was 64.
 *   - A node was still called "Hermes engine" five days after Hermes-Agent was
 *     deleted in the W6 swap.
 *   - It claimed "open a file" was a broken capability with no working path.
 *     `open_file` had existed in from-computer.js since 2026-08-21.
 *
 * And the largest one: the map covered 144 of 179 registered tools and
 * presented itself as complete. Thirty-five tools — every widget, persona,
 * mission, pipeline, kanban, OKF and installer verb — had no node at all, so
 * they could never appear as red, warn or dark. They were invisible, which on a
 * map reads as "fine".
 *
 * WHAT IS GENERATED AND WHAT IS NOT
 *
 * Generated: the vitals, and every cross-check below. Curated and PRESERVED:
 * each node's name, cluster, status, prose note, evidence text, and the list of
 * tool ids it stands for. A human decides what a node means; the machine
 * decides whether that claim still matches the code.
 *
 * The node -> tool-id mapping is names only and is checked in BOTH directions,
 * the same shape as EFFECTOR_LABELS in sync-test-count.js: a tool named by a
 * node that is not registered fails, and a registered tool named by no node
 * fails. That second direction is the one that would have caught `open_file`
 * the day it landed.
 *
 * THE VAULT IS NOT ALWAYS THERE, AND THIS SCRIPT MUST NOT PRETEND IT IS
 *
 * The per-tool ok/fail counts and the incident backlog live in the operator's
 * live vault (%APPDATA%/MYTHOS/vault). A git worktree and a CI runner cannot
 * see it — measured here, `resolveVaultRoot()` falls back to the stale in-repo
 * twin and reports zero incidents. Writing that zero would turn "I could not
 * look" into "there is nothing wrong", which is the single most expensive
 * mistake this repository has made repeatedly. So a vault-derived vital is
 * PRESERVED with its original stamp and flagged `stale` when the vault is
 * absent; the header then renders it dim and prefixed "last read". It is never
 * overwritten with a confident zero.
 *
 * DELIBERATELY NOT CHECKED (Stage 3 §8)
 *
 * Node NAMES against deleted programs. A literal "the string Hermes must not
 * appear" gate would fire on an honest historical note, and a gate that fires
 * on correct content is a gate somebody switches off. The Hermes node is fixed
 * by renaming it; keeping the name honest stays a human review job. What IS
 * structural is that its tool list must name a tool that actually exists, and
 * that is checked.
 */

const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');
const MAP_FILE = path.join(REPO_ROOT, 'MYTHOS-CAPABILITY-MAP.html');
const ROADMAP_FILE = path.join(REPO_ROOT, 'ROADMAP.md');
const BUGS_FILE = path.join(REPO_ROOT, 'BUGS.md');

const ISLAND_OPEN = '<script type="application/json" id="map-data">';
const ISLAND_CLOSE = '</script>';

const STATUSES = ['ok', 'warn', 'fail', 'dark', 'unknown'];

// ---------------------------------------------------------------------------
// reading the island

function readMap(file = MAP_FILE) {
  return fs.readFileSync(file, 'utf8');
}

function parseIsland(html) {
  const open = html.indexOf(ISLAND_OPEN);
  if (open === -1) throw new Error(`capability map has no ${ISLAND_OPEN} island`);
  const bodyStart = open + ISLAND_OPEN.length;
  const close = html.indexOf(ISLAND_CLOSE, bodyStart);
  if (close === -1) throw new Error('capability map island is not closed');
  const raw = html.slice(bodyStart, close);
  return { data: JSON.parse(raw), bodyStart, close };
}

// ---------------------------------------------------------------------------
// the facts the repository can answer on its own

function repoFacts(deps = {}) {
  const sync = deps.sync || require('./sync-test-count.js');
  const liveTools = deps.liveTools || require('../src/core/voice/live-tools.js');

  const perFile = sync.computeEffectorTools().perFile;
  const registered = [];
  for (const ids of Object.values(perFile)) registered.push(...ids);

  const allow = new Set(liveTools.DEFAULT_ALLOWLIST);
  const withheld = registered.filter((id) => !allow.has(id));

  return {
    registered,
    voiceReachable: registered.filter((id) => allow.has(id)),
    withheld,
    // Split so the map can say WHY a tool is off the voice surface. The
    // curated ones carry a recorded reason in live-tools.js; the rest are
    // danger-tier verbs (delete_file, run_command, phone_call) that the
    // reachability gate deliberately does not cover.
    withheldCurated: withheld.filter((id) => new Set(liveTools.VOICE_ALLOWLIST_EXEMPT || []).has(id)),
  };
}

// The suite numbers are owned by sync-test-count.js and committed to ROADMAP.md.
// This script READS them rather than running the suite: two generators that
// both measure the same thing are two numbers that can disagree.
const ROADMAP_RE = /last run (\d{4}-\d{2}-\d{2})\): \*\*(\d+) tests, (\d+) passing, (\d+) failing, (\d+) skipped\.\*\*/;

function suiteFacts(deps = {}) {
  const text = deps.roadmapText ?? fs.readFileSync(ROADMAP_FILE, 'utf8');
  const m = ROADMAP_RE.exec(text);
  if (!m) {
    throw new Error('ROADMAP.md has no readable SYNC:TEST-COUNT line — run '
      + '`node mythos/scripts/sync-test-count.js --write` first. Refusing to guess a test count.');
  }
  return { measuredAt: m[1], tests: +m[2], pass: +m[3], fail: +m[4], skipped: +m[5] };
}

// ---------------------------------------------------------------------------
// the fact only the operator's machine can answer

function vaultFacts(deps = {}) {
  const triage = deps.triage || require('./triage-incidents.js');
  let root;
  try { root = triage.resolveVaultRoot(); } catch { return { reachable: false, reason: 'vault root unresolvable' }; }
  const ledger = path.join(root, 'Semantic', 'incidents.md');
  if (!fs.existsSync(ledger)) {
    // `reason` is written INTO the tracked map, so it must never carry a
    // resolved path: AD-7 forbids machine-specific absolute paths in tracked
    // files, and the first draft of this leaked the operator's whole directory
    // layout into the island. The path goes to the console instead, where the
    // person debugging it needs it and git does not see it.
    return { reachable: false, reason: 'the live vault is not reachable from this checkout', ledger, root };
  }
  const incidents = triage.parseIncidents(fs.readFileSync(ledger, 'utf8'));
  const untracked = triage.findUntracked(incidents, fs.readFileSync(path.join(REPO_ROOT, 'BUGS.md'), 'utf8'));
  return { reachable: true, root, incidents: incidents.length, untracked: untracked.length };
}

// ---------------------------------------------------------------------------
// vitals

// LOCAL date, not UTC. These stamps answer "when did this machine last look",
// and they are rendered in the map header as the honesty mechanism for a number
// nobody can re-measure here. `toISOString()` is UTC, so for an operator east of
// Greenwich every stamp written before ~05:30 local reads as YESTERDAY — a
// stamp that is reliably a day early undermines the exact thing it exists for.
// (sync-test-count.js still uses the UTC slice for the ROADMAP block, so the
// suite vital's stamp can legitimately trail this one by a day. That is not a
// bug in either script: they are two different measurements taken at two
// different times, and the map shows both rather than averaging them.)
const today = (deps = {}) => {
  if (deps.today) return deps.today;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function buildVitals(previous, facts, deps = {}) {
  const { repo, suite, vault } = facts;
  const prev = previous || {};

  const vitals = {
    tests: {
      value: suite.tests, label: 'tests', tone: 'ok',
      source: 'ROADMAP.md SYNC:TEST-COUNT', measuredAt: suite.measuredAt,
    },
    fail: {
      value: suite.fail, label: 'tests fail', tone: suite.fail ? 'fail' : 'ok',
      source: 'ROADMAP.md SYNC:TEST-COUNT', measuredAt: suite.measuredAt,
    },
    withheld: {
      value: repo.withheld.length, label: 'withheld from voice', tone: 'warn',
      source: 'live-tools.js DEFAULT_ALLOWLIST', measuredAt: today(deps),
    },
    registered: {
      value: repo.registered.length, label: 'registered tools', tone: 'ok',
      source: 'computeEffectorTools()', measuredAt: today(deps),
    },
    voiceReachable: {
      value: repo.voiceReachable.length, label: 'reachable by voice', tone: 'ok',
      source: 'live-tools.js DEFAULT_ALLOWLIST', measuredAt: today(deps),
    },
  };

  // The vault-derived one. Preserved, never zeroed — see the header comment.
  if (vault.reachable) {
    vitals.untriaged = {
      value: vault.untracked, label: 'untriaged incidents',
      tone: vault.untracked ? 'fail' : 'ok',
      source: 'live vault incident ledger', measuredAt: today(deps), stale: false,
    };
  } else if (prev.untriaged) {
    // PRESERVED VERBATIM. A machine that cannot measure does not get to rewrite
    // this field — not even to add a flag.
    //
    // The first version stamped `stale: true` here, which looked honest and was
    // a live defect: after a vault-reachable machine wrote a fresh reading, every
    // OTHER checkout wanted to add the flag back, so `--check` exited 1 with zero
    // real problems and the pre-commit hook was broken for CI, every worktree and
    // every fresh clone. It went unnoticed for a day because it only appears once
    // a machine WITH the vault has written; before that the committed island
    // already carried the flag and the two agreed.
    //
    // Passing the entry through untouched removes the whole class: the value and
    // its `measuredAt` stamp are the honest signal on their own, the reader can
    // see how old the reading is, and no checkout can downgrade another's
    // measurement. The `--check` diff then has nothing to disagree about.
    vitals.untriaged = { ...prev.untriaged };
  } else {
    vitals.untriaged = {
      value: '?', label: 'untriaged incidents', tone: '',
      source: 'live vault incident ledger', measuredAt: null, stale: true, staleReason: vault.reason,
    };
  }

  return vitals;
}

// ---------------------------------------------------------------------------
// the checks

function checkIsland(data, facts) {
  const problems = [];
  const nodes = data.nodes || [];
  const clusterIds = new Set((data.clusters || []).map((c) => c.id));

  const claimed = new Map(); // tool id -> [node names]
  const names = new Set();

  for (const n of nodes) {
    const where = `node "${n.n}"`;
    if (names.has(n.n)) problems.push(`${where}: duplicate node name`);
    names.add(n.n);
    if (!clusterIds.has(n.c)) problems.push(`${where}: unknown cluster "${n.c}"`);
    if (!STATUSES.includes(n.s)) problems.push(`${where}: status "${n.s}" is not one of ${STATUSES.join('|')}`);
    if (!Array.isArray(n.tools)) { problems.push(`${where}: no tools array`); continue; }
    if (n.tools.length === 0 && n.kind !== 'subsystem') {
      // An empty list is a real answer for a pipeline or an adapter, but it
      // must SAY so. Without this, "nobody has mapped this yet" and "this is
      // not a tool" look identical, and the coverage check below silently
      // stops meaning anything.
      problems.push(`${where}: empty tools list without kind:"subsystem" — say which it is`);
    }
    for (const id of n.tools) {
      if (!claimed.has(id)) claimed.set(id, []);
      claimed.get(id).push(n.n);
    }
  }

  const registered = new Set(facts.repo.registered);

  const unregistered = [...claimed.keys()].filter((id) => !registered.has(id)).sort();
  if (unregistered.length) {
    problems.push(`the map names ${unregistered.length} tool(s) that are not registered anywhere: `
      + `${unregistered.join(', ')}. Either the tool was removed and its node is stale, or the id is misspelt.`);
  }

  const uncovered = [...registered].filter((id) => !claimed.has(id)).sort();
  if (uncovered.length) {
    problems.push(`${uncovered.length} registered tool(s) appear on no node, so the map cannot `
      + `show them broken, working or dark — they are simply invisible: ${uncovered.join(', ')}`);
  }

  const doubled = [...claimed.entries()].filter(([, ns]) => ns.length > 1);
  for (const [id, ns] of doubled) {
    problems.push(`tool "${id}" is claimed by ${ns.length} nodes (${ns.join(', ')}) — one tool, one node, `
      + 'or its status is ambiguous');
  }

  return problems;
}

function checkVitals(data, expected) {
  const problems = [];
  const have = data.vitals || {};
  // Only the repository-derived vitals are compared. The vault-derived one is
  // deliberately exempt: on a machine that cannot see the vault the preserved
  // value is CORRECT behaviour, and failing on it would make --check
  // unsatisfiable everywhere except the operator's desktop.
  for (const key of ['tests', 'fail', 'withheld', 'registered', 'voiceReachable']) {
    const a = have[key] && have[key].value;
    const b = expected[key].value;
    if (a !== b) problems.push(`vitals.${key}: island says ${a}, the code says ${b}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// BUG-377 — which tickets sit inside which node.
//
// WHY THIS IS CURATED AND NOT DERIVED, measured 2026-08-27 before it was built.
// The obvious design is to attach a bug to a node by the TOOL NAMES its BUGS.md
// entry mentions, since every node already carries a tool list. It was tried
// against the real data and it fails three ways at once:
//
//   * 19 of 91 nodes have `tools: []` — wake word, Aether mesh, fabrication,
//     TTS chain, pc-child, immune system. No tool name can ever attach to them,
//     so the rule is silent on precisely the nodes it was wanted for: BUG-346
//     and BUG-347 (wake word) and BUG-351 (Aether mesh) would land NOWHERE.
//   * Prose mentions a tool for many reasons other than being about it.
//     `web_search` collected six tickets and `open_web` seven; BUG-275 is about
//     fabrication and attached to `web_search`. A mention is not a claim — the
//     same lesson as BUG-373, one layer out.
//   * Two thirds of the registry has no machine-readable status (62 of 234
//     entries), so the join's own filter is a guess. It read BUG-1 as open and
//     attached it to spotify_play.
//
// So `node.bugs` is hand-authored, exactly as `node.tools` already is, and
// checked in BOTH directions by the code below. That is not a retreat from "no
// hand-typed number survives": that rule bans hand-typing what a machine can
// derive (test counts). This association measurably cannot be derived.

// bugFacts — the two sets the checks need, read from BUGS.md only. No vault, no
// git, no network, so every checkout computes the same answer. (BUG-376 is the
// cautionary tale: a field one machine could compute and another could not made
// --check unsatisfiable for every vault-less checkout.)
function bugFacts(deps = {}) {
  const text = deps.bugsText ?? fs.readFileSync(deps.bugsFile || BUGS_FILE, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // DECLARED: the number is a known ticket, as either a heading or a bullet.
  // Both shapes count — 11 of the 12 genuinely open bugs are pointer-only
  // bullets with no heading, and a check that only read headings would call
  // them undeclared.
  //
  // This is deliberately the PERMISSIVE UNION and is NOT a headline figure.
  // lint-bug-registry.js reports `declaredCount: 227` where this set has 235,
  // because that script answers "how many tickets are properly declared" under
  // its own declaration rule, and this one answers "which numbers may a node
  // cite without the gate objecting". Being over-inclusive here can only ever
  // avoid a false failure; being under-inclusive would block commits over a
  // ticket that plainly exists. So do not render this size anywhere as the
  // registry's count — the registry owns that number.
  const declared = new Set();
  for (const line of lines) {
    const m = /^#{2,4}\s.*?BUG-(\d+)\b/.exec(line) || /^- BUG-(\d+)\b/.exec(line);
    if (m) declared.add(Number(m[1]));
  }

  // OPEN: read from the operator's open-work register, and read as BLOCKS. A
  // bullet's "FIXED" often sits on its SECOND line, so judging a list item by
  // its first line reports closed tickets as open — measured, on BUG-353.
  let inRegister = false;
  const open = new Set();
  let registerFound = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^## OPEN WORK\b/.test(lines[i])) { inRegister = true; registerFound = true; continue; }
    if (inRegister && /^## /.test(lines[i])) inRegister = false;
    if (!inRegister) continue;
    const m = /^- BUG-(\d+)\b/.exec(lines[i]);
    if (!m) continue;
    let block = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^- |^#{2,4}\s/.test(lines[j])) break;
      block += '\n' + lines[j];
    }
    if (!/\bFIXED\b/.test(block)) open.add(Number(m[1]));
  }

  return { declared, open, registerFound };
}

// checkBugs — mirrors checkIsland's two directions for tools, because the
// failure it prevents is the same one: BUG-348 sits in `system volume`, a node
// showing 105 ok / 0 fail, because nodes are coloured by CALL COUNTS and that
// bug is about a call that succeeds while answering the wrong question. Without
// the second direction, "28 nodes green" keeps meaning "28 things finished".
function checkBugs(data, facts) {
  const problems = [];
  const nodes = data.nodes || [];
  const { declared, open, registerFound } = facts.bugs;

  // GUARD THE GUARD. An empty open-set satisfies the coverage direction for
  // free, so the check would pass loudest at the moment it stopped working.
  if (!registerFound) {
    problems.push('BUGS.md has no "## OPEN WORK" register, so the open-bug set cannot be read '
      + 'and the coverage check below would pass vacuously. Restore the register or update this check.');
    return problems;
  }
  if (open.size === 0) {
    problems.push('the open-bug register parsed to ZERO open bugs. That is either a genuine '
      + 'empty backlog or a parser that has stopped matching; it must not be read as coverage.');
    return problems;
  }

  const claimed = new Map(); // bug number -> [node names]
  for (const n of nodes) {
    if (n.bugs === undefined) continue;
    if (!Array.isArray(n.bugs)) { problems.push(`node "${n.n}": bugs must be an array of numbers`); continue; }
    for (const raw of n.bugs) {
      if (!Number.isInteger(raw) || raw <= 0) {
        problems.push(`node "${n.n}": bug "${raw}" is not a positive integer — write 348, not "BUG-348"`);
        continue;
      }
      if (!claimed.has(raw)) claimed.set(raw, []);
      claimed.get(raw).push(n.n);
    }
  }

  // Direction 1: every number the map names must be a real ticket.
  const unknown = [...claimed.keys()].filter((b) => !declared.has(b)).sort((a, b) => a - b);
  if (unknown.length) {
    problems.push(`the map names ${unknown.length} bug number(s) that are not declared in BUGS.md: `
      + `${unknown.map((b) => 'BUG-' + b).join(', ')}. Either the number is wrong or the entry was never written.`);
  }

  // Direction 2: every OPEN ticket must be visible on some node. This is the
  // direction that catches an open bug hiding inside a green node, and it is
  // the one the tool check already earns its keep with.
  const invisible = [...open].filter((b) => !claimed.has(b)).sort((a, b) => a - b);
  if (invisible.length) {
    problems.push(`${invisible.length} open bug(s) appear on no node, so the map cannot show the `
      + `capability they affect as anything other than healthy: ${invisible.map((b) => 'BUG-' + b).join(', ')}. `
      + 'Add each to the node whose capability it degrades.');
  }

  // Deliberately NOT checked: a bug listed on more than one node. Tools are
  // one-tool-one-node because a tool has a single owner; a defect legitimately
  // degrades several capabilities, and forcing a choice would make the map lie
  // about scope. Recorded so the asymmetry with checkIsland reads as a decision.

  return problems;
}

// ---------------------------------------------------------------------------

function generate(deps = {}) {
  const html = deps.html ?? readMap(deps.mapFile);
  const { data, bodyStart, close } = parseIsland(html);
  const facts = {
    repo: deps.repo || repoFacts(deps),
    suite: deps.suite || suiteFacts(deps),
    vault: deps.vault || vaultFacts(deps),
    bugs: deps.bugs || bugFacts(deps),
  };
  const vitals = buildVitals(data.vitals, facts, deps);
  // Two kinds, and they are not interchangeable. A MAPPING problem is a claim
  // the code contradicts and only a human can resolve, so it blocks --write:
  // stamping a fresh date onto a map that is wrong is worse than leaving it
  // visibly old. A STALE VITAL is the ordinary condition --write exists to
  // clear, so it must not block it — an earlier draft conflated the two and
  // the generator could never bootstrap its own vitals.
  // A bug-mapping problem is a MAPPING problem, not a stale vital: it is a claim
  // the registry contradicts, only a human can resolve it, and stamping a fresh
  // date onto a map that hides an open ticket is the failure being prevented.
  const mapping = [...checkIsland(data, facts), ...checkBugs(data, facts)];
  const stale = checkVitals(data, vitals);
  const problems = [...mapping, ...stale];

  const next = { ...data, generated: today(deps), vitals };
  const json = JSON.stringify(next, null, 2).replace(/</g, '\\u003c');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const body = eol + json.split('\n').join(eol) + eol;
  const nextHtml = html.slice(0, bodyStart) + body + html.slice(close);

  return { data, next, facts, vitals, problems, mapping, stale, html, nextHtml, changed: nextHtml !== html };
}

function main(argv) {
  const wantJson = argv.includes('--json');
  const write = argv.includes('--write');

  let result;
  try {
    result = generate();
  } catch (e) {
    console.error(`build-capability-map: ${e.message}`);
    return 1;
  }

  const { problems, mapping, facts, vitals, changed, nextHtml } = result;

  if (wantJson) {
    console.log(JSON.stringify({
      problems, vitals, changed,
      registered: facts.repo.registered.length,
      vaultReachable: facts.vault.reachable,
    }, null, 2));
    return problems.length ? 1 : 0;
  }

  console.log(`build-capability-map: ${result.data.nodes.length} nodes, `
    + `${facts.repo.registered.length} registered tools, `
    + `${facts.repo.voiceReachable.length} reachable by voice, `
    + `${facts.repo.withheld.length} withheld `
    + `(${facts.repo.withheldCurated.length} curated with a recorded reason, `
    + `${facts.repo.withheld.length - facts.repo.withheldCurated.length} danger-tier).`);
  console.log(`build-capability-map: suite ${facts.suite.tests}/${facts.suite.fail} fail `
    + `(from ROADMAP.md, last run ${facts.suite.measuredAt}).`);
  if (!facts.vault.reachable) {
    console.log(`build-capability-map: live vault NOT reachable (${facts.vault.reason}). `
      + 'The incident vital keeps its last stamp and renders stale — it is not zeroed.');
  }

  const bugTotals = (result.data.nodes || []).reduce((acc, n) => {
    for (const b of (n.bugs || [])) acc.add(b);
    return acc;
  }, new Set());
  console.log(`build-capability-map: ${facts.bugs.open.size} open bug(s) in the register, `
    + `${bugTotals.size} mapped onto nodes.`);

  const byStatus = {};
  for (const n of result.data.nodes) byStatus[n.s] = (byStatus[n.s] || 0) + 1;
  console.log(`build-capability-map: ${STATUSES.map((s) => `${s} ${byStatus[s] || 0}`).join(' · ')}`);

  for (const p of problems) console.log(`  ! ${p}`);

  if (write) {
    if (mapping.length) {
      console.error('build-capability-map: refusing to write while the island disagrees with the code. '
        + 'Fix the mapping first — writing now would stamp a fresh date onto a map that is wrong.');
      return 1;
    }
    if (changed) {
      fs.writeFileSync(MAP_FILE, nextHtml, 'utf8');
      console.log('build-capability-map: island rewritten.');
    } else {
      console.log('build-capability-map: island already current, nothing written.');
    }
    return 0;
  }

  if (problems.length) {
    console.error(`build-capability-map --check: ${problems.length} problem(s). `
      + 'Run --write after fixing the mapping.');
    return 1;
  }
  if (changed) {
    console.error('build-capability-map --check: the island is stale — run --write.');
    return 1;
  }
  console.log('build-capability-map --check: the map matches the code. OK.');
  return 0;
}

module.exports = {
  bugFacts,
  checkBugs,
  parseIsland, repoFacts, suiteFacts, vaultFacts, buildVitals,
  checkIsland, checkVitals, generate, main, STATUSES, ROADMAP_RE,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
