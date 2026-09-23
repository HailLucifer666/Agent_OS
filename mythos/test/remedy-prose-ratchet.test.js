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
const { TIER_TABLE } = require('../src/core/leash/tiers');
// BUG-435 follow-up (2026-09-16): src/core/voice joined the scan. Its guards
// refuse calls and name tools in prose too (browser-route-guard.js is the one
// BUG-435's repair note flagged as "outside the ratchet, held to it by hand").
// Measured before widening: 11 sites, recorded below by content hash like the
// rest. Keys stay bare filenames; the guard test below proves no name is shared
// between the two directories, so the flat map cannot be ambiguous.
const DIRS = [path.join(__dirname, '../src/core/effectors'), path.join(__dirname, '../src/core/voice')];
const PROSE_BASELINE = {
  "browser-route-guard.js": ["8b98d7bb25a915f2"],
  "claim-check.js": ["331fa7dc114f198f"],
  "narration-claims.js": ["d98c73994603d126"],
  "turn-audit-notices.js": ["2516cec7e56c2064"],
  "voice-agent.js": ["0389baa340c47aa1", "a769c4ee72490ffc", "8266b6bf213bc2b9", "37bb0d112fd86208", "829d84f969b61a66", "e498939cf2a8d0b0", "57ac9c3a016ac87a"],
  "browser-intent-remedy.js": [
    "49a97d7d71bc722c",
    "50518bdca0531d56"
  ],
  "browser-target.js": [
    "e28da3b6159edf95"
  ],
  "from-android.js": [
    "45dbd21b86f3109c",
    "a7d09bd610728999"
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
    "92609290b800395b"
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
    "19bc0806640b90b2",
    "1adc7b106a487c93",
    "e09870975d9f1611",
    "da227a0c1b53dbd5",
    "8e0298bb1ac1d826",
    "63c728c55fedf326",
    "16840d9d2521158e",
    "4fcfad525cdbccbd",
    "d2d12fb7a10a1b68",
    // 2026-09-11, BUG-435: was "22546be8773c0393". A SWAP, not an addition —
    // from-dashboard.js holds 18 recorded sites before and after; only the
    // content of this one changed, because open_web's description was edited to
    // stop telling the model to pass browserName for a named browser (the
    // instruction the route guard refuses, and the root cause of the 18:21Z
    // four-refusal loop).
    // WHAT THIS ENTRY ACTUALLY IS, since the hash hides it: not a string. The
    // scanner's lexer opens a quote it cannot close and swallows a span covering
    // most of the file — 23 trigger verbs and 32 tool names, beginning mid-way
    // through a comment. So ANY edit to from-dashboard.js rehashes it, and it
    // can never be removed by rewording. That makes it a poor guard on this file
    // and it should be split or the lexer taught about apostrophes; filed rather
    // than fixed here, because re-baselining the scanner while repairing a
    // regression is how a measurement gets adjusted to fit a result.
    // Net across both files this commit: 35 recorded sites -> 34.
    "e705dca568dfd4e8"
  ],
  "from-desktop.js": [
    "458175d1e982f809"
  ],
  "from-memory.js": [
    "b71a6e6ef0158eaf",
    "9358477ca0a7cc55",
    "f133837a748af9ea"
  ],
  "from-pc.js": [
    "059cedc981388d7f",
    "53064c650ac240b7",
    "c5aa7c5cbc0fa800",
    "5a9c34c38d64387f",
    "6b78d2c777ff3d14",
    "25d8db1367a1b965",
    "6c2bd2fd6ff1cc9b",
    "c206a455ff88c2ca",
    "9ca368ba70bcec8e",
    "13a2bfc237f6a526",
    "08ed606029ae8c3c"
  ],
  "from-runner.js": [
    "761881b9148f56cc"
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
  "web-search.js": [
    "59110f0d052dbca5"
  ],
  "window-recovery.js": [
    "fd8def33381464cd"
  ]
};

function adviceStrings(source) {
  const found = [];
  for (let i = 0; i < source.length; i++) {
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    const quote = source[i];
    if (!['"', "'", '`'].includes(quote)) continue;
    const start = i++;
    for (; i < source.length; i++) { if (source[i] === '\\') { i++; continue; } if (source[i] === quote) break; }
    const text = source.slice(start + 1, i);
    if (!/\b(?:call|use|try|retry)\b/i.test(text)) continue;
    if (!Object.keys(TIER_TABLE).some(tool => new RegExp('\\b' + tool + '\\b').test(text))) continue;
    // A result/text string immediately beside a constructed remedy already
    // carries a call, so it does not require a prose exception.
    if (/^\s*,\s*remedy\s*:\s*remedy\(/.test(source.slice(i + 1))) continue;
    found.push(crypto.createHash('sha256').update(text).digest('hex').slice(0, 16));
  }
  return found;
}
function inventory() {
  const out = {};
  for (const dir of DIRS) {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      // Review 2026-09-10: two Android literals span lines, so the raw hash carried the
      // checkout's line ending — recorded from a CRLF worktree, red on an LF clone and CI.
      const entries = adviceStrings(fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n'));
      if (entries.length) out[file] = (out[file] || []).concat(entries);
    }
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

test('tool-call prose debt never grows', () => {
  const extra = [];
  for (const [file, hashes] of Object.entries(inventory())) {
    const allowed = [...(PROSE_BASELINE[file] || [])];
    for (const hash of hashes) { const i = allowed.indexOf(hash); if (i < 0) extra.push(file + ':' + hash); else allowed.splice(i, 1); }
  }
  assert.deepEqual(extra, [], 'use evidence.remedy(tool, args, why) beside refusal text; do not grow PROSE_BASELINE');
});
module.exports = { inventory, adviceStrings };
