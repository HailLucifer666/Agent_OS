'use strict';

// test/effector-failure-reason-class.test.js — BUG-378. THE CLASS ASSERTION for
// "a failure path that discards its reason".
//
// WHY THIS FILE EXISTS RATHER THAN A FOURTH PATCH
//
// This defect has now been found four times and the first three were each fixed
// by hand at the site where they were noticed:
//
//   1. BUG-101   — `{ok:false, error:'why'}` reached consumers that read only
//                  `.result`, so the operator was told a bare "Failed."
//                  Patched in effectors/adapter.js (the mirror this file drives).
//   2. P2-12     — dispatch-action.js's audit `reason` was `String(result.result)`,
//                  which wrote the literal "[object Object]" for an object shape.
//                  Patched with a local reasonText().
//   3. B5        — seven effectors' own catch blocks built `err.message || err`.
//                  reasonText() extracted to util/reason-text.js and applied.
//
// Each patch was correct and each left the CLASS open, because the invariant was
// never written down anywhere a commit could fail against it. The fourth instance
// (found 2026-08-27, measured below) was inside adapter.js itself — the file that
// fixed the first one.
//
// THE INVARIANT, stated once, for all registered tools:
//
//   When a tool fails, the reason that reaches the audit trail is a non-empty
//   string a human can act on. Never absent, never empty, never "[object Object]",
//   never "{}", and never a reason that existed inside the effector and was
//   dropped on the way out.
//
// WHAT THIS FILE COVERS AND WHAT IT DOES NOT
//
// Covers: the ONE seam every registered tool's failure passes through. Measured
// 2026-08-27 — all 29 files in src/core/effectors register exclusively via
// `hub.register(effectorFromTool(...))`, with zero direct registrations, so
// adapter.js's invoke() plus dispatch-action.js's audit write is a genuine choke
// point and not merely the common case. Part A pins that choke point shut, so the
// walk in Part B cannot be made vacuous by a future direct registration.
//
// Does NOT cover: the wording of any individual tool's own failure messages.
// Part B substitutes each tool's `fn` rather than calling it, deliberately —
// really invoking every tool would run `run_command`, `move_file` and `ui_type`
// for real. So this asserts that whatever a tool reports survives the journey,
// not that the tool reports something sensible in the first place.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { effectorFromTool } = require('../src/core/effectors/adapter');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { computeEffectorTools, createInertCtx } = require('../scripts/sync-test-count.js');
const { reasonText, DEAD_REASON_TEXT } = require('../src/core/util/reason-text');

const SRC_DIR = path.join(__dirname, '..', 'src');
const EFFECTOR_DIR = path.join(SRC_DIR, 'core', 'effectors');

// ---------------------------------------------------------------------------
// What "a human can act on" means, as code rather than as prose.
//
// The bar is deliberately low: this is not a style check on failure messages, it
// is a check that information EXISTS. Every string below was observed in the
// operator's real audit trail (%APPDATA%/MYTHOS/vault/Audit) on a fail row, and
// each one told the reader nothing whatsoever about what went wrong.
// DERIVED, never re-typed. This was a second hand-written copy of the list in
// util/reason-text.js — the "denylist where a rule belongs" shape: two lists
// that must agree are two lists that will eventually disagree, and the one that
// drifts is whichever nobody is looking at. reason-text.js owns the question
// "is this text actually a reason?", so it owns the answer and this reads it.
const DEAD_REASONS = DEAD_REASON_TEXT;

function unreadable(reason) {
  if (reason === undefined) return 'the reason key is absent from the audit row';
  if (reason === null) return 'the reason is null';
  if (typeof reason !== 'string') return 'the reason is a ' + typeof reason + ', not a string';
  if (!reason.trim()) return 'the reason is an empty string';
  if (DEAD_REASONS.has(reason.trim())) return 'the reason is the dead literal ' + JSON.stringify(reason);
  return null; // readable
}

// ---------------------------------------------------------------------------
// The failure shapes. Each is a shape this tree really produces — the citation
// on each line is where, so a future reader can tell a hypothetical from a
// measured one. `expectPreserved` names a substring that WAS present in the
// effector's own output and therefore must survive to the audit row; a fix that
// merely substitutes a generic placeholder would pass the readability check and
// still be losing information, so these are what stop that.
//
// Two mutually exclusive expectations, because two different helpers own the
// two cases and conflating them would force a bad change on one of them:
//
//   namesTool     — the effector set no `.result` at all, so adapter.js's own
//                   last resort answers. It KNOWS the tool name, and "which
//                   effector do I open" is the only information left to give,
//                   so naming the tool is required. Added after a mutation
//                   survived: swapping that text for a generic constant kept
//                   every other assertion green while making it worthless.
//   namesShape    — the effector DID set `.result`, to something that renders
//                   empty. util/reason-text.js's describeEmpty() owns this and
//                   names the shape received ("an empty object", "Error with no
//                   message"). It must NOT be made to name the tool: that
//                   helper is shared with concatenating callers that prepend
//                   their own context ("Gmail fetch failed: " + reasonText(e)),
//                   and injecting a tool name there would corrupt every one of
//                   them. The audit row carries `tool` as its own field, so the
//                   reader is not actually left guessing.
const FAILURE_SHAPES = [
  {
    label: 'ok:false with no result field at all',
    // 26 rows in the real vault (2026-07-15..2026-07-24, 13 tools) landed with
    // no `reason` key whatsoever. This is the shape that produced them.
    fn: () => ({ ok: false }),
    namesTool: true,
  },
  {
    label: 'ok:false with result undefined',
    fn: () => ({ ok: false, result: undefined }),
    namesTool: true,
  },
  {
    label: 'ok:false with result null',
    fn: () => ({ ok: false, result: null }),
    namesTool: true,
  },
  {
    label: 'ok:false with result an empty string',
    fn: () => ({ ok: false, result: '' }),
    namesShape: 'no reason given',
  },
  {
    label: 'ok:false with result an empty object',
    fn: () => ({ ok: false, result: {} }),
    namesShape: 'an empty object',
  },
  {
    label: 'ok:false with a top-level string error — the BUG-101 shape',
    // adapter.js mirrors this into .result. Widespread: forge.js,
    // from-calendar.js, from-app-reply.js and ~20 others return it.
    fn: () => ({ ok: false, error: 'quota exceeded on the free tier' }),
    expectPreserved: 'quota exceeded',
  },
  {
    label: 'ok:false with a non-string error, so the BUG-101 mirror declines',
    fn: () => ({ ok: false, error: { code: 'ECONNRESET', syscall: 'read' } }),
    expectPreserved: 'ECONNRESET',
  },
  {
    label: 'ok:false with a top-level reason — the third spelling',
    fn: () => ({ ok: false, reason: 'PC automation is not running' }),
    expectPreserved: 'PC automation is not running',
  },
  {
    label: 'fn throws a plain object (an adapter rejecting with a bag of fields)',
    // Measured cause of B5: `err.message` is undefined for a non-Error, and
    // adapter.js's catch is `result: err.message`.
    fn: () => { throw { code: 'ENOENT', path: 'C:/nope' }; },
    expectPreserved: 'ENOENT',
  },
  {
    label: 'fn throws a bare string',
    fn: () => { throw 'adb is not on PATH'; },
    expectPreserved: 'adb is not on PATH',
  },
  {
    label: 'fn throws an Error with an empty message',
    // The exact 2026-08-14 Gmail case: "Gmail fetch failed: " and nothing after
    // the colon. reason-text.js's describeEmpty() exists for this.
    fn: () => { throw new Error(''); },
    namesShape: 'Error with no message',
  },
  {
    label: 'fn throws a non-Error carrying a nested status',
    fn: () => { throw { response: { status: 402, body: 'payment required' } }; },
    expectPreserved: '402',
  },
  // The four below came from a hostile-input probe run AFTER the first version of
  // this file was already green — the "friendly test data" class. The twelve
  // shapes above are the ones I could imagine from reading the tree; these are
  // the ones that embarrassed it. Three of fifteen probed shapes produced the
  // bare token 'NaN', which is truthy, so it sailed through the mirror and became
  // the operator's entire explanation.
  {
    label: 'ok:false with error: NaN — truthy after String(), still not a reason',
    fn: () => ({ ok: false, error: NaN }),
    namesTool: true,
  },
  {
    label: 'ok:false with reason: NaN',
    fn: () => ({ ok: false, reason: NaN }),
    namesTool: true,
  },
  {
    label: 'fn throws NaN',
    fn: () => { throw NaN; },
    namesTool: true,
  },
  {
    label: 'fn throws null',
    // reasonText(null) is '' by design (it means "no argument passed"), so this
    // is the shape that most directly needs the door's own last resort.
    fn: () => { throw null; },
    namesTool: true,
  },
];

// Negative controls. A fix that made every failure readable by flattening them
// all to one generic sentence would pass everything above. These fail if that
// happens.
const READABLE_CONTROLS = [
  {
    label: 'a plain string reason passes through byte-for-byte',
    fn: () => ({ ok: false, result: 'disk full' }),
    exact: 'disk full',
  },
  {
    label: 'the real list_folder sandbox refusal survives verbatim',
    // Shape copied from the operator's vault, 2026-08-14T12:02:19Z,
    // aud-08f29369581a. That row is why the capability map's claim that
    // list_folder belongs to this defect class is wrong: its reason was never
    // lost. It is here as a control precisely so the fix cannot start
    // truncating or rewording the messages that already work.
    //
    // The real paths are replaced with placeholders on purpose. AD-7 forbids a
    // drive-letter path literal in any tracked file, test files included, and
    // this assertion only needs SOME long punctuated string to prove
    // byte-for-byte preservation — the specific drive letters carry no
    // information the test uses.
    fn: () => ({
      ok: false,
      result: '"<other-user-desktop>" is outside the folders I can access. '
        + "I'm limited to: <root-a>; <root-b>.",
    }),
    exact: '"<other-user-desktop>" is outside the folders I can access. '
      + "I'm limited to: <root-a>; <root-b>.",
  },
  {
    label: 'a real Error message passes through byte-for-byte',
    fn: () => { throw new Error('Gmail fetch failed: invalid_grant: Bad Request'); },
    exact: 'Gmail fetch failed: invalid_grant: Bad Request',
  },
  // PINNED DELIBERATE NON-CHANGE. `0` and `false` are as useless as prose as
  // 'NaN' is, and they are NOT rejected. The difference is that they are
  // indistinguishable from a legitimate numeric error code or a meaningful flag,
  // and a door that discards real information to tidy up its own output is worse
  // than one that passes along a terse value. These two live here so the next
  // reader does not "finish the job" by adding them to DEAD_REASON_TEXT.
  {
    label: 'error: 0 is passed through, NOT treated as a dead reason (by design)',
    fn: () => ({ ok: false, error: 0 }),
    exact: '0',
  },
  {
    label: 'error: false is passed through, NOT treated as a dead reason (by design)',
    fn: () => ({ ok: false, error: false }),
    exact: 'false',
  },
];

// ---------------------------------------------------------------------------
// Enumerate the real registered tool objects.
//
// Mirrors computeEffectorTools()'s probe order, but keeps the tool OBJECTS (that
// function returns names only). The parity assertion in Part A is what keeps the
// two honest: the first draft of this walk missed `from-mcp.js` and
// `from-strix.js` because they return the LOWERCASE `.tools` key, covering 175
// of 179 tools while reporting itself complete — the same drift
// computeEffectorTools' own comment records having paid for.
function enumerateToolObjects() {
  const ctx = createInertCtx();
  const out = [];
  for (const file of fs.readdirSync(EFFECTOR_DIR).filter((f) => f.endsWith('.js'))) {
    let mod;
    try { mod = require(path.join(EFFECTOR_DIR, file)); } catch (_) { continue; }
    let tools = null;
    if (Array.isArray(mod.TOOLS)) {
      tools = mod.TOOLS;
    } else {
      const buildFn = Object.keys(mod).find((k) => /^build.*Tools$/i.test(k) && typeof mod[k] === 'function');
      if (buildFn) {
        try {
          let r = mod[buildFn](ctx);
          if (!Array.isArray(r) && r && typeof r === 'object') {
            if (Array.isArray(r.TOOLS)) r = r.TOOLS;
            else if (Array.isArray(r.tools)) r = r.tools;
          }
          if (Array.isArray(r)) tools = r;
        } catch (_) { /* sync-test-count's own guard reports these */ }
      }
    }
    if (tools) for (const tool of tools) out.push({ file, tool });
  }
  return out;
}

// Drive the REAL adapter and the REAL dispatcher. Mocking either would bypass
// the code under test — the mistake dispatch-self-timed-tools.test.js's header
// records making in its own first draft.
async function auditRowFor(toolName, fn) {
  const rows = [];
  const bus = { emit() {} };
  const hub = createEffectorHub({ bus, config: {} });
  hub.register(effectorFromTool({
    name: toolName, description: 'class-assertion probe', params: {}, danger: false, fn,
  }));
  const memory = {
    // Round-trip through JSON exactly as audit-writer.js's appendFileSync does.
    // Without this the test reads the in-memory object, where a key set to
    // `undefined` is still an own property — and "the key vanished on disk" is
    // the whole failure mode. w1-cortex-dispatch-audit.test.js's header records
    // the same requirement.
    audit: { write: (e) => rows.push(JSON.parse(JSON.stringify(e))) },
  };
  const res = await dispatchAction({ tool: toolName, args: {} }, {
    bus, memory, goals: null, effectors: hub, config: { ACTION_TIMEOUT_MS: 5000 },
  });
  const completed = rows.find((r) => r.decision === 'completed');
  return { res, row: completed, reason: completed ? completed.reason : undefined };
}

// ---------------------------------------------------------------------------
describe('BUG-378 Part A — the choke point every tool failure passes through', () => {
  it('every effector registered ANYWHERE under src/ goes through effectorFromTool', () => {
    // THIS ASSERTION WAS REWRITTEN AFTER TWO PROBES DEFEATED ITS FIRST DRAFT.
    //
    // The first draft scanned only `src/core/effectors/` for the literal text
    // `hub.register(`. Both probes passed — meaning the guard MISSED both — and
    // each was an instance of the very class this file exists to close:
    //
    //   probe 1: `hub.register({id, invoke})` added to `src/main.js`, one
    //            directory above the scan. Invisible. A smuggled effector is
    //            dispatchable and never touches adapter.js.
    //   probe 2: `const h = hub; h.register(rawEffector(...))` INSIDE the
    //            scanned directory. Invisible, because the guard matched a
    //            SPELLING (`hub.register`) instead of expressing a RULE.
    //
    // So: any receiver, and every .js file under src/. The set a guard must hold
    // over is every file that comes after it, not the files that existed when it
    // was written.
    //
    // Measured before widening so this cannot cry wolf: there are 30 `.register(`
    // call sites under src/ and every one is either `effectorFromTool` or
    // `registerNamed`. Zero false positives today.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        // Strip line comments first: several files discuss `hub.register(` in
        // prose, and a guard that fires on a comment is a guard someone
        // switches off.
        const src = fs.readFileSync(full, 'utf8').replace(/\/\/[^\n]*/g, '');
        // Scan CALL SITES, not lines. The line-based first draft would also have
        // false-positived on the ordinary formatting
        // `hub.register(\n  effectorFromTool(tool))`.
        const re = /\.register\s*\(/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          // registerNamed is deliberately allowed, and this is the evidence
          // rather than an assumption: verified 2026-08-27 in hub.js that
          // `invoke()` resolves out of the `effectors` Map (hub.js:243) while
          // `registerNamed` writes a separate `namedServices` Map (hub.js:105).
          // A named service therefore cannot be reached by a tool call and
          // produces no audit row. src/main.js registers three (the goals,
          // kanban and pipeline bridges).
          if (/registerNamed\s*\($/.test(src.slice(0, m.index + m[0].length))) continue;
          const window = src.slice(m.index, m.index + 200);
          if (!/effectorFromTool/.test(window)) {
            offenders.push(path.relative(SRC_DIR, full).replace(/\\/g, '/')
              + ': ' + window.split('\n').slice(0, 2).join(' ').trim().slice(0, 90));
          }
        }
      }
    };
    walk(SRC_DIR);
    assert.deepEqual(offenders, [],
      'a register() call that does not go through effectorFromTool() bypasses '
      + 'adapter.js, where the failure-reason normalisation lives. Either route it '
      + 'through effectorFromTool(), or — if it genuinely is not a dispatch door, '
      + 'the way registerNamed is not — allow it here WITH the evidence that '
      + 'invoke() cannot reach it. Do not delete this assertion.');
  });

  it('the walk covers every tool sync-test-count counts (no silent under-coverage)', () => {
    const walked = enumerateToolObjects();
    const expected = computeEffectorTools().total;
    assert.equal(walked.length, expected,
      'this file walks ' + walked.length + ' tools but the repo registers ' + expected
      + '. A walk that covers fewer tools than exist reports itself as complete coverage; '
      + 'fix the enumeration, do not relax this number.');
    assert.ok(walked.length > 150, 'sanity: expected ~179 tools, got ' + walked.length);
    for (const { file, tool } of walked) {
      assert.equal(typeof (tool && tool.name), 'string', file + ' declares a tool with no name');
    }
  });
});

describe('BUG-378 Part B — every registered tool: a forced failure reaches the audit trail readable', () => {
  for (const shape of FAILURE_SHAPES) {
    it('all registered tools, failing as: ' + shape.label, async () => {
      const walked = enumerateToolObjects();
      const broken = [];
      for (const { file, tool } of walked) {
        const { reason } = await auditRowFor(tool.name, shape.fn);
        const why = unreadable(reason);
        if (why) {
          broken.push(file + ':' + tool.name + ' -> ' + why);
          continue;
        }
        if (shape.expectPreserved && !String(reason).includes(shape.expectPreserved)) {
          broken.push(file + ':' + tool.name + ' -> reason is readable but LOST '
            + JSON.stringify(shape.expectPreserved) + ' (got ' + JSON.stringify(reason) + ')');
          continue;
        }
        if (shape.namesTool && !String(reason).includes(tool.name)) {
          broken.push(file + ':' + tool.name + ' -> last-resort reason does not name the '
            + 'tool, so the reader cannot tell which effector to open (got '
            + JSON.stringify(reason) + ')');
          continue;
        }
        if (shape.namesShape && !String(reason).includes(shape.namesShape)) {
          broken.push(file + ':' + tool.name + ' -> reason does not name the shape it '
            + 'received; expected it to mention ' + JSON.stringify(shape.namesShape)
            + ' (got ' + JSON.stringify(reason) + ')');
        }
      }
      assert.deepEqual(broken.slice(0, 6), [],
        broken.length + ' of ' + walked.length + ' tools discard their failure reason for this shape');
    });
  }
});

describe('BUG-378 Part C — negative controls: readable reasons must not be touched', () => {
  for (const control of READABLE_CONTROLS) {
    it(control.label, async () => {
      const { reason } = await auditRowFor('probe_tool', control.fn);
      assert.equal(reason, control.exact,
        'a reason that was already readable must survive byte-for-byte; the fix must add '
        + 'information where there was none, never reword what already worked');
    });
  }

  it('a successful call is unaffected (the fix must not invent a failure reason)', async () => {
    const { res, row } = await auditRowFor('probe_tool', () => ({ ok: true, result: 'done' }));
    assert.equal(res.ok, true);
    assert.equal(row.outcome, 'ok');
    assert.ok(row.reason === undefined || row.reason === null || row.reason === '',
      'an ok row carries no failure reason, got ' + JSON.stringify(row.reason));
  });
});

// ---------------------------------------------------------------------------
// Part D exists because three separate places in this subsystem derive "why did
// this fail" from the same object by different means, and BUG-378 was found by
// diffing them rather than by reading any one of them:
//
//   adapter.js         sets result.result            (this fix)
//   dispatch-action.js reasonText(result.result)  -> the audit row
//   hub.js  reasonOf() reasonText(result.result)
//                        || reasonText(result.error) -> a breaker's stored remedy
//
// reasonOf had the `.error` fallback and the dispatcher did not, so for a
// top-level-`error` failure the breaker recorded a real reason while the audit
// recorded nothing. Two normalisers reading one object and disagreeing is the
// parity gap; the fix removes it by guaranteeing `.result` at the single door,
// so every downstream reader inherits one answer instead of deriving its own.
//
// These assert that guarantee directly, so the routes cannot drift apart again
// without a test naming which one moved.
describe('BUG-378 Part D — one answer, however it is read', () => {
  const ALL_SHAPES = FAILURE_SHAPES.concat(READABLE_CONTROLS);

  // THE CONTRACT IS "reasonText(.result) IS READABLE", NOT ".result IS A STRING".
  //
  // The first draft of this assertion demanded a string, and it failed — which
  // was the assertion being wrong, not the code. Grepped 2026-08-27 before
  // changing anything: `engagements/executor.js:469`, `from-app-reply.js:133`
  // and `from-pc.js:280` all read `result.result.error` ON THE FAILURE PATH, so
  // flattening a structured `.result` object into a sentence would have deleted
  // fields three real consumers depend on — a fix that hides evidence in order
  // to pass its own test. `.result` may therefore stay an object; what must hold
  // is that the shared normaliser gets something actionable out of it.
  it('a failed effector result always yields a readable reason through reasonText', async () => {
    const broken = [];
    for (const shape of ALL_SHAPES) {
      const eff = effectorFromTool({
        name: 'probe_tool', description: 'd', params: {}, fn: shape.fn,
      });
      const out = await eff.invoke({}, {});
      assert.equal(out.ok, false, shape.label + ' should have failed');
      const why = unreadable(reasonText(out.result));
      if (why) broken.push(shape.label + ' -> reasonText(.result) is ' + why);
    }
    assert.deepEqual(broken, [],
      'every consumer downstream resolves .result through reasonText — the audit '
      + 'reason, the breaker remedy text and the spoken summary. Guaranteeing it '
      + 'here is what stops each of them growing its own normaliser to drift.');
  });

  it('the audit reason is exactly what the shared normaliser already said', async () => {
    for (const shape of ALL_SHAPES) {
      const eff = effectorFromTool({
        name: 'probe_tool', description: 'd', params: {}, fn: shape.fn,
      });
      const normalised = await eff.invoke({}, {});
      const { reason } = await auditRowFor('probe_tool', shape.fn);
      assert.equal(reason, reasonText(normalised.result).slice(0, 300),
        'the audit row and the effector result disagree for ' + shape.label
        + ' — a second, divergent derivation IS the bug class');
    }
  });

  it('a structured .result object survives on the failure path (pinned disposition)', async () => {
    // DELIBERATELY NOT CHANGED. from-runner.js's fail(m, extra) returns
    // `{ok:false, result:{error:m, ...extra}}` and the extra fields are the
    // diagnosis — exit code, stderr, which allowlist rule refused. The mirror
    // must leave that alone: it fires only when `.result` is absent, never to
    // rewrite a `.result` that already carries something. This test exists so
    // the next reader does not "finish the job" by stringifying it.
    const eff = effectorFromTool({
      name: 'probe_tool',
      description: 'd',
      params: {},
      fn: () => ({ ok: false, result: { error: 'command not allowed', code: 'EPERM', exitCode: 126 } }),
    });
    const out = await eff.invoke({}, {});
    assert.equal(typeof out.result, 'object', '.result must not be flattened to a string');
    assert.equal(out.result.code, 'EPERM', 'the structured extras must survive');
    assert.equal(out.result.exitCode, 126);
    const { reason } = await auditRowFor('probe_tool', () => ({
      ok: false, result: { error: 'command not allowed', code: 'EPERM', exitCode: 126 },
    }));
    assert.equal(reason, 'command not allowed',
      'and the audit still reads the human half out of it');
  });

  it('normalising a failure preserves the other fields, including terminal', async () => {
    // hub.js's isTerminalResult() reads result.terminal to decide whether to
    // open a breaker permanently and store a remedy. The mirror rebuilds the
    // result object with Object.assign, so a careless spread would drop that
    // flag and silently turn a terminal failure into a retried one — the
    // evidence contract in src/core/CLAUDE.md forbids folding these into ok.
    const eff = effectorFromTool({
      name: 'probe_tool',
      description: 'd',
      params: {},
      fn: () => ({ ok: false, error: 'dead credential', terminal: true, unverified: true }),
    });
    const out = await eff.invoke({}, {});
    assert.equal(out.ok, false);
    assert.equal(out.terminal, true, 'terminal must survive normalisation');
    assert.equal(out.unverified, true, 'unverified must survive normalisation');
    assert.equal(out.error, 'dead credential', 'the original error field stays intact (BUG-101)');
    assert.equal(out.result, 'dead credential', 'and is mirrored into result');
  });

  it('the last-resort reason is bounded, since a breaker stores it untruncated', async () => {
    const wide = { ok: false };
    for (let i = 0; i < 400; i += 1) wide['field_' + i] = i;
    const eff = effectorFromTool({
      name: 'probe_tool', description: 'd', params: {}, fn: () => wide,
    });
    const out = await eff.invoke({}, {});
    assert.ok(out.result.length < 300,
      'dispatch-action truncates to 300 but hub.reasonOf does not, so the bound '
      + 'belongs here; got ' + out.result.length + ' chars');
    assert.match(out.result, /and \d+ more/, 'the reader is told the list was cut');
    assert.match(out.result, /probe_tool/, 'and which tool to open');
  });
});
