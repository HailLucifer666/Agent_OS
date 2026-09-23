'use strict';
// BUG-427: preserve PNG artifact, send q80 JPEG to vision. Judge quality needs a live run.
// Mutations 2026-09-10: send PNG buffer (1 fail); remove lag observer (1 fail).
// Both restored by absolute-path byte copy with matching SHA256.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBuildRefiner } = require('../src/core/effectors/build-refine');
it('render keeps PNG, critique sends JPEG and reports byte counts plus call-local maximum lag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-payload-'));
  const screenshots = [], logs = [], listeners = new Set();
  let vision;
  const page = { on() {}, goto: async () => {}, waitForTimeout: async () => {}, evaluate: async () => null,
    screenshot: async o => { screenshots.push(o); const bytes = Buffer.from(o.type === 'jpeg' ? 'JPEG' : 'PNG_ARTIFACT'); if (o.path) fs.writeFileSync(o.path, bytes); return bytes; } };
  const logger = { info: (event, data) => logs.push({ event, data }), onLog: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const refiner = createBuildRefiner({ vault: { vaultPath: rel => path.join(root, rel) }, logger,
    launcher: { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => {} }) },
    chainFor: async () => [{}], brain: { think: async o => {
      vision = o; for (const lagMs of [1857, 200]) for (const fn of listeners) fn({ msg: 'loop.stalled', lagMs });
      return { content: 'VERDICT: PASS' };
    } } });
  try {
    const rendered = await refiner.render('<html></html>', 'proof');
    assert.equal(rendered.ok, true);
    assert.equal(screenshots.length, 2);
    assert.deepEqual(screenshots[1], { type: 'jpeg', quality: 80 });
    assert.equal(fs.readFileSync(rendered.screenshotPath, 'utf8'), 'PNG_ARTIFACT');
    assert.equal(Buffer.from(rendered.screenshotB64, 'base64').toString(), 'JPEG');
    await refiner.critique(rendered);
    assert.equal(vision.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,SlBFRw==');
    const metric = logs.find(r => r.event === 'build-refine.vision-payload').data;
    assert.deepEqual(metric, { screenshotBytes: 12, visionPayloadBytes: 4, maxLoopStallMs: 1857 });
    assert.equal(listeners.size, 0, 'call-scoped observer must detach');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
