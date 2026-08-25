#!/usr/bin/env node
'use strict';

// scripts/verify-stt-hints.js — does the Whisper recognition-hint prompt
// actually improve transcription of MYTHOS's own vocabulary?
//
// WHY THIS SCRIPT EXISTS RATHER THAN A COMMENT SAYING IT SHOULD HELP. Whisper
// prompt biasing is documented behaviour, but "documented" is not "measured",
// and this repo's record is that plausible premises change shape on contact with
// evidence. The change it verifies is one `form.append('prompt', …)` in
// providers/groq-stt.js, so the null result — no difference — is a real and
// useful answer that should lead to reverting it.
//
// HOW IT MEASURES. Real speech, not fixtures: a TTS engine synthesizes
// utterances containing the terms MYTHOS mishears, and each clip is transcribed
// TWICE against the same model — once with the hint prompt and once without.
// Scoring is exact-substring, case-insensitive, on the specific terms under
// test, so the number means "did the recognizer produce this word" and nothing
// vaguer.
//
// WHAT IT CANNOT TELL YOU, stated because the gap matters. Synthesized speech is
// cleaner than a human on a laptop microphone with music playing, so an
// improvement here is a LOWER bound on a real one and a null result here does
// not prove a null result in the operator's actual conditions. It also cannot
// measure the operator's own accent. Treat this as the cheap first gate, not the
// final word.
//
//   node mythos/scripts/verify-stt-hints.js
//   node mythos/scripts/verify-stt-hints.js --samples 2   (repeat each clip)

const fs = require('fs');
const os = require('os');
const path = require('path');

const MYTHOS_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MYTHOS_DIR, '..');
for (const rel of [path.join(MYTHOS_DIR, '.env'), path.join(REPO_ROOT, '.env.local')]) {
  try { process.loadEnvFile(rel); } catch { /* optional */ }
}

const hints = require('../providers/stt-hints');

const SAMPLES = (() => {
  const i = process.argv.indexOf('--samples');
  const n = i >= 0 ? Number(process.argv[i + 1]) : 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
})();

// Each case names the TERMS that must survive transcription. Chosen because they
// are the words the operator actually said out loud this session and MYTHOS (or
// its transcriber) got wrong, plus the neighbours most likely to collide with
// ordinary English.
const CASES = [
  { text: 'Open the MYTHOS heads up display and check the vault.', terms: ['mythos', 'vault'] },
  { text: 'The build engine is DeepSeek Harness, we call it dsh.', terms: ['deepseek harness', 'dsh'] },
  { text: 'Route the build lane through Codestral on Mistral.', terms: ['codestral', 'mistral'] },
  { text: 'Check the S T T chain and the wake word models.', terms: ['stt', 'wake word'] },
  { text: 'The leash denies tier three, the cortex retries.', terms: ['leash', 'cortex'] },
  { text: 'Run Forge and open the kanban board.', terms: ['forge', 'kanban'] },
];

// ---------------------------------------------------------------------------
// Synthesis. Google's TTS is used because GOOGLE_API_KEY is the one this repo
// documents as required, and because it returns raw PCM we can wrap in a WAV
// header with no external binary — edge-tts needs a Python sidecar and piper
// needs downloaded voices, neither of which should gate a measurement script.
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_URL = 'https://generativelanguage.googleapis.com/v1beta/models/'
  + TTS_MODEL + ':generateContent';

function wavFromPcm(pcm, sampleRate, channels, bitsPerSample) {
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                       // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesize(text) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY is unset — this script needs a TTS engine to make speech');
  const res = await fetch(TTS_URL + '?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error('TTS ' + res.status + ': ' + body.slice(0, 300).replace(/\s+/g, ' '));
  const parsed = JSON.parse(body);
  const part = parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content
    && parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0];
  const inline = part && part.inlineData;
  if (!inline || !inline.data) throw new Error('TTS returned no audio payload');
  // mimeType looks like "audio/L16;codec=pcm;rate=24000" — read the rate rather
  // than assuming it, because a wrong rate transcribes as chipmunk noise and
  // would look like a recognizer failure.
  const rate = Number((/rate=(\d+)/.exec(inline.mimeType || '') || [])[1]) || 24000;
  return wavFromPcm(Buffer.from(inline.data, 'base64'), rate, 1, 16);
}

// ---------------------------------------------------------------------------
// Transcription, calling Groq directly so the hint prompt is the ONLY variable.
// Going through providers/groq-stt.js would read the env flag and give no way to
// run both arms in one process.
const STT_BASE = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1';
const STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

async function transcribe(wav, promptText) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is unset');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', STT_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('language', 'en');
  if (promptText) form.append('prompt', promptText);
  const res = await fetch(STT_BASE + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error('STT ' + res.status + ': ' + body.slice(0, 200).replace(/\s+/g, ' '));
  const data = JSON.parse(body);
  return typeof data.text === 'string' ? data.text.trim() : '';
}

function hit(text, term) {
  return text.toLowerCase().includes(term.toLowerCase());
}

async function main() {
  const prompt = hints.buildPrompt(null);
  console.log('hint prompt: ' + prompt.length + ' chars, ' + prompt.split(', ').length + ' terms');
  console.log('stt model:   ' + STT_MODEL);
  console.log('tts model:   ' + TTS_MODEL);
  console.log('');

  let withHit = 0, withoutHit = 0, total = 0;
  const rows = [];

  for (const c of CASES) {
    let wav;
    try {
      wav = await synthesize(c.text);
    } catch (err) {
      console.log('SKIP  ' + JSON.stringify(c.text.slice(0, 40)) + ' — synthesis failed: ' + err.message);
      continue;
    }
    for (let s = 0; s < SAMPLES; s++) {
      let a = '', b = '';
      try {
        b = await transcribe(wav, null);      // control first, so a rate limit
        a = await transcribe(wav, prompt);    // cannot bias which arm survives
      } catch (err) {
        console.log('SKIP  transcription failed: ' + err.message);
        continue;
      }
      for (const term of c.terms) {
        total++;
        const gotWith = hit(a, term);
        const gotWithout = hit(b, term);
        if (gotWith) withHit++;
        if (gotWithout) withoutHit++;
        rows.push({
          term: term,
          withHints: gotWith,
          withoutHints: gotWithout,
        });
      }
      if (a !== b) {
        console.log('DIFF  ' + JSON.stringify(c.text.slice(0, 44)));
        console.log('  without hints: ' + JSON.stringify(b));
        console.log('  with hints:    ' + JSON.stringify(a));
      }
    }
  }

  console.log('');
  console.log('term            without  with');
  const seen = Object.create(null);
  for (const r of rows) {
    const k = r.term;
    seen[k] = seen[k] || { n: 0, without: 0, with: 0 };
    seen[k].n++;
    if (r.withoutHints) seen[k].without++;
    if (r.withHints) seen[k].with++;
  }
  for (const [term, v] of Object.entries(seen)) {
    const mark = v.with > v.without ? '  <- improved' : (v.with < v.without ? '  <- REGRESSED' : '');
    console.log('  ' + term.padEnd(16) + String(v.without) + '/' + v.n + '      ' + v.with + '/' + v.n + mark);
  }
  console.log('');
  if (!total) {
    console.log('NOTHING MEASURED — every case was skipped. That is not a pass.');
    process.exitCode = 2;
    return;
  }
  console.log('terms recognised WITHOUT hints: ' + withoutHit + '/' + total);
  console.log('terms recognised WITH hints:    ' + withHit + '/' + total);
  if (withHit > withoutHit) {
    console.log('=> the hint prompt HELPS on this material.');
  } else if (withHit === withoutHit) {
    console.log('=> NO DIFFERENCE on this material. Synthesized speech may be too clean to');
    console.log('   show it; if a real-microphone sample also shows nothing, revert the change');
    console.log('   rather than keeping a knob that does nothing.');
  } else {
    console.log('=> the hint prompt made it WORSE. Revert it.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('verify-stt-hints failed: ' + String((err && err.stack) || err));
  process.exitCode = 1;
});
