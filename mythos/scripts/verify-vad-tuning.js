#!/usr/bin/env node
'use strict';

// verify-vad-tuning.js — live verification harness for BUG-020.
//
// BUG-020: "Voice pipeline picks up phantom background noise" — MYTHOS's VAD
// picks up and transcribes background noise even in a supposedly quiet room.
// The shipped fix turns the four hardcoded VAD constants in
// ui/public/js/voice/voice-loop.js (SPEECH_RMS, MIN_PEAK_RMS,
// SPEECH_HOLD_TICKS, SILENCE_MS) into `let`s overridable via
// src/core/config/schema.js's VAD_* keys (env-configurable), surfaced to the
// HUD over GET /api/config/vad and wired into createVoiceLoop's `vad` option
// in ui/public/js/app.js — with the explicit contract that the DEFAULTS stay
// byte-identical to the previous hardcoded values (zero behavior change
// unless someone opts in).
//
// What this script CAN prove live (and does):
//   1. Boot MYTHOS with no VAD_* env set -> GET /api/config/vad must return
//      exactly the same numbers voice-loop.js has hardcoded in its own
//      source (parsed live from the file, not duplicated by hand) —
//      the "byte-identical default behavior" half of the fix.
//   2. Reboot MYTHOS with VAD_* env vars set to different values -> GET
//      /api/config/vad must reflect the overrides, proving the constants
//      are actually plumbed through config -> route -> HTTP response, i.e.
//      the mechanism a human would use to tune them for real actually works.
//
// What this script CANNOT prove, and why (this is BUG-020's actual open
// item per BUGS.md, not the config plumbing above):
//   The bug's acceptance test is perceptual and physical — a human sitting
//   in a real room with real ambient noise (AC, fans, traffic), listening to
//   whether MYTHOS still transcribes phantom speech, adjusting the four
//   values, and re-listening until false triggers stop. That requires:
//     - A live microphone CAPTURE session feeding voice-loop.js's actual
//       browser-side getUserMedia -> AudioContext -> vadTick() pipeline in
//       real time (not just an HTTP round-trip of numbers).
//     - A human perceptual judgment ("does this still pick up the AC hum")
//       that no script, oracle, or synthetic-audio injection can stand in
//       for — injecting a synthetic waveform would test a categorically
//       different thing (does the threshold math work on canned samples),
//       not whether the tuning matches THIS room's real ambient noise.
//     - An interactive human physically present, which this harness — a
//       non-interactive subagent spawned by a workflow orchestration script
//       — structurally cannot supply, regardless of whether the host
//       machine happens to enumerate an audio-capture device.
//   This script checks and logs whether the host even has an audio-capture
//   endpoint (informational only) but does NOT treat that as sufficient —
//   hardware presence alone was never the blocker; a live human operator is.
//
// Usage:
//   node scripts/verify-vad-tuning.js

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');
const { log, bootMythos, killTree, MYTHOS_DIR } = require('./verify-lib');

const PORT = 4761; // picked free in the 4500-4900 range, well away from default 4478

function httpGetJson(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (err) { reject(new Error(`bad JSON from ${route}: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout on ${route}`)); });
  });
}

// Parse voice-loop.js's own hardcoded default literals live, rather than
// hand-duplicating the numbers here (which could silently drift from the
// real source and give a false PASS).
function parseVoiceLoopDefaults() {
  const src = fs.readFileSync(
    path.join(MYTHOS_DIR, 'ui', 'public', 'js', 'voice', 'voice-loop.js'), 'utf8'
  );
  const grab = (re, label) => {
    const m = src.match(re);
    if (!m) throw new Error(`could not parse ${label} default out of voice-loop.js`);
    return Number(m[1]);
  };
  return {
    speechRms: grab(/let\s+SPEECH_RMS\s*=\s*([\d.]+);/, 'SPEECH_RMS'),
    minPeakRms: grab(/let\s+MIN_PEAK_RMS\s*=\s*([\d.]+);/, 'MIN_PEAK_RMS'),
    holdTicks: grab(/let\s+SPEECH_HOLD_TICKS\s*=\s*(\d+);/, 'SPEECH_HOLD_TICKS'),
    silenceMs: grab(/let\s+SILENCE_MS\s*=\s*(\d+);/, 'SILENCE_MS'),
  };
}

// Informational only — see header comment. Presence/absence of an
// audio-capture endpoint is NOT what this bug is blocked on.
function probeAudioCaptureDevice() {
  if (process.platform !== 'win32') return 'not checked (non-Windows host)';
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      "(Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Microphone' -or $_.FriendlyName -match 'Mic ' }).FriendlyName"
    ], { encoding: 'utf8', timeout: 8000 });
    const out = (r.stdout || '').trim();
    return out || 'none enumerated';
  } catch (err) {
    return `probe failed: ${err.message}`;
  }
}

async function main() {
  log('🧪', 'BUG-020 VAD-tuning verification starting');

  const defaults = parseVoiceLoopDefaults();
  log('ℹ️', `voice-loop.js hardcoded defaults (parsed live): ${JSON.stringify(defaults)}`);

  const micInfo = probeAudioCaptureDevice();
  log('ℹ️', `audio-capture endpoint probe (informational only, not the blocker): ${micInfo}`);

  let allPassed = true;

  // --- Pass 1: no overrides -> /api/config/vad must equal voice-loop.js's own defaults ---
  let boot1;
  try {
    boot1 = await bootMythos({ port: PORT });
  } catch (err) {
    log('❌', `boot (no overrides) failed: ${err.message}`);
    process.exit(2);
  }
  try {
    const { status, json } = await httpGetJson(PORT, '/api/config/vad');
    log('ℹ️', `GET /api/config/vad (no env overrides) -> ${status} ${JSON.stringify(json)}`);
    const keys = ['speechRms', 'minPeakRms', 'holdTicks', 'silenceMs'];
    for (const k of keys) {
      if (json[k] !== defaults[k]) {
        log('❌', `default mismatch: ${k} route=${json[k]} voice-loop.js=${defaults[k]}`);
        allPassed = false;
      }
    }
    if (allPassed) log('✅', 'defaults byte-identical to voice-loop.js hardcoded constants');
  } catch (err) {
    log('❌', `default-config check failed: ${err.message}`);
    allPassed = false;
  } finally {
    await killTree(boot1.child);
  }

  // --- Pass 2: env overrides -> /api/config/vad must reflect them (proves the
  // tuning mechanism a human would actually use is really wired end-to-end) ---
  const overrides = {
    VAD_SPEECH_RMS: '0.09',
    VAD_MIN_PEAK_RMS: '0.15',
    VAD_HOLD_TICKS: '6',
    VAD_SILENCE_MS: '2500',
  };
  let boot2;
  try {
    boot2 = await bootMythos({ port: PORT, env: overrides });
  } catch (err) {
    log('❌', `boot (with overrides) failed: ${err.message}`);
    process.exit(2);
  }
  try {
    const { status, json } = await httpGetJson(PORT, '/api/config/vad');
    log('ℹ️', `GET /api/config/vad (env overrides set) -> ${status} ${JSON.stringify(json)}`);
    const expect = {
      speechRms: Number(overrides.VAD_SPEECH_RMS),
      minPeakRms: Number(overrides.VAD_MIN_PEAK_RMS),
      holdTicks: Number(overrides.VAD_HOLD_TICKS),
      silenceMs: Number(overrides.VAD_SILENCE_MS),
    };
    for (const k of Object.keys(expect)) {
      if (json[k] !== expect[k]) {
        log('❌', `override not reflected: ${k} route=${json[k]} expected=${expect[k]}`);
        allPassed = false;
      }
    }
    if (allPassed) log('✅', 'env overrides correctly plumbed through config -> route -> HTTP response');
  } catch (err) {
    log('❌', `override-config check failed: ${err.message}`);
    allPassed = false;
  } finally {
    await killTree(boot2.child);
  }

  if (!allPassed) {
    log('💀', 'BUG-020 config-plumbing check: FAIL (see above) — cannot even reach the point of needing a human tuning pass');
    process.exit(1);
  }

  log('✅', 'BUG-020 config-plumbing (the scriptable half of the fix): PASS');
  log('⏭️', 'SKIP: BUG-020\'s actual acceptance test — tuning VAD_SPEECH_RMS/VAD_MIN_PEAK_RMS/' +
    'VAD_HOLD_TICKS/VAD_SILENCE_MS against REAL ambient room noise through a REAL microphone ' +
    'and confirming false triggers stop by ear — requires a live human operator physically ' +
    'present in a real room. This is a non-interactive subagent session with no human listening ' +
    'and no way to judge "does this still pick up the AC hum"; that judgment cannot be scripted, ' +
    'synthesized, or automated away. Missing precondition: a live human-in-the-room tuning session.');
  process.exit(3);
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
