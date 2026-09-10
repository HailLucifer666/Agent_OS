'use strict';

// test/refusal-is-actionable.test.js — the assertion for a class this repo has
// now broken THREE times.
//
// THE CLASS: a tool call is refused, the refusal suggests a next step, and the
// model cannot take that step. It has been fixed twice as an instance and come
// back both times:
//
//   BUG-099 — browser_navigate refused a wrong-browser request and said "call
//             browser_launch_debug with browser:brave". browser_launch_debug was
//             not in the Live allowlist, so the spoken path could not call it.
//   BUG-107 — the same refusal's next remedy, browser_switch, was withheld too;
//             live-tools.js records it as "the same 'a hint naming an
//             unreachable tool is not a remedy' gap BUG-099 fixed".
//   BUG-435 — 2026-09-10 18:21Z. The named-browser refusal suggested
//             browser_launch_debug, which had ALREADY run and connected twenty
//             seconds earlier. Reachable, but already satisfied — unfollowable
//             for a different reason, with the same outcome: the model retried
//             the refused call four times and no page ever opened.
//
// Two of the three are mechanically checkable, and this file checks them. The
// house rule is explicit about when to stop patching instances: same invariant
// broken twice, write the assertion and put it somewhere that runs repeatedly.
//
// WHAT THIS CANNOT SEE, said plainly so a green run is not misread. It cannot
// tell that a reachable tool's step is already DONE — that is BUG-435's variant,
// it depends on runtime state, and the only guard against it is a behavioural
// test per refusal (bug-435-one-browser-route-per-turn.test.js's (k) is the
// worked example). It also cannot judge whether prose is persuasive. It answers
// exactly one question: can the model reach what it was told to call.
//
// MUTATION RUN 2026-09-11, each applied to the real source, verified present,
// and restored sha256-identical:
//   remedy() pointed at a TIER_TABLE tool that is not allowlisted  -> (a) red
//   a withheld tool named inside the refusal message               -> (b) red
//   DEFAULT_ALLOWLIST exported as []                               -> (a)(b)(c) red
//
// THE SECOND MUTATION SURVIVED TWICE BEFORE (b) WAS ANY GOOD, and both survivals
// are the reason this file is shaped as it is:
//   1st — (b) also required a refusal marker ("NOT run", "cannot", "instead") in
//         the SAME string literal. The guard builds its message by concatenation,
//         so the marker and the tool name are in different literals and nothing
//         matched. The test was vacuous on the file it was written for.
//   2nd — after widening, the key pattern still demanded a quote directly after
//         `message:`. The guard writes `message: head + '...'`, an identifier.
//         Still blind, still green.
// A guard cannot be trusted because it passes. It can be trusted once it has been
// made to fail on purpose, which is the only reason the two defects above were
// found before this shipped rather than in the next incident.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { DEFAULT_ALLOWLIST, VOICE_ALLOWLIST_EXEMPT } = require('../src/core/voice/live-tools');

// Where a refusal can be built. Both directories, because the route guard that
// broke this lives in voice/ and the ones that got it right live in effectors/.
const DIRS = ['src/core/voice', 'src/core/effectors'].map((d) => path.join(__dirname, '..', d));

// A tool the spoken path can actually call. VOICE_ALLOWLIST_EXEMPT names the
// ones deliberately withheld — a remedy pointing at one of those is exactly the
// BUG-099 defect, so exempt tools are NOT treated as reachable here.
const reachable = new Set(DEFAULT_ALLOWLIST);
const TOOLS = Object.keys(TIER_TABLE);

function sources() {
  const out = [];
  for (const dir of DIRS) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      out.push({ file: path.relative(path.join(__dirname, '..'), path.join(dir, f)).replace(/\\/g, '/'),
        text: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n') });
    }
  }
  return out;
}

// Strip comments before looking for advice: a comment explaining a past bug may
// legitimately name a withheld tool, and failing on prose ABOUT the rule instead
// of prose that BREAKS it is how a guard gets deleted for crying wolf.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// The model-facing prose in this repo is always the value of one of four keys.
// Scanning only those, rather than every quoted run in the file, is deliberate:
// a whole-file string scan cannot tell a literal from an apostrophe in code, and
// the existing prose ratchet demonstrates the cost — its from-dashboard.js entry
// is a mis-lexed span covering most of the file. This walk starts at a known key,
// tracks quotes and escapes, and stops at the end of that property, so a
// mis-parse is contained to one value instead of running to the end of the file.
// No lookahead for an opening quote, and the 2026-09-11 mutation run is why:
// browser-route-guard.js builds its message as `head + '...literal...'`, so the
// character after `message:` is an identifier. Requiring a quote there made this
// test blind to the one file it was written for — the mutation that renamed the
// tool inside that message survived twice before this line was widened.
const ADVICE_KEYS = /\b(message|result|description|text)\s*:\s*/g;
function adviceValues(src) {
  const out = [];
  for (const m of src.matchAll(ADVICE_KEYS)) {
    let i = m.index + m[0].length;
    let value = '';
    // A property value may be a concatenation of literals and identifiers; keep
    // the literal parts, skip the rest, and stop at the comma or brace that ends
    // the property while not inside a string.
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === ',' || c === '}' || c === ';') break;
      if (c !== '"' && c !== "'" && c !== '`') continue;
      const quote = c;
      i += 1;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === quote) break;
      }
      if (i >= src.length) break; // unterminated: give up on this property, not the file
      value += src.slice(start, i);
    }
    if (value.length >= 12) out.push({ key: m[1], value });
  }
  return out;
}

describe('a refusal must name something the model can actually call', () => {
  test('(a) every remedy() names an allowlisted tool, not merely a real one', () => {
    // remedy() already throws on a tool that is not in TIER_TABLE. That is a
    // weaker check than it looks: TIER_TABLE holds every tool in the system,
    // including the ones deliberately kept away from the spoken surface. The
    // gap between "is a tool" and "is a tool the voice can reach" is precisely
    // where BUG-099 and BUG-107 lived.
    const bad = [];
    for (const { file, text } of sources()) {
      for (const m of stripComments(text).matchAll(/\bremedy\(\s*'([a-z0-9_]+)'/g)) {
        if (!reachable.has(m[1])) bad.push(file + ' -> remedy(' + m[1] + ')');
      }
    }
    assert.deepEqual(bad, [], 'a remedy the spoken path cannot call is not a remedy — allowlist it in live-tools.js or point elsewhere');
  });

  test('(b) any prose that tells the model to call a tool names a reachable one', () => {
    // The other half. The prose is what the model actually reads — BUG-435's
    // refusal put its tools ONLY in structured fields and the model ignored them
    // entirely, so prose is not decoration here, it is the working channel.
    //
    // WRITTEN TOO NARROW FIRST, AND THE MUTATION IS WHY THIS COMMENT EXISTS. The
    // original version also required a refusal marker ("NOT run", "cannot",
    // "instead") in the SAME string literal. Nothing in browser-route-guard.js
    // matched: its refusal is built by concatenation, so the marker sits in one
    // literal and the tool name in another. The 2026-09-11 mutation that renamed
    // browser_navigate to a withheld tool inside the refusal message SURVIVED —
    // this test was vacuous on the exact file it was written for.
    // The narrowing was never load-bearing anyway: "prose that names a tool to
    // call must name one the model can reach" is true of a description as much
    // as a refusal, and it is the rule BUG-099 and BUG-107 both state.
    const bad = [];
    for (const { file, text } of sources()) {
      for (const { key, value } of adviceValues(stripComments(text))) {
        if (!/\b(?:call|use|try|retry)\b/i.test(value)) continue;
        for (const tool of TOOLS) {
          if (!new RegExp('\\b' + tool + '\\b').test(value)) continue;
          if (!reachable.has(tool)) bad.push(file + ' (' + key + '): names ' + tool + ' — "' + value.slice(0, 80) + '"');
        }
      }
    }
    assert.deepEqual(bad, [], 'prose naming a withheld tool sends the model somewhere it cannot go');
  });

  // CHANNEL COUNT: 1 OF 3. Tests (a) and (b) ask "is this tool in
  // DEFAULT_ALLOWLIST" — the CURATION channel. That is a cheaper question than
  // the one that matters, which is "can the model call it right now", and the
  // gap between them is not theoretical. Both passed green while the 2026-09-10
  // attended session died in the second channel.
  //
  // A tool can be kept from the model by THREE independent mechanisms:
  //   1. curation      — DEFAULT_ALLOWLIST / LIVE_TOOL_ALLOWLIST  (a) and (b)
  //   2. availability  — tool-capability.js's snapshot             (d), below
  //   3. desktop mode  — conversationToolAllowed() in live-declarations.js
  // A guard that reads one and reports on all three fails open, which is the
  // failure mode it was hired to prevent.
  //
  // (3) is not asserted here and that is stated rather than hidden: it applies
  // only when DESKTOP_OPERATOR_ENABLED is on (`!desktop || conversationToolAllowed`),
  // which is off by default and was off on the machine that produced the
  // incident, so it has never been the withholding channel in evidence. Closing
  // it needs the desktop-connection allowlist in scope; filed, not faked.
  test('(d) a remedy must be DECLARABLE, not merely allowlisted — the second channel', () => {
    // WHY WORST CASE. buildSetup() rebuilds declarations once per socket, so a
    // session that opens with an adapter down keeps that tool list until it
    // rotates. The list a refusal's remedy has to survive is therefore the one
    // built when NOTHING is up — that is the frozen list, and it is what the
    // model was holding when it launched a browser it could not then drive.
    const { buildFunctionDeclarations } = require('../src/core/voice/live-tools');
    const { buildCapabilitySnapshot } = require('../src/core/voice/tool-capability');
    const offline = { getStatus: () => ({ state: 'OFFLINE' }) };
    const worstCase = buildCapabilitySnapshot({
      config: {}, adapters: { browser: offline, cua: offline, pcChild: offline, android: offline },
    });

    // WHAT IS IN SCOPE HERE, and the first version of this test got it wrong.
    // It gathered names from BOTH remedy() calls and advice prose, and flagged
    // cua_click, cua_list_windows and desktop_task_status. Those are tool
    // DESCRIPTIONS naming sibling tools ("Pass pid or window_id from
    // cua_list_windows"), and they are not the defect: the advisor and the
    // advised share a capability rule, so when cua is down BOTH are withheld and
    // the advice never reaches the model at all. Dead advice needs a LIVE
    // speaker.
    //
    // remedy() calls are different in exactly that way. They live in guard code
    // in src/core/voice/, which runs whatever the adapters are doing — the route
    // guard refused open_web and handed back browser_navigate while
    // browser_navigate was undeclared. Live speaker, dead advice. That is the
    // set this test selects, derived from the distinction rather than from a
    // list of files.
    //
    // Description-to-description advice comes into scope the moment an advisor
    // and its advised tool fall under DIFFERENT capability rules. Nothing in the
    // tree does today; if that changes, extend this to pair each name with its
    // owning tool and flag only where the owner is declared and the named one is
    // not.
    const named = new Set();
    for (const { text } of sources()) {
      for (const m of stripComments(text).matchAll(/\bremedy\(\s*'([a-z0-9_]+)'/g)) named.add(m[1]);
    }
    assert.ok(named.size >= 3, 'found only ' + named.size + ' remedy tools — the scan is not reaching the sources');

    const hub = { catalog: () => [...named].map((n) => ({ name: n, description: 'x', params: {} })) };
    const built = buildFunctionDeclarations(hub, { allowlist: DEFAULT_ALLOWLIST, capability: worstCase });
    const declarable = new Set(built.declarations.map((d) => d.name));
    const unreachable = [...named].filter((n) => reachable.has(n) && !declarable.has(n));
    assert.deepEqual(unreachable, [],
      'these tools are allowlisted but NOT declared when their adapter is down, so a refusal naming '
      + 'them leaves the model with advice it cannot take for the rest of the session — mark the '
      + 'capability rule selfHealing if a step in the session can clear it, or stop naming the tool');
  });

  test('(c) the two lists this file depends on are real, so a green run means something', () => {
    // A guard that reads an empty allowlist passes everything. This repo has the
    // lesson on record as "gates can pass on metrics they cannot read".
    assert.ok(reachable.size > 50, 'DEFAULT_ALLOWLIST looks empty or unreadable: ' + reachable.size);
    assert.ok(TOOLS.length > 100, 'TIER_TABLE looks empty or unreadable: ' + TOOLS.length);
    assert.ok(Array.isArray(VOICE_ALLOWLIST_EXEMPT), 'the withheld list must exist for the distinction above to mean anything');
    // And the scan must actually be reaching files, not an empty directory.
    const files = sources();
    assert.ok(files.length > 20, 'the source scan found only ' + files.length + ' files');
    assert.ok(files.some((f) => f.file.endsWith('browser-route-guard.js')), 'the file that broke this must be in scope');
  });
});
