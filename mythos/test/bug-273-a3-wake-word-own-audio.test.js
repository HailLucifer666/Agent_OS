'use strict';

// bug-273-a3-wake-word-own-audio.test.js — BUG-273 A3.
//
// THE INCIDENT, from the 2026-08-18 server log:
//   11:33:16.603  tts.provider-failed  gemini-tts  503 high demand
//   11:33:17.978  tts.failover         gemini-tts -> edge-tts
//   11:33:19.591  wakeword.detected    score 0.9797  "opening a turn"
//   11:33:22.619  wakeword.metrics     peakScore 0.997818
// The three metric windows before that read 0.000005, 0.000009 and 0.00001. A room
// silent to six significant figures for twenty seconds produced a 0.98 the moment
// MYTHOS's own failover TTS started, and the log says `detected`, not
// `detected-suppressed` — so all five guards in app.js's onWake evaluated false.
//
// WHY A CORRECT GUARD MISSED IT, and this is the whole fix. A wake-word score is
// not a statement about the present. One classifier score is computed from
// classifierWindow feature frames; the first covers EMBED_WINDOW mel frames and
// each subsequent one advances EMBED_STRIDE, so at the defaults a single score is
// evidence about 196 mel frames — very close to TWO SECONDS of audio. Every guard
// in the chain asked "is MYTHOS speaking NOW?". A greeting that stopped playing
// shortly before the score crossed the threshold is invisible to all of them.
//
// TWO CORRECTIONS TO A3 AS FILED, both from the log rather than from reading the
// suppression chain alone:
//
//  1. "at boot there is no Live session yet, so it really plays" — there WAS one.
//     `live.tool-call-batch` with three tools is logged at 11:33:01.976, eighteen
//     seconds BEFORE the detection, and `live-tools: declared 91, withheld 74` at
//     11:33:00.325 is that session being built. So the premise that the Live route
//     was unavailable is wrong, and `s2s.isActive()` returning false while a Live
//     session is making tool calls is its own finding: the client bridge's `active`
//     flag tracks the CLIENT's session, and BUG-060/061's proactive-speech
//     re-routing is conditional on that flag.
//  2. The fix filed was "track server-TTS playback via the speech-chunk
//     subscription and add it to the suppression chain". That is necessary and is
//     done here — but on its own it is another instantaneous guard, and it would
//     still have missed this detection if playback had ended 300ms earlier. The
//     timestamp-plus-window shape is what makes it correct under BOTH timings:
//     audio still playing, or audio just finished.
//
// Q1 — WHAT ELSE MATCHES THIS? Deliberately only MYTHOS's own SPEECH. Media the
// operator asked for (Spotify, a YouTube page) must not deafen the wake word;
// suspendForMedia is the separate, narrower, opening-burst-only mechanism for that
// and this fix must not quietly widen it. Asserted below.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WAKEWORD_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'wakeword.js'),
).href;

const appSrc = () => fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8',
).replace(/\r\n/g, '\n');

describe('BUG-273 A3 — the detector states how much audio one score is made of', () => {
  it('computes the receptive field from the model constants, not a hardcoded number', async () => {
    const m = await import(WAKEWORD_URL);
    // first embedding covers EMBED_WINDOW, each later one advances EMBED_STRIDE
    const expected = m.EMBED_WINDOW + (m.DEFAULT_CLASSIFIER_WINDOW - 1) * m.EMBED_STRIDE;
    assert.equal(m.receptiveFieldMelFrames(m.DEFAULT_CLASSIFIER_WINDOW), expected);
    assert.equal(expected, 196, 'the arithmetic the incident timing is read against');
  });

  it('converts to ms at openWakeWord\'s documented 10ms mel hop', async () => {
    const m = await import(WAKEWORD_URL);
    assert.equal(m.MEL_FRAME_MS, 10, 'hop_length 160 at 16kHz — cited, not derived');
    assert.equal(m.receptiveFieldMs(m.DEFAULT_CLASSIFIER_WINDOW), 1960);
    // The window has to be WIDER than the 1.6s gap between the failover that started
    // the audio and the detection it produced, or it would not have caught this one.
    assert.ok(m.receptiveFieldMs(16) > 1613,
      'the 2026-08-18 detection came 1,613ms after tts.failover; a narrower window misses it');
  });

  it('tracks a model that reports a different classifierWindow', async () => {
    const m = await import(WAKEWORD_URL);
    assert.equal(m.receptiveFieldMs(8), (76 + 7 * 8) * 10);
    assert.ok(m.receptiveFieldMs(8) < m.receptiveFieldMs(16),
      'a shorter classifier window means less audio per score, and the suppression '
      + 'window must shrink with it rather than staying at a copied constant');
  });

  it('falls back to the default rather than producing a nonsense window', async () => {
    const m = await import(WAKEWORD_URL);
    const dflt = m.receptiveFieldMs(m.DEFAULT_CLASSIFIER_WINDOW);
    for (const bad of [undefined, null, 0, -5, NaN, Infinity, 'sixteen', {}]) {
      assert.equal(m.receptiveFieldMs(bad), dflt,
        `receptiveFieldMs(${JSON.stringify(bad)}) must not yield a window of 0 — that would `
        + 'silently disable the guard, which is the fail-open shape');
    }
  });

  it('the instance exposes the window read from the real model', () => {
    // createWakeWord needs a mic and onnxruntime, so the wiring is asserted on
    // source. The point is that the getter uses `classifierWindow` (read out of the
    // classifier's own input shape at load) and not the module default.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'wakeword.js'), 'utf8',
    ).replace(/\r\n/g, '\n');
    assert.match(src, /receptiveFieldMs: \(\) => receptiveFieldMs\(classifierWindow\)/);
  });
});

describe('BUG-273 A3 — app.js suppresses a score whose evidence window contains our own voice', () => {
  it('has a sixth guard, and it is the last one in the chain', () => {
    const s = appSrc();
    const start = s.indexOf('const suppressed =');
    assert.notEqual(start, -1, 'the suppression chain must still exist');
    const chain = s.slice(start, s.indexOf(': null;', start));
    for (const existing of [
      /pin-gate-closed/, /voice-turn-already-active/, /s2s-session-already-active/,
      /mythos-is-speaking/, /voice-state-speaking/,
    ]) {
      assert.match(chain, existing, 'the five existing guards must all survive');
    }
    assert.match(chain, /own-audio-within-detector-window/, 'and the sixth must be present');
    // Last on purpose: the five before it are cheaper and more specific, and a
    // suppression reason is a diagnostic — 'pin-gate-closed' is far more useful in a
    // log than a window hit that happens to also be true.
    assert.ok(chain.indexOf('own-audio-within-detector-window') > chain.indexOf('voice-state-speaking'),
      'the new guard must not shadow the more specific reasons above it');
  });

  it('compares an AGE against the detector-reported window, not a literal', () => {
    const s = appSrc();
    assert.match(s, /const audioAgeMs = _lastAssistantAudioAt \? Date\.now\(\) - _lastAssistantAudioAt : Infinity;/,
      'a timestamp, because "was MYTHOS speaking at any point in the window" is the '
      + 'question a boolean cannot answer');
    assert.match(s, /wakeword\.receptiveFieldMs\(\)/,
      'the window must be read from the detector — a copied constant drifts the first '
      + 'time a model ships a different classifierWindow');
    assert.match(s, /audioAgeMs < windowMs/);
  });

  it('opens the window from the speech-chunk stream, before playback is audible', () => {
    const s = appSrc();
    const start = s.indexOf("subscribe(['speech-chunk']");
    assert.notEqual(start, -1);
    const block = s.slice(start, s.indexOf('});', start));
    assert.match(block, /noteAssistantAudio\(\);/,
      'a chunk on the wire is the earliest honest signal that our own audio is coming, '
      + 'and it does not depend on which of the three TTS engines won the chain');
  });

  it("also opens on a voice-state transition into 'speaking', covering the Live bridge", () => {
    const s = appSrc();
    const start = s.indexOf('function onVoiceState(s) {');
    assert.notEqual(start, -1);
    const fn = s.slice(start, s.indexOf('\n}', start));
    assert.match(fn, /if \(s === 'speaking'\) noteAssistantAudio\(\);/,
      's2s is constructed with onState: onVoiceState and calls setVoiceState(\'speaking\') '
      + 'from onSpeakStart, so this covers Live audio as well as voice-loop playback');
  });

  it('Q1 — media the operator asked for does NOT feed the window', () => {
    const s = appSrc();
    // The PLAYBACK_TOOLS subscriber is the Spotify/YouTube echo guard. It has its own
    // narrower mechanism (suspendForMedia, opening burst only) precisely so that music
    // the operator requested does not deafen the wake word, and this fix must not
    // quietly widen that.
    const start = s.indexOf('const PLAYBACK_TOOLS =');
    assert.notEqual(start, -1, 'the media echo guard must still exist');
    // Bounded by the NEXT subscribe, not by a later function: the speech-chunk
    // subscriber — which does call noteAssistantAudio, correctly — sits between
    // PLAYBACK_TOOLS and ensureVoice, so a wider window reads as a violation on
    // correct code. Third time this file family has been bitten by a source window
    // that was one anchor too generous.
    const end = s.indexOf("subscribe(['speech-chunk']", start);
    assert.ok(end > start, 'the speech-chunk subscriber must still follow the media guard');
    const block = s.slice(start, end);
    assert.doesNotMatch(block, /noteAssistantAudio/,
      'Spotify is not MYTHOS speaking — suppressing the wake word for it would make the '
      + 'assistant unreachable for as long as music plays');
  });

  it('Q2 — a suppression reports the margin, not just the verdict', () => {
    const s = appSrc();
    const start = s.indexOf("reportWakeword('detected-suppressed', 'wake word detected but not acted on'");
    assert.notEqual(start, -1);
    const call = s.slice(start, s.indexOf('});', start));
    assert.match(call, /ownAudioAgeMs:/,
      'without the age, the next session cannot tell "correctly rejected our own greeting" '
      + 'from "the window is too wide and ate the operator"');
    assert.match(call, /detectorWindowMs:/, 'and the threshold it was compared against');
    assert.match(call, /score:/, 'the score stays — it is what made BUG-150 diagnosable');
  });
});
