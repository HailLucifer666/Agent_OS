'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { transcribe } = require('../providers/groq-stt');

describe('groq-stt', () => {
  const realFetch = global.fetch;
  const realKey = process.env.GROQ_API_KEY;
  beforeEach(() => { process.env.GROQ_API_KEY = 'test-key'; });
  afterEach(() => { global.fetch = realFetch; process.env.GROQ_API_KEY = realKey; });

  function mockResponse(data) {
    global.fetch = async () => ({ ok: true, json: async () => data });
  }

  it('returns real speech unfiltered', async () => {
    mockResponse({
      text: 'What is the weather today?',
      segments: [{ no_speech_prob: 0.02, avg_logprob: -0.2 }],
    });
    const text = await transcribe(Buffer.from('audio'), 'audio/webm');
    assert.equal(text, 'What is the weather today?');
  });

  it('drops a hallucinated transcript when no_speech_prob is high', async () => {
    mockResponse({
      text: 'Thank you.',
      segments: [{ no_speech_prob: 0.9, avg_logprob: -0.3 }],
    });
    const text = await transcribe(Buffer.from('noise'), 'audio/webm');
    assert.equal(text, '');
  });

  it('drops a hallucinated transcript when avg_logprob is very low', async () => {
    mockResponse({
      text: 'Hi, how are you?',
      segments: [{ no_speech_prob: 0.1, avg_logprob: -1.5 }],
    });
    const text = await transcribe(Buffer.from('noise'), 'audio/webm');
    assert.equal(text, '');
  });

  it('drops a hallucination flagged in any one of multiple segments', async () => {
    mockResponse({
      text: 'Real words then noise.',
      segments: [
        { no_speech_prob: 0.05, avg_logprob: -0.1 },
        { no_speech_prob: 0.95, avg_logprob: -0.1 },
      ],
    });
    const text = await transcribe(Buffer.from('mixed'), 'audio/webm');
    assert.equal(text, '');
  });

  it('trusts the text when no segments are returned', async () => {
    mockResponse({ text: 'Build me a landing page.' });
    const text = await transcribe(Buffer.from('audio'), 'audio/webm');
    assert.equal(text, 'Build me a landing page.');
  });

  it('returns empty on an already-empty transcript', async () => {
    mockResponse({ text: '', segments: [{ no_speech_prob: 0.99, avg_logprob: -3 }] });
    const text = await transcribe(Buffer.from('silence'), 'audio/webm');
    assert.equal(text, '');
  });

  it('drops a stock hallucination even when confidence scores look normal', async () => {
    // Reproduces the exact behavior observed live against the real Groq API:
    // pure digital silence transcribed as "Thank you." with no_speech_prob 0
    // and avg_logprob -0.29 — both well inside "confident real speech" range.
    mockResponse({
      text: 'Thank you.',
      segments: [{ no_speech_prob: 0, avg_logprob: -0.29, compression_ratio: 0.58 }],
    });
    const text = await transcribe(Buffer.from('silence'), 'audio/wav');
    assert.equal(text, '');
  });

  it('drops a punctuation-only transcript with no actual words', async () => {
    mockResponse({ text: '.', segments: [{ no_speech_prob: 0, avg_logprob: -0.46 }] });
    const text = await transcribe(Buffer.from('noise'), 'audio/wav');
    assert.equal(text, '');
  });

  it('does not drop a real sentence that merely contains a stock phrase', async () => {
    mockResponse({
      text: 'Thank you for reminding me, can you also check my goals?',
      segments: [{ no_speech_prob: 0.05, avg_logprob: -0.2 }],
    });
    const text = await transcribe(Buffer.from('audio'), 'audio/webm');
    assert.equal(text, 'Thank you for reminding me, can you also check my goals?');
  });
});
