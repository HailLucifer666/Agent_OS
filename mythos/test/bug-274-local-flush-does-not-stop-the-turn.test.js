'use strict';

// bug-274-local-flush-does-not-stop-the-turn.test.js — why MYTHOS kept talking even
// on the barge-ins that "landed".
//
// THE OPERATOR'S COMPLAINT, unchanged since 2026-08-17: speak, and MYTHOS does not
// stop. Three fixes shipped on 2026-08-19 and each fixed a real defect in the
// AUTHORISATION path (the policy revoking its own grant, the two counters unable to
// coincide, the floor). None of them touched what happens AFTER a barge-in is
// authorised, and that is where the operator's experience is actually decided.
//
// WHAT THE LOCAL BARGE-IN DOES, and all it does:
//
//   player.flush()   discards the PCM chunks already queued in the browser.
//
// It does not tell the server anything — barge-in-backstop.js's own header says so
// ("Local flush only — see barge-in-backstop.js for why nothing is sent to the
// server here"). Gemini therefore keeps generating the rest of its turn, the server
// keeps forwarding every chunk as `live-audio-out`, and s2s-bridge.js's handler
// enqueued each one unconditionally. So the queue was emptied and then immediately
// refilled: a few hundred milliseconds of silence, then MYTHOS carrying on.
//
// THE MEASUREMENT THAT SETTLES IT — $APPDATA/MYTHOS/mythos-server.log, the
// 2026-08-19 session, the same log the other BUG-274 fixes were derived from:
//
//   grep -c '"msg":"voice.live.interrupted"'  ->  0
//
// ZERO server-side interrupts in the entire session. Gemini's own VAD — the thing
// the eager tier exists to hand the decision to, and the only mechanism that can
// actually stop the model mid-turn — never fired once. So on every one of that
// session's holds the model turn ran to completion regardless of what the client
// did locally, including the two holds logged as `barge-in-confirmed`.
//
// WHY GEMINI'S VAD NEVER FIRED, from the same log lines: the operator's held speech
// reaches Gemini as the preroll replay, and the noise gate zeroes most of it —
// `"flushedFrames":84,"flushedZeroed":80,"flushedRaw":4` on the 0.0935 hold, and
// 68 of 81 zeroed on the 0.1344 one. Four raw frames of a burst is not something a
// VAD interrupts on. That is a separate defect (BUG-273 A2's remaining acoustic
// question) and is NOT fixed here; it is the reason the client cannot delegate
// stopping the speech to the server and must stop it locally.
//
// WHAT THIS PINS. After an authorised barge-in, incoming audio for the REST OF THAT
// MODEL TURN is dropped instead of enqueued. That is what makes "speak and MYTHOS
// stops" true without inventing a wire message the frozen Live protocol (V2 spine
// §3) does not have.
//
// Q1 — WHAT ELSE MATCHES THIS? Only a barge-in the policy authorised, which means it
//   already passed the 500ms protected window, the bleed floor and the full 350ms
//   sustain test. What DOES change is the cost of a wrong authorisation: it used to
//   be a few hundred ms of clipped audio, and it is now the remainder of one reply.
//   The mitigation is that none of the authorisation conditions were widened, and
//   the suppression is bounded by one turn — never by a guess about the room.
// Q2 — DOES THIS HIDE EVIDENCE? It would silently eat speech, so it reports: a
//   distinct suspend-transition line with how many chunks it dropped and how it
//   ended. That number is the operator's next argument for or against this fix.
// Q3 — WHO READS IT? scripts/verify-voice-session.js, and the fields go through
//   server/index.js's allowlist (see bug-273-suspend-fields-reach-the-log.test.js —
//   that seam has now dropped a client field three times).
// Q5 — CONSTANTS. One new one, and it is a fail-open window, not a threshold: if the
//   turn never ends, suppression must lift on its own. A suppression that can stick
//   is a permanently mute assistant, which is worse than the bug.
// Q6 — WHAT CLASS IS THIS? "A mechanism that looks like coverage and does nothing" —
//   the class BUG-274 was opened over, third instance. `live-turn-complete` has been
//   broadcast by the server since it was written and, until this change, was read by
//   NOTHING in the HUD: the exact turn boundary this fix needs, already on the wire,
//   unused.
// Q7 — WHAT DID THE TICKET SAY? W1(a) "speaking over MYTHOS stops it". This is the
//   part of (a) that the three earlier fixes could not reach. (b) ghost pickup,
//   (c) first word loss, (d) interruption with media playing, (e) the packaged
//   installer all remain open and are not touched here.
//
// WHY SOURCE-SHAPE. s2s-bridge.js is a browser ES module with no bundler (ui/
// CLAUDE.md) and the suppression lives inside its closure with the rest of the gate;
// exporting it purely to test it would add production surface. Same reasoning, and
// the same shape, as test/s2s-preroll-ring.test.js.
//
// Run: cd mythos && node --test test/bug-274-local-flush-does-not-stop-the-turn.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BRIDGE = fs.readFileSync(
  path.join(ROOT, 'ui', 'public', 'js', 'voice', 's2s-bridge.js'), 'utf8');
// Comments are stripped for the ordering assertions: this file's own prose mentions
// player.enqueue and live-turn-complete, and so does the bridge's.
const CODE = BRIDGE.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('BUG-274 — a local flush does not stop the model turn', () => {
  it('arriving audio is dropped, not enqueued, while a barge-in suppression is active', () => {
    const handler = /onAudioOutMsg = \(msg\) => \{[\s\S]*?\n {4}\};/.exec(CODE);
    assert.ok(handler, 'onAudioOutMsg is no longer where this test can find it');
    const body = handler[0];
    const guardAt = body.indexOf('suppressAudioOut');
    const enqueueAt = body.indexOf('player.enqueue');
    assert.ok(guardAt !== -1,
      'nothing in onAudioOutMsg consults the barge-in suppression, so the server '
      + 'refills the queue the barge-in just emptied and MYTHOS keeps talking');
    assert.ok(enqueueAt !== -1, 'the handler must still enqueue audio in the normal case');
    assert.ok(guardAt < enqueueAt,
      'the suppression is checked AFTER the chunk was already enqueued, which plays it');
    assert.ok(/return;/.test(body.slice(guardAt, enqueueAt)),
      'the suppression branch must return before enqueueing');
  });

  it('suppression is armed by the authorised barge-in door and by nothing else', () => {
    const door = /function stopAssistantSpeech\([\s\S]{0,800}?\n {2}\}/.exec(CODE);
    assert.ok(door, 'stopAssistantSpeech() is missing');
    assert.ok(/armAudioOutSuppression\(/.test(door[0]),
      'the stop-speech door does not arm the suppression, so only the already-queued '
      + 'audio is stopped');
    // One arming site: anything else could suppress a reply the operator never
    // interrupted, which is a mute assistant rather than a responsive one.
    const armSites = (CODE.match(/armAudioOutSuppression\(/g) || []).length;
    assert.equal(armSites, 2,
      `expected exactly one call to armAudioOutSuppression() plus its declaration, `
      + `found ${armSites} occurrences — a second caller can mute a reply nobody interrupted`);
  });

  it('the suppression ends at the turn boundary the server already broadcasts', () => {
    // live-turn-complete has been sent by server/index.js since it was written and
    // read by nothing in the HUD. It is the exact signal this needs.
    assert.ok(/onBroadcast\('live-turn-complete'/.test(CODE),
      'live-turn-complete is still an unread broadcast — the turn boundary is on the '
      + 'wire and the client is not listening');
    assert.ok(/offBroadcast\('live-turn-complete'/.test(CODE),
      'the listener must be unsubscribed in stop(), like every other one here');
    const onTurn = /onTurnCompleteMsg = \(\)[^\n]*\n?/.exec(CODE);
    assert.ok(onTurn && /endAudioOutSuppression\(/.test(onTurn[0]),
      'live-turn-complete must end the suppression');
    // The server winning the race must also clear it: a server interrupt means the
    // turn is already cut, and leaving suppression armed would eat the NEXT reply.
    const onInterrupted = /onInterruptedMsg = \(\) => \{[^}]*\}/.exec(CODE);
    assert.ok(onInterrupted && /endAudioOutSuppression\(/.test(onInterrupted[0]),
      'live-interrupted must end the suppression too, or the next reply is eaten');
  });

  it('the suppression cannot stick: it fails OPEN on an idle window', () => {
    // Q5/§11 bias — "no mechanism over one that can fail open" cuts the other way for
    // a mechanism whose stuck state is silence. If the turn never completes (dropped
    // socket, rotated session), the operator must not be left with a mute assistant.
    assert.ok(/const SUPPRESS_IDLE_MS = \d+/.test(CODE),
      'the fail-open window must be a named constant, not a literal in a setTimeout');
    const end = /function endAudioOutSuppression\([\s\S]{0,900}?\n {2}\}/.exec(CODE);
    assert.ok(end, 'endAudioOutSuppression() is missing');
    assert.ok(/logSuspendTransition\(/.test(end[0]),
      'the suppression must report what it dropped, or it eats speech invisibly');
    assert.ok(/suppressedChunks/.test(end[0]),
      'the count of dropped chunks is the whole instrument — report it');
    const arm = /function armAudioOutSuppression\([\s\S]{0,900}?\n {2}\}/.exec(CODE);
    assert.ok(arm, 'armAudioOutSuppression() is missing');
    assert.ok(/SUPPRESS_IDLE_MS/.test(arm[0]) || /SUPPRESS_IDLE_MS/.test(CODE.slice(CODE.indexOf('function armAudioOutSuppression'))),
      'the idle fail-open timer must be armed with the suppression');
  });

  // The suppression's own log lines are 'barge-in'-prefixed, and TWO consumers in
  // verify-voice-session.js prefix-matched that string. Under the old match every
  // suppression line counted as another landed barge-in in one place and as another
  // barge-in release in the other — inflating the success number in the criterion added
  // to stop exactly that over-report, and shrinking the self-interruption estimate at
  // the same time. This drives the real script rather than asserting on its source.
  describe('the suppression cannot inflate the numbers that measure it', () => {
    // AD-7: derived from os.tmpdir(), never a literal machine path.
    const runOn = (lines) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b274-'));
      const file = path.join(dir, 'session.log');
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      try {
        const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
        return spawnSync(process.execPath,
          [path.join(ROOT, 'scripts', 'verify-voice-session.js'), file],
          { encoding: 'utf8', env });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    const suspend = (reason, extra) => '{"ts":"2026-08-19T10:00:00.000Z","level":"info",'
      + `"msg":"voice.capture-suspend","suspended":false,"reason":"${reason}"${extra || ''}}`;

    it('counts one landing, not four, when three suppression lines follow it', () => {
      const out = runOn([
        '{"ts":"2026-08-19T10:00:00.000Z","level":"info","msg":"live.turn-parts","turnId":1,'
          + '"scFields":"modelTurn,outputTranscription,turnComplete"}',
        suspend('own-voice-hold'),
        suspend('barge-in', ',"heldMs":900,"peakRms":0.12,"bargeVetoed":0'),
        suspend('barge-in-suppression-turn-complete', ',"suppressedChunks":7,"suppressedMs":1400'),
        suspend('barge-in-suppression-idle', ',"suppressedChunks":2,"suppressedMs":2000'),
        suspend('barge-in-suppression-server-interrupted', ',"suppressedChunks":1,"suppressedMs":300'),
      ]);
      const line = (out.stdout || '').split('\n').find((l) => /STOPPED THE SPEECH/.test(l));
      assert.ok(line, `criterion missing from output: ${out.stdout}\n${out.stderr}`);
      assert.match(line, /1 stopped playback/,
        'the three suppression lines were counted as landings — the same over-report this '
        + 'criterion exists to prevent, in a new place');
      assert.match(line, /dropped 10 audio chunk\(s\)/,
        'the suppression must report how much of the turn it dropped');
    });

    it('a log with no suppression lines is read as the older build it is', () => {
      const out = runOn([
        '{"ts":"2026-08-19T10:00:00.000Z","level":"info","msg":"live.turn-parts","turnId":1,'
          + '"scFields":"modelTurn,outputTranscription,turnComplete"}',
        suspend('barge-in-confirmed', ',"heldMs":8445,"peakRms":0.0935,"bargeVetoed":0'),
      ]);
      const line = (out.stdout || '').split('\n').find((l) => /STOPPED THE SPEECH/.test(l));
      assert.ok(line, 'criterion missing from output');
      assert.match(line, /0 stopped playback/,
        'this is the real 2026-08-19 hold: released as barge-in-confirmed by a build whose '
        + 'eager tier never flushed. Reading it as a landing is what produced the false success');
      assert.match(line, /reopened the mic ONLY/, 'and it must say so in words');
    });
  });

  it('DISPOSITION, deliberately unchanged: nothing new is sent to the server', () => {
    // The frozen Live wire protocol (V2 spine §3) has no client-initiated cancel, and
    // AD-1 forbids inventing one. Stopping the speech is therefore a CLIENT-side
    // decision, and the model finishing its turn into a dropped stream is the
    // accepted cost. If a future session adds a real cancel, this test should fail and
    // be updated — it is here to make that a decision rather than a drift.
    const inbound = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    assert.ok(!/msg\.type === 'live-interrupt'/.test(inbound),
      'a client-initiated interrupt route now exists; update this test and the spine');
  });
});
