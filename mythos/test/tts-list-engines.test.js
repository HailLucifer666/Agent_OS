'use strict';

// tts-list-engines.test.js — what the picker is allowed to offer.
//
// listEngines() feeds a dropdown, so its failure modes are quiet ones:
//   * a dead sidecar throwing out of isAvailable() must not take the whole
//     listing down — the operator would see "no voices at all" when three
//     engines are fine;
//   * an engine that is NOT available must never be asked for its catalogue. For
//     kokoro that probe is a model load, so asking a missing engine would mean
//     pulling weights down to populate a dropdown nobody chose from;
//   * the three engines answer in three shapes (gemini bare strings, the
//     edge/piper sidecars {id,name,language,gender}, kokoro {id,label}) and the
//     picker must not have to know which is which.
//
// Run: cd mythos && node --test test/tts-list-engines.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const TTS_PATH = require.resolve('../providers/tts');

// listEngines walks the real BY_NAME registry, so the providers are replaced in
// the module cache before tts.js is loaded. Restored after each case.
function withFakeProviders(fakes, fn) {
  const paths = {
    edge: require.resolve('../providers/edge-tts'),
    gemini: require.resolve('../providers/gemini-tts'),
    piper: require.resolve('../providers/piper-tts'),
    kokoro: require.resolve('../providers/kokoro-tts'),
  };
  const saved = {};
  for (const [short, p] of Object.entries(paths)) {
    saved[p] = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true, exports: fakes[short] };
  }
  const savedTts = require.cache[TTS_PATH];
  delete require.cache[TTS_PATH];
  try {
    return fn(require(TTS_PATH));
  } finally {
    for (const [p, mod] of Object.entries(saved)) {
      if (mod) require.cache[p] = mod; else delete require.cache[p];
    }
    if (savedTts) require.cache[TTS_PATH] = savedTts; else delete require.cache[TTS_PATH];
  }
}

function fake(name, opts = {}) {
  const p = {
    name,
    mime: 'audio/wav',
    listCalls: 0,
    async isAvailable() { if (opts.probeThrows) throw new Error('probe blew up'); return opts.available !== false; },
    async synthesize() { return Buffer.from('x'); },
  };
  if (opts.voices !== undefined || opts.listThrows) {
    p.listVoices = async () => { p.listCalls++; if (opts.listThrows) throw new Error('sidecar down'); return opts.voices; };
  }
  return p;
}

describe('listEngines', () => {
  it('normalizes all three voice shapes into {id,label}', async () => {
    const fakes = {
      gemini: fake('gemini-tts', { voices: ['Aoede', 'Kore'] }),
      edge: fake('edge-tts', { voices: [{ id: 'en-US-AvaNeural', name: 'Ava', language: 'en-US', gender: 'Female' }] }),
      kokoro: fake('kokoro-tts', { voices: [{ id: 'af_heart', label: 'Heart' }] }),
      piper: fake('piper-tts', { voices: [] }),
    };
    await withFakeProviders(fakes, async (tts) => {
      const engines = await tts.listEngines();
      const by = Object.fromEntries(engines.map((e) => [e.short, e]));
      assert.deepEqual(by.gemini.voices[0], { id: 'Aoede', label: 'Aoede' });
      assert.equal(by.edge.voices[0].id, 'en-US-AvaNeural');
      assert.equal(by.edge.voices[0].label, 'Ava');
      assert.equal(by.edge.voices[0].detail, 'en-US · Female');
      assert.deepEqual(by.kokoro.voices[0], { id: 'af_heart', label: 'Heart' });
    });
  });

  it('a throwing probe is reported as unavailable, not propagated', async () => {
    const fakes = {
      gemini: fake('gemini-tts', { probeThrows: true, voices: ['Aoede'] }),
      edge: fake('edge-tts', { voices: [] }),
      kokoro: fake('kokoro-tts', { voices: [] }),
      piper: fake('piper-tts', { voices: [] }),
    };
    await withFakeProviders(fakes, async (tts) => {
      const engines = await tts.listEngines();
      const gemini = engines.find((e) => e.short === 'gemini');
      assert.equal(gemini.available, false);
      assert.deepEqual(gemini.voices, []);
      assert.equal(engines.length, 4, 'one bad engine must not shorten the list');
    });
  });

  it('never asks an unavailable engine for its catalogue', async () => {
    const kokoro = fake('kokoro-tts', { available: false, voices: [{ id: 'af_heart' }] });
    const fakes = {
      kokoro,
      gemini: fake('gemini-tts', { voices: ['Aoede'] }),
      edge: fake('edge-tts', { voices: [] }),
      piper: fake('piper-tts', { voices: [] }),
    };
    await withFakeProviders(fakes, async (tts) => {
      await tts.listEngines();
      assert.equal(kokoro.listCalls, 0, 'listing a missing engine would mean downloading a model for a dropdown');
    });
  });

  it('a listVoices that throws costs that engine its voices, nothing more', async () => {
    const fakes = {
      edge: fake('edge-tts', { listThrows: true }),
      gemini: fake('gemini-tts', { voices: ['Aoede'] }),
      kokoro: fake('kokoro-tts', { voices: [] }),
      piper: fake('piper-tts', { voices: [] }),
    };
    await withFakeProviders(fakes, async (tts) => {
      const engines = await tts.listEngines();
      const edge = engines.find((e) => e.short === 'edge');
      assert.equal(edge.available, true);
      assert.deepEqual(edge.voices, []);
      assert.equal(engines.find((e) => e.short === 'gemini').voices.length, 1);
    });
  });

  it('lists every engine in the registry, installed or not', async () => {
    const fakes = {
      gemini: fake('gemini-tts', { available: false }),
      edge: fake('edge-tts', { available: false }),
      kokoro: fake('kokoro-tts', { available: false }),
      piper: fake('piper-tts', { available: false }),
    };
    await withFakeProviders(fakes, async (tts) => {
      const engines = await tts.listEngines();
      assert.deepEqual(engines.map((e) => e.short).sort(), ['edge', 'gemini', 'kokoro', 'piper']);
      assert.equal(engines.every((e) => e.available === false), true);
    });
  });
});

describe('providerByShortName', () => {
  it('resolves the audition route\'s engine without building a chain', () => {
    const { providerByShortName } = require('../providers/tts');
    assert.equal(providerByShortName('gemini').name, 'gemini-tts');
    assert.equal(providerByShortName(' PIPER ').name, 'piper-tts');
    assert.equal(providerByShortName('espeak'), null);
    assert.equal(providerByShortName(''), null);
  });
});
