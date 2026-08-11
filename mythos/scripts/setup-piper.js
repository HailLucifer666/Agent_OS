#!/usr/bin/env node
'use strict';

// scripts/setup-piper.js — downloads a Piper voice (MIT, rhasspy/piper-voices)
// into models/piper/, the directory effectors/piper-child.js serves from.
//
// WHY IT EXISTS NOW (2026-08-11). Three places in this repo have advertised this
// exact command for months while the file did not exist: piper-child.js's
// no-voices hint, doctor.js's piper row (which documents the lie in a comment
// rather than repeating it), and the first-run wizard's "not automated here"
// note. Meanwhile the dev checkout has three voices sitting in models/piper and
// the packaged installer has none — piper is the offline last link of
// VOICE_TTS_CHAIN, so an installed MYTHOS with no network and no Google key had
// nothing at all to speak with. This closes both gaps with one script.
//
// SOURCE: huggingface.co/rhasspy/piper-voices — the project's own published
// voice repository. Each voice is a pair: the .onnx weights and the .onnx.json
// config, and piper refuses a voice whose json is missing, so both are fetched
// and the pair is verified before either is kept.
//
// LICENSING: piper's code and the en_US voices fetched here are MIT (see
// THIRD_PARTY_NOTICES.md). They are downloaded to the operator's machine on
// demand and never committed or redistributed in the installer — the same rule
// as setup-silero.js and setup-wakeword.js, and the reason mythos/models stays
// in package.json's build.files exclusions.
//
// Zero dependencies — Node's https only, manual redirect following (HuggingFace
// answers with a 302 to its CDN), same shape as setup-silero.js.
//
// Usage:
//   node scripts/setup-piper.js                 # installs the default voice
//   node scripts/setup-piper.js --install       # same (components.js passes this)
//   node scripts/setup-piper.js --voice en_US-amy-medium
//   node scripts/setup-piper.js --list

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const OUT_DIR = process.env.PIPER_MODEL_DIR || path.join(__dirname, '..', 'models', 'piper');
// A medium voice is ~60MB; a truncated download is orders of magnitude smaller.
const MIN_ONNX_BYTES = 10 * 1024 * 1024;
const MIN_JSON_BYTES = 500;

// The three the dev machine runs, so a packaged install can reach parity with
// it. hfc_female is first because it is the schema default for PIPER_VOICE
// (src/core/config/schema.js) — installing anything else by default would give
// the operator a voice the config does not point at.
const VOICES = {
  'en_US-hfc_female-medium': 'en/en_US/hfc_female/medium',
  'en_US-amy-medium': 'en/en_US/amy/medium',
  'en_US-kristin-medium': 'en/en_US/kristin/medium',
};
const DEFAULT_VOICE = 'en_US-hfc_female-medium';

function httpsGetFollow(url, headers, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects: ' + url)); return; }
        // HuggingFace answers the .json with a RELATIVE Location
        // ("/api/resolve-cache/models/..."), and the weights with an absolute
        // CDN one. setup-silero.js's follower — which this is otherwise copied
        // from — passes the header straight back to https.get and therefore dies
        // with "Invalid URL" on the relative form. Resolving against the URL we
        // just requested handles both, and is what a browser does.
        resolve(httpsGetFollow(new URL(res.headers.location, url).toString(), headers, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      resolve(res);
    }).on('error', reject);
  });
}

// Downloads to a .part file and renames only on success, so an interrupted run
// can never leave a half-written .onnx that piper would load and fail on — and
// that doctor.js would then count as an installed voice.
function downloadFile(url, destPath) {
  const tmp = destPath + '.part';
  return httpsGetFollow(url, { 'User-Agent': 'mythos-setup-piper' }).then((res) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    res.pipe(file);
    file.on('finish', () => file.close(() => resolve()));
    file.on('error', reject);
    res.on('error', reject);
  })).then(() => {
    fs.renameSync(tmp, destPath);
  }).catch((err) => {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    throw err;
  });
}

function parseArgs(argv) {
  const out = { voice: DEFAULT_VOICE, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') out.list = true;
    else if (argv[i] === '--voice' && argv[i + 1]) { out.voice = argv[i + 1]; i++; }
  }
  return out;
}

async function installVoice(voice) {
  const dir = VOICES[voice];
  if (!dir) {
    throw new Error(`unknown voice "${voice}" — known: ${Object.keys(VOICES).join(', ')}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const onnxPath = path.join(OUT_DIR, voice + '.onnx');
  const jsonPath = path.join(OUT_DIR, voice + '.onnx.json');

  console.log(`Downloading ${voice} config ...`);
  await downloadFile(`${BASE}/${dir}/${voice}.onnx.json`, jsonPath);
  console.log(`Downloading ${voice} weights (~60MB) ...`);
  await downloadFile(`${BASE}/${dir}/${voice}.onnx`, onnxPath);

  const onnxSize = fs.statSync(onnxPath).size;
  const jsonSize = fs.statSync(jsonPath).size;
  // A voice is the PAIR. Removing both on a size failure keeps the "is piper
  // installed" answer honest — doctor.js counts .onnx files, so a stranded one
  // would report an engine that cannot speak.
  if (onnxSize < MIN_ONNX_BYTES || jsonSize < MIN_JSON_BYTES) {
    try { fs.unlinkSync(onnxPath); } catch (_) { /* already gone */ }
    try { fs.unlinkSync(jsonPath); } catch (_) { /* already gone */ }
    throw new Error(`${voice} downloaded but looks truncated (${onnxSize} bytes weights, ${jsonSize} bytes config) — nothing was kept`);
  }
  return { onnxPath, onnxSize };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log('Available voices:');
    for (const name of Object.keys(VOICES)) {
      console.log('  ' + name + (name === DEFAULT_VOICE ? '  (default)' : ''));
    }
    return;
  }
  console.log('Piper voice setup');
  const { onnxPath, onnxSize } = await installVoice(args.voice);
  console.log(`\nPiper voice installed to: ${onnxPath} (${(onnxSize / (1024 * 1024)).toFixed(1)} MB)`);
  console.log('MIT-licensed (rhasspy/piper-voices) — fetched to this machine only, never packaged.');
  console.log('Restart the server to pick it up; piper is the offline last link of VOICE_TTS_CHAIN.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('setup-piper failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { VOICES, DEFAULT_VOICE, OUT_DIR, BASE, MIN_ONNX_BYTES, MIN_JSON_BYTES, parseArgs, installVoice };
