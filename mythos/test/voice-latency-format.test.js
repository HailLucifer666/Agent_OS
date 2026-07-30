'use strict';
// test/voice-latency-format.test.js — pure node:test coverage for
// formatVoiceLatency(), the /api/status -> HUD-tile text mapping.
//
// AD-5 is the whole point of this file: src/core/voice/latency-tracker.js
// returns {p50:null, p95:null, sampleCount:0} when nothing has been measured,
// and the tile must SAY so. A zero, a dash implying zero, a placeholder
// number, or an estimate would all be fabricated metrics. Every assertion
// below that greps for digits exists to make that impossible to regress into.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { createLatencyTracker } = require('../src/core/voice/latency-tracker');

const FORMAT_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'latency-format.js')
).href;

describe('formatVoiceLatency (AD-5 honest voice-latency tile)', () => {
  it('sampleCount:0 — the REAL tracker output before any turn — reports no samples, with no number anywhere', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    // Not a hand-written literal: this is what the shipped tracker actually returns.
    const empty = createLatencyTracker().stats();
    assert.deepEqual(empty, { p50: null, p95: null, sampleCount: 0 });

    const out = formatVoiceLatency(empty);
    assert.equal(out.hasSamples, false);
    assert.match(out.value, /no samples yet/i);
    assert.equal(/\d/.test(out.value), false, `value must contain no digit at all, got ${JSON.stringify(out.value)}`);
    assert.equal(/\d/.test(out.detail), false, `detail must contain no digit at all, got ${JSON.stringify(out.detail)}`);
    // A bare dash reads as "zero / nothing to see" — AD-5 wants words, not glyphs.
    assert.equal(out.value.trim(), out.value.trim().replace(/^[—–-]+$/, ''), 'value must not be a bare dash');
  });

  it('a missing voiceLatency field (older server, or /api/status failed) is reported as absent, never as zero', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    for (const bad of [undefined, null, {}, { p50: null, p95: null }, 'nonsense', 42]) {
      const out = formatVoiceLatency(bad);
      assert.equal(out.hasSamples, false, `input ${JSON.stringify(bad)} must not claim samples`);
      assert.equal(/\d/.test(out.value), false, `input ${JSON.stringify(bad)} produced a digit in value: ${out.value}`);
    }
  });

  it('real samples render p50 as the headline in ms and p95 + count in the sub-line', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    const tracker = createLatencyTracker();
    [400, 500, 600, 900].forEach((d) => tracker.record(d));
    const stats = tracker.stats();
    assert.equal(stats.sampleCount, 4);

    const out = formatVoiceLatency(stats);
    assert.equal(out.hasSamples, true);
    assert.equal(out.value, `${stats.p50} ms`);
    assert.match(out.detail, new RegExp(`p95\\s*${stats.p95}\\s*ms`));
    assert.match(out.detail, /4 samples/);
  });

  it('one sample says "1 sample", not "1 samples"', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    const tracker = createLatencyTracker();
    tracker.record(250);
    const out = formatVoiceLatency(tracker.stats());
    assert.match(out.detail, /\b1 sample\b/);
    assert.equal(/1 samples/.test(out.detail), false);
  });

  it('fractional millisecond deltas are rounded for display but never invented — p50 present means p50 shown', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    const out = formatVoiceLatency({ p50: 412.7, p95: 980.2, sampleCount: 9 });
    assert.equal(out.hasSamples, true);
    assert.equal(out.value, '413 ms');
    assert.match(out.detail, /p95 980 ms/);
    assert.match(out.detail, /9 samples/);
  });

  it('a positive sampleCount with a null p50 is a contradiction and is reported as no-samples, not as 0 ms', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    const out = formatVoiceLatency({ p50: null, p95: null, sampleCount: 7 });
    assert.equal(out.hasSamples, false);
    assert.equal(/\d/.test(out.value), false, `must not print a number for a null p50, got ${out.value}`);
  });

  it('p50 of exactly 0 is a REAL measurement and must be shown as 0 ms (not swallowed as "no samples")', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    const out = formatVoiceLatency({ p50: 0, p95: 0, sampleCount: 3 });
    assert.equal(out.hasSamples, true);
    assert.equal(out.value, '0 ms');
  });

  it('an unreadable /api/status ({ unreadable: true }) is a DIFFERENT claim than "no samples yet" — it must never assert a sample count that was never actually read', async () => {
    const { formatVoiceLatency } = await import(FORMAT_URL);
    const noSamples = formatVoiceLatency({ p50: null, p95: null, sampleCount: 0 });
    const unreadable = formatVoiceLatency(null, { unreadable: true });
    assert.equal(unreadable.hasSamples, false);
    assert.equal(/\d/.test(unreadable.value), false, `value must contain no digit, got ${JSON.stringify(unreadable.value)}`);
    assert.notEqual(unreadable.value, noSamples.value, 'unreadable state must not reuse the "no samples yet" wording');
    assert.notEqual(unreadable.detail, noSamples.detail, 'unreadable state must not reuse the no-samples detail wording either');
  });
});
