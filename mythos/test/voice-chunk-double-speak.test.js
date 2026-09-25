'use strict';

// test/voice-chunk-double-speak.test.js — the operator reported on 2026-07-31:
// "the voice glitches, I am hearing 5-6 words repetitions".
//
// Mechanism (voice-loop.js playNextChunk): a chunk whose audio data fails to
// decode makes the <audio> element fire `error` AND reject the promise from
// play(). Both handlers called speakChunkFallback(), which QUEUES a
// SpeechSynthesisUtterance instead of replacing the current one — so one
// sentence-sized chunk (about 5-6 words) was spoken twice in a row. The same
// double fire also advanced the chunk queue twice, skipping the next chunk;
// on the second-to-last chunk that silently dropped the end of the reply.
//
// createChunkCompletion() is the guard. Tested directly (pure, exported for
// exactly this reason — same seam as decideBargeIn/pickSpeechVoice) because the
// queue around it needs Audio and speechSynthesis, which the runner has not
// got. Loaded via dynamic import(), the pattern from pcm-player.test.js.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const VOICE_LOOP_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js')
).href;

describe('chunk completion is idempotent (operator-reported 5-6 word repetition)', () => {
  let createChunkCompletion;

  before(async () => {
    ({ createChunkCompletion } = await import(VOICE_LOOP_URL));
  });

  it('speaks the fallback ONCE when error and play()-rejection both fire', () => {
    let spoken = 0;
    const step = createChunkCompletion({ advance() {}, fallback() { spoken++; } });

    step.fail();   // audio.onerror
    step.fail();   // audio.play().catch — same chunk, same failure

    assert.equal(spoken, 1, 'the same chunk was handed to speechSynthesis twice — the repetition');
  });

  it('advances the queue ONCE when the fallback finishes after a double failure', () => {
    let advanced = 0;
    const step = createChunkCompletion({
      advance() { advanced++; },
      fallback(done) { done(); done(); },   // utterance onend AND onerror both fire
    });

    step.fail();
    step.fail();

    assert.equal(advanced, 1, 'double advance skips the next chunk — the missing tail words');
  });

  it('advances once on normal playback and ignores a late error', () => {
    let advanced = 0;
    let spoken = 0;
    const step = createChunkCompletion({
      advance() { advanced++; },
      fallback() { spoken++; },
    });

    step.done();   // audio.onended — chunk played fine
    step.fail();   // a late error event must not re-speak what was already heard

    assert.equal(advanced, 1);
    assert.equal(spoken, 0, 'a chunk that already played was spoken again');
  });

  it('still falls back exactly once for a chunk that only errors', () => {
    let spoken = 0;
    let advanced = 0;
    const step = createChunkCompletion({
      advance() { advanced++; },
      fallback(done) { spoken++; done(); },
    });

    step.fail();

    assert.equal(spoken, 1, 'the text-only path must still be spoken');
    assert.equal(advanced, 1, 'the queue must still move on');
  });

  it('a missing fallback still advances the queue rather than stalling it', () => {
    let advanced = 0;
    const step = createChunkCompletion({ advance() { advanced++; } });

    step.fail();

    assert.equal(advanced, 1);
  });

  it('playNextChunk routes both audio failure paths through the guard', () => {
    // The guard only helps if it is the thing wired to the handlers. s2s-bridge
    // and the chunk queue need Audio/AudioWorklet/getUserMedia, so the wiring
    // itself is source-checked (the file's own header explains why it has no
    // meaningful Node-side double).
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js'), 'utf8'
    );
    assert.match(src, /audio\.onerror = step\.fail;/);
    assert.match(src, /audio\.play\(\)\.catch\(step\.fail\);/);
    assert.doesNotMatch(
      src, /catch\(\(\) => speakChunkFallback/,
      'an unguarded fallback is wired to a failure path again — that is the repetition bug'
    );
  });
});

// ---------------------------------------------------------------------------
// The other half of what the operator heard: MYTHOS's own TTS being fed back
// into the Live microphone, so Gemini transcribed the entity as the operator
// and answered itself (three times in vault/Episodic/2026-07-31.jsonl).
// ---------------------------------------------------------------------------
describe('S2S half-duplex gate: our own TTS never reaches the Live mic', () => {
  const jsDir = path.join(__dirname, '..', 'ui', 'public', 'js');

  it('the bridge drops capture frames while suspended', () => {
    const src = fs.readFileSync(path.join(jsDir, 'voice', 's2s-bridge.js'), 'utf8');
    // 2026-09-23 (BUG-406): the combined `if (!active || captureSuspended) return;`
    // became two returns with the gate recorder's sample between them — the
    // recorder must see the frames the gate holds. The invariant this test exists
    // for is unchanged and is now asserted as an ORDER inside the frame handler:
    // the suspended return comes before the frame is sent.
    const start = src.indexOf('captureNode.port.onmessage');
    const handler = src.slice(start, src.indexOf('source.connect(captureNode)', start));
    const returnAt = handler.indexOf('if (captureSuspended) return;');
    const sendAt = handler.indexOf("sendMessage({ type: 'live-audio'");
    assert.ok(returnAt !== -1 && sendAt !== -1 && returnAt < sendAt,
      'suspended capture must stop sending live-audio frames');
    assert.match(src, /function setCaptureSuspended\(/);
    assert.match(src, /setCaptureSuspended,/, 'the gate must be on the public API');
  });

  it('the gate fails OPEN so a stuck speaking state cannot leave Live deaf', () => {
    const src = fs.readFileSync(path.join(jsDir, 'voice', 's2s-bridge.js'), 'utf8');
    assert.match(src, /MAX_SUSPEND_MS/);
    assert.match(src, /captureSuspended = false;\s*\/\/ fail open/);
  });

  it('media playback still suspends capture (Stage 5\'s territory, unaffected here)', () => {
    const src = fs.readFileSync(path.join(jsDir, 'voice', 's2s-bridge.js'), 'utf8');
    assert.match(src, /function suspendForMedia\(/);
    assert.match(src, /suspendForMedia,/, 'the media gate must stay on the public API');
  });

  // Stage 2 (BUG-060): the own-TTS suspend that used to live in app.js's
  // onVoiceState ("setCaptureSuspended(s === 'speaking')") is gone. It was a
  // symptom-level workaround for proactiveSpeak() emitting edge-tts audio
  // while a Live session's mic was open; server/index.js's proactiveSpeak()
  // now checks for an open Live session and routes text through the
  // session's own sendText() instead, so there is no more own-TTS audio for
  // this bridge to ever hear — the workaround is dead code, not a live gate.
  it('app.js no longer suspends Live capture for the voice loop\'s own "speaking" state', () => {
    const src = fs.readFileSync(path.join(jsDir, 'app.js'), 'utf8');
    assert.doesNotMatch(
      src, /setCaptureSuspended\(s === 'speaking'\)/,
      "own-TTS speech-chunk audio no longer plays while Live is open (proactiveSpeak routes through sendText instead), " +
      "so this mic-suspend workaround must be gone, not merely dormant"
    );
  });
});
