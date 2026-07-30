#!/usr/bin/env node
'use strict';

// scripts/generate-alert-wav.js — generates the bundled timer/reminder alert
// tone (Task 5, step 5) as a small 16-bit PCM mono WAV: no external deps, no
// binary tools, no network. A gentle two-note chime (880Hz then 660Hz, each
// 150ms, with a short linear fade in/out on every note to avoid clicks).
// Run once; the resulting file is committed to
// mythos/ui/public/audio/alert.wav so this script never needs to run again
// on a fresh clone. Re-run it only if the tone itself needs to change.

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const AMPLITUDE = 0.35; // headroom — this plays right after/alongside spoken audio
const FADE_MS = 12;

function toneSamples(freqHz, durationMs) {
  const n = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const fadeSamples = Math.round((FADE_MS / 1000) * SAMPLE_RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < fadeSamples) env = i / fadeSamples;
    else if (i > n - fadeSamples) env = (n - i) / fadeSamples;
    out[i] = AMPLITUDE * env * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
  }
  return out;
}

function buildPcm() {
  const notes = [...toneSamples(880, 150), ...toneSamples(0, 30), ...toneSamples(660, 200)];
  const buf = Buffer.alloc(notes.length * 2);
  for (let i = 0; i < notes.length; i++) {
    const s = Math.max(-1, Math.min(1, notes[i]));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

function wrapWav(pcmData) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

function main() {
  const outPath = path.join(__dirname, '..', 'ui', 'public', 'audio', 'alert.wav');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const wav = wrapWav(buildPcm());
  fs.writeFileSync(outPath, wav);
  console.log('Wrote ' + outPath + ' (' + wav.length + ' bytes)');
}

if (require.main === module) main();

module.exports = { buildPcm, wrapWav };
