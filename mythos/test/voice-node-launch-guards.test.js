'use strict';

// Voice Nodes — source-shape guards for three defects that a green build and a
// green unit suite both report as fine, and that only appear on a real device.
//
// WHY THIS FILE IS SHAPED LIKE THIS. Each hazard below is a RUNTIME contract of
// the Android platform or a library: invisible to the Kotlin compiler, and
// untestable in a JVM unit test because reproducing it needs a real Looper, a real
// keystore, or a revoked permission. The repo has an established precedent for
// exactly this situation — test/electron-cursor-overlay.test.js asserts the SHAPE
// of electron/main.js because the `screen`-module-before-app-ready crash could not
// be caught any other way, and it shipped behind 16 passing tests and a walked
// installer artifact.
//
// These are therefore regression pins, not proof of correctness. They cannot show
// the app runs; they can stop a future edit from silently reintroducing a crash
// that was found by auditing rather than by any signal.
//
// All three were found by reading the phone module for launch-blocking hazards
// AFTER the APK built and every test passed. That is the point.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PHONE = path.join(__dirname, '..', '..', 'nodes', 'phone', 'src', 'main', 'kotlin', 'com', 'mythos', 'nodes', 'phone');

function read(name) {
  return fs.readFileSync(path.join(PHONE, name), 'utf8');
}

// The nodes/ module is a separate Gradle build that a contributor need not have.
// Skip honestly rather than fail if it is absent — but do NOT skip if it exists
// and is merely broken.
const present = fs.existsSync(PHONE);

describe('voice node — launch-blocking hazards stay fixed', () => {
  it('ExoPlayer access is marshalled to a single Looper', (t) => {
    if (!present) return t.skip('nodes/phone not present in this checkout');
    const src = read('SpeechPlayer.kt');

    // ExoPlayer binds to the Looper of the thread that built it and throws
    // IllegalStateException("Player is accessed on the wrong thread") on ANY
    // cross-thread access. Every caller in VoiceNodeService is a coroutine on
    // Dispatchers.Default, so direct access crashed the service on the FIRST
    // speech chunk: the app installed, connected, looked healthy, and died the
    // moment MYTHOS spoke.
    assert.match(src, /setLooper\(/,
      'the player must pin its Looper explicitly, not inherit whatever thread constructs it');
    assert.match(src, /private inline fun onMain|private fun onMain/,
      'mutations must be marshalled onto that Looper');
    assert.match(src, /Looper\.myLooper\(\) == Looper\.getMainLooper\(\)/,
      'the marshaller must run inline when already on the right thread, or it can deadlock on itself');

    // isPlaying is read by the wake-word gate on every detection frame. A
    // cross-thread getter would either throw or block that hot path, so it must be
    // served from a cached flag the player updates.
    assert.match(src, /@Volatile\s+private var playingCached/,
      'isPlaying must be cached, not read across threads');
    assert.match(src, /val isPlaying: Boolean get\(\) = playingCached/,
      'isPlaying must return the cache');
  });

  it('the foreground-service type is derived from granted permissions', (t) => {
    if (!present) return t.skip('nodes/phone not present in this checkout');
    const src = read('VoiceNodeService.kt');

    // From API 34 a declared FGS type must be backed by a granted permission:
    // claiming FOREGROUND_SERVICE_TYPE_MICROPHONE without RECORD_AUDIO throws
    // SecurityException and kills the service. The UI grants mic before starting
    // the service, but START_STICKY means Android also restarts it with a null
    // intent — by which time the operator may have revoked it in settings.
    assert.match(src, /checkSelfPermission\(Manifest\.permission\.RECORD_AUDIO\)/,
      'the mic FGS type must be conditional on the permission actually being held');
    assert.match(src, /FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/,
      'the scanner type must remain so a mic-less node still works as a proximity node');
    // The unconditional both-types call is what threw. Guard against its return.
    assert.doesNotMatch(
      src,
      /startForeground\(\s*NOTIFICATION_ID,\s*notification,\s*ServiceInfo\.FOREGROUND_SERVICE_TYPE_MICROPHONE/,
      'must not claim the microphone type unconditionally'
    );
  });

  it('a failed mic start reports why instead of silently returning to idle', (t) => {
    if (!present) return t.skip('nodes/phone not present in this checkout');
    const mic = read('MicRecorder.kt');
    const svc = read('VoiceNodeService.kt');

    // AudioRecord's constructor throws SecurityException with no RECORD_AUDIO and
    // when another app holds the mic exclusively; startRecording() throws
    // IllegalStateException. Uncaught, any of them takes the foreground service
    // down on the operator's first press.
    assert.match(mic, /catch \(e: SecurityException\)/, 'the constructor must be guarded');
    assert.match(mic, /catch \(e: IllegalStateException\)/, 'startRecording must be guarded');
    assert.match(mic, /var lastError: String\?/, 'the reason must be recoverable by the caller');

    // And the reason must reach the screen: a press that does nothing, with
    // nothing to read, is the worst version of this failure.
    assert.match(svc, /_micStatus\.value = recorder\.lastError/,
      'the service must surface the mic error rather than just going IDLE');
  });

  it('unreadable secure storage resets instead of killing the node, and never falls back to plaintext', (t) => {
    if (!present) return t.skip('nodes/phone not present in this checkout');
    const src = read('NodeSettings.kt');

    // EncryptedSharedPreferences.create() throws on a restored/reset keystore —
    // an ordinary situation, not an exotic one — and it is reached from the
    // service's start path.
    assert.match(src, /deleteSharedPreferences\(PREFS_NAME\)/,
      'an unreadable store must be cleared and rebuilt rather than crashing at launch');
    assert.match(src, /storeWarning/, 'the reset must be visible, not silent');

    // The auth token guards MYTHOS's whole tool surface. Degrading to plaintext
    // storage would be the wrong trade, and made invisibly.
    assert.doesNotMatch(src, /getSharedPreferences\(/,
      'must not fall back to unencrypted SharedPreferences');
  });
});
