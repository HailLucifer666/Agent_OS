#!/usr/bin/env node
'use strict';

// scripts/setup-wakeword.js — downloads openWakeWord's pretrained ONNX models
// into ui/public/models/wakeword/. These models are CC BY-NC-SA licensed
// (github.com/dscripka/openWakeWord) — they are fetched to the user's own
// machine here, never committed to this repo (see .gitignore and
// THIRD_PARTY_NOTICES.md). The wake-word feature (ui/public/js/voice/wakeword.js)
// ports openWakeWord's Apache-2.0 pipeline *code*, which is a separate,
// permissively-licensed thing from these model weights.
//
// Zero dependencies — Node's built-in https module only, with manual
// redirect-following (GitHub release assets 302 to S3).
//
// Usage:
//   node scripts/setup-wakeword.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = 'dscripka/openWakeWord';
const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases`;
const REQUIRED_ASSETS = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'];
// Installer parity (2026-08-11): write to the userData-scoped model directory
// when one is known, NOT into the install tree. The install tree is excluded from
// package.json build.files (so a packaged install has no models directory at all)
// and is replaced wholesale by an update — which would silently un-install these
// weights and take the wake word with them on every upgrade.
// See src/core/setup/model-paths.js for the full resolution order.
const { modelWriteDir } = require('../src/core/setup/model-paths');
const OUT_DIR = modelWriteDir('wakeword');
const MIN_BYTES = 100 * 1024; // sanity floor — a truncated/failed download is far smaller than this

// Pure, network-free: given a parsed GitHub "list releases" API response,
// find the newest release whose assets include all REQUIRED_ASSETS and return
// { assetName -> browser_download_url }. Exported for unit testing — the test
// feeds fixture JSON, never touches the network.
function resolveAssetUrls(releases) {
  for (const release of releases || []) {
    const assets = release.assets || [];
    const byName = new Map(assets.map((a) => [a.name, a.browser_download_url]));
    if (REQUIRED_ASSETS.every((name) => byName.has(name))) {
      const found = {};
      for (const name of REQUIRED_ASSETS) found[name] = byName.get(name);
      return found;
    }
  }
  return null;
}

function httpsGetFollow(url, headers, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // discard body, follow redirect
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

async function fetchJson(url) {
  const res = await httpsGetFollow(url, { 'User-Agent': 'mythos-setup-wakeword' });
  res.setEncoding('utf8');
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

function downloadFile(url, destPath) {
  return httpsGetFollow(url, { 'User-Agent': 'mythos-setup-wakeword' }).then((res) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    res.pipe(file);
    file.on('finish', () => file.close(() => resolve()));
    file.on('error', reject);
    res.on('error', reject);
  }));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('openWakeWord model setup');
  console.log('Resolving release asset URLs from ' + RELEASES_API_URL + ' ...');
  const releases = await fetchJson(RELEASES_API_URL);
  const urls = resolveAssetUrls(releases);
  if (!urls) {
    console.error('Could not find an openWakeWord release carrying all required assets: ' + REQUIRED_ASSETS.join(', '));
    console.error('Check https://github.com/' + REPO + '/releases manually.');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const name of REQUIRED_ASSETS) {
    const dest = path.join(OUT_DIR, name);
    console.log(`Downloading ${name} ...`);
    await downloadFile(urls[name], dest);
    const size = fs.statSync(dest).size;
    if (size < MIN_BYTES) {
      throw new Error(`${name} downloaded but is only ${size} bytes (< ${MIN_BYTES} sanity floor) — the download likely failed or was truncated`);
    }
    results.push({ name, size });
  }

  console.log('\nopenWakeWord models installed to: ' + OUT_DIR);
  for (const r of results) console.log(`  ${r.name}  (${(r.size / 1024).toFixed(0)} KB)`);
  console.log('\nThese models are CC BY-NC-SA (dscripka/openWakeWord) — fetched to this machine');
  console.log('only, never committed to the MYTHOS repo. Set WAKEWORD_ENABLED=true in .env');
  console.log('and restart the server to activate hands-free "hey jarvis" detection.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('setup-wakeword failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { resolveAssetUrls, REQUIRED_ASSETS };
