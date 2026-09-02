'use strict';

// test/bug-267-prompt-names-only-declared-tools.test.js — BUG-267, 2026-09-02.
//
// THE RULE, and it is derived rather than listed: every REGISTERED tool name
// that appears in the text of the Live system instruction must be declared to
// Live. If the prompt names it, the spoken surface can reach it.
//
// WHY A RULE AND NOT THREE FIXES. The ticket named exactly one instance —
// `use_skill` — and its own justification was much wider: "the primary spoken
// surface receives a catalogue of 43 skills plus an instruction to call a
// function that was never declared to it." Measured 2026-09-02, that one had
// ALREADY been fixed (promoted out of VOICE_ALLOWLIST_EXEMPT on 2026-08-21 and
// pinned in voice-allowlist-curation-audit-2026-08-21.test.js), and the entry
// was never updated. Deriving the set from the reason instead found three the
// ticket never mentioned, each sitting beside a sibling that WAS declared:
//
//   mission_status     T0, read-only. RULES' INFORMATIONAL TOOLS RULE lists it
//                      among lookups to call in the same turn — beside
//                      read_status, list_goals, job_status, pipeline_status,
//                      kanban_status, get_time, get_weather, all declared.
//   run_mission        T3 + NEVER_TRUSTABLE. Named beside start_project and
//                      build_project, both declared; start_project is also
//                      NEVER_TRUSTABLE, so that combination was already
//                      precedent rather than a new risk.
//   browser_fill_form  T3. RULES says "Pass that ref to browser_click,
//                      browser_type or browser_fill_form" and only the third
//                      was missing.
//
// This is the BUG-171 shape ("the model can act but has no reachable way to
// verify what it acted on") pointed the other way: the model is told to act
// through a door that is not there. Per the withheld-read-tool pattern this
// repo has measured repeatedly, it does not report the gap — it substitutes the
// nearest tool and narrates it as though it had used the named one.
//
// A HAND-KEPT LIST WOULD BE THE SAME OMISSION SCHEDULED FOR THE NEXT PROMPT
// EDIT. The property that identifies a member of this set is "a registered tool
// name occurring in prompt text", so the test selects on that: it reads the real
// tier table for the tool names, the real prompt constants for the text, and
// diffs. Adding a tool name to RULES tomorrow is checked the same day.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
const tiers = require('../src/core/leash/tiers');

// The system's own list of registered tools, not a copy of it.
const TIER_TABLE = tiers.TIER_TABLE
  || (tiers._internal && tiers._internal.TIER_TABLE);

// Every string constant that reaches buildLiveSystemInstruction()'s `parts`.
// Collected by TYPE from the modules that own them rather than named one by
// one, so a new prompt constant is covered without editing this list.
function promptPieces() {
  const pieces = [];
  const push = (label, text) => {
    if (typeof text === 'string' && text.length > 40) pieces.push({ label, text });
  };
  const va = require('../src/core/voice/voice-agent');
  push('RULES', va.RULES || (va._internal && va._internal.RULES));
  for (const mod of ['live-tool-adapter', 'narration-claims']) {
    const m = require('../src/core/voice/' + mod);
    for (const k of Object.keys(m)) push(mod + '.' + k, m[k]);
  }
  const loader = require('../src/core/skills/loader');
  try {
    if (typeof loader.catalogBlock === 'function') push('catalogBlock', loader.catalogBlock());
  } catch (_) { /* a machine with no skills dir contributes no text; not a failure */ }
  return pieces;
}

describe('BUG-267 — the Live prompt names only tools the Live path can call', () => {
  test('NEGATIVE CONTROL: the tier table and the prompt text both loaded', () => {
    // Without this, every assertion below passes vacuously against an empty
    // table or an empty prompt and reads as coverage. This repo has shipped
    // exactly that shape before.
    assert.ok(TIER_TABLE && Object.keys(TIER_TABLE).length > 100,
      'the tier table did not load; the check below would compare against nothing');
    const pieces = promptPieces();
    assert.ok(pieces.length >= 3, 'expected several prompt constants, saw ' + pieces.length);
    const rules = pieces.find((p) => p.label === 'RULES');
    assert.ok(rules && rules.text.length > 5000,
      'RULES is the bulk of the prompt and must be present, saw ' + (rules ? rules.text.length : 0));
    // And the check must be capable of firing: prove it finds tool names at all.
    assert.ok(/\bweb_search\b/.test(rules.text),
      'the matcher found no known tool name in RULES, so a miss below would be meaningless');
  });

  test('every registered tool named in the prompt is declared to Live', () => {
    const allow = new Set(DEFAULT_ALLOWLIST);
    const names = Object.keys(TIER_TABLE);
    const offenders = [];
    for (const piece of promptPieces()) {
      for (const name of names) {
        if (!new RegExp('\\b' + name + '\\b').test(piece.text)) continue;
        if (allow.has(name)) continue;
        offenders.push(`${name} (tier ${TIER_TABLE[name]}) named in ${piece.label}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these tools are named in the Live prompt but were never declared to Live, so the '
      + 'model is instructed to call a function it does not have. Either declare them in '
      + 'DEFAULT_ALLOWLIST or stop naming them in the prompt — and per the '
      + 'withheld-read-tool pattern the model will NOT report the gap, it will substitute '
      + 'the nearest tool and narrate it');
  });

  test('the three promoted by this ticket are declared, and their tiers are unchanged', () => {
    // Named explicitly as a regression pin. The derived check above is the
    // forward guard; this is the record of what was wrong on 2026-09-02, so a
    // revert is legible as a revert rather than as a general failure.
    for (const name of ['mission_status', 'run_mission', 'browser_fill_form']) {
      assert.ok(DEFAULT_ALLOWLIST.includes(name), name + ' must be reachable from Live');
    }
    // DECLARING IS NOT RE-TIERING, and this is the assertion that says so.
    // Promoting a name onto the Live allowlist makes it callable; the leash
    // still decides whether the call proceeds. If a later change tried to buy
    // convenience by lowering one of these tiers, that is a different and much
    // larger decision and it fails here.
    assert.equal(tiers.tierOf('mission_status'), 0, 'read-only, and must stay so');
    assert.equal(tiers.tierOf('run_mission'), 3);
    assert.equal(tiers.tierOf('browser_fill_form'), 3);
  });

  test('use_skill — the instance the ticket named — is still reachable', () => {
    // It was fixed on 2026-08-21 and the ticket was never updated, which is how
    // this ended up looking open for twelve days. Pinned here too so the
    // ticket's own claim has a test attached to it rather than only a comment.
    assert.ok(DEFAULT_ALLOWLIST.includes('use_skill'),
      'the skills catalogue in the Live prompt instructs calling use_skill by name');
  });
});

// MUTATION PROOF — run 2026-09-02, each applied-verified by re-counting the
// mutated string, restored by full-path copy verified sha256-identical.
//
//   (a) remove 'mission_status','run_mission' from DEFAULT_ALLOWLIST
//       -> reds "every registered tool named in the prompt is declared" naming
//          both, and "the three promoted by this ticket are declared".
//   (b) remove 'browser_fill_form' -> reds the same two, naming it.
//   (c) remove 'use_skill' -> reds the derived check AND the use_skill test,
//       which is the proof the derived check really covers the ticket's own
//       instance rather than only the three found later.
//   (d) NEGATIVE-CONTROL PROBE: make promptPieces() return [] -> reds the
//       negative control, NOT the main check. That is the point of it: without
//       it, an empty prompt would make the main assertion pass on nothing.
//   (e) ADJACENT CASE, must stay green: add a tool name to a prompt constant
//       that IS declared (e.g. mention web_fetch in a claim string) -> nothing
//       reds, so the rule does not fire on correctly-declared mentions.
//
// Results as observed are recorded in the BUG-267 entry in BUGS.md.
