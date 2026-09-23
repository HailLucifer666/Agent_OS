'use strict';
// BUG-431, reviewed 2026-09-10: retry/refine can replace the first model's
// artifact. Mutation probes remove either replacement stamp; these wires fail.
// Rejected/offline refinement deliberately retains the last accepted metadata.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createJobSensor } = require('../src/core/sensors/job');

for (const mode of ['retry', 'refine', 'refine-rejected', 'refine-offline']) {
  for (const firstFallback of [false, true]) {
    test(`${mode} keeps the saved artifact's model evidence (first fallback=${firstFallback})`, { timeout: 2000 }, async () => {
      let generated = 0, verified = 0, critiqued = 0, persisted, saved;
      const perceptions = [];
      const runner = createBuildRunner({
        config: { BUILD_REFINE_MAX_ITERATIONS: 2 },
        vault: { readJSON() {}, readJSONStrict: () => ({ jobs: [] }),
          writeJSON: (_path, value) => { persisted = structuredClone(value); } },
        buildEngine: { generate: async () => {
          const first = generated++ === 0;
          return { content: first ? 'first artifact' : 'replacement artifact', engine: 'dsh',
            laneFallback: first ? firstFallback : !firstFallback,
            offline: !first && mode === 'refine-offline' };
        } },
        verifier: { verify: async () => {
          const first = verified++ === 0;
          return { pass: mode === 'retry' ? !first : mode === 'refine-rejected' ? first : true,
            issues: ['repair this'], warnings: [] };
        } },
        refiner: mode === 'retry' ? null : {
          available: () => true, looksRenderable: () => true,
          render: async () => ({ ok: true, pageErrors: [], consoleErrors: [] }),
          critique: async () => ({ pass: critiqued++ > 0, issues: ['repair this'], verdict: 'repair this' }),
        },
      });
      const sensor = createJobSensor({ buildRunner: runner,
        bus: { emit: (_type, payload) => perceptions.push(payload) } });
      sensor.start();
      try {
        const finished = new Promise(resolve => {
          const unsubscribe = runner.onJobUpdate(job => {
            if (job.status === 'done' || job.status === 'failed') { unsubscribe(); resolve(job); }
          });
        });
        runner.enqueue({ kind: 'build', prompt: 'Build a page', run: async (raw, job) => {
          saved = { raw, laneFallback: job.laneFallback }; return {};
        } });
        const job = await finished;
        assert.equal(job.status, 'done', job.error);
        assert.equal(generated, 2, 'the real runner must attempt the replacement');
        const accepted = mode === 'retry' || mode === 'refine';
        const expected = accepted ? !firstFallback : firstFallback;
        assert.deepEqual(saved, { raw: accepted ? 'replacement artifact' : 'first artifact', laneFallback: expected });
        assert.equal(job.laneFallback, expected);
        assert.equal(persisted.jobs[0].laneFallback, expected);
        assert.equal(perceptions.at(-1).laneFallback, expected);
      } finally { sensor.stop(); }
    });
  }
}
