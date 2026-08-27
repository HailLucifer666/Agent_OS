#!/usr/bin/env node
'use strict';

/**
 * build-index.js — the ticket register half of the root `index.html`.
 *
 *   node mythos/scripts/build-index.js --check   # exit 1 on drift
 *   node mythos/scripts/build-index.js --write   # regenerate
 *
 * WHAT THIS OWNS, AND WHAT IT DOES NOT
 *
 * `index.html` is the single tracked surface for this repository: the
 * capability map and the ticket register, two views over ONE JSON island.
 * Three generators write into that island and they do not overlap:
 *
 *   build-capability-map.js  -> nodes, clusters, vitals   (and `node.bugs`)
 *   build-index.js (this)    -> `register`, the flat ticket list
 *   sync-test-count.js       -> the suite figures this reads out of ROADMAP.md
 *
 * Each splices its own key and preserves the others by spread, so the order
 * they run in does not matter and two sessions can own different halves.
 *
 * WHY THE STATUS COLUMN SAYS "unrecorded" SO OFTEN
 *
 * Measured 2026-08-27: of the entries in BUGS.md, only about a quarter state a
 * status in a form a machine can read. The rest are a heading and prose. This
 * generator reports `unrecorded` for those rather than inferring `fixed`,
 * because an entry with no status is not evidence of closure — and a register
 * that guesses is worse than one that admits the gap. The count of unrecorded
 * entries is itself published, so the gap is visible rather than smoothed over.
 *
 * THE OPEN SET IS DERIVED FROM THE REGISTER SECTION, NOT FROM ABSENCE
 *
 * "No status" does not mean open. The authoritative open list is the
 * `## OPEN WORK filed ...` section, whose bullets are read as BLOCKS — the word
 * FIXED frequently sits on an entry's second line, and reading only the first
 * line reports a closed bug as open. That mistake was made and caught on
 * 2026-08-27; the block parse is the fix.
 */

const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');
const INDEX_FILE = path.join(REPO_ROOT, 'index.html');
const BUGS_FILE = path.join(REPO_ROOT, 'BUGS.md');

const ISLAND_OPEN = '<script type="application/json" id="map-data">';
const ISLAND_CLOSE = '</script>';

const STATES = ['verified', 'fixed', 'open', 'coded', 'diagnosed', 'duplicate', 'unrecorded'];

// ---------------------------------------------------------------------------

function parseBugs(text) {
  const marks = [...text.matchAll(/^#{1,6} BUG-(\d+)([^\n\r]*)/gm)]
    .map((m) => ({ n: +m[1], head: m[2], at: m.index }));

  const seen = new Set();
  const out = [];

  marks.forEach((m, i) => {
    if (seen.has(m.n)) return;
    seen.add(m.n);
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    out.push({ n: m.n, shape: 'entry', head: clean(m.head), body: text.slice(m.at, end) });
  });

  // Pointer-only declarations: a bullet with no heading anywhere. Read as a
  // BLOCK — the bullet plus its continuation lines — because the status word is
  // routinely on the second line.
  for (const m of text.matchAll(/^[-*] BUG-(\d+)\b/gm)) {
    const n = +m[1];
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ n, shape: 'pointer', head: '', body: blockAt(text, m.index) });
  }

  return out.sort((a, b) => a.n - b.n);
}

function blockAt(text, at) {
  const rest = text.slice(at);
  const stop = /\r?\n\s*\r?\n|\r?\n[-*] BUG-|\r?\n#{1,6} /.exec(rest);
  return stop ? rest.slice(0, stop.index) : rest.slice(0, 1500);
}

const clean = (s) => String(s || '').replace(/^[\s—:-]+/, '').trim();

/**
 * Pull the structured half of an entry out so a reader can open a ticket and
 * see what it IS, without opening a 1 MB markdown file.
 *
 * The labels are measured, not invented. Across BUGS.md: symptom 64, status 55,
 * root cause 38, severity 36, fix 34, regression test 21, verification 15,
 * mechanism 9. 185 of 219 entries carry at least one, and the 34 that carry
 * none fall back to a plain excerpt rather than rendering blank.
 *
 * Every section is CAPPED. The median entry is 2.3 KB but the largest is 141 KB;
 * embedding whole bodies would push a 123 KB page past 1 MB and make the file
 * hostile to open. A capped excerpt with a pointer to the real entry is the
 * honest trade — this view is for triage, BUGS.md remains the source.
 */
const SECTION_MAP = [
  ['symptom', ['symptom', 'complaint', 'what was measured wrong', 'how it bit']],
  ['cause', ['root cause', 'mechanism', 'cause', 'why this happened']],
  ['fix', ['fix', 'the fix', 'fix applied', 'fix needed', 'what shipped']],
  ['verification', ['verification', 'regression test', 'tests', 'test', 'verification note']],
  ['limits', ['what this does not fix', 'not closed by this', 'deliberate non-change',
    'deliberate non-changes', 'not done', 'residual']],
  ['files', ['files']],
];
const SECTION_CAP = 900;

function sections(body) {
  // Index every bold label with its offset, then slice each to the next one.
  const marks = [...body.matchAll(/\*\*([^*\n]{2,60}?)[.:]?\*\*/g)]
    .map((m) => ({ label: m[1].trim().toLowerCase(), at: m.index, len: m[0].length }));
  const out = {};
  marks.forEach((m, i) => {
    const key = SECTION_MAP.find(([, names]) => names.includes(m.label));
    if (!key) return;
    if (out[key[0]]) return; // first occurrence wins
    const end = i + 1 < marks.length ? marks[i + 1].at : body.length;
    const text = body.slice(m.at + m.len, end).replace(/\s+/g, ' ').replace(/^[\s—:-]+/, '').trim();
    if (text) out[key[0]] = text.length > SECTION_CAP ? text.slice(0, SECTION_CAP).trim() + '…' : text;
  });
  return out;
}

function excerpt(body) {
  // Fallback for the 34 entries with no recognised section: the prose after the
  // heading, capped. Better than an empty panel, and it says where to read more.
  const afterHeading = body
    .replace(/^#{1,6}[^\n\r]*\r?\n/, '')          // drop a heading line
    .replace(/^[-*]\s*BUG-\d+\s*[-—:]?\s*/, '');  // drop a bullet's own id prefix
  // The panel already shows BUG-nnn as the title; repeating it in the body is
  // noise on exactly the entries that have the least to show.
  const t = afterHeading.replace(/\s+/g, ' ').trim();
  return t.length > SECTION_CAP ? t.slice(0, SECTION_CAP).trim() + '…' : t;
}

function classify(bug, openSet) {
  const t = bug.body.replace(/\s+/g, ' ');
  const h = bug.head;
  const say = (re) => re.test(t);

  if (/duplicate of BUG/i.test(h) || /\*\*Status:\*\*[^.]{0,40}duplicate/i.test(t)) return 'duplicate';
  if (openSet.has(bug.n)) return 'open';

  const fixed = /✅/.test(h) || /\bFIXED\b/.test(h) || /\bRESOLVED\b/.test(h)
    || /\*\*Status:\*\*\s*✅/.test(t) || /\*\*Status:\*\*[^.]{0,40}(FIXED|RESOLVED)/i.test(t);
  if (fixed) {
    const proven = say(/mutation-proven/i) || say(/0 survived/i);
    const live = say(/live-?verified/i) && !say(/NOT (?:yet )?live-?verified/i);
    return (proven || live) ? 'verified' : 'fixed';
  }
  if (/🔍/.test(h) || /\bMEASURED\b/.test(h) || /\bDIAGNOSED\b/.test(h)) return 'diagnosed';
  if (/🔧/.test(h) || /\bCODED\b/.test(h)) return 'coded';
  if (say(/\bFILED, NOT STARTED\b|\bNOT STARTED\b/i)) return 'open';
  return 'unrecorded';
}

/**
 * The authoritative open set. Read from the OPEN WORK register section only —
 * absence of a status elsewhere is not evidence of openness, and treating it as
 * such would report dozens of long-closed bugs as live work.
 */
function openSetFrom(text) {
  const at = text.search(/^## OPEN WORK filed /m);
  if (at === -1) return { set: new Set(), section: false };
  const after = text.slice(at);
  const endRel = after.slice(3).search(/^## /m);
  const section = endRel === -1 ? after : after.slice(0, endRel + 3);
  const set = new Set();
  for (const m of section.matchAll(/^[-*] BUG-(\d+)\b/gm)) {
    const block = blockAt(section, m.index).replace(/\s+/g, ' ');
    if (/\bFIXED\b|\bRESOLVED\b|\bCLOSED\b/i.test(block)) continue;
    set.add(+m[1]);
  }
  return { set, section: true };
}

// ---------------------------------------------------------------------------

function buildRegister(deps = {}) {
  const text = deps.bugsText ?? fs.readFileSync(BUGS_FILE, 'utf8');
  const { set: openSet, section } = openSetFrom(text);

  // Guard the guard. An empty open set would make every "is it covered" check
  // pass vacuously, which is the shape that has bitten this repo twice.
  if (!section) throw new Error('build-index: BUGS.md has no "## OPEN WORK filed" section — '
    + 'refusing to publish a register whose open set would be empty by accident.');

  const bugs = parseBugs(text).map((b) => {
    const sec = sections(b.body);
    const row = {
      n: b.n,
      shape: b.shape,
      state: classify(b, openSet),
      title: b.shape === 'entry'
        ? b.head.replace(/\s*\((?:✅|🔧|🔍)[^)]*\)\s*$/, '').trim()
        : clean(b.body.split(/\r?\n/)[0].replace(/^[-*]\s*BUG-\d+\s*[-—:]?\s*/, '')),
      detail: sec,
    };
    // An entry with no recognised section still opens to something readable.
    if (!Object.keys(sec).length) row.excerpt = excerpt(b.body);
    return row;
  });

  const counts = {};
  for (const s of STATES) counts[s] = bugs.filter((b) => b.state === s).length;

  return {
    bugs,
    counts,
    total: bugs.length,
    openDeclared: [...openSet].sort((a, b) => a - b),
    pointerOnly: bugs.filter((b) => b.shape === 'pointer').length,
    generatedFrom: 'BUGS.md',
  };
}

// ---------------------------------------------------------------------------

function readIsland(html) {
  const open = html.indexOf(ISLAND_OPEN);
  if (open === -1) throw new Error(`index.html has no ${ISLAND_OPEN} island`);
  const bodyStart = open + ISLAND_OPEN.length;
  const close = html.indexOf(ISLAND_CLOSE, bodyStart);
  if (close === -1) throw new Error('index.html island is not closed');
  return { data: JSON.parse(html.slice(bodyStart, close)), bodyStart, close };
}

function generate(deps = {}) {
  const html = deps.html ?? fs.readFileSync(INDEX_FILE, 'utf8');
  const { data, bodyStart, close } = readIsland(html);
  const register = deps.register ?? buildRegister(deps);

  // Spread preserves every key this generator does not own — `nodes`,
  // `clusters`, `vitals`, and `node.bugs` from build-capability-map.js.
  const next = { ...data, register };
  const json = JSON.stringify(next, null, 2).replace(/</g, '\\u003c');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const body = eol + json.split('\n').join(eol) + eol;
  const nextHtml = html.slice(0, bodyStart) + body + html.slice(close);

  return { data, next, register, html, nextHtml, changed: nextHtml !== html };
}

function main(argv) {
  const write = argv.includes('--write');
  let r;
  try { r = generate(); } catch (e) { console.error(`build-index: ${e.message}`); return 1; }

  const c = r.register.counts;
  console.log(`build-index: ${r.register.total} declared bug numbers `
    + `(${r.register.pointerOnly} pointer-only, no heading).`);
  console.log(`build-index: ${STATES.map((s) => `${s} ${c[s]}`).join(' · ')}`);
  console.log(`build-index: open per the OPEN WORK register: `
    + r.register.openDeclared.map((n) => `BUG-${n}`).join(', '));
  if (c.unrecorded) {
    console.log(`build-index: ${c.unrecorded} entries state no status a machine can read. `
      + 'They are published as "unrecorded", never inferred as closed.');
  }

  if (argv.includes('--json')) { console.log(JSON.stringify(r.register, null, 2)); return 0; }

  if (write) {
    if (r.changed) { fs.writeFileSync(INDEX_FILE, r.nextHtml, 'utf8'); console.log('build-index: register rewritten.'); }
    else console.log('build-index: register already current, nothing written.');
    return 0;
  }
  if (r.changed) {
    console.error('build-index --check: the register is stale — run --write.');
    return 1;
  }
  console.log('build-index --check: the register matches BUGS.md. OK.');
  return 0;
}

module.exports = { parseBugs, classify, openSetFrom, buildRegister, readIsland, generate, main, STATES };

if (require.main === module) process.exit(main(process.argv.slice(2)));
