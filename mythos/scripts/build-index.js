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
 * WHY THE STATUS COLUMN SAYS "unrecorded", AND WHY IT USED TO SAY IT 97 TIMES
 * MORE THAN IT SHOULD HAVE
 *
 * The claim that stood here — "only about a quarter state a status in a form a
 * machine can read, the rest are a heading and prose" — was measured against the
 * reader rather than against BUGS.md, and it was wrong. Of the 133 entries this
 * file called unrecorded on 2026-08-27, 88 opened with a BOLD MARKER LINE
 * (`**FIXED.**`, `**Fixed** by <sha>`, `**NOT done, and not attempted:**`) and 8
 * more had an ordinary `**Status:**` line in a shape the regexes missed. That is
 * simply the convention BUGS.md used before `**Status:**` existed. BUG-389 taught
 * classify() to read it: 133 unrecorded became 36, with no entry that already had
 * a status changing state.
 *
 * The refusal to guess is UNCHANGED and is the reason this is safe. Reading a
 * status the author wrote in an older shape is reading; deriving one from a
 * commit or a test file is not, and is still not done. Measured while fixing
 * this: 75 of the no-status entries have a commit naming them, but BUG-051's
 * only commit is `docs(bugs): file BUG-051..BUG-058` (the FILING commit) and
 * BUG-059's matches name other bugs in their subject — so a commit-derived status
 * would have closed bugs nobody fixed. An entry that states nothing is still
 * `unrecorded`, the count is still published, and the gap stays visible.
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

// BUG-389 — THE OLDER ENTRIES DO STATE A STATUS; NOTHING WAS LOOKING FOR IT.
//
// This file's own header used to say the unrecorded entries were "a heading and
// prose". Measured against all 133 of them: 88 open with a BOLD MARKER LINE —
// `**FIXED.**`, `**Fixed** by <sha>`, `**NOT done, and not attempted:**` — which
// is simply the convention BUGS.md used before `**Status:**` existed. Reading a
// status the author wrote in an older shape is READING, not inferring, so the
// refusal-to-guess rule below is untouched: an entry that states nothing is still
// `unrecorded`.
//
// Q1 — WHAT ELSE MATCHES THIS? The reason these are anchored to the start of a
// line and to `**`. `\bFIXED\b` appears somewhere in 100 of the 121, including
// sentences about OTHER tickets' fixes and about things that were NOT fixed, so a
// free-text search would have closed bugs on the strength of a cross-reference.
// Two live traps this population actually contains, both pinned by tests:
// BUG-098's `**NOT done, and not attempted:**` must read OPEN, not fixed, and
// BUG-049's `**Not unit-testable.**` is not a status at all and must stay
// unrecorded — which is why NOT- is matched against an explicit verb list rather
// than as a prefix.
// BUG-390 — two further shapes, both found the same way as BUG-389's: by reading
// what the entries that were still `unrecorded` actually say.
//   * `**OPEN. Deferred by design to …**` / `**OPEN, UNDIAGNOSED. …**` — a stated
//     status, and the one whose absence matters most, because an entry wrongly
//     left unrecorded here is real work that nothing is tracking.
//   * pointer-shape entries, which are a BULLET rather than a heading and carry
//     their status inline: `- BUG-345 - adblock silence caveat. FIXED 639200c:`.
// `bulletPartial` is ordered ahead of `bulletFixed` for BUG-352, which reads
// "COUNTER FIXED … the README catalog table and pie are NOT yet generated": a
// half-done ticket is open work, and reading its FIXED and stopping there would
// close it on the strength of the half that landed.
const MARK = {
  // Order matters: every negative is tested before the positive it contains.
  notDone: /^\s*\*\*\s*NOT\s+(?:done|fixed|attempted|started|implemented)\b/im,
  open: /^\s*\*\*\s*OPEN\b/im,
  // These two are built per-entry by bulletMarks() so the bullet must name THIS
  // entry's own number. Kept here as placeholders only so the state names exist.
  bulletPartial: /(?!)/,
  bulletFixed: /(?!)/,
  verified: /^\s*\*\*\s*(?:LIVE-?VERIFIED|VERIFIED)\b/im,
  fixed: /^\s*\*\*\s*(?:FIXED|RESOLVED|SHIPPED|Fixed)\b/m,
  coded: /^\s*\*\*\s*(?:🔧\s*)?CODED\b/im,
  diagnosed: /^\s*\*\*\s*(?:🔍\s*)?(?:DIAGNOSED|MEASURED)\b/im,
};
const MARK_OPEN = new Set(['notDone', 'open', 'bulletPartial']);
const MARK_FIXED = new Set(['fixed', 'verified', 'bulletFixed']);

// The `**Status:**` line, as WRITTEN rather than as hoped for. The old reader
// required the marker to sit immediately after the colon, so BUG-011's
// "**Status:** Fix 2 (param aliasing) ✅ VERIFIED · Fix 1 ... ✅ LIVE-VERIFIED"
// — three separately verified fixes — was read as no status at all.
function statusLine(body) {
  const m = body.match(/\*\*Status:?\*\*:?([^\n\r]{0,300})/i);
  return m ? m[1] : '';
}

// ONE status source per entry, chosen deterministically, and the order is the
// whole safety property. An explicit `**Status:**` line is what the author wrote
// as the status and always wins; a bold marker line is consulted ONLY when there
// is no Status line at all.
//
// Q1 again, and this one bit during development: scanning the body for markers
// regardless of a Status line reclassified three entries that were already being
// read CORRECTLY. BUG-037 (`**Status:** ⚠️ MITIGATED`) and BUG-038 and BUG-367
// (both `**Status:** ✅ FIXED`) each carry a later `**Not fixed in this pass:**`
// or `**Not ...**` subsection, which is a scoped note about one PART of the work,
// not the ticket's disposition. Reading it as the status turned two fixed bugs
// and one verified bug back into open ones. A marker is only a status when it is
// standing in for a Status line that does not exist.
// BUG-390 — the bullet patterns are tested against the FLATTENED body and the
// `**` ones per line, and the split is not cosmetic. A pointer entry is one
// bullet that wraps: BUG-352 reads "- BUG-352 - catalog truth. **COUNTER FIXED
// … ;\n  the README catalog table and pie are NOT yet generated**". Scanning line
// by line sees the FIXED and never reaches the qualifier two lines down, which
// closes a ticket on the strength of the half of it that landed. The `**` markers
// stay line-anchored, because that anchoring is what stops a mid-paragraph
// sentence being read as a status.
// A bullet only states THIS entry's status when it names THIS entry's number.
// Without that, BUG-273 read `verified` off a bullet nested inside it that was
// about BUG-345 — one ticket's disposition assigned to another, which is the same
// mistake as reading a `**Not fixed in this pass:**` subsection as a status, and
// it fails toward closing things nobody fixed.
function bulletMarks(n) {
  // Assembled rather than written as one literal on purpose. Writing the prefix
  // and the zero-padding adjacent spells a valid-looking ticket id in tracked
  // source, and lint-bug-registry scans tracked source for exactly that shape —
  // so the pattern gets counted as a number in use with no entry and pushes the
  // undeclared ratchet over baseline. A pattern that matches ids must not itself
  // look like one, and neither must the comment explaining it: the first draft of
  // this note tripped the same gate twice by quoting the string it warns about.
  const id = '[-*]\\s*' + 'BUG-' + '0*' + n + '\\b';
  return {
    bulletPartial: new RegExp(`${id}[^\\n]*\\bFIXED\\b[^\\n]*\\bNOT\\s+yet\\b`, 'i'),
    // SATISFIED reads the same as FIXED here, and for the same reason it was
    // added to openSetFrom's closure vocabulary: BUG-344's bullet states
    // "VERIFIED-SATISFIED 2026-08-24" and nothing could read it. Leaving it out
    // would move that entry from wrongly-open to wrongly-unrecorded, which is
    // trading one false report for another.
    bulletFixed: new RegExp(`${id}[^\\n]*\\b(?:FIXED|SATISFIED)\\b`, 'i'),
  };
}

function firstMarkerLine(body, n) {
  const flat = body.replace(/\s+/g, ' ');
  const bullets = bulletMarks(n);
  for (const state of ['bulletPartial', 'bulletFixed']) {
    if (bullets[state].test(flat)) return { state, line: flat.slice(0, 120) };
  }
  for (const line of body.split(/\r?\n/)) {
    for (const [state, re] of Object.entries(MARK)) {
      if (state.startsWith('bullet')) continue;
      if (re.test(line)) return { state, line };
    }
  }
  return null;
}

function classify(bug, openSet) {
  const t = bug.body.replace(/\s+/g, ' ');
  const h = bug.head;
  const s = statusLine(bug.body);
  const mark = s ? null : firstMarkerLine(bug.body, bug.n);
  const say = (re) => re.test(t);

  // The 40-character window is deliberate and was widened to 300 once, which
  // immediately misread BUG-001 ("✅ CLOSED via BUG-026's fix … live-verified
  // working") as a duplicate because the word appeared much later in the line.
  if (/duplicate of BUG/i.test(h) || /^[^.]{0,40}duplicate/i.test(s)) return 'duplicate';
  // SUPERSEDED points at another entry, which is what `duplicate` already means
  // here; inventing a seventh state would change the register's shape for two rows.
  if (/^[^.]{0,40}SUPERSEDED/i.test(s) || /\bSUPERSEDED\b/.test(h)) return 'duplicate';
  if (openSet.has(bug.n)) return 'open';
  if (mark && MARK_OPEN.has(mark.state)) return 'open';

  // MITIGATED is a shipped change that bounds a defect it does not remove. It is
  // closer to fixed than to anything else and is stated as a status by its author.
  const fixed = /✅/.test(h) || /\bFIXED\b/.test(h) || /\bRESOLVED\b/.test(h)
    || /✅/.test(s) || /\b(FIXED|RESOLVED|VERIFIED|MITIGATED|CLOSED)\b/i.test(s)
    || (mark && MARK_FIXED.has(mark.state));
  if (fixed) {
    const proven = say(/mutation-proven/i) || say(/0 survived/i);
    const live = say(/live-?verified/i) && !say(/NOT (?:yet )?live-?verified/i);
    return (proven || live) ? 'verified' : 'fixed';
  }
  if (/🔍/.test(h) || /\bMEASURED\b/.test(h) || /\bDIAGNOSED\b/.test(h)
    || /🔍/.test(s) || /\b(DIAGNOSED|MEASURED)\b/i.test(s)
    || (mark && mark.state === 'diagnosed')) {
    return 'diagnosed';
  }
  if (/🔧/.test(h) || /\bCODED\b/.test(h)
    || /🔧/.test(s) || /\bCODED\b/i.test(s)
    || (mark && mark.state === 'coded')) {
    return 'coded';
  }
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
    // BUG-346 sweep: SATISFIED belongs in this vocabulary. BUG-344's bullet reads
    // "VERIFIED-SATISFIED 2026-08-24: live boot logged websearch.not-installed
    // with the remedy" — a closure stated in the register itself, which the
    // register then went on reporting as open work for four days. Checked before
    // adding: it is the only occurrence of the word in the section, and it is not
    // negated, so this cannot close a bullet that says it was NOT satisfied.
    if (/\bFIXED\b|\bRESOLVED\b|\bCLOSED\b|\bSATISFIED\b/i.test(block)) continue;
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
