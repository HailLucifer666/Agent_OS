'use strict';

// voice-choice-store.js — where the picked voice is kept.
//
// <vault>/Config/voice-choice.json. The vault is per-install, excluded from the
// installer (package.json build.files) and survives an upgrade (nsis
// deleteAppDataOnUninstall:false), which is exactly the lifetime a voice
// preference wants: set it once, keep it across reinstalls, and never ship one
// operator's choice inside someone else's build.
//
// NOT BUILT ON src/core/memory/fs-store.js, deliberately. That store is created
// inside createMemory(), which does not exist yet when loadConfig() runs — the
// choice has to be readable strictly earlier than memory. The atomic write below
// is the same tmp+rename idiom as fs-store.js:writeText, including its B6 .tmp
// cleanup on a Windows EPERM/EXDEV rename failure.
//
// READS NEVER THROW. This file is consulted during boot, before a logger or bus
// exists; a corrupt JSON blob must cost the operator their voice preference, not
// their entire startup. Everything degrades to null, which applyVoiceChoice()
// then reads as "no choice was made" — i.e. exactly the behaviour of an install
// that has never opened the picker.

const fs = require('fs');
const path = require('path');

const REL_DIR = 'Config';
const REL_FILE = 'voice-choice.json';
const SCHEMA_VERSION = 1;

function filePath(vaultRoot) {
  return path.join(String(vaultRoot || ''), REL_DIR, REL_FILE);
}

function readVoiceChoice(vaultRoot) {
  const full = filePath(vaultRoot);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    // An install that has never used the picker is the common case, not a fault.
    if (err && err.code === 'ENOENT') return null;
    console.warn('voice-choice: cannot read ' + full + ': ' + err.message);
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    // A future version writing a shape this build cannot read is not corruption —
    // it is a downgrade. Same answer either way: ignore it rather than guess.
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      console.warn('voice-choice: ignoring unknown schemaVersion ' + parsed.schemaVersion);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('voice-choice: ' + full + ' is not valid JSON, ignoring it: ' + err.message);
    return null;
  }
}

// Throws on failure, unlike the read — a POST that could not persist must answer
// the operator honestly instead of reporting a save that did not happen.
function writeVoiceChoice(vaultRoot, choice) {
  const full = filePath(vaultRoot);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    provider: choice.provider,
    voice: choice.voice,
    updatedAt: choice.updatedAt || new Date().toISOString(),
  }, null, 2);
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, full);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* the rename failure is the real error */ }
    throw err;
  }
  return full;
}

module.exports = { filePath, readVoiceChoice, writeVoiceChoice, SCHEMA_VERSION };
