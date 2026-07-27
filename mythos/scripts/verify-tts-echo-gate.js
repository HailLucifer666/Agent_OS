#!/usr/bin/env node
'use strict';

// verify-tts-echo-gate.js — verification harness for BUG-027.
//
// BUG-027: browser echo-cancellation wasn't reliably preventing MYTHOS's own
// spoken TTS replies (over open-air speakers) from being re-picked-up by the
// mic and transcribed as a new user turn, causing hallucinated tool calls.
// The fix adds a hard `assistantSpeaking` mechanical gate in
// ui/public/js/voice/voice-loop.js: while true, vadTick() refuses to arm a
// new MediaRecorder no matter how loud the input is.
//
// BUGS.md classifies this item as GROUP: blocked — "No automated test
// harness exists for this browser-only module; verification requires an
// actual voice conversation with a real microphone and speakers." That is a
// physical acceptance test: a human speaking near open-air speakers while
// MYTHOS talks back, confirming by ear/transcript that its own voice is never
// mistaken for a new command. No autonomous process can supply that: there is
// no human to speak or judge naturalness, and — more fundamentally — no way
// to make sound leave a real speaker, travel through open air, and land back
// in a real microphone as a genuine acoustic event, which is the literal
// failure mode this bug is about. Feeding a canned tone through Chrome's
// --use-fake-device-for-media-stream flag would only prove the mechanical
// assistantSpeaking state machine holds under an artificial substitute input
// (already covered by test/voice-barge-in-decision.test.js's unit coverage of
// decideBargeIn()) — not that real acoustic leakage is actually suppressed.
// That is why this item sits in 'blocked', not 'human-live'.
//
// This script does the two things that ARE honestly checkable without a
// human/hardware loop:
//   1. Statically confirms the shipped assistantSpeaking gate still exists
//      and is wired the way BUGS.md's Files section describes: the flag
//      declaration, both set-true call sites (chunked + non-chunked TTS
//      start), the set-false call site (playback drained/stopped), and the
//      vadTick() gate check sitting BEFORE the normal speech-detection path.
//      This is a source-structure check, not a behavioral proof.
//   2. Confirms the real precondition (a human + a real open-air
//      speaker->microphone acoustic loop) is actually absent from this
//      session, so the bug's own stated acceptance test cannot be run.
//
// Reports SKIP in the normal case (never a fabricated PASS). Only reports
// FAIL if the static check in step 1 finds the gate missing or rewired in a
// way that would defeat it — that much a source read can honestly prove.
//
// Usage:
//   node scripts/verify-tts-echo-gate.js

const fs = require('fs');
const path = require('path');
const { log } = require('./verify-lib');

const VOICE_LOOP_PATH = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js');

function sliceFunctionBody(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) return null;
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

function lineOfSubstring(src, substring) {
  const idx = src.indexOf(substring);
  if (idx === -1) return null;
  return src.slice(0, idx).split(/\r?\n/).length;
}

async function main() {
  log('🧪', 'BUG-027 TTS-echo assistantSpeaking gate — static-wiring + precondition check');

  if (!fs.existsSync(VOICE_LOOP_PATH)) {
    console.log(`FAIL: ${VOICE_LOOP_PATH} does not exist`);
    process.exit(1);
  }
  const src = fs.readFileSync(VOICE_LOOP_PATH, 'utf8');

  let allOk = true;

  // 1. Flag declared, defaulting false.
  const declLine = lineOfSubstring(src, 'let assistantSpeaking = false;');
  if (declLine) log('✅', `assistantSpeaking flag declared — line ${declLine}`);
  else { log('❌', 'assistantSpeaking flag declaration NOT FOUND'); allOk = false; }

  // 2. Set true when chunked TTS playback starts (playNextChunk).
  const playNextChunkBody = sliceFunctionBody(src, 'function playNextChunk(session) {', 'function speakChunkFallback(');
  if (playNextChunkBody && /assistantSpeaking\s*=\s*true;/.test(playNextChunkBody)) {
    log('✅', `assistantSpeaking set true in playNextChunk() — line ${lineOfSubstring(src, playNextChunkBody.match(/assistantSpeaking\s*=\s*true;[^\n]*/)[0])}`);
  } else {
    log('❌', 'assistantSpeaking = true NOT FOUND in playNextChunk() (chunked TTS start)');
    allOk = false;
  }

  // 3. Set true when non-chunked TTS fallback starts (speakFallback).
  const speakFallbackBody = sliceFunctionBody(src, 'function speakFallback(spoken, session) {', 'function finishTurn(');
  if (speakFallbackBody && /assistantSpeaking\s*=\s*true;/.test(speakFallbackBody)) {
    log('✅', `assistantSpeaking set true in speakFallback() — line ${lineOfSubstring(src, speakFallbackBody.match(/assistantSpeaking\s*=\s*true;[^\n]*/)[0])}`);
  } else {
    log('❌', 'assistantSpeaking = true NOT FOUND in speakFallback() (non-chunked TTS start)');
    allOk = false;
  }

  // 4. Set false once playback is drained/stopped (stopSpeaking).
  const stopSpeakingBody = sliceFunctionBody(src, 'function stopSpeaking() {', 'function enqueueChunk(');
  if (stopSpeakingBody && /assistantSpeaking\s*=\s*false;/.test(stopSpeakingBody)) {
    log('✅', `assistantSpeaking set false in stopSpeaking() — line ${lineOfSubstring(src, stopSpeakingBody.match(/assistantSpeaking\s*=\s*false;[^\n]*/)[0])}`);
  } else {
    log('❌', 'assistantSpeaking = false NOT FOUND in stopSpeaking() (playback drained/stopped)');
    allOk = false;
  }

  // 5. vadTick() checks the gate BEFORE the normal speech-detection path runs
  // — i.e. the gate can actually short-circuit arming a new recording, not
  // just exist as dead code after the point that matters.
  const vadTickBody = sliceFunctionBody(src, 'function vadTick() {', 'async function start() {');
  if (vadTickBody) {
    const gateIdx = vadTickBody.indexOf('if (assistantSpeaking)');
    const normalIdx = vadTickBody.indexOf('const speaking = level > SPEECH_RMS;');
    if (gateIdx !== -1 && normalIdx !== -1 && gateIdx < normalIdx && /return;/.test(vadTickBody.slice(gateIdx, normalIdx))) {
      log('✅', 'vadTick() checks assistantSpeaking and returns BEFORE the normal speech-detection path — the gate can actually block a new recording from arming');
    } else {
      log('❌', 'vadTick() gate check missing, or no longer positioned/returning ahead of the normal speech-detection path');
      allOk = false;
    }
  } else {
    log('❌', 'vadTick() function not found');
    allOk = false;
  }

  if (!allOk) {
    console.log('FAIL: the assistantSpeaking gate is missing or no longer wired the way BUGS.md describes');
    process.exit(1);
  }

  log('ℹ️', 'static wiring check: the shipped gate matches BUGS.md\'s Files description — all call sites present, and the gate short-circuits vadTick() ahead of the normal speech-detection path.');

  // ---- Precondition check: is the bug's own stated acceptance test
  // (a live human voice conversation with real open-air speakers + a real
  // microphone) actually runnable in this session? ----
  log('🔍', 'checking precondition: a live human voice conversation with real open-air speakers + a real microphone');
  log('ℹ️', 'this is a non-interactive automated CLI session — no human is present to speak into a microphone, listen to MYTHOS\'s spoken replies over real speakers, or judge by ear whether its own voice ever gets mistaken for a new command.');
  log('ℹ️', 'even on a machine where Windows enumerates a physical microphone/speaker pair, this process has no mechanism to make MYTHOS\'s TTS audio physically leave a speaker, travel through open air, and be re-captured by that microphone as a genuine acoustic event — the exact failure mode BUG-027 describes and the one its BUGS.md entry requires a live human session to confirm is actually suppressed.');
  log('ℹ️', 'a synthetic substitute (Chrome --use-fake-device-for-media-stream feeding a canned tone into a headless browser) would only re-prove the mechanical assistantSpeaking state machine holds under artificial input — the same claim already covered by the static check above and by test/voice-barge-in-decision.test.js\'s existing unit coverage of decideBargeIn(). It would not prove real speaker->mic acoustic leakage is suppressed, so it is not substituted here for a live-conversation PASS.');

  console.log('SKIP: no human operator and no real open-air speaker->microphone acoustic loop available in this automated session — BUG-027\'s stated acceptance test ("an actual voice conversation with a real microphone and speakers") cannot be run here. The static source check above confirms the assistantSpeaking fix is present and correctly wired; that is the only part of this item provable without a live human.');
  process.exit(3);
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
