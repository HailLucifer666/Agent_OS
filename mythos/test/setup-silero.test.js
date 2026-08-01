'use strict';

// test/setup-silero.test.js — scripts/setup-silero.js's exported constants.
// No network here (the actual download was live-verified manually — see
// THIRD_PARTY_NOTICES.md and the script's own sourcing comment); this just
// asserts the shape stays consistent (pinned version in the URL, output path
// matches what silero-vad.js/voice-loop.js expect to find at runtime).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const setupSilero = require('../scripts/setup-silero');

describe('scripts/setup-silero.js', () => {
  test('MODEL_URL is a pinned, versioned jsDelivr npm CDN URL (not "latest")', () => {
    assert.match(setupSilero.MODEL_URL, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@ricky0123\/vad-web@\d+\.\d+\.\d+\/dist\/silero_vad_v5\.onnx$/);
  });

  test('OUT_DIR/OUT_FILE matches where silero-vad.js expects the model to be served from', () => {
    assert.equal(setupSilero.OUT_FILE, 'silero_vad.onnx');
    assert.equal(
      path.basename(path.dirname(setupSilero.OUT_DIR)) + '/' + path.basename(setupSilero.OUT_DIR),
      'models/silero'
    );
  });

  test('MIN_BYTES sanity floor is well under the real ~2.2MB file but well above a truncated/failed download', () => {
    assert.ok(setupSilero.MIN_BYTES > 10 * 1024);
    assert.ok(setupSilero.MIN_BYTES < 2 * 1024 * 1024);
  });
});
