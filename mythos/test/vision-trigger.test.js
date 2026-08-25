'use strict';
// test/vision-trigger.test.js — pure node:test coverage for isVisionQuery(),
// the phrase gate that decides whether a transcribed utterance is answered with
// a camera frame (the vision lane) instead of going to the brain.
//
// It lives in its own module for the reason mythos/ui/CLAUDE.md gives for
// pcm-resample.js: voice-loop.js cannot be imported outside a browser, so while
// this regex lived inside it, nothing could test it.
//
// The NEGATIVE cases are the important half of this file. "what is this" and
// "what's the weather" are the same grammatical shape, and a gate that catches
// both answers a weather question with a description of the operator's desk.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const TRIGGER_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'vision-trigger.js')
).href;

// Phrases that MUST reach the vision lane. The first four are the ones the
// original regex already caught and must keep catching; the rest are the
// widening added 2026-08-10.
const SHOULD_LOOK = [
  'what do you see',
  'what can you see',
  'describe what you see',
  'describe this',
  'look at this',
  'look at me',
  'take a look',
  'what am i holding',
  'what am i showing you',
  // widened coverage
  'what are you seeing',
  'can you see this',
  'do you see that',
  'are you able to see me',
  'look at that',
  'look at this thing on my desk',
  'have a look at this',
  'tell me what you see',
  'tell me what this is',
  'what is this',
  "what's this",
  'what are these',
  'what am i wearing',
  'what am i pointing at',
  'describe the scene',
  'describe the room',
  'check this out',
  'check out this label',
];

// Phrases that MUST NOT be swallowed. Each of these has a real answer that has
// nothing to do with the camera.
const SHOULD_NOT_LOOK = [
  'open spotify',
  "what's the weather",
  'what is the weather in kolkata',
  'what is the time',
  "what's my next meeting",
  'what is kubernetes',
  'what is the capital of france',
  'describe the architecture of this repo', // "describe the ..." but not a scene
  'tell me what you did last night',
  'tell me a joke',
  'can you see if the build passed',        // "can you see if" — a check, not a look
  'take a screenshot',
  'look up the docs for express',
  'check my email',
  'play the next song',
  '',
  '   ',
];

describe('isVisionQuery — phrases that should attach a camera frame', () => {
  for (const phrase of SHOULD_LOOK) {
    it(`catches ${JSON.stringify(phrase)}`, async () => {
      const { isVisionQuery } = await import(TRIGGER_URL);
      assert.equal(isVisionQuery(phrase), true);
    });
  }

  it('is case- and whitespace-insensitive (STT capitalises and pads)', async () => {
    const { isVisionQuery } = await import(TRIGGER_URL);
    assert.equal(isVisionQuery('  What Do You See?  '), true);
    assert.equal(isVisionQuery('LOOK AT THIS'), true);
  });
});

describe('isVisionQuery — utterances that must NOT be hijacked', () => {
  for (const phrase of SHOULD_NOT_LOOK) {
    it(`leaves ${JSON.stringify(phrase)} for the brain`, async () => {
      const { isVisionQuery } = await import(TRIGGER_URL);
      assert.equal(isVisionQuery(phrase), false);
    });
  }

  it('only matches at the START of an utterance, so a mid-sentence mention is not a trigger', async () => {
    const { isVisionQuery } = await import(TRIGGER_URL);
    assert.equal(isVisionQuery('remind me to ask what do you see later'), false);
  });

  it('survives null/undefined without throwing', async () => {
    const { isVisionQuery } = await import(TRIGGER_URL);
    assert.equal(isVisionQuery(null), false);
    assert.equal(isVisionQuery(undefined), false);
  });
});
