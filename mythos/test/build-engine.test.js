'use strict';
// build-engine.js — the single content generator for builds (DeepSeek Harness).
//
// The contract under test is mostly about REFUSING to produce content: no brain
// fallback when the engine is down, and no shipping an artifact the engine did
// not actually earn. Both are regressions this repo has shipped before.
//
// W6 (2026-08-22) swapped the HARNESS from Hermes-Agent to dsh. The models did
// not change — dsh runs whatever BRAIN_TABLES.build ranks first. Two things
// under test changed shape with it and both are called out at their tests:
// deps.hermes became deps.engine, and the exit-0-error-on-stdout guard is gone
// because dsh has no such mode.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildEngine, OUTPUT_CONTRACT, stripWholeReplyFence } = require('../src/core/effectors/build-engine');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

function fakeEngine(impl) {
  const calls = [];
  return {
    calls,
    runTask: async (prompt, opts) => { calls.push({ prompt, opts }); return impl(prompt, opts); },
  };
}
const noopBus = { emit() {}, subscribe() { return () => {}; } };

describe('build-engine — dsh is the only generator', () => {
  it('returns engine output as content and stamps the engine', async () => {
    const dir = tempVaultDir();
    try {
      const engineAdapter = fakeEngine(async () => '<h1>hello</h1>');
      const engine = createBuildEngine({ engine: engineAdapter, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build a heading', source: 'test:1' });
      assert.equal(out.content, '<h1>hello</h1>');
      assert.equal(out.engine, 'dsh');
      assert.equal(out.offline, false);
    } finally { cleanupVaultDir(dir); }
  });

  it('sends the output contract ahead of the prompt and runs read-only in a scratch dir', async () => {
    const dir = tempVaultDir();
    try {
      const engineAdapter = fakeEngine(async () => 'x');
      const engine = createBuildEngine({ engine: engineAdapter, vault: createFsStore(() => dir, null), bus: noopBus });
      await engine.generate({ prompt: 'PROMPT-BODY', source: 'test:2' });
      const call = engineAdapter.calls[0];
      assert.ok(call.prompt.startsWith(OUTPUT_CONTRACT), 'contract must lead the prompt');
      assert.ok(call.prompt.includes('PROMPT-BODY'));
      // 2026-08-14: three of four real snake-game builds auto-started, lost
      // unattended, and rendered a Game Over screen before anyone looked; a
      // fourth drew pieces at 0.5% canvas coverage. Both clauses are load-bearing
      // build quality, not prose — a silent deletion would bring both back.
      assert.match(OUTPUT_CONTRACT, /READY state that waits for the user/);
      assert.match(OUTPUT_CONTRACT, /never open on a game-over\/error screen/);
      assert.match(OUTPUT_CONTRACT, /Draw at a size a person can actually see/);
      // W6: requireCli is gone — dsh has no HTTP surface, so there is no second
      // transport to degrade onto and nothing to gate. What replaced it is
      // stronger: autoApprove is DELIBERATELY absent, which selects dsh's
      // read-only sandbox, so the contract's "write nothing" is ENFORCED rather
      // than requested. Asserting the absence is the point — passing autoApprove
      // here would silently re-enable writes on the single-artifact path.
      assert.equal(call.opts.requireCli, undefined);
      assert.ok(!call.opts.autoApprove, 'a text-only build must not request write permission');
      assert.ok(call.opts.cwd, 'a scratch cwd must be supplied (W6-AD-3: never inherited)');
      assert.ok(call.opts.cwd.indexOf(path.join('builds', '.engine-scratch')) !== -1,
        'text-only calls run in a scratch dir, never a project dir');
    } finally { cleanupVaultDir(dir); }
  });

  it('an OFFLINE engine yields offline + the install hint — never falls back', async () => {
    const dir = tempVaultDir();
    try {
      const engineAdapter = fakeEngine(async () => { throw new Error('dsh-agent OFFLINE: run node mythos/scripts/setup-dsh.js --install'); });
      const engine = createBuildEngine({ engine: engineAdapter, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build', source: 'test:3' });
      assert.equal(out.offline, true);
      assert.equal(out.content, undefined, 'must produce no content at all');
      assert.match(out.error, /OFFLINE/);
      // The adapter's own message must survive, AND build-engine must append the
      // no-fallback statement with the install command. Ruling A is the thing
      // being pinned here, not a particular vendor's URL — that is why this
      // asserts on the fix command rather than on a github.com path, which is
      // what it used to check when the engine was Hermes.
      assert.match(out.error, /setup-dsh\.js --install/);
      assert.match(out.error, /there is no fallback/);
    } finally { cleanupVaultDir(dir); }
  });

  it('an empty reply is a failure, not an empty artifact', async () => {
    const dir = tempVaultDir();
    try {
      const engineAdapter = fakeEngine(async () => '   ');
      const engine = createBuildEngine({ engine: engineAdapter, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build', source: 'test:4' });
      assert.equal(out.offline, true);
      assert.match(out.error, /empty reply/i);
    } finally { cleanupVaultDir(dir); }
  });

  it('rejects an empty prompt without calling the engine', async () => {
    const dir = tempVaultDir();
    try {
      const engineAdapter = fakeEngine(async () => 'should not run');
      const engine = createBuildEngine({ engine: engineAdapter, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: '   ' });
      assert.equal(out.offline, true);
      assert.equal(engineAdapter.calls.length, 0);
    } finally { cleanupVaultDir(dir); }
  });

  it('requires the dsh adapter at construction', () => {
    assert.throws(() => createBuildEngine({}), /requires the dsh-agent adapter/);
  });
});

// W6 DISPOSITION (2026-08-22): THE EXIT-0-ERROR-ON-STDOUT GUARD IS GONE, AND
// THIS BLOCK PINS THAT AS A DECISION SO NOBODY RE-ADDS IT SPECULATIVELY.
//
// The history: observed live 2026-07-29, a misconfigured provider made HERMES
// print "HTTP 401: Missing Authentication header" to stdout and exit 0, and a
// stale model slug produced "API call failed after 3 retries: HTTP 404: ...".
// Both would have been filed verbatim as the build artifact, so
// HERMES_ERROR_REPLY_RE existed to catch them.
//
// dsh has no such mode. Its exit code IS the oracle (0 iff the final turn/end
// reason is `completed`), its reference documents stderr as empty on success,
// and adapters/dsh-agent asserts BOTH — a non-zero exit throws, and an exit 0
// that wrote to stderr throws with the text on the grounds that the documented
// contract moved. So a provider failure can no longer arrive here disguised as a
// reply; it arrives as a thrown error, which the "OFFLINE engine" test above
// covers.
//
// Keeping a regex anyway would mean scanning a MODEL'S OWN OUTPUT — text the
// task's author influences — for a pattern nothing has ever matched under dsh,
// and rejecting any artifact whose first line happened to read like an HTTP
// error. This repo has recorded both halves of that as defect classes: a guard
// that is correct and never fires is not a guard, and a heuristic over
// attacker-adjacent input catches what it was not built for.
describe('build-engine — an error-shaped reply is CONTENT under dsh, by decision', () => {
  const FORMERLY_POISON = [
    'HTTP 401: Missing Authentication header',
    'API call failed after 3 retries: HTTP 404: This model is unavailable for free.',
  ];
  for (const reply of FORMERLY_POISON) {
    it(`passes ${JSON.stringify(reply.slice(0, 40))}… through, because dsh would have exited non-zero`, async () => {
      const dir = tempVaultDir();
      try {
        const seen = [];
        const bus = { emit: (k, p) => seen.push({ k, p }), subscribe: () => () => {} };
        const engine = createBuildEngine({ engine: fakeEngine(async () => reply), vault: createFsStore(() => dir, null), bus });
        const out = await engine.generate({ prompt: 'build', source: 'test:formerly-poison' });
        assert.equal(out.offline, false);
        assert.equal(out.content, reply);
        assert.equal(seen.length, 0, 'no anomaly — there is no provider-error detector any more');
      } finally { cleanupVaultDir(dir); }
    });
  }

  it('the module exports no error-reply regex, and nothing imports one', () => {
    const buildEngine = require('../src/core/effectors/build-engine');
    assert.equal(buildEngine.HERMES_ERROR_REPLY_RE, undefined);
    assert.equal(buildEngine.DSH_ERROR_REPLY_RE, undefined);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'build-engine.js'), 'utf8');
    assert.equal(/ERROR_REPLY_RE\s*=/.test(src), false,
      'a re-added error-reply regex needs a MEASUREMENT of dsh producing exit-0 failures, not a hunch');
  });

  it('legitimate content that mentions an HTTP code is untouched — the case a regex risks', async () => {
    const dir = tempVaultDir();
    try {
      const body = 'The API returns HTTP 404: Not Found when the id is unknown.';
      const engine = createBuildEngine({ engine: fakeEngine(async () => body), vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'document the api', source: 'test:5' });
      assert.equal(out.content, body);
    } finally { cleanupVaultDir(dir); }
  });

  it('an absent scratch directory FAILS the build instead of inheriting a cwd (W6-AD-3)', async () => {
    // dsh adopts its invoking directory as a writable workspace and reads that
    // directory's CLAUDE.md as agent instructions. scratchDir() returning
    // undefined used to mean "the adapter falls back to cwd inheritance", which
    // under dsh would hand a build task this repo's rules plus write access.
    const engineAdapter = fakeEngine(async () => 'should not run');
    const be = createBuildEngine({ engine: engineAdapter, vault: null, bus: noopBus });
    const out = await be.generate({ prompt: 'build', source: 'test:no-vault' });
    assert.equal(out.offline, true);
    assert.equal(engineAdapter.calls.length, 0, 'the engine must not be called without a scratch dir');
    assert.match(out.error, /scratch directory/);
  });
});

describe('build-runner — routes through the engine, never brain, when wired', () => {
  function makeRunner(engineImpl) {
    const dir = tempVaultDir();
    const vault = createFsStore(() => dir, null);
    const brainCalls = [];
    const brain = { think: async (a) => { brainCalls.push(a); return { content: 'BRAIN CONTENT' }; } };
    const buildEngine = { generate: engineImpl };
    const runner = createBuildRunner({ config: {}, brain, bus: noopBus, vault, verifier: null, buildEngine });
    return { runner, brainCalls, dir };
  }

  function settled(runner, jobId) {
    return new Promise((resolve) => {
      const stop = runner.onJobUpdate((j) => {
        if (j.id === jobId && (j.status === 'done' || j.status === 'failed')) { stop(); resolve(j); }
      });
    });
  }

  it('uses the engine for content and stamps engine on the job; brain is never called', async () => {
    const { runner, brainCalls, dir } = makeRunner(async () => ({ content: 'ENGINE CONTENT', engine: 'dsh' }));
    try {
      let saved = null;
      const job = runner.enqueue({ kind: 'build', prompt: 'make a thing', run: async (raw) => { saved = raw; return {}; } });
      const done = await settled(runner, job.id);
      assert.equal(done.status, 'done', done.error || '');
      assert.equal(saved, 'ENGINE CONTENT');
      assert.equal(done.engine, 'dsh');
      assert.deepEqual(brainCalls, [], 'brain.think must not be consulted for build content');
    } finally { cleanupVaultDir(dir); }
  });

  it('an offline engine fails the job carrying the real reason — no brain fallback artifact', async () => {
    const { runner, brainCalls, dir } = makeRunner(async () => ({ offline: true, engine: 'dsh', error: 'dsh-agent OFFLINE: install hint here' }));
    try {
      let ran = false;
      const job = runner.enqueue({ kind: 'build', prompt: 'make a thing', run: async () => { ran = true; return {}; } });
      const done = await settled(runner, job.id);
      assert.equal(done.status, 'failed');
      assert.match(done.error, /OFFLINE/);
      assert.match(done.error, /install hint here/);
      assert.equal(ran, false, 'no artifact may be written');
      assert.deepEqual(brainCalls, []);
    } finally { cleanupVaultDir(dir); }
  });

  it('constructing with neither an engine nor a brain is refused', () => {
    assert.throws(() => createBuildRunner({ config: {}, bus: noopBus, vault: { readJSON() {}, writeJSON() {} } }),
      /requires a buildEngine/);
  });
});

describe('a whole-reply markdown fence is stripped (found by the first real e2e build)', () => {
  // 2026-08-14. OUTPUT_CONTRACT asks the model not to fence its reply. The engine
  // fenced it anyway and nothing downstream stripped it, so the saved .html
  // opened with a ```html line and closed with a bare fence — which the browser
  // renders as literal text either side of the page, on every fenced reply, and
  // it had been invisible to the entire pipeline. The verifier reads source and
  // has no "no stray fences" rule; the only reason this surfaced is that the new
  // refine loop screenshotted the artifact and the fence text was in the picture.
  // A prompt instruction is not a guarantee — this is the enforcement.
  const FENCE = '```';

  it('strips a fence that wraps the entire reply, with or without a language tag', () => {
    assert.equal(stripWholeReplyFence(FENCE + 'html\n<h1>hi</h1>\n' + FENCE), '<h1>hi</h1>');
    assert.equal(stripWholeReplyFence(FENCE + '\n<h1>hi</h1>\n' + FENCE), '<h1>hi</h1>');
    assert.equal(stripWholeReplyFence(FENCE + 'HTML  \n<h1>hi</h1>\n' + FENCE + '  \n'), '<h1>hi</h1>');
    assert.equal(stripWholeReplyFence('\n' + FENCE + 'js\nconst a = 1;\n' + FENCE + '\n'), 'const a = 1;');
  });

  it('leaves an artifact that merely CONTAINS fenced blocks alone', () => {
    const readme = '# Title\n\nSome prose.\n\n' + FENCE + 'js\nconst a = 1;\n' + FENCE + '\n\nMore prose.\n';
    assert.equal(stripWholeReplyFence(readme), readme);
    const html = '<!doctype html>\n<pre>' + FENCE + 'not a fence' + FENCE + '</pre>\n';
    assert.equal(stripWholeReplyFence(html), html);
  });

  it('leaves unfenced content and degenerate input untouched', () => {
    assert.equal(stripWholeReplyFence('<!doctype html><html></html>'), '<!doctype html><html></html>');
    assert.equal(stripWholeReplyFence(''), '');
    assert.equal(stripWholeReplyFence(null), '');
    // An opening fence with no close is not a wrapped reply — never guess.
    const unclosed = FENCE + 'html\n<h1>hi</h1>';
    assert.equal(stripWholeReplyFence(unclosed), unclosed);
  });

  it('refuses to unwrap a nested/ambiguous fence rather than risk truncating', () => {
    const nested = FENCE + '\n' + FENCE + 'html\n<h1>hi</h1>\n' + FENCE + '\n' + FENCE;
    assert.equal(stripWholeReplyFence(nested), nested);
  });

  it('the engine returns fence-free content from a fenced engine reply', async () => {
    const dir = tempVaultDir();
    try {
      const vault = createFsStore(() => dir, noopBus);
      const engine = createBuildEngine({
        engine: fakeEngine(async () => FENCE + 'html\n<!doctype html><html><body>ok</body></html>\n' + FENCE),
        vault, bus: noopBus,
      });
      const out = await engine.generate({ prompt: 'build a page', source: 'test' });
      assert.equal(out.offline, false);
      assert.equal(out.engine, 'dsh');
      assert.equal(out.content.indexOf(FENCE), -1, 'a saved artifact must never carry the fence markers');
      assert.match(out.content, /^<!doctype html>/);
    } finally { cleanupVaultDir(dir); }
  });
});

describe('build dispatch tools are T3 (no auto-allow under AUTONOMOUS_MAX_TIER=2)', () => {
  for (const tool of ['pipeline_execute', 'kanban_build_card', 'kanban_assemble', 'start_project', 'run_mission', 'build_project', 'revise_project']) {
    it(`${tool} is tier 3`, () => {
      assert.equal(tierOf(tool), 3);
      assert.equal(TIER_TABLE[tool], 3);
    });
  }
});
