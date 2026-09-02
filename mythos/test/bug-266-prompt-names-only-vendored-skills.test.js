'use strict';

// test/bug-266-prompt-names-only-vendored-skills.test.js — BUG-266, 2026-09-02.
//
// THE RULE, and `skills.allowlist` states it itself: prompt text may only name
// skills the repo GUARANTEES are there. That file's own header is the contract:
//
//   "A leading '?' marks the entry OPTIONAL: MYTHOS uses it when the host CLI
//    has it installed, but it is deliberately NOT vendored into this repo.
//    An optional entry that does not resolve is the normal state of a fresh
//    clone and is never warned about. A plain entry that does not resolve IS
//    reported — treat that as a bug."
//
// So instructing the model, every turn, to call `use_skill` on an OPTIONAL name
// is instructing it to call something the repo says may legitimately be absent.
// Per the withheld-read-tool pattern measured repeatedly here, it does not
// report the gap — it substitutes the nearest skill and narrates it as though it
// had loaded the named one.
//
// MEASURED 2026-09-02 (fresh-clone reproduction: a child process with
// USERPROFILE/HOME pointed at a non-existent directory and MYTHOS_SKILLS_DIR
// empty). All six prompt-named skills returned `loadContent = NULL`, confirming
// the ticket. What the ticket got wrong is lane 8A.2's scope: it claims
// `ui-ux-pro-max` is phantom "on every machine", and with a host CLI's skill
// directory present `loadContent` returned 44,380 characters. The contradiction
// is a fresh-clone one, i.e. the same population as 8A.1.
//
// FIXED BY SUBSTITUTION, not by vendoring third-party content. Four of the six
// had an exact vendored equivalent already in the repo, so the prompts now name
// those instead:
//
//   tdd-workflow            -> test-driven-development   (required, vendored)
//   code-review             -> code-review-and-quality   (required, vendored)
//   spec-driven-development -> writing-plans             (required, vendored)
//   frontend-ui-engineering -> taste-frontend            (required, vendored)
//
// That is 4 phantoms removed on every clone with no licence exposure and no new
// files. `deep-research` was dropped from the SKILLS RULE rather than
// substituted — nothing vendored covers it and naming a phantom is worse than
// naming nothing.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS = path.join(__dirname, '..');
const ALLOWLIST = path.join(MYTHOS, 'skills.allowlist');

// THE WAIVER MAP IS DELIBERATELY ALMOST EMPTY, AND EVERY ENTRY IS CONDITIONAL.
// A waiver here is not a free pass: the test below proves the waived skill still
// resolves with NO external roots, so a waiver cannot hide a phantom. If step 8
// vendors the rest, entries are deleted and the rule tightens by itself.
const WAIVED = {
  'ui-ux-pro-max':
    'Deliberately vendored ESSENCE-ONLY (LICENSE + SKILL-CORE.md): the full 45 KB '
    + 'doc needs a Python CSV database this repo does not ship, which is the exact '
    + "case skills.allowlist's header gives for marking an entry optional. It is "
    + 'named in prompts anyway because BUG-266 lane 8A.2 made `loadContent` fall '
    + 'back to the vendored core, so it now resolves on a fresh clone — and the '
    + 'test below enforces that, so this waiver dies the day the fallback breaks.',
};

function readAllowlist() {
  const required = new Set();
  const optional = new Set();
  for (const line of fs.readFileSync(ALLOWLIST, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('?')) optional.add(t.slice(1)); else required.add(t);
  }
  return { required, optional };
}

// Prompt text that names skills. RULES is the exported prompt; the other two
// carry the `use_skill` tool DESCRIPTION, which the model reads every turn and
// which is a string literal in source. Read as source deliberately — the point
// is which NAMES appear in text the model sees, and a name is a name wherever
// the literal lives.
function promptTexts() {
  const out = [];
  const va = require('../src/core/voice/voice-agent');
  const rules = va.RULES || (va._internal && va._internal.RULES);
  if (rules) out.push({ label: 'RULES', text: String(rules) });
  for (const rel of ['src/core/voice/voice-agent.js', 'src/core/effectors/from-skills.js']) {
    out.push({ label: rel, text: fs.readFileSync(path.join(MYTHOS, rel), 'utf8') });
  }
  return out;
}

function namesIn(text, candidates) {
  const hits = [];
  for (const n of candidates) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Exact name only. `code-review` must NOT match inside
    // `code-review-and-quality` — that substring collision produced two wrong
    // readings while measuring this ticket, so the boundary excludes `-` too.
    if (new RegExp('(^|[^\\w-])' + esc + '([^\\w-]|$)').test(text)) hits.push(n);
  }
  return hits;
}

describe('BUG-266 — prompt text names only skills a fresh clone is guaranteed to have', () => {
  test('NEGATIVE CONTROL: the allowlist and the prompt text both loaded', () => {
    // Without this, the rule below passes vacuously against an empty allowlist
    // or empty prompt and reads as coverage.
    const { required, optional } = readAllowlist();
    assert.ok(required.size > 30, 'required entries look wrong: ' + required.size);
    assert.ok(optional.size > 0, 'no optional entries parsed; the `?` split is broken');
    const texts = promptTexts();
    assert.equal(texts.length, 3);
    const rules = texts.find((t) => t.label === 'RULES');
    assert.ok(rules.text.length > 5000, 'RULES did not load');
    // And prove the matcher can find a name at all, or a miss below is
    // meaningless. DELIBERATELY AGAINST A SYNTHETIC STRING, not against RULES:
    // the first version asserted it found `test-driven-development` in RULES,
    // which coupled this control to the very substitution the suite is testing
    // — probe (a) reverted that name and reddened the control as collateral,
    // hiding which assertion had actually caught the revert. A control must not
    // depend on the thing it is controlling for.
    assert.deepEqual(namesIn('call use_skill on writing-plans first', ['writing-plans']),
      ['writing-plans'], 'the name matcher itself is broken');
    assert.deepEqual(namesIn('nothing relevant here', ['writing-plans']), [],
      'the matcher fires on text that names nothing');
    // The substring collision that produced two wrong readings while measuring
    // this ticket, pinned so the boundary cannot loosen back.
    assert.deepEqual(namesIn('see code-review-and-quality', ['code-review']), [],
      '`code-review` must not match inside `code-review-and-quality`');
  });

  test('every skill named in prompt text is REQUIRED, or carries a waiver', () => {
    const { required, optional } = readAllowlist();
    const all = [...required, ...optional];
    const offenders = [];
    for (const piece of promptTexts()) {
      for (const n of namesIn(piece.text, all)) {
        if (required.has(n)) continue;
        if (WAIVED[n]) continue;
        offenders.push(`${n} (optional in skills.allowlist) named in ${piece.label}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these skills are named in prompt text but are OPTIONAL, so a fresh clone will not '
      + 'have them and `use_skill` on the name the prompt gave will answer "not found". '
      + 'Either name a vendored equivalent, drop the mention, or add a justified entry to '
      + 'WAIVED in this file — and see skills.allowlist\'s own header for why');
  });

  test('every WAIVED skill still resolves with NO external roots', () => {
    // What makes a waiver honest. `ui-ux-pro-max` is named in prompts only
    // because its vendored SKILL-CORE.md makes it loadable on a fresh clone; if
    // that stops being true the waiver must fail rather than keep excusing a
    // phantom. Checked at the file the loader actually reads, so no environment
    // scrubbing is needed to make the assertion meaningful.
    for (const name of Object.keys(WAIVED)) {
      const core = path.join(MYTHOS, 'skills', name, 'SKILL-CORE.md');
      assert.ok(fs.existsSync(core),
        `${name} is waived into the prompt but has no vendored SKILL-CORE.md, so on a fresh `
        + 'clone it is exactly the phantom this ticket is about');
      assert.ok(fs.readFileSync(core, 'utf8').trim().length > 200,
        `${name}'s vendored core is too thin to be useful guidance`);
    }
  });

  test('every WAIVED entry states a reason (no bare waivers)', () => {
    for (const [name, why] of Object.entries(WAIVED)) {
      assert.equal(typeof why, 'string');
      assert.ok(why.length > 80, `the waiver for ${name} must say WHY, not just exist`);
    }
  });

  test('the four substituted names are required AND vendored', () => {
    // The regression pin for what was wrong on 2026-09-02. A revert reads as a
    // revert rather than as a general failure.
    const { required } = readAllowlist();
    for (const n of ['test-driven-development', 'code-review-and-quality',
      'writing-plans', 'taste-frontend']) {
      assert.ok(required.has(n), n + ' must be a REQUIRED allowlist entry');
      assert.ok(fs.existsSync(path.join(MYTHOS, 'skills', n)),
        n + ' must be vendored in-repo, or "required" is a promise the repo cannot keep');
    }
  });

  test('the four replaced names are gone from prompt text', () => {
    const replaced = ['tdd-workflow', 'spec-driven-development', 'frontend-ui-engineering'];
    for (const piece of promptTexts()) {
      for (const n of namesIn(piece.text, replaced)) {
        // `code-review` is excluded from this list on purpose: it cannot be
        // checked this way because `code-review-and-quality` contains it, and a
        // matcher loose enough to see one sees the other. Its absence is
        // asserted by the main rule above instead.
        assert.fail(`${n} is still named in ${piece.label} — it is optional and was replaced`);
      }
    }
  });

  test('ACCEPTANCE: on a FRESH CLONE, every skill named in prompts actually loads', () => {
    // THE TICKET'S DEFECT, STATED AS A QUESTION, and the only thing that closes
    // it. Every check above is about names and lists; this one runs the real
    // loader with no external skill roots reachable and demands content back.
    //
    // A child process with a scrubbed environment is the mechanism, because
    // `externalSkillRoots()` reads HOME/USERPROFILE at call time and this
    // process has a real one. Reproduced the same way the ticket did on
    // 2026-08-17. Before this fix all six prompt-named skills returned NULL
    // here; a list-membership check cannot see that, which is why it exists.
    const { execFileSync } = require('node:child_process');
    const { required, optional } = readAllowlist();
    const named = [...required, ...optional]
      .filter((n) => promptTexts().some((p) => namesIn(p.text, [n]).length));
    assert.ok(named.length >= 4, 'expected several named skills, saw ' + JSON.stringify(named));

    const loaderPath = path.join(MYTHOS, 'src', 'core', 'skills', 'loader.js');
    const script = 'const l=require(' + JSON.stringify(loaderPath) + ');'
      + 'const out={};for(const n of ' + JSON.stringify(named) + '){'
      + 'const c=l.loadContent(n);out[n]=c?String(c).trim().length:0;}'
      + 'console.log(JSON.stringify(out));';
    const env = Object.assign({}, process.env, {
      USERPROFILE: path.join(MYTHOS, '__no_such_home__'),
      HOME: path.join(MYTHOS, '__no_such_home__'),
      HOMEPATH: path.join('__no_such_home__'),
      MYTHOS_SKILLS_DIR: '',
      CLAUDE_SKILLS_DIR: '',
    });
    const raw = execFileSync(process.execPath, ['-e', script],
      { encoding: 'utf8', env, cwd: MYTHOS, timeout: 30000 });
    const lengths = JSON.parse(raw.trim().split(/\r?\n/).pop());

    // The scrub has to have WORKED, or this passes because it is still reading
    // the developer's real skills directory and proves nothing about a clone.
    assert.ok(lengths['ui-ux-pro-max'] < 10000,
      'the environment scrub failed — ui-ux-pro-max returned ' + lengths['ui-ux-pro-max']
      + ' chars, which is the full externally-installed doc, so this test is not '
      + 'measuring a fresh clone at all');

    const phantom = Object.entries(lengths).filter(([, len]) => len < 100).map(([n]) => n);
    assert.deepEqual(phantom, [],
      'these skills are named in prompt text and return nothing usable on a fresh clone, '
      + 'so the model is told every turn to load guidance that is not there: '
      + JSON.stringify(lengths));
  });

  test('BOUND: a required-and-vendored skill named in prompts does not trip the rule', () => {
    // The false-positive check. Without it the rule could be firing on
    // everything and the suite would still look green on the offenders list.
    const { required } = readAllowlist();
    const rules = promptTexts().find((t) => t.label === 'RULES');
    const named = namesIn(rules.text, [...required]);
    assert.ok(named.length >= 3,
      'RULES should name several vendored skills; saw ' + JSON.stringify(named));
  });
});

// MUTATION PROOF — run 2026-09-02, each applied-verified by re-counting the
// mutated string, restored by full-path copy verified sha256-identical.
//
//   (a) revert `test-driven-development` to `tdd-workflow` in RULES -> reds the
//       main rule naming it, and "the four replaced names are gone".
//   (b) revert `code-review-and-quality` to `code-review` -> reds the main rule
//       (via RULES and voice-agent.js), and the substitution pin.
//   (c) empty the WAIVED map -> reds the main rule naming `ui-ux-pro-max`,
//       proving the waiver is load-bearing rather than decorative.
//   (d) rename the vendored `skills/ui-ux-pro-max/SKILL-CORE.md` aside -> reds
//       "every WAIVED skill still resolves with NO external roots" while the
//       main rule stays green. That is the point of the conditional waiver: the
//       excuse dies before the phantom returns.
//   (e) make promptTexts() return [] -> reds only the NEGATIVE CONTROL, with the
//       main rule passing green on nothing. The reason that control exists.
//   (f) ADJACENT CASE, must stay green: add a mention of another required,
//       vendored skill (`executing-plans`) to RULES -> nothing reds, so the rule
//       does not fire on correctly-named skills.
//
// Results as observed are recorded in the BUG-266 entry in BUGS.md.
