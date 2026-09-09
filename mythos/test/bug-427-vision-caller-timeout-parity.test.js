'use strict';
// BUG-427 Sept 9 replay: build-refine silently fell back to 4000ms, not config 7000.
// Mutation 2026-09-10: remove total timeout -> derived scan names build-refine,
// 1 failure. Restored by absolute-path byte copy with matching SHA256.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBuildRefiner } = require('../src/core/effectors/build-refine');
it('every effector vision caller forwards both budgets (including named option objects)', () => {
  const dir = path.join(__dirname, '../src/core/effectors');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'vision-call.js')) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const call of src.matchAll(/visionThink\(brain,\s*(\{|\w+)/g)) {
      const body = call[1] === '{' ? src.slice(call.index, src.indexOf('\n  });', call.index)) :
        src.match(new RegExp('const ' + call[1] + ' = \\{([\\s\\S]*?)\\n    \\};'))?.[1] || '';
      assert.match(body, /timeoutMs\s*:/, file + ' must forward total budget');
      assert.match(body, /attemptTimeoutMs\s*:/, file + ' must forward attempt budget');
    }
  }
});
it('configured attempt budget reaches brain; configured total bounds critique', async () => {
  let options;
  const refiner = createBuildRefiner({ config: { VISION_CALL_TIMEOUT_MS: 25, VISION_ATTEMPT_TIMEOUT_MS: 17 },
    chainFor: async () => [{}], brain: { think: o => { options = o; return new Promise(() => {}); } } });
  const res = await refiner.critique({ screenshotB64: 'eA==' });
  assert.equal(options.attemptTimeoutMs, 17);
  assert.equal(res.blind, true);
  assert.match(res.verdict, /did not answer in time/);
});
