#!/usr/bin/env node
'use strict';

// scripts/setup-silero.js — downloads Silero VAD's pretrained ONNX model
// (MIT license) into ui/public/models/silero/. Same convention as
// scripts/setup-wakeword.js: fetched to the user's own machine on demand,
// never committed (see .gitignore, THIRD_PARTY_NOTICES.md).
//
// SOURCE, and why it's pinned to a specific npm package version rather than
// snakers4/silero-vad's GitHub repo directly: the model's exported I/O
// signature has changed across releases (this script targets the "v5" export
// with inputs {input, state, sr} and outputs {output, stateN} — a single
// combined recurrent state, replacing the older separate h/c tensors), and a
// live check against the current snakers4/silero-vad master branch found
// src/silero_vad/data/silero_vad.onnx to carry the RIGHT input/output names
// but produce near-zero speech probability on known real speech (verified
// against the model's own tests/data/test.wav fixture) — a different export
// of the same architecture that the version here does not reproduce
// correctly. @ricky0123/vad-web's published npm package bundles the same
// model under a pinned version and was verified live to score that exact
// fixture correctly (max 0.9998, 77% of frames > 0.5). Fetching that exact,
// version-pinned asset over jsDelivr's npm CDN (not the wrapper's JS, which
// this project doesn't vendor) is the reproducible, verified source.
//
// Zero dependencies — Node's built-in https module only, with manual
// redirect-following (same as setup-wakeword.js).
//
// Usage:
//   node scripts/setup-silero.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const PACKAGE_VERSION = '0.0.30'; // pinned — see the sourcing note above
const MODEL_URL = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${PACKAGE_VERSION}/dist/silero_vad_v5.onnx`;
const OUT_DIR = path.join(__dirname, '..', 'ui', 'public', 'models', 'silero');
const OUT_FILE = 'silero_vad.onnx';
const MIN_BYTES = 500 * 1024; // sanity floor — the real file is ~2.2MB; a truncated/failed download is far smaller

function httpsGetFollow(url, headers, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects: ' + url)); return; }
        resolve(httpsGetFollow(res.headers.location, headers, redirectsLeft - 1));
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

function downloadFile(url, destPath) {
  return httpsGetFollow(url, { 'User-Agent': 'mythos-setup-silero' }).then((res) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    res.pipe(file);
    file.on('finish', () => file.close(() => resolve()));
    file.on('error', reject);
    res.on('error', reject);
  }));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, OUT_FILE);
  console.log('Silero VAD model setup');
  console.log('Downloading ' + MODEL_URL + ' ...');
  await downloadFile(MODEL_URL, dest);
  const size = fs.statSync(dest).size;
  if (size < MIN_BYTES) {
    throw new Error(`${OUT_FILE} downloaded but is only ${size} bytes (< ${MIN_BYTES} sanity floor) — the download likely failed or was truncated`);
  }
  console.log(`\nSilero VAD model installed to: ${dest} (${(size / 1024).toFixed(0)} KB)`);
  console.log('This model is MIT-licensed (snakers4/silero-vad) — fetched to this machine');
  console.log('only, never committed to the MYTHOS repo. Set VAD_ENGINE=silero in .env and');
  console.log('restart the server to activate it (default remains VAD_ENGINE=rms).');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('setup-silero failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { MODEL_URL, OUT_DIR, OUT_FILE, MIN_BYTES };
