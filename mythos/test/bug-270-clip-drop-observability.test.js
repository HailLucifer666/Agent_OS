'use strict';

// BUG-270 (2026-08-17) — a dropped voice clip must never be silent again.
//
// The batch voice path's recorder.onstop gates each clip twice before it is
// sent for transcription: the clip's peak RMS must clear MIN_PEAK_RMS, and
// its effective length/size must clear MIN_CLIP_MS/MIN_CLIP_BYTES. Both gates
// used to `return` with no log, no event and no HUD hint — so when the
// operator's first live session reported "it is not picking up words from the
// noise", there was literally no evidence anywhere distinguishing "the mic
// never heard you" from "heard, but rejected as too quiet/short". The batch
// path emits no client telemetry of its own; this was its only decision point
// with zero observability.
//
// Deliberately a SOURCE-SHAPE test: the gates live inside a MediaRecorder
// onstop closure with no injectable seam, and the defect being pinned is
// structural (a decision point with no evidence), not one function's logic.
// If a third drop gate is ever added to onstop, extend this file — the last
// test asserts every `return` inside onstop is preceded by a warn+caption.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VOICE_LOOP = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js');
const src = fs.readFileSync(VOICE_LOOP, 'utf8');

// Brace-matched extraction of the recorder.onstop handler body.
function onstopBody() {
  const anchor = 'recorder.onstop = () => {';
  const start = src.indexOf(anchor);
  assert.notEqual(start, -1, 'recorder.onstop handler must exist');
  let depth = 0;
  for (let i = start + anchor.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail('recorder.onstop handler braces never balanced');
}

describe('BUG-270 — dropped voice clips are loud, never silent', () => {
  const body = onstopBody();

  test('the loudness gate warns with the measured peak and the floor, and captions the HUD', () => {
    const gate = body.indexOf('if (!loudEnough)');
    assert.notEqual(gate, -1, 'the loudness gate must still exist');
    // The gate is a block now, not the old one-line silent `return;`.
    assert.ok(!/if \(!loudEnough\) return;/.test(body),
      'the old silent one-line drop must be gone');
    const block = body.slice(gate, body.indexOf('}', body.indexOf('{', gate) + 1) + 400);
    assert.match(block, /console\.warn\('\[voice\] clip dropped: peak RMS/,
      'loudness drop must console.warn the measured peak');
    assert.match(block, /MIN_PEAK_RMS/, 'warn must name the floor it compared against');
    assert.match(block, /caption\(/, 'loudness drop must surface in the HUD caption');
  });

  test('the length/size gate warns with the measured clip and the minimums, and captions the HUD', () => {
    const gate = body.indexOf('effectiveMs < MIN_CLIP_MS');
    assert.notEqual(gate, -1, 'the length/size gate must still exist');
    assert.ok(!/if \(effectiveMs < MIN_CLIP_MS \|\| blob\.size < MIN_CLIP_BYTES\) return;/.test(body),
      'the old silent one-line drop must be gone');
    const block = body.slice(gate, gate + 500);
    assert.match(block, /console\.warn\('\[voice\] clip dropped/,
      'length/size drop must console.warn');
    assert.match(block, /MIN_CLIP_MS/, 'warn must name the minimums it compared against');
    assert.match(block, /caption\(/, 'length/size drop must surface in the HUD caption');
  });

  test('the clips are still DROPPED — observability changed, behaviour did not', () => {
    // Both gates must still return before transcription; the fix made the
    // drop visible, it did not loosen the gates.
    const loudGate = body.indexOf('if (!loudEnough)');
    const loudBlock = body.slice(loudGate, body.indexOf('}', body.indexOf('{', loudGate)) + 1);
    assert.match(loudBlock, /return;/, 'loudness gate must still drop the clip');
    const lenGate = body.indexOf('effectiveMs < MIN_CLIP_MS');
    const lenBlock = body.slice(lenGate, body.indexOf('}', body.indexOf('{', lenGate)) + 1);
    assert.match(lenBlock, /return;/, 'length/size gate must still drop the clip');
  });
});
