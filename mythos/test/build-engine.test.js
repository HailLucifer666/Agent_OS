'use strict';
// build-engine.js — the single content generator for builds (Hermes-Agent).
//
// The contract under test is mostly about REFUSING to produce content: no
// brain fallback when Hermes is down, and no treating Hermes's own error text
// as an artifact. Both are regressions this repo has actually shipped before.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildEngine, OUTPUT_CONTRACT, stripWholeReplyFence } = require('../src/core/effectors/build-engine');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

function fakeHermes(impl) {
  const calls = [];
  return {
    calls,
    runTask: async (prompt, opts) => { calls.push({ prompt, opts }); return impl(prompt, opts); },
  };
}
const noopBus = { emit() {}, subscribe() { return () => {}; } };

describe('build-engine — Hermes is the only generator', () => {
  it('returns Hermes output as content and stamps the engine', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => '<h1>hello</h1>');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build a heading', source: 'test:1' });
      assert.equal(out.content, '<h1>hello</h1>');
      assert.equal(out.engine, 'hermes');
      assert.equal(out.offline, false);
    } finally { cleanupVaultDir(dir); }
  });

  it('sends the output contract ahead of the prompt and requires the CLI', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => 'x');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      await engine.generate({ prompt: 'PROMPT-BODY', source: 'test:2' });
      const call = hermes.calls[0];
      assert.ok(call.prompt.startsWith(OUTPUT_CONTRACT), 'contract must lead the prompt');
      assert.ok(call.prompt.includes('PROMPT-BODY'));
      // 2026-08-14: three of four real snake-game builds auto-started, lost
      // unattended, and rendered a Game Over screen before anyone looked; a
      // fourth drew pieces at 0.5% canvas coverage. Both clauses are load-bearing
      // build quality, not prose — a silent deletion would bring both back.
      assert.match(OUTPUT_CONTRACT, /READY state that waits for the user/);
      assert.match(OUTPUT_CONTRACT, /never open on a game-over\/error screen/);
      assert.match(OUTPUT_CONTRACT, /Draw at a size a person can actually see/);
      // requireCli: the HTTP gateway cannot be cwd-pinned, so builds must not
      // silently degrade onto it.
      assert.equal(call.opts.requireCli, true);
      assert.ok(call.opts.cwd, 'a scratch cwd must be supplied');
      assert.ok(call.opts.cwd.indexOf(path.join('builds', '.engine-scratch')) !== -1,
        'text-only calls run in a scratch dir, never a project dir');
    } finally { cleanupVaultDir(dir); }
  });

  it('an OFFLINE Hermes yields offline + the install hint — never falls back', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => { throw new Error('hermes-agent OFFLINE: install from github.com/NousResearch/hermes-agent'); });
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build', source: 'test:3' });
      assert.equal(out.offline, true);
      assert.equal(out.content, undefined, 'must produce no content at all');
      assert.match(out.error, /OFFLINE/);
      assert.match(out.error, /github\.com\/NousResearch/);
    } finally { cleanupVaultDir(dir); }
  });

  it('an empty reply is a failure, not an empty artifact', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => '   ');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build', source: 'test:4' });
      assert.equal(out.offline, true);
      assert.match(out.error, /empty reply/i);
    } finally { cleanupVaultDir(dir); }
  });

  it('rejects an empty prompt without calling Hermes', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => 'should not run');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: '   ' });
      assert.equal(out.offline, true);
      assert.equal(hermes.calls.length, 0);
    } finally { cleanupVaultDir(dir); }
  });

  it('requires the hermes adapter at construction', () => {
    assert.throws(() => createBuildEngine({}), /requires the hermes-agent adapter/);
  });
});

// Observed live 2026-07-29: a misconfigured provider made Hermes print
// "HTTP 401: Missing Authentication header" to stdout and exit 0, and a stale
// model slug produced "API call failed after 3 retries: HTTP 404: ...".
// Both would have been filed verbatim as the build artifact.
describe('build-engine — Hermes error-on-stdout with exit 0 is not content', () => {
  const POISON = [
    'HTTP 401: Missing Authentication header',
    'API call failed after 3 retries: HTTP 404: This model is unavailable for free.',
    '  HTTP 500: upstream exploded',
  ];
  for (const reply of POISON) {
    it(`treats ${JSON.stringify(reply.trim().slice(0, 40))}… as a failure`, async () => {
      const dir = tempVaultDir();
      try {
        const seen = [];
        const bus = { emit: (k, p) => seen.push({ k, p }), subscribe: () => () => {} };
        const hermes = fakeHermes(async () => reply);
        const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus });
        const out = await engine.generate({ prompt: 'build', source: 'test:poison' });
        assert.equal(out.offline, true);
        assert.equal(out.content, undefined);
        assert.match(out.error, /provider error/i);
        assert.ok(seen.some((e) => e.k === 'health.anomaly' && e.p.kind === 'build-engine-provider-error'),
          'a provider error must raise an anomaly, not pass silently');
      } finally { cleanupVaultDir(dir); }
    });
  }

  it('does not misfire on legitimate content that merely mentions an HTTP code', async () => {
    const dir = tempVaultDir();
    try {
      const body = 'The API returns HTTP 404: Not Found when the id is unknown.';
      const hermes = fakeHermes(async () => body);
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'document the api', source: 'test:5' });
      assert.equal(out.content, body, 'the guard is anchored to the start of the reply');
    } finally { cleanupVaultDir(dir); }
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
    const { runner, brainCalls, dir } = makeRunner(async () => ({ content: 'HERMES CONTENT', engine: 'hermes' }));
    try {
      let saved = null;
      const job = runner.enqueue({ kind: 'build', prompt: 'make a thing', run: async (raw) => { saved = raw; return {}; } });
      const done = await settled(runner, job.id);
      assert.equal(done.status, 'done', done.error || '');
      assert.equal(saved, 'HERMES CONTENT');
      assert.equal(done.engine, 'hermes');
      assert.deepEqual(brainCalls, [], 'brain.think must not be consulted for build content');
    } finally { cleanupVaultDir(dir); }
  });

  it('an offline engine fails the job carrying the real reason — no brain fallback artifact', async () => {
    const { runner, brainCalls, dir } = makeRunner(async () => ({ offline: true, engine: 'hermes', error: 'hermes-agent OFFLINE: install hint here' }));
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
  // 2026-08-14. OUTPUT_CONTRACT asks the model not to fence its reply. Hermes
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

  it('the engine returns fence-free content from a fenced Hermes reply', async () => {
    const dir = tempVaultDir();
    try {
      const vault = createFsStore(() => dir, noopBus);
      const engine = createBuildEngine({
        hermes: fakeHermes(async () => FENCE + 'html\n<!doctype html><html><body>ok</body></html>\n' + FENCE),
        vault, bus: noopBus,
      });
      const out = await engine.generate({ prompt: 'build a page', source: 'test' });
      assert.equal(out.offline, false);
      assert.equal(out.engine, 'hermes');
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
