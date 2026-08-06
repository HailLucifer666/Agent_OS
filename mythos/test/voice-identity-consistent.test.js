'use strict';

// voice-identity-consistent.test.js — the entity must sound like ONE person.
//
// REPORTED BY THE OPERATOR 2026-07-31, after a real voice session: "at the
// starting there is this British guy, male accent... but then comes the female
// voice." Both were correct behaviour by their own module's lights, which is why
// nothing failed. There are three independent speech engines and the operator
// hears all of them in a single session:
//
//   1. edge-tts, server-side      -> config.VOICE_TTS_VOICE   (boot greeting,
//                                     batch replies, sentence streaming)
//   2. Gemini Live S2S            -> config.GEMINI_LIVE_VOICE (duplex path)
//   3. browser speechSynthesis    -> voice-loop.js fallback when edge-tts is down
//
// (1) defaulted to en-GB-RyanNeural (male) while (2) defaulted to Aoede (female),
// and (3) set no voice at all so it inherited the OS default — Microsoft David,
// male, on Windows. The entity therefore greeted the operator as a British man
// and then answered as a woman.
//
// This file is the gate. It cannot hear, so it does not assert "sounds female" —
// it asserts the two things that are actually checkable: the shipped defaults are
// the specific voices chosen as a matched set, and the browser fallback makes a
// deliberate choice instead of deferring to the OS.
//
// UPDATED 2026-08-06, after the operator reported the same class of fault again:
// "when mythos boots there is one voice, when I speak it is another, and when I
// type it replies with another." Matched *gender* was not enough — three engines
// still meant three people. The real fix is VOICE_UNIFIED_LIVE_VOICE, which makes
// the boot greeting and typed turns speak through the SAME Gemini Live session as
// spoken conversation, so engines (1) and (3) are now fallbacks rather than
// everyday paths. Their voices were retuned from en-GB to en-US to sit closer to
// Aoede, which is what this file now pins.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCHEMA } = require('../src/core/config/schema');

// The matched set. Changing any of these is a deliberate act that should also
// update the other two — that is the whole point of pinning them together here.
const EXPECTED_EDGE_TTS_VOICE = 'en-US-AvaNeural';
const EXPECTED_LIVE_VOICE = 'Aoede';

// Microsoft Neural voice ids that are male. Not exhaustive — it only has to
// catch a regression back to the specific voice this bug shipped with, plus the
// obvious neighbours someone might reach for.
const KNOWN_MALE_NEURAL = [
  'en-GB-RyanNeural', 'en-GB-ThomasNeural', 'en-GB-AlfieNeural', 'en-GB-ElliotNeural',
  'en-US-GuyNeural', 'en-US-DavisNeural', 'en-US-TonyNeural', 'en-US-BrianNeural',
];

describe('voice identity: one entity, one voice, across all three engines', () => {
  test('the edge-tts default is the chosen female voice, not the male one that shipped', () => {
    assert.equal(SCHEMA.VOICE_TTS_VOICE.default, EXPECTED_EDGE_TTS_VOICE);
    assert.ok(!KNOWN_MALE_NEURAL.includes(SCHEMA.VOICE_TTS_VOICE.default),
      'VOICE_TTS_VOICE regressed to a male voice: ' + SCHEMA.VOICE_TTS_VOICE.default);
  });

  test('the Gemini Live default is unchanged, so the two engines stay matched', () => {
    assert.equal(SCHEMA.GEMINI_LIVE_VOICE.default, EXPECTED_LIVE_VOICE);
  });

  test('both engine defaults are female-matched as a SET, not independently', () => {
    // The failure this guards is subtle: each module was individually defensible.
    // Only the pair is wrong. Assert the pair.
    const pair = [SCHEMA.VOICE_TTS_VOICE.default, SCHEMA.GEMINI_LIVE_VOICE.default];
    assert.deepEqual(pair, [EXPECTED_EDGE_TTS_VOICE, EXPECTED_LIVE_VOICE],
      'the edge-tts and Live voices must be changed together — see this file’s header');
  });

  test('the browser fallback sets an explicit voice rather than inheriting the OS default', () => {
    // Source-level, because SpeechSynthesisUtterance does not exist in node.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js'), 'utf8');
    const utterances = src.match(/new SpeechSynthesisUtterance\(/g) || [];
    assert.ok(utterances.length >= 2, 'expected both fallback call sites, found ' + utterances.length);
    const assignments = src.match(/\bu\.voice = v\b/g) || [];
    assert.equal(assignments.length, utterances.length,
      'every SpeechSynthesisUtterance must be assigned a picked voice — ' +
      utterances.length + ' utterances but ' + assignments.length + ' voice assignments');
  });
});

describe('pickSpeechVoice()', () => {
  // Dynamic import: voice-loop.js is a browser ES module. Cache-buster matches
  // the idiom already used by the ws.js test.
  let pickSpeechVoice;
  const load = async () => {
    if (!pickSpeechVoice) {
      const url = 'file:///' + path
        .join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js')
        .replace(/\\/g, '/') + '?t=voiceid';
      ({ pickSpeechVoice } = await import(url));
    }
    return pickSpeechVoice;
  };

  const V = (name, lang) => ({ name, lang });

  test('prefers a higher-ranked en-US female voice over a lower-ranked en-GB one', async () => {
    const pick = await load();
    const chosen = pick([
      V('Microsoft David - English (United States)', 'en-US'),
      V('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
      V('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
    ]);
    // Aria outranks Sonia since 2026-08-06 — the fallback now pairs with
    // en-US-AvaNeural/Aoede, not en-GB-SoniaNeural.
    assert.match(chosen.name, /Aria/);
  });

  test('prefers the preferred locale when the SAME name exists in two variants', async () => {
    const pick = await load();
    const chosen = pick([
      V('Microsoft Aria Online (Natural) - English (United Kingdom)', 'en-GB'),
      V('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
    ]);
    assert.equal(chosen.lang, 'en-US');
  });

  test('falls further down the list when the top choice is absent', async () => {
    const pick = await load();
    const chosen = pick([
      V('Microsoft David - English (United States)', 'en-US'),
      V('Microsoft Zira - English (United States)', 'en-US'),
    ]);
    assert.match(chosen.name, /Zira/);
  });

  test('never returns a male voice just because it is the only one present', async () => {
    const pick = await load();
    // Deferring to the browser default beats actively selecting the wrong voice.
    assert.equal(pick([V('Microsoft David - English (United States)', 'en-US')]), null);
  });

  test('an empty or absent voice list is null, never a throw', async () => {
    const pick = await load();
    assert.equal(pick([]), null);
    assert.equal(pick(undefined), null);
    assert.equal(pick(null), null);
  });

  test('malformed voice entries do not throw', async () => {
    const pick = await load();
    assert.equal(pick([null, {}, { name: 42 }, undefined]), null);
  });
});
