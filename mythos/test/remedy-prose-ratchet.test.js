'use strict';
// BUG-425, 2026-09-10. New tool-call advice in a refusal must be structured.
// Existing prose sites are recorded by content (not line), so moves do not
// create a waiver. The baseline can shrink; additions require fixing the site.
// This lexical scan includes descriptions too, deliberately stricter than the
// minimum: new prose that teaches a tool call has the same argument-copy risk.
// Mutation 2026-09-10: add an unstructured refusal naming browser_navigate -> red.
// Same-date probe restores the unrelated-nearby-remedy waiver; fixture fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { TIER_TABLE } = require('../src/core/leash/tiers');
// BUG-435 follow-up (2026-09-16): src/core/voice joined the scan. Its guards
// refuse calls and name tools in prose too (browser-route-guard.js is the one
// BUG-435's repair note flagged as "outside the ratchet, held to it by hand").
// Measured before widening: 11 sites, recorded below by content hash like the
// rest. Keys stay bare filenames; the guard test below proves no name is shared
// between the two directories, so the flat map cannot be ambiguous.
const DIRS = [path.join(__dirname, '../src/core/effectors'), path.join(__dirname, '../src/core/voice')];
// RE-RECORDED 2026-09-24, once, when the lexer learned regex literals and
// template substitutions (see lexSpans). Measured with the old and new lexer over
// the same tree: 96 recorded sites -> 90. Six files changed; the other 17 hash
// byte-identically before and after, so this is not a general reshuffle.
//   from-dashboard.js 18 -> 15. Ten entries leave: all were code spans (from the
//     backtick in /[;&|`$()<>^]/ at ~line 631 to the end of the file), including
//     "229a5b530dea374a", the 22,796-char span that began in a comment. Seven
//     real descriptions arrive: open_web's own ("1f257f50ce13702a", the one that
//     says "use browser_navigate"), navigate, open_artifact, the hardware-facts
//     tool, camera_look, camera_on, and the camera-off refusal. Eight unchanged.
//   voice-agent.js 7 -> 9. Five leave (fragments from the apostrophe in
//     NEGATIVE_RE's don'?t at line 37 onward); seven real tool descriptions
//     arrive (navigate, close_panel, the hardware-facts tool, the goal delegate,
//     the multi-file build, remember, forget). The RULES block and LOCAL CLOCK
//     are unchanged.
//   from-android.js 2 -> 0, from-runner.js 1 -> 0, web-search.js 1 -> 0,
//     claim-check.js 1 -> 0. Every one was a code span behind a regex holding a
//     quote. None of those files holds an advice literal.
// Net: no new advice was written. Fourteen sites were always there and invisible;
// twenty "sites" were never strings (96 - 20 + 14 = 90).
const PROSE_BASELINE = {
  "browser-route-guard.js": ["8b98d7bb25a915f2"],
  "narration-claims.js": ["d98c73994603d126"],
  "turn-audit-notices.js": ["2516cec7e56c2064"],
  // 2026-09-23, BUG-445: was "e498939cf2a8d0b0". A SWAP, not an addition — still
  // 7 sites. The hashed literal is the whole RULES block; its BROWSER INTERACTION
  // RULE now says browser_snapshot LISTS items with a ref like e12 (it no longer
  // returns a tree of [ref=e12] markers), which rehashes the block. No new advice.
  // 2026-09-24, BUG-459: three more SWAPS, not additions — each file keeps its
  // site count (voice-agent 7, from-dashboard 18, from-computer 8), measured
  // before and after. voice-agent.js "4ef68331d4e70f3f" -> "22e41c1daa991f8c" is
  // the RULES block again (BROWSER RULE: "open_web opens nothing" corrected).
  // from-computer.js "92609290b800395b" -> "05a12d3d27dcab6a" is think_deeply's
  // description, trimmed under the 1024-char Live cut. from-dashboard.js
  // "e705dca568dfd4e8" -> "229a5b530dea374a" was NOT open_web's description: the
  // scanner was out of step with that file. Fixed the same day; see the
  // re-record note above PROSE_BASELINE.
  "voice-agent.js": ["546e8539819af7cd", "3c25f643cceb0fa2", "9a5dd0e1c98de8df", "e0db23954e414057", "b72f6edd1d69ff40", "4a3a5e322bdd6733", "908e621b116a6dcc", "22e41c1daa991f8c", "57ac9c3a016ac87a"],
  "browser-intent-remedy.js": [
    "49a97d7d71bc722c",
    "50518bdca0531d56"
  ],
  "browser-target.js": [
    "e28da3b6159edf95"
  ],
  "from-browser.js": [
    "a975b9905d7d2947",
    "4616d8dcdc63d207",
    "2b2c515678c7e7e2",
    "6284118b408d0d90",
    "c3be4c619e019f7c",
    "7724a1b4e9afb9c6",
    "21d46ff38ac0986d",
    "8965740324ad39b6",
    "78b0a15b6f60706b",
    "ed3abd6be9a23ed6",
    "715c7f0a93be94fc",
    "05adcb641de58fab",
    "6d280d04e5a96480",
    "9a5e2c5afe9d4077",
    "d6786399ff45e777",
    "8d6a3a768e5b668c"
  ],
  // 2026-09-11, BUG-435. "968a83af42c67649" was browser_launch_debug's
  // description. Its only trigger verb ("Use when the user asks...") is now
  // "For when...", so the site leaves the inventory entirely rather than being
  // re-recorded: 17 sites in this file, now 16. Removals need no waiver.
  "from-calendar.js": [
    "8d2dcf7a97928856",
    "c8d8190cd3986a1b",
    "f486563d8a299dcf"
  ],
  "from-computer.js": [
    "71e2bec2aa22f70c",
    "bfdfd4be06a391b3",
    "09f5a40ee7100b7c",
    "09080c48eaf359ed",
    "e299246974cda7c0",
    "52f45bb33bb4f0c9",
    "b4b209450216ba82",
    "05a12d3d27dcab6a"
  ],
  "from-cua.js": [
    "609c393db0a597b0",
    "793f16fcf11e8d31",
    "0c8dba7adedbba40",
    "bd0ffbbcc6e9929a",
    "c4b46617ce9e7240",
    "0a6dde98c9bc672c",
    "53800ce7a8fcd53c"
  ],
  "from-dashboard.js": [
    "2c760bc3e3c5687a",
    "eac3216010582e3d",
    "a421def947e484b3",
    "488493dced5847d4",
    "f93aa4b47fef67ed",
    "c66c1c5a23142e85",
    "c23975ac085b0403",
    "6724cb9544588cf0",
    // 2026-09-24 re-record: the seven below were invisible until the lexer skipped
    // the regex at ~line 631. "1f257f50ce13702a" is open_web's description.
    "8359dcb70bf1cafc",
    "6b803bbdf16cdd30",
    "1f257f50ce13702a",
    "d36978994381b270",
    "1226202c7948d34d",
    "b72a6d62f8a330fe",
    "c6c2d2b30dcd3e4d"
  ],
  "from-desktop.js": [
    "458175d1e982f809"
  ],
  "from-memory.js": [
    "b71a6e6ef0158eaf",
    "9358477ca0a7cc55",
    "f133837a748af9ea"
  ],
  // B2a (2026-09-29): launch_app moved to launch-app.js, taking one recorded
  // site with it (53064c650ac240b7, "Call list_windows..."), and its tool
  // description was reworded (c5aa7c5cbc0fa800 -> 6644f2adef2c4283: it now also
  // names open_file/open_web for paths and links, and says approval is asked for;
  // then -> 5ab9e18a9e50a07c, the review's fix: its example "code" became
  // "calculator", because an unreviewed app now asks for approval).
  // Same count; the two new refusals carry structured remedies and are exempt.
  "launch-app.js": [
    "53064c650ac240b7"
  ],
  "from-pc.js": [
    "059cedc981388d7f",
    "5ab9e18a9e50a07c",
    "5a9c34c38d64387f",
    "6b78d2c777ff3d14",
    "25d8db1367a1b965",
    "6c2bd2fd6ff1cc9b",
    "c206a455ff88c2ca",
    "9ca368ba70bcec8e",
    "13a2bfc237f6a526",
    "08ed606029ae8c3c"
  ],
  "from-skills.js": [
    "65266bcfb3983575"
  ],
  "from-spotify.js": [
    "fe8c593c734928aa"
  ],
  "open-external-route.js": [
    "57276ae7662e8743",
    "3a40639759c6bffa"
  ],
  "ui-target.js": [
    "188f75b50a69d42a",
    "fe40c5688b4af858",
    "0769ef5e681129db",
    "99cfcbaa025ecc39",
    "2562a86dc9c023fe",
    "d5daf7bada6efe3f"
  ],
  "window-recovery.js": [
    "fd8def33381464cd"
  ]
};

// 2026-09-24. The lexer. Its one job is to find string and template literals.
// The first version walked quote to quote, so a quote character inside a REGEX
// literal opened a phantom string: /[;&|`$()<>^]/ in from-dashboard.js opened a
// "template" at its backtick, and don'?t in voice-agent.js opened a string at its
// apostrophe. From there each file was out of step — the scan hashed code spans
// between two quotes and missed real strings (open_web's own description among
// them). Nothing reported it: a desynced span hashes as happily as a string.
// So this one skips regex literals (a `/` opens one wherever an operand is
// expected, the rule JS itself uses), walks `${...}` as code so a quote inside a
// substitution belongs to the substitution, and throws rather than guess when a
// quoted string reaches a raw newline, which in valid JS it cannot.
// Returns top-level spans { kind, start, end } (end exclusive), in source order.
const WORDS_BEFORE_AN_OPERAND = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
function lexSpans(source) {
  const spans = [];
  let i = 0;
  let operandExpected = true;
  const outOfStep = what => new Error('lexer out of step: ' + what + ' at line ' + source.slice(0, i).split('\n').length);
  function quoted(quote) {
    for (i++; source[i] !== quote; i++) {
      if (i >= source.length || source[i] === '\n') throw outOfStep('unterminated string');
      if (source[i] === '\\') i++;
    }
    i++;
  }
  function template() {
    for (i++; source[i] !== '`'; i++) {
      if (i >= source.length) throw outOfStep('unterminated template');
      if (source[i] === '\\') i++;
      else if (source.startsWith('${', i)) { i += 2; code(true); }
    }
    i++;
  }
  function regex() { // false, with i unchanged, when this `/` cannot open a regex
    const start = i;
    let inClass = false;
    for (i++; source[i] !== '/' || inClass; i++) {
      if (i >= source.length || source[i] === '\n') { i = start; return false; }
      if (source[i] === '\\') i++;
      else if (source[i] === '[') inClass = true;
      else if (source[i] === ']') inClass = false;
    }
    for (i++; /[a-z]/i.test(source[i] || ''); i++);
    return true;
  }
  function token() { // one token from i; returns its span kind, or null
    const c = source[i];
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) i = source.length; return 'comment'; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) throw outOfStep('unterminated comment'); i = end + 2; return 'comment'; }
    if (c === '/' && operandExpected && regex()) { operandExpected = false; return 'regex'; }
    if (c === '"' || c === "'") { quoted(c); operandExpected = false; return 'string'; }
    if (c === '`') { template(); operandExpected = false; return 'template'; }
    const word = /^[\w$\u0080-\uffff]+/.exec(source.slice(i, i + 64));
    if (word) { i += word[0].length; operandExpected = WORDS_BEFORE_AN_OPERAND.has(word[0]); return null; }
    if (/\s/.test(c)) { i++; return null; }
    const pair = source.slice(i, i + 2);
    if (pair === '++' || pair === '--') { i += 2; operandExpected = false; return null; }
    i++;
    operandExpected = c !== ')' && c !== ']';
    return null;
  }
  function code(inSubstitution) {
    let depth = 0;
    while (i < source.length) {
      if (source[i] === '}' && inSubstitution && depth === 0) return;
      if (source[i] === '{') depth++; else if (source[i] === '}') depth--;
      const start = i;
      const kind = token();
      if (kind && !inSubstitution) spans.push({ kind, start, end: i });
    }
    if (inSubstitution) throw outOfStep('unterminated ${');
  }
  code(false);
  return spans;
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
function adviceStrings(source) {
  const found = [];
  for (const { kind, start, end } of lexSpans(source)) {
    if (kind !== 'string' && kind !== 'template') continue;
    const text = source.slice(start + 1, end - 1);
    if (!/\b(?:call|use|try|retry)\b/i.test(text)) continue;
    if (!Object.keys(TIER_TABLE).some(tool => new RegExp('\\b' + tool + '\\b').test(text))) continue;
    // A result/text string immediately beside a constructed remedy already
    // carries a call, so it does not require a prose exception.
    if (/^\s*,\s*remedy\s*:\s*remedy\(/.test(source.slice(end))) continue;
    found.push(sha(text));
  }
  return found;
}
// The lexer is in step with a file when blanking every span it found leaves a
// program V8 still compiles. A span that began mid-token, or a regex taken for a
// division (or the reverse), cuts real code apart and the compile fails.
function blankSpans(source) {
  let out = '', at = 0;
  for (const { kind, start, end } of lexSpans(source)) {
    const body = source.slice(start, end);
    const blank = kind === 'comment' ? body.replace(/[^\n]/g, ' ')
      : kind === 'regex' ? '/x/' + /[a-z]*$/i.exec(body)[0]
      : body[0] + body[0];
    out += source.slice(at, start) + blank;
    at = end;
  }
  return out + source.slice(at);
}
function scannedSources() {
  return DIRS.flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith('.js'))
    // Review 2026-09-10: two Android literals span lines, so the raw hash carried the
    // checkout's line ending — recorded from a CRLF worktree, red on an LF clone and CI.
    .map(file => ({ file, source: fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n') })));
}
function inventory() {
  const out = {};
  for (const { file, source } of scannedSources()) {
    const entries = adviceStrings(source);
    if (entries.length) out[file] = (out[file] || []).concat(entries);
  }
  return out;
}
test('the scanned directories share no filename, so the flat baseline keys are unambiguous', () => {
  const seen = new Map();
  for (const dir of DIRS) for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    assert.ok(!seen.has(f), f + ' exists in both ' + seen.get(f) + ' and ' + dir + ' — key the baseline by relative path before adding it');
    seen.set(f, dir);
  }
});
// Mutation 2026-09-16: `const PROBE = 'Call browser_navigate to fix it.';` added to
// src/core/voice/claim-check.js -> "tool-call prose debt never grows" red with
// claim-check.js:<hash>; restored sha256-identical. Before the widening the same
// probe was invisible to this file.
test('only a sibling remedy exempts refusal prose', () => {
  assert.equal(adviceStrings("return { result: 'Call browser_navigate.', remedy: remedy('browser_navigate', {}, 'why') };").length, 0);
  assert.equal(adviceStrings("return { result: 'Call browser_navigate.' }; const other = { remedy: remedy('browser_navigate', {}, 'why') };").length, 1);
});

// 2026-09-24. Each shape below put the first lexer out of step in a real file.
// Each fixture expects EXACTLY the advice string, so a lexer that drops it, or
// that hashes a span around it instead, is red either way.
// Mutations 2026-09-24, each applied once by exact replacement, run, restored from
// a copy and verified sha256-identical; each reddened the tests named:
//   regex literals never recognised -> the regex fixture, "in step", "never grows"
//   ${...} not walked as code       -> the template fixture, "in step"
//   every word expects an operand   -> the division fixture, "in step"
//   ++/-- rule removed              -> the division fixture
//   ) and ] expect an operand       -> the division fixture, "in step"
//   no keyword expects an operand   -> the regex fixture, "in step"
//   raw newline in a string allowed -> the raw-newline test
// Probes on from-dashboard.js, same date, same restore: `const PROBE = 'Call
// browser_navigate to fix it.';` at the top, inside read_status, inside
// camera_look and at the bottom -> "never grows" red with exactly
// from-dashboard.js:bce46cf5f9722c2d, the probe's own hash (the old lexer went red
// for three of those four by rehashing a code span instead). Prefixing open_web's
// description with "PROBE. " -> red with exactly the reworded text's hash, computed
// from the source by anchors, not by this lexer. Pure code edits — the regex at
// ~631, a statement in read_status, one in camera_look, voice-agent.js's
// NEGATIVE_RE, a trailing comma in its navigate entry -> all green; the old lexer
// rehashed a recorded site on four of the five.
test('a regex holding a quote or a backtick opens no string (from-dashboard.js, voice-agent.js)', () => {
  const advice = 'Use browser_navigate for a page you must read.';
  const source = "if (/[;&|`$()<>^]/.test(p)) return;\nconst NO = /\\b(?:don'?t|stop)\\b/i;\nfunction q(x) { return /'/.test(x); }\nconst d = { description: '" + advice + "' };\n";
  assert.deepEqual(adviceStrings(source), [sha(advice)]);
});
test('a template substitution is code, so its quotes and backticks are its own', () => {
  const advice = 'Call browser_navigate with the url.';
  const source = "const t = `a ${ok ? `it's` : ''} b`;\nconst s = '" + advice + "';\n";
  assert.deepEqual(adviceStrings(source), [sha(advice)]);
});
test('a division is not a regex', () => {
  const advice = 'Use browser_navigate.';
  // A `/` wrongly read as a regex runs to the next `/` on the line, swallowing the string.
  for (const left of ['a', 'n++', '(a + b)', 'xs[0]']) {
    assert.deepEqual(adviceStrings('const r = ' + left + " / 2; const s = '" + advice + "'; const q = c / d;"), [sha(advice)], left);
  }
});
test('a quoted string that reaches a raw newline is reported, not hashed', () => {
  assert.throws(() => lexSpans("const s = 'abc\nconst t = 1;"), /lexer out of step: unterminated string at line 1/);
});
test('the lexer is in step with every scanned file', () => {
  for (const { file, source } of scannedSources()) {
    assert.doesNotThrow(() => vm.compileFunction(blankSpans(source)), file);
  }
});

test('tool-call prose debt never grows', () => {
  const extra = [];
  for (const [file, hashes] of Object.entries(inventory())) {
    const allowed = [...(PROSE_BASELINE[file] || [])];
    for (const hash of hashes) { const i = allowed.indexOf(hash); if (i < 0) extra.push(file + ':' + hash); else allowed.splice(i, 1); }
  }
  assert.deepEqual(extra, [], 'use evidence.remedy(tool, args, why) beside refusal text; do not grow PROSE_BASELINE');
});
module.exports = { inventory, adviceStrings, lexSpans };
