'use strict';

// test/electron-screen-share.test.js — Step 7 / Phase 8, Electron Slice 3
// (desktopCapturer), spine §13: "desktopCapturer — Live accepts video. This
// unlocks true 'watch my screen and tell me what you see' continuous multimodal,
// which is strictly better than the polling screen-sensor.js and is the one IRIS
// capability that genuinely needs Electron."
//
// Four layers, tested at the level each one can honestly be tested at:
//
//   1. live-session.js  — sendVideoFrame() puts a §3-legal frame on the wire.
//      Real unit test against a stubbed socket (the frozen wire protocol is
//      assertable without a network).
//   2. server/index.js  — the `live-video` WS branch forwards to the session.
//      Source-shape, per the precedent set by electron-ocr-hotkey.test.js: the
//      branch lives inside a 2,000-line ws.on('message') closure with no seam
//      to require, so a shape guard is what's available and it does catch the
//      regression that matters (branch deleted / renamed / wired to the wrong
//      method).
//   3. electron/main.js — setDisplayMediaRequestHandler is registered and
//      resolves a real screen source. Source-shape for the same reason
//      electron-talk-hotkey.test.js is: requiring electron/main.js executes
//      app.whenReady() against a real Electron runtime that does not exist
//      under `node --test`.
//   4. AD-8 regression — Slice 3 must NOT widen the preload contextBridge
//      surface. getDisplayMedia() is a renderer-native call granted by a
//      main-process handler, so no new channel is needed; this test pins that
//      no new channel appeared, which is the whole reason this design was
//      chosen over a preload-mediated capture.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MYTHOS_DIR = path.join(__dirname, '..');

function readSource(...segs) {
  return fs.readFileSync(path.join(...segs), 'utf8');
}

// ---------------------------------------------------------------------------
// Layer 1 — live-session.js sendVideoFrame(): the real wire contract.
// ---------------------------------------------------------------------------

// Reuses live-session.js's own `createSocket` injection seam — the same idiom as
// test/live-session.test.js. No require-cache surgery and no network: the session
// is handed a fake socket by construction.
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
}

function fakeDeps(overrides) {
  const sockets = [];
  const deps = Object.assign({
    // LIVE_SCREEN_SHARE_ENABLED must be explicitly true here as of 2026-08-05.
    // These tests originally ran with an empty config because sendVideoFrame had
    // no opt-in gate at all — which was finding C2 of the first security review of
    // this surface: the flag was enforced ONLY in renderer JS, so anything that
    // reached the local socket could stream frames to Gemini with screen share
    // "off". The gate now lives in sendVideoFrame and fails closed on an absent
    // flag, so a test asserting the HAPPY path has to opt in like a real operator
    // does. The refusal paths are covered in test/screen-share-security.test.js.
    config: { LIVE_SCREEN_SHARE_ENABLED: true },
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut() {}, onTranscript() {}, onState() {}, onTurnComplete() {},
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  }, overrides || {});
  return { deps, sockets };
}

test('Slice 3 / live-session: sendVideoFrame is part of the public session API', () => {
  const src = readSource(MYTHOS_DIR, 'src', 'core', 'voice', 'live-session.js');
  assert.match(src, /function sendVideoFrame\s*\(/,
    'live-session.js must define sendVideoFrame() — the Live video input path');
  assert.match(src, /return\s*\{[^}]*sendVideoFrame/s,
    'sendVideoFrame must be returned on the session object, or server/index.js cannot call it');
});

test('Slice 3 / live-session: sendVideoFrame emits a §3-legal realtimeInput.video frame', async () => {
  const { deps, sockets } = fakeDeps();
  process.env.GOOGLE_API_KEY = 'test-key';
  const session = createLiveSession(deps);
  const openPromise = session.open();
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  assert.equal(await openPromise, true);

  // The setup frame is already on the wire; clear so we assert only the video.
  sockets[0].sent.length = 0;

  const ok = session.sendVideoFrame('AAAAbase64jpegAAAA');
  assert.equal(ok, true, 'sendVideoFrame must report success on an open session');
  assert.equal(sockets[0].sent.length, 1, 'exactly one frame on the wire');

  const frame = sockets[0].sent[0];
  // §3: a client frame has EXACTLY ONE top-level key.
  assert.deepEqual(Object.keys(frame), ['realtimeInput'],
    'a video frame must carry exactly one top-level key, realtimeInput (spine §3)');
  assert.deepEqual(Object.keys(frame.realtimeInput), ['video']);
  assert.equal(frame.realtimeInput.video.mimeType, 'image/jpeg');
  assert.equal(frame.realtimeInput.video.data, 'AAAAbase64jpegAAAA');
  session.close();
});

test('Slice 3 / live-session: sendVideoFrame on a closed session is a no-op, not a throw', () => {
  const { deps, sockets } = fakeDeps();
  const session = createLiveSession(deps);
  // Never opened — state is 'idle', and no socket has even been created.
  const ok = session.sendVideoFrame('ZZZZ');
  assert.equal(ok, false, 'must report false rather than throwing (mirrors sendAudio)');
  assert.equal(sockets.length, 0, 'nothing may reach the wire before the session is open');
});

test('Slice 3 / live-session: an empty or non-string frame is refused', () => {
  const { deps, sockets } = fakeDeps();
  process.env.GOOGLE_API_KEY = 'test-key';
  const session = createLiveSession(deps);
  const openPromise = session.open();
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  return openPromise.then(() => {
    sockets[0].sent.length = 0;
    // A canvas that failed to encode yields '' or undefined. Sending that would
    // spend a request on a frame carrying no image.
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.equal(session.sendVideoFrame(bad), false, `must refuse ${JSON.stringify(bad)}`);
    }
    assert.equal(sockets[0].sent.length, 0, 'no empty frame may reach the wire');
    session.close();
  });
});

test('Slice 3 / live-session: video frames must NOT re-arm the idle timer', () => {
  // Load-bearing, and the reason this test exists: LIVE_IDLE_TIMEOUT_MS closes a
  // session nobody is talking to, which is what stops an unattended room from
  // burning the operator's BYO Gemini quota. A screen-share frame is not speech.
  // If sendVideoFrame() called armIdle() the way sendAudio() does, an idle
  // machine with screen share on would hold a Live session open indefinitely at
  // real token cost. sendAudio arms the timer; sendVideoFrame must not.
  const src = readSource(MYTHOS_DIR, 'src', 'core', 'voice', 'live-session.js');
  const fnStart = src.indexOf('function sendVideoFrame');
  assert.ok(fnStart > -1, 'sendVideoFrame must exist');
  const body = src.slice(fnStart, src.indexOf('\n  }', fnStart));
  assert.ok(!/armIdle\s*\(/.test(body),
    'sendVideoFrame must NOT call armIdle() — video is not speech, and arming on '
    + 'video keeps an unattended session alive at real cost');
});

// ---------------------------------------------------------------------------
// Layer 2 — server/index.js `live-video` WS branch.
// ---------------------------------------------------------------------------

test('Slice 3 / server: a live-video WS message forwards to liveSession.sendVideoFrame', () => {
  const src = readSource(MYTHOS_DIR, 'server', 'index.js');
  assert.match(src, /msg\.type === 'live-video'/,
    "server/index.js must handle {type:'live-video'} on the HUD socket");
  // Widened from a single-line slice to the whole branch on 2026-08-05: the
  // branch stopped being a one-liner when the security review's finding C2 added
  // the server-side LIVE_SCREEN_SHARE_ENABLED check. The two things this test
  // guards — the right method, and the liveSession guard — are both still
  // asserted; only the window they are read from changed.
  const branch = src.slice(src.indexOf("msg.type === 'live-video'"), src.indexOf("msg.type === 'live-close'"));
  assert.match(branch, /sendVideoFrame\(/,
    'the live-video branch must call sendVideoFrame — not sendAudio, not sendText');
  assert.match(branch, /if \(liveSession\s*&&/,
    'must still guard on liveSession, so a frame arriving before live-open is a '
    + 'no-op rather than a TypeError');
  assert.match(branch, /LIVE_SCREEN_SHARE_ENABLED/,
    'and must refuse when screen share is not enabled — this socket is '
    + 'unauthenticated for loopback callers on stock config');
});

// ---------------------------------------------------------------------------
// Layer 3 — electron/main.js display-media handler.
// ---------------------------------------------------------------------------

test('Slice 3 / electron: setDisplayMediaRequestHandler is registered', () => {
  const src = readSource(REPO_ROOT, 'electron', 'main.js');
  assert.match(src, /setDisplayMediaRequestHandler\s*\(/,
    'without this handler Electron denies getDisplayMedia() outright and screen '
    + 'share silently fails — the same class of bug as the mic denial fixed in Slice 1');
  assert.match(src, /desktopCapturer/,
    'the handler must resolve a real source via desktopCapturer (spine §13)');
  assert.match(src, /types:\s*\[\s*'screen'\s*\]/,
    "must request 'screen' sources — the whole point is the desktop, not a window");
});

test('Slice 3 / electron: no screen source degrades honestly instead of hanging', () => {
  const src = readSource(REPO_ROOT, 'electron', 'main.js');
  // Anchored on the handler itself, not the first mention of its name. Until
  // 2026-09-29 the 1600-character window from that first mention reached only an
  // unrelated `} catch (_)` in the requester lookup, never getSources()'s own
  // .catch — so the assertion below passed without seeing the path it names.
  const start = src.indexOf('setDisplayMediaRequestHandler((request, callback)');
  const region = src.slice(start, start + 2600);
  assert.match(region, /getSources\([^)]*\)\.then\([\s\S]*?\}\)\.catch\(\(err\) =>/,
    'the rejection of getSources() itself must be caught');
  // The handler's callback MUST be invoked on every path. An un-invoked callback
  // leaves the renderer's getDisplayMedia() promise pending forever, which looks
  // exactly like a hung app (AD-9's "degrade, never hang" in spirit).
  assert.match(region, /callback\(\{\}\)/,
    'the empty-source and error paths must call callback({}) to deny explicitly — '
    + 'a never-invoked callback hangs getDisplayMedia() forever');
  assert.match(region, /catch/,
    'getSources() can reject (no display, permission revoked) — that must be caught');
});

// ---------------------------------------------------------------------------
// Layer 4 — AD-8: the preload surface must not grow.
// ---------------------------------------------------------------------------

test('Slice 3 / AD-8: screen share adds NO new preload contextBridge channel', () => {
  const src = readSource(REPO_ROOT, 'electron', 'preload.js');
  // The exact Slice 1 surface, plus the Slice 2 hotkey listener already pinned by
  // electron-preload-surface.test.js. Slice 3 must add nothing: getDisplayMedia is
  // called by the renderer directly and granted in the main process.
  for (const forbidden of ['getDisplayMedia', 'desktopCapturer', 'getSources', 'captureScreen']) {
    assert.ok(!src.includes(forbidden),
      `preload.js must not expose ${forbidden} — the renderer calls getDisplayMedia() `
      + 'natively and the main process grants it, so no bridge channel is needed');
  }
});

// ---------------------------------------------------------------------------
// Config surface.
// ---------------------------------------------------------------------------

test('Slice 3 / config: screen share is opt-in and reaches the HUD via /api/config/s2s', () => {
  const { SCHEMA } = require('../src/core/config/schema.js');
  assert.ok(SCHEMA.LIVE_SCREEN_SHARE_ENABLED, 'LIVE_SCREEN_SHARE_ENABLED must exist');
  assert.equal(SCHEMA.LIVE_SCREEN_SHARE_ENABLED.default, false,
    'streaming the operator\'s screen to Google must be opt-in, never a default');
  assert.equal(SCHEMA.LIVE_SCREEN_FPS.type, 'number');
  assert.ok(SCHEMA.LIVE_SCREEN_FPS.default <= 2,
    'default frame rate must stay low — every frame is a billed image token');

  // The HUD has no other way to learn the flag; this is the same gap that left
  // s2s-bridge.js unreachable until /api/config/s2s existed.
  const route = readSource(MYTHOS_DIR, 'server', 'routes', 'config.js');
  assert.match(route, /LIVE_SCREEN_SHARE_ENABLED/,
    '/api/config/s2s must report screen-share availability or the HUD can never start it');
});

test('Slice 3 / config: every new key is documented in .env.example', () => {
  const env = readSource(MYTHOS_DIR, '.env.example');
  for (const key of ['LIVE_SCREEN_SHARE_ENABLED', 'LIVE_SCREEN_FPS', 'LIVE_SCREEN_JPEG_QUALITY']) {
    assert.ok(env.includes(key), `${key} must be documented in .env.example (repo portability rule)`);
  }
});

// ---------------------------------------------------------------------------
// HUD capture module.
// ---------------------------------------------------------------------------

test('Slice 3 / HUD: screen-share.js captures via getDisplayMedia and sends live-video', () => {
  const src = readSource(MYTHOS_DIR, 'ui', 'public', 'js', 'voice', 'screen-share.js');
  assert.match(src, /getDisplayMedia\s*\(/, 'must capture via getDisplayMedia');
  assert.match(src, /'live-video'/, "must send {type:'live-video'} — the wire shape server/index.js expects");
  assert.match(src, /image\/jpeg/, 'frames must be JPEG — what realtimeInput.video expects');
  assert.match(src, /getTracks\s*\(\)/,
    'stop() must release the capture tracks, or the OS keeps showing a live '
    + 'screen-capture indicator after the session closes');
});

test('Slice 3 / HUD: capture stops when the live session closes', () => {
  // A screen capture that outlives its Live session is both a privacy problem
  // (the OS indicator stays lit) and a cost problem (frames sent into a closed
  // socket). The bridge owns the session lifecycle, so it must own this too.
  const bridge = readSource(MYTHOS_DIR, 'ui', 'public', 'js', 'voice', 's2s-bridge.js');
  assert.match(bridge, /screen-share\.js|screenShare/,
    's2s-bridge.js must drive the screen-share module so capture shares the session lifecycle');
  assert.match(bridge, /stopScreenShare|screenShare\.stop/,
    'the bridge must stop capture on session teardown');
});
