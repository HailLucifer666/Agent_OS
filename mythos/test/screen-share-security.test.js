'use strict';

// test/screen-share-security.test.js — findings from the FIRST security review of
// the Slice 3 screen-share surface (2026-08-05). Slices 1 and 2 each had a
// security-reviewer dispatched before commit; Slice 3 did not, because the
// session that built it was instructed not to spawn agents — and it is the one
// slice that streams the operator's entire desktop to a third party.
//
// Two findings were CRITICAL and both were confirmed by reading the code, not
// inferred:
//
// C1 — setDisplayMediaRequestHandler never inspected `request`, so it granted
//      the primary screen to ANY webContents on the shared default session. That
//      includes electron/media-window.js, a second BrowserWindow with no own
//      `session`/`partition` which loads `payload.url` from the `open_web` tool.
//      A prompt-injected or operator-mistyped URL therefore loads attacker JS in
//      a window that could call getDisplayMedia() and receive the whole desktop
//      with no prompt, no picker and no indicator MYTHOS controls — exfiltrating
//      it over its own fetch(), never touching MYTHOS's WS or Gemini at all.
//      LIVE_SCREEN_SHARE_ENABLED was irrelevant to that path.
//
// C2 — the `live-video` WS branch forwarded frames to Gemini with no server-side
//      check of LIVE_SCREEN_SHARE_ENABLED. The flag was enforced ONLY in
//      renderer JS (s2s-bridge.js), so main.js's own comment — "the renderer
//      still cannot start capture unopted — LIVE_SCREEN_SHARE_ENABLED gates it
//      server-side" — was false. On stock defaults (no MYTHOS_AUTH_TOKEN,
//      PIN_SESSION_ENFORCE false, VOICE_S2S_ENABLED true) any local non-browser
//      process can open the loopback WS with no Origin header, send live-open
//      then live-video, and bill arbitrary images to the operator's own key.
//
// The gate for C2 lives in live-session.js's sendVideoFrame rather than only in
// the server branch, deliberately: it is the single choke point every caller
// must pass to reach the wire, so a future second call site cannot reintroduce
// the hole. The server branch checks too — refusing before touching the session
// is cheaper and says so in the audit-visible place.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MYTHOS_DIR = path.join(__dirname, '..');
const { createLiveSession } = require('../src/core/voice/live-session');

function readSource(...segs) {
  return fs.readFileSync(path.join(...segs), 'utf8');
}

// Same FakeSocket/fakeDeps idiom as test/electron-screen-share.test.js and
// test/live-session.test.js — live-session.js's own `createSocket` injection
// seam, so no network and no require-cache surgery. `send` stores parsed objects.
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

// The session only reaches state 'open' after the socket opens AND the server
// sends setupComplete — a bare await open() would hang.
async function openSession(overrides) {
  const { deps, sockets } = fakeDeps(overrides);
  process.env.GOOGLE_API_KEY = 'test-key';
  const session = createLiveSession(deps);
  const openPromise = session.open();
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  assert.equal(await openPromise, true, 'the fake session must reach open');
  const socket = sockets[0];
  socket.sent.length = 0; // drop the setup frame
  return { session, socket };
}

function videoFrames(socket) {
  return socket.sent.filter((m) => m && m.realtimeInput && m.realtimeInput.video);
}

// ---------------------------------------------------------------------------
// C2 — the opt-in flag must be enforced on the server, not only in the browser.
// ---------------------------------------------------------------------------

test('C2: with LIVE_SCREEN_SHARE_ENABLED off, a frame never reaches the wire', async () => {
  const { session, socket } = await openSession({ config: { LIVE_SCREEN_SHARE_ENABLED: false } });
  const accepted = session.sendVideoFrame('AAAA');
  assert.equal(accepted, false, 'sendVideoFrame must refuse when the operator has not opted in');
  assert.equal(videoFrames(socket).length, 0,
    'a desktop frame reached Gemini with screen share disabled — the flag is not a real gate');
  session.close('test');
});

test('C2: an ABSENT flag is treated as off, not as permission', async () => {
  // The stock config object has the key; a caller constructing a session with a
  // partial config must not thereby enable desktop streaming. Fail closed.
  const { session, socket } = await openSession({ config: {} });
  assert.equal(session.sendVideoFrame('AAAA'), false);
  assert.equal(videoFrames(socket).length, 0, 'a missing flag must never mean "allowed"');
  session.close('test');
});

test('C2: with the flag on, a frame still goes through (the gate is not a blanket block)', async () => {
  const { session, socket } = await openSession();
  assert.equal(session.sendVideoFrame('AAAA'), true);
  assert.equal(videoFrames(socket).length, 1, 'the opted-in path must keep working');
  session.close('test');
});

test('C2: the server\'s live-video branch checks the flag before touching the session', () => {
  const src = readSource(MYTHOS_DIR, 'server', 'index.js');
  const idx = src.indexOf("msg.type === 'live-video'");
  assert.ok(idx !== -1, "server/index.js must still handle {type:'live-video'}");
  const branch = src.slice(idx, idx + 600);
  assert.match(branch, /LIVE_SCREEN_SHARE_ENABLED/,
    'the live-video branch must refuse when screen share is not enabled — a local process can reach this socket with no token on stock defaults');
});

// ---------------------------------------------------------------------------
// HIGH — nothing bounded frame size or rate below ws's 100MB default.
// ---------------------------------------------------------------------------

test('HIGH: an oversized frame is refused rather than billed', async () => {
  const { session, socket } = await openSession({
    config: { LIVE_SCREEN_SHARE_ENABLED: true, LIVE_SCREEN_MAX_FRAME_KB: 1 },
  });
  const tooBig = 'A'.repeat(4096); // 4KB of base64 against a 1KB ceiling
  assert.equal(session.sendVideoFrame(tooBig), false, 'an over-ceiling frame must be refused');
  assert.equal(videoFrames(socket).length, 0);
  session.close('test');
});

test('HIGH: frames are rate-limited server-side, not only by the renderer\'s timer', async () => {
  const { session, socket } = await openSession({
    config: { LIVE_SCREEN_SHARE_ENABLED: true, LIVE_SCREEN_FPS: 0.5 },
  });
  // The legitimate client sends at 0.5 fps. A direct WS caller has no such
  // timer, so the ceiling has to live here.
  const results = [];
  for (let i = 0; i < 10; i++) results.push(session.sendVideoFrame('AAAA'));
  const accepted = results.filter(Boolean).length;
  assert.equal(accepted, 1, `a burst of 10 frames must not all be forwarded (accepted ${accepted})`);
  assert.equal(videoFrames(socket).length, 1);
  session.close('test');
});

test('HIGH: a refused frame does not consume the rate budget', async () => {
  // Ordering matters: if an invalid or over-size frame stamped the clock, a
  // malformed burst would lock out the operator's own next real frame.
  const { session, socket } = await openSession({
    config: { LIVE_SCREEN_SHARE_ENABLED: true, LIVE_SCREEN_MAX_FRAME_KB: 1 },
  });
  assert.equal(session.sendVideoFrame('A'.repeat(4096)), false);
  assert.equal(session.sendVideoFrame(''), false);
  assert.equal(session.sendVideoFrame('AAAA'), true, 'the first VALID frame must still be accepted');
  assert.equal(videoFrames(socket).length, 1);
  session.close('test');
});

// ---------------------------------------------------------------------------
// C1 — the Electron grant must be scoped to the HUD window.
// Source-shape assertions, following the precedent set by
// test/electron-screen-share.test.js and test/electron-cursor-overlay.test.js:
// the real handler cannot run without a live Electron app.
// ---------------------------------------------------------------------------

test('C1: the display-media handler inspects the requesting frame instead of granting blindly', () => {
  const src = readSource(REPO_ROOT, 'electron', 'main.js');
  const idx = src.indexOf('setDisplayMediaRequestHandler');
  assert.ok(idx !== -1, 'the handler must still be registered');
  const handler = src.slice(idx, idx + 2200);
  assert.match(handler, /request\.frame/,
    'the handler must look at request.frame — granting sources[0] to any requester hands the desktop to whatever the media window loaded');
  assert.match(handler, /callback\(\{\}\)/,
    'a non-HUD requester must be denied explicitly, not left with a pending promise');
});

test('C1: the grant is restricted to the main HUD window', () => {
  const src = readSource(REPO_ROOT, 'electron', 'main.js');
  const handler = src.slice(src.indexOf('setDisplayMediaRequestHandler'), src.indexOf('setDisplayMediaRequestHandler') + 2200);
  // The scoping predicate is shared with the two permission handlers, so assert
  // the handler USES it and, separately, that the predicate really compares
  // against the HUD's webContents. Asserting only the call site would pass
  // against a predicate someone had quietly widened to `return true`.
  assert.match(handler, /isHudContents\s*\(/,
    'the handler must gate on the HUD-identity predicate — media-window.js shares this session and loads arbitrary URLs from open_web');
  const predStart = src.indexOf('const isHudContents');
  assert.ok(predStart !== -1, 'isHudContents must exist');
  const pred = src.slice(predStart, predStart + 500);
  assert.match(pred, /mainWindow/, 'isHudContents must compare against mainWindow');
  assert.match(pred, /webContents/, 'isHudContents must compare webContents identity, not a URL or a title');
});

test('C1: display-capture is not blanket-granted by the permission-check handler', () => {
  const src = readSource(REPO_ROOT, 'electron', 'main.js');
  const idx = src.indexOf('setPermissionCheckHandler');
  assert.ok(idx !== -1, 'the permission-check handler must still exist');
  const block = src.slice(idx, idx + 1200);
  // The mic permissions stay blanket-allowed for the loopback HUD; only
  // display-capture is dangerous enough to need the requester checked.
  assert.match(block, /display-capture/, 'display-capture must still be addressed here');
  assert.ok(/webContents|mainWindow/.test(block),
    'display-capture must be decided per requester — a blanket true lets the media window pre-seed the permission');
});

test('C1: media-window.js still shares the default session, and that is why the handler must scope', () => {
  // Deliberately NOT fixed by giving the media window its own partition: the
  // network-level ad/tracker blocking in main.js is registered on
  // session.defaultSession, so isolating the media window would silently
  // disable ad blocking for exactly the surface that shows ads (see BUG-115).
  // The scoping in the handler is the fix; this test records the tradeoff so
  // nobody "hardens" it by splitting the session and breaking ad blocking.
  const src = readSource(REPO_ROOT, 'electron', 'media-window.js');
  const opts = src.slice(src.indexOf('new BrowserWindowCtor('), src.indexOf('new BrowserWindowCtor(') + 700);
  assert.ok(!/partition\s*:/.test(opts),
    'if the media window ever gets its own partition, re-check that ad blocking still applies to it');
});
