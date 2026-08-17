'use strict';

// F5 (2026-08-15) — a build must fail rather than ship fabricated content.
//
// Root CLAUDE.md is binding: Hermes-Agent is the only build-content engine and
// there is no brain.think fallback BY DESIGN, so a build with no engine fails
// with an install hint instead of shipping a plausible-but-wrong artifact.
// build-engine.js carried a brainFallback() that did exactly the forbidden
// thing, behind a 2026-07-31 comment arguing the downstream verifier made it
// safe.
//
// The 2026-08-14 session settled that argument with evidence. From
// vault/Checkpoints/build-jobs.json, job job-1786743287677-62:
//     "engine": "brain-fallback",
//     "_verifyWarnings": [
//       "Headline story 'OpenAI Launches \"GPT-5 Turbo\"' not found in provided HTML",
//       "Content appears generic placeholder, lacking specific AI news items"
//     ]
// The verifier worked perfectly and the job was recorded as done anyway. The
// operator ruled on 2026-08-15 to honour the documented rule.
//
// PINNED DISPOSITION: this is a deliberate refusal to degrade. If builds ever
// need to work without Hermes, that is a change to the documented architecture,
// argued on its own terms — not a fallback re-added inside a catch block.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBuildEngine } = require('../src/core/effectors/build-engine');

function engineWith(hermesBehaviour, extra) {
  const emitted = [];
  return {
    emitted,
    engine: createBuildEngine(Object.assign({
      hermes: { runTask: hermesBehaviour },
      bus: { emit: (type, payload) => emitted.push({ type, payload }) },
    }, extra || {})),
  };
}

// A brain that would happily produce plausible content, if anything asked it to.
const EAGER_BRAIN = {
  think: async () => ({ content: '<html>a confident, generic, wrong artifact</html>' }),
};

describe('F5 — Hermes failing means the build fails', () => {
  it('a thrown Hermes error does not fall back to the brain', async () => {
    let brainCalled = false;
    const { engine } = engineWith(
      async () => { throw new Error('spawn hermes ENOENT'); },
      { brain: { think: async () => { brainCalled = true; return { content: 'fabricated' }; } } },
    );
    const res = await engine.generate({ prompt: 'build a landing page', source: 'test' });
    assert.equal(brainCalled, false,
      'a second content engine is exactly what the architecture forbids');
    assert.equal(res.offline, true);
    assert.ok(!res.content, 'a failed build must produce NO content at all');
  });

  it('an empty Hermes reply fails too, rather than being regenerated', async () => {
    const { engine } = engineWith(async () => '   ', { brain: EAGER_BRAIN });
    const res = await engine.generate({ prompt: 'build a landing page', source: 'test' });
    assert.equal(res.offline, true);
    assert.ok(!res.content);
  });

  it('a provider error on stdout with exit 0 fails too', async () => {
    // Hermes reports provider failures on STDOUT with exit code 0, so this shape
    // looks like a successful run and was the original reason for the guard.
    const { engine, emitted } = engineWith(
      async () => 'HTTP 401: Missing Authentication header',
      { brain: EAGER_BRAIN },
    );
    const res = await engine.generate({ prompt: 'build a landing page', source: 'test' });
    assert.equal(res.offline, true);
    assert.ok(!res.content, 'the error text must never become the artifact');
    assert.ok(emitted.some((e) => e.payload && e.payload.kind === 'build-engine-provider-error'),
      'and the provider error must still be announced');
  });

  it('the failure names the remedy, so it is actionable rather than just a refusal', async () => {
    const { engine } = engineWith(async () => { throw new Error('spawn hermes ENOENT'); });
    const res = await engine.generate({ prompt: 'x', source: 'test' });
    assert.match(res.error, /setup-hermes/,
      'the operator needs the install command, per the documented behaviour');
    assert.match(res.error, /ENOENT/, 'and the real underlying error must survive');
  });

  it('a working Hermes is completely unaffected', async () => {
    const { engine } = engineWith(async () => '<html>the real artifact</html>');
    const res = await engine.generate({ prompt: 'x', source: 'test' });
    assert.equal(res.offline, false);
    assert.equal(res.engine, 'hermes');
    assert.match(res.content, /the real artifact/);
  });
});

describe('F5 — the fallback cannot come back by accident', () => {
  const RAW = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'effectors', 'build-engine.js'), 'utf8');
  // Comments are stripped because the file's own record of this bug QUOTES the
  // forbidden names, and a scanner that cannot tell code from prose would either
  // fail on the documentation or force the documentation to be vague. Line-based
  // and conservative: this file uses `//` comments only, and the assertion below
  // fails loudly if that ever stops being true rather than silently scanning
  // everything (or, worse, silently scanning nothing — see the smoke test whose
  // comment stripper deleted the rest of a file).
  const SRC = RAW.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('the comment stripper is doing something, and not too much', () => {
    assert.ok(SRC.length < RAW.length, 'nothing was stripped — the filter is broken');
    assert.ok(SRC.length > RAW.length * 0.2, 'almost everything was stripped — the filter is too greedy');
    assert.ok(SRC.includes('function createBuildEngine'), 'real code must survive the strip');
    // Inline `/* best-effort */` trailers are fine — they hold no prose. What
    // would defeat a line filter is a MULTI-LINE block comment, so that is what
    // is checked.
    assert.doesNotMatch(RAW, /\/\*[^*]*\n/,
      'this file must not use multi-line block comments — the line filter cannot see into them');
  });

  it('build-engine.js makes no brain call at all', () => {
    assert.doesNotMatch(SRC, /brain\s*\.\s*think/,
      'a second content engine in this file is the defect, whatever it is named');
    assert.doesNotMatch(SRC, /lane:\s*'build'/,
      'the build lane must not be reachable from the engine that replaced it');
  });

  it('nothing can still emit build-engine-fallback-used', () => {
    // The anomaly fired four times on 2026-08-14. If this string can still be
    // emitted, some path can still ship regenerated content.
    assert.doesNotMatch(SRC, /build-engine-fallback-used/);
  });

  it('main.js does not wire a brain into the build engine', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const at = main.indexOf('createBuildEngine({');
    assert.notStrictEqual(at, -1, 'the call site must still exist');
    const call = main.slice(at, main.indexOf('}', at));
    assert.doesNotMatch(call, /brain/,
      'passing a brain here is how the fallback would come back — there is nothing for it to do');
  });

  // Task B1 (2026-08-17) — the engagement executor's BUILD stage kept a live
  // `|| brain` / `: await think(...)` branch long after build-engine.js lost
  // its fallback, so the same no-fallback rule is now scanned there too. Only
  // runBuildStage is guarded: the executor LEGITIMATELY uses brain/think at
  // its research, verify claims-check, repair-hint and completion-report
  // sites, so a whole-file scan would false-positive. Scope = this one fn.
  const EXEC_RAW = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'engagements', 'executor.js'), 'utf8');
  const EXEC_SRC = EXEC_RAW.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  // Extract one function body by brace-matching from a given source. Returns
  // null if the signature or its opening brace is missing (the smoke test
  // below fails loudly rather than silently scanning nothing).
  function extractFn(src, name) {
    const at = src.indexOf('async function ' + name);
    if (at === -1) return null;
    const open = src.indexOf('{', at);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
  }
  const BUILD_BODY = extractFn(EXEC_SRC, 'runBuildStage');

  it('the executor runBuildStage extractor found the real function', () => {
    assert.ok(BUILD_BODY, 'runBuildStage must be found and brace-matched');
    assert.ok(BUILD_BODY.includes('generator.generate'), 'real engine call must survive the strip');
    assert.ok(BUILD_BODY.includes('verifyStage'), 'real verify call must survive the strip');
    // The line filter cannot see into a multi-line block comment, so forbid it
    // in the raw region — same guard as build-engine.js above.
    const rawBody = extractFn(EXEC_RAW, 'runBuildStage') || '';
    assert.doesNotMatch(rawBody, /\/\*[^*]*\n/,
      'runBuildStage must not use multi-line block comments — the line filter cannot see into them');
  });

  it('executor runBuildStage makes no brain/think reference at all', () => {
    assert.doesNotMatch(BUILD_BODY, /\bbrain\b/,
      'the build stage must not fall back to brain — Hermes is the only build-content engine');
    assert.doesNotMatch(BUILD_BODY, /\bthink\b/,
      'the build stage must not call the brain.think helper — there is no fallback');
  });
});
