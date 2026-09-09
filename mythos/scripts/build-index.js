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

// BUG-394 mechanism 1 — AN ENTRY ENDS AT THE NEXT TOP-LEVEL SECTION, not at the
// next BUG heading.
//
// Before this, an entry ran to the next `# BUG-` heading and the final one ran to
// `text.length`. BUG-273 is the last `## BUG-` heading in BUGS.md, so the whole
// `## OPEN WORK filed` register and every `## Session (...)` section after it was
// read as BUG-273's body — its status was computed partly from other tickets'
// bullets, and appending anything to the end of the file changed it. That is not
// theoretical: it turned a test red on 2026-08-28 while BUG-273 itself never
// changed.
//
// EXACTLY TWO HASHES, AND THE COUNT IS THE WHOLE FIX. The first draft stopped at
// the next heading of ANY depth (`#{1,6}`) and that is much worse than the bug:
// entries own their own `###` subsections, so it cut BUG-273 at its own
// "### Evidence — measured, not inferred" and discarded 89,125 characters
// including its mutation proof, and BUG-278 at its own "### Root cause 1". 46
// entries shrank and 7 changed state, four of them by losing evidence they had
// written themselves. With `##` it is 18 entries and 3 state changes — the
// figures the ticket filed. Found by inspecting the changes by hand, which is
// what the ticket says to do, and NOT by counting them, which is what looked
// fine.
//
// THIS PATTERN DELIBERATELY DOES NOT EXCLUDE BUG HEADINGS, and the first draft
// did. It carried `(?!BUG-\d)` as well, which read like the load-bearing half and
// was not: bug headings are removed from `sections` BY POSITION below
// (`!bugAt.has(at)`), using the offsets the entry scan already produced, and that
// is both exact and unavoidable. Mutation probe (c), 2026-09-02: deleting the
// lookahead reddened NOTHING — 12/12 still passed — which is how it was found.
// Two guards for one property, one of them unreachable, is worse than one: the
// dead one reads as defence to the next reader while its test passes forever
// proving nothing. Removed rather than kept as a backstop, and the position
// filter is what the regression test now attacks.
const SECTION_BOUNDARY_RE = /^## [^\n\r]*/gm;

function parseBugs(text) {
  const marks = [...text.matchAll(/^#{1,6} BUG-(\d+)([^\n\r]*)/gm)]
    .map((m) => ({ n: +m[1], head: m[2], at: m.index }));

  // Every top-level heading offset, INCLUDING bug entries' own headings — and
  // that is deliberate rather than sloppy.
  //
  // Two drafts of this line filtered bug headings out, first with a `(?!BUG-\d)`
  // lookahead in the pattern and then with a `!bugAt.has(at)` position check.
  // Mutation probes (c) on 2026-09-02 deleted each in turn and reddened NOTHING,
  // twice, and the reason is that the property is guaranteed by the `Math.min`
  // below: `nextBug` is already the offset of the next bug heading, so a bug
  // heading in this list can only ever tie with it and never win. Both guards
  // were unreachable by construction.
  //
  // They are gone rather than kept as backstops. Two mechanisms for one property
  // with one unreachable is worse than one: the dead half reads as live defence
  // to the next reader while its test passes forever proving nothing. The
  // regression test for this property is honest that it holds by construction
  // and that no mutation can reach it.
  const sections = [...text.matchAll(SECTION_BOUNDARY_RE)].map((m) => m.index);

  const seen = new Set();
  const out = [];

  marks.forEach((m, i) => {
    if (seen.has(m.n)) return;
    seen.add(m.n);
    const nextBug = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const nextSection = sections.find((at) => at > m.at);
    const end = Math.min(nextBug, nextSection === undefined ? text.length : nextSection);
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
  // BUG-394 step 3 — the gap no other bug number may cross, adopted from
  // bulletHalfDone below where it was already proven. Applied to bulletPartial
  // and bulletFixed TOGETHER: the ticket's whole reason for holding these in one
  // change is that tightening either alone flips the winner between them, and on
  // 2026-08-28 that would have reported the live licence ticket BUG-274 as done.
  //
  // MEASURED 2026-09-02 BEFORE CHANGING IT, in all four cells of
  // {bounding on/off} x {tight on/off}: BUG-274, BUG-275 and BUG-394 read `open`
  // in every one. Step 1 (an explicit Status line on 274 and 275, plus a register
  // declaration for both) is what removed the hazard, so this is now safe.
  //
  // AND IT CHANGES NOTHING TODAY — 0 of 237 entries move. That is the honest
  // description: this is a FORWARD guard against the class returning, not a
  // repair of a present misreading, and a test asserting "the real file is
  // unaffected" would pass vacuously. The regression tests use synthetic
  // fixtures for exactly that reason.
  const gap = '(?:(?!BUG-\\d)[^\\n])*';
  return {
    bulletPartial: new RegExp(`${id}${gap}\\bFIXED\\b${gap}\\bNOT\\s+yet\\b`, 'i'),
    // SATISFIED reads the same as FIXED here, and for the same reason it was
    // added to openSetFrom's closure vocabulary: BUG-344's bullet states
    // "VERIFIED-SATISFIED 2026-08-24" and nothing could read it. Leaving it out
    // would move that entry from wrongly-open to wrongly-unrecorded, which is
    // trading one false report for another.
    bulletFixed: new RegExp(`${id}${gap}\\b(?:FIXED|SATISFIED)\\b`, 'i'),
    // BUG-393 — the same half-done shape as bulletPartial, for openSetFrom.
    //
    // IT USED TO BE TIGHTER IN TWO WAYS AND NOW IT IS TIGHTER IN ONE. The gap
    // guard it pioneered — `(?:(?!BUG-\d)[^\n])*` rather than `[^\n]*`, so no
    // OTHER bug number may sit between this bullet's id and its qualifier — is
    // now shared by all three patterns via `gap` above, which is BUG-394 step 3.
    // This comment previously described a difference that no longer exists;
    // corrected rather than left standing, because a confident wrong comment
    // outlives the code.
    //
    // What still differs is the CLOSURE VOCABULARY, and that is not cosmetic:
    // openSetFrom's filter closes on any of FIXED/RESOLVED/CLOSED/SATISFIED, so
    // a pattern meant to hold that filter back must recognise every word the
    // filter acts on, or it holds back one case in four.
    bulletHalfDone: new RegExp(
      `${id}(?:(?!BUG-\\d)[^\\n])*\\b(?:FIXED|RESOLVED|CLOSED|SATISFIED)\\b`
      + '(?:(?!BUG-\\d)[^\\n])*\\bNOT\\s+yet\\b',
      'i',
    ),
  };
}

// BUG-394 mechanism 2 and its third sighting — A BULLET'S MARKER IS READ FROM
// THAT BULLET'S OWN BLOCK, and a bullet must start a line.
//
// Two defects, one shape, and scoping fixes both at once instead of guarding
// each:
//
//   THE FLATTENED BODY. The patterns used to run against the whole body with
//   every newline collapsed, so `[^\n]*` spanned nested follow-up lines and the
//   marker word could be drawn from a `- BUG-nnn` bullet about a DIFFERENT
//   ticket. Measured on the real file, that is how BUG-273 and BUG-274 both drew
//   a marker from someone else's bullet.
//
//   THE ARROW. The id anchor is `[-*]\s*BUG-0*<n>\b` and an ASCII arrow
//   satisfies it. Writing `brain calls=1  <- BUG-278 measured 1` inside BUG-278's
//   own entry made the `-` of `<-` read as a bullet marker, and BUG-278
//   classified `open` immediately after being live-verified. Nothing in the entry
//   was a bullet. 27 entries currently carry a dash before a bug id on a line
//   that does not start with one.
//
// SO THE BAD STATE IS MADE UNREPRESENTABLE RATHER THAN DETECTABLE. Find lines
// that START with a bullet naming THIS entry, take that bullet's own block
// (itself plus its continuation lines, via the same blockAt the pointer path
// uses), and test the marker inside it. Another bullet's marker is then not
// something the pattern can reach, rather than something a lookahead has to
// notice. The block flatten is kept because it is load-bearing for a different
// reason the file already records: a wrapped bullet states the qualifier two
// lines down ("...**COUNTER FIXED …;\n the README catalog table and pie are NOT
// yet generated**"), and reading line by line closes a ticket on the half that
// landed.
//
// THE `(?!BUG-\d)` GAP IS STILL NOT REDUNDANT, and this is worth stating because
// it looks it. Scoping excludes a SEPARATE bullet about another ticket; it does
// nothing about one bullet that mentions two ids — `- BUG-274 — see BUG-345,
// which is FIXED` is a single block, and only the gap guard stops BUG-345's
// marker being read as BUG-274's. Both are kept, deliberately.
const BULLET_LINE_RE = /^\s{0,8}[-*]\s+BUG-0*(\d+)\b/;

function ownBulletBlocks(body, n) {
  const lines = body.split(/\r?\n/);
  const blocks = [];
  let offset = 0;
  for (const line of lines) {
    const m = BULLET_LINE_RE.exec(line);
    if (m && Number(m[1]) === n) blocks.push(blockAt(body, offset).replace(/\s+/g, ' '));
    offset += line.length + 1;
  }
  return blocks;
}

function firstMarkerLine(body, n) {
  const bullets = bulletMarks(n);
  const blocks = ownBulletBlocks(body, n);
  for (const state of ['bulletPartial', 'bulletFixed']) {
    for (const block of blocks) {
      if (bullets[state].test(block)) return { state, line: block.slice(0, 120) };
    }
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

  // BUG-398 R11 (2026-09-02): NEGATIVE-FIRST ON THE STATUS LINE. The MARK table
  // above opens with "Order matters: every negative is tested before the positive
  // it contains" — and the Status-line path below never honoured that intent, so
  // prose beat an explicit marker sitting in the same sentence.
  //
  // MEASURED, live: a status line reading "🔴 PARTIALLY FIXED — row 1 closed,
  // the rest still open" was classified **fixed**, because /\bFIXED\b/ matches
  // inside "PARTIALLY FIXED" and nothing looked at the 🔴. The register then
  // reported a partially-fixed ticket as done — and the register is what a new
  // session reads to know what is outstanding.
  //
  // Scope was measured before changing anything: across all 248 entries exactly
  // ONE status line carries 🔴 together with a positive word (the one above).
  // Two entries whose prose mentions leftovers ("Not done, ...", "which is
  // still ...") carry no 🔴 and are genuinely fixed — they are untouched, which
  // is the false-positive case this rule must not fire on.
  //
  // NOT a complete fix for the prose-matching class. The underlying defect is
  // that ANY of these words ANYWHERE in the status line still means fixed, so a
  // cross-reference like "section 0 (verified working — do not break)" can still
  // close a ticket by accident. The real remedy is an explicit machine-readable
  // state field, or bounding this match the way the `duplicate` check above is
  // bounded to 40 characters. This closes only the half where the author DID
  // write an unambiguous marker and it was ignored.
  const statusSaysNotDone = /🔴/.test(s)
    || /^[^.]{0,40}\bPARTIAL(?:LY)?\b/i.test(s)
    || /^[^.]{0,40}\bNOT\s+(?:yet\s+)?(?:FIXED|STARTED|DONE|IMPLEMENTED)\b/i.test(s);
  if (statusSaysNotDone) return 'open';

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
    // BUG-393 — a half-done bullet states BOTH halves, so the closure filter and
    // classify's bulletPartial read one set of words and reached two verdicts:
    // this filter saw FIXED and dropped the ticket from the authoritative open
    // set, while classify saw "FIXED ... NOT yet" and called it open. Nothing
    // compared them, and BUG-352 sat contradicting itself for a day.
    //
    // The alignment is one-way on purpose. openSetFrom is an ADDITIVE override
    // (`if (openSet.has(n)) return 'open'` below), so keeping a half-done bullet
    // in the set can only move an entry toward open. Teaching classify to honour
    // the closure filter instead would have closed a half-done ticket on the
    // strength of the half that landed — precisely the failure bulletPartial was
    // built to stop.
    const n = +m[1];
    const halfDone = bulletMarks(n).bulletHalfDone.test(block);
    if (!halfDone && /\bFIXED\b|\bRESOLVED\b|\bCLOSED\b|\bSATISFIED\b/i.test(block)) continue;
    set.add(n);
  }
  return { set, section: true };
}

// ---------------------------------------------------------------------------

function campaignAssessments(text) {
  const headings = [...text.matchAll(/^### Individual declared-ticket dispositions\s*$/gm)];
  if (headings.length !== 1) return new Map();
  const tail = text.slice(headings[0].index + headings[0][0].length);
  const section = tail.split(/^#{1,6} /m)[0];
  const lines = section.split(/\r?\n/);
  const cells = (line) => line.trim().split(/(?<!\\)\|/).slice(1, -1).map((s) => s.trim().replace(/\\\|/g, '|'));
  const header = lines.findIndex((line) => cells(line).join('|') ===
    'Ticket|Recorded state|Campaign disposition|Current evidence / missing proof|Candidate test or source');
  if (header < 0 || !/^\|(?:\s*:?-+:?\s*\|){5}$/.test((lines[header + 1] || '').trim())) return new Map();
  const allowed = new Set(['currently reproduced', 'currently verified', 'disproved', 'duplicate', 'superseded', 'blocked']);
  const result = new Map(), seen = new Set();
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith('|')) break;
    const row = cells(line), id = /^BUG-(\d+)$/.exec(row[0] || '');
    if (!id) continue;
    const n = Number(id[1]);
    // Conflicting/duplicate rows are not a trustworthy campaign assessment.
    if (seen.has(n)) { result.delete(n); continue; }
    seen.add(n);
    if (row.length !== 5 || !allowed.has(row[2]) || !row[3] || !row[4]) continue;
    result.set(n, { disposition: row[2], evidence: row[3], source: row[4] });
  }
  return result;
}

function assertConsistentStatus(bug) {
  // Current Status paragraph only: history and unresolved siblings are valid.
  const paragraph = (bug.body.match(/^\*\*Status:\*\*[^\n]*(?:\n(?!\s*\n)[^\n]+)*/m) || [''])[0].replace(/\*/g, '');
  const states = new Map();
  const lists = /\b(H\d+(?:(?:,\s*|\s+(?:and|or)\s+)H\d+)*)\s+(?:(?:are|is|remain|remains|still|genuinely)\s+)*(closed|open)\b/gi;
  for (const match of paragraph.matchAll(lists)) {
    for (const id of match[1].toUpperCase().match(/H\d+/g)) {
      const state = match[2].toLowerCase();
      if (states.has(id) && states.get(id) !== state) throw new Error('BUG-' + bug.n + ' ' + id + ' is both closed and open in its Status paragraph');
      states.set(id, state);
    }
  }
}

function buildRegister(deps = {}) {
  const text = deps.bugsText ?? fs.readFileSync(BUGS_FILE, 'utf8');
  const { set: openSet, section } = openSetFrom(text);
  const campaign = campaignAssessments(text);

  // Guard the guard. An empty open set would make every "is it covered" check
  // pass vacuously, which is the shape that has bitten this repo twice.
  if (!section) throw new Error('build-index: BUGS.md has no "## OPEN WORK filed" section — '
    + 'refusing to publish a register whose open set would be empty by accident.');

  const bugs = parseBugs(text).map((b) => {
    assertConsistentStatus(b);
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
    if (campaign.has(b.n)) row.campaign = campaign.get(b.n);
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

module.exports = { parseBugs, classify, openSetFrom, buildRegister, campaignAssessments, readIsland, generate, main, STATES };

if (require.main === module) process.exit(main(process.argv.slice(2)));
