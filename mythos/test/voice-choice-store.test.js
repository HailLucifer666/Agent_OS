'use strict';

// voice-choice-store.test.js — the picked voice on disk.
//
// This file is read during boot, BEFORE a logger or bus exists (it is consulted
// from loadConfig(), which runs before createMemory()). So the load-bearing
// property is not "it round-trips" — it is that NOTHING it can encounter throws:
// a missing file, a truncated file, a file from a future build. Each degrades to
// null, which applyVoiceChoice() reads as "no choice was made" — the behaviour of
// an install that never opened the picker.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { filePath, readVoiceChoice, writeVoiceChoice, SCHEMA_VERSION } = require('../src/core/config/voice-choice-store');

let vault;
let warnings;
let realWarn;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-voice-choice-'));
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
});

afterEach(() => {
  console.warn = realWarn;
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('voice-choice-store', () => {
  test('round-trips a choice through the vault', () => {
    const written = writeVoiceChoice(vault, { provider: 'piper-tts', voice: 'en_US-amy-medium' });
    assert.equal(written, filePath(vault));
    const read = readVoiceChoice(vault);
    assert.equal(read.provider, 'piper-tts');
    assert.equal(read.voice, 'en_US-amy-medium');
    assert.equal(read.schemaVersion, SCHEMA_VERSION);
    assert.equal(typeof read.updatedAt, 'string');
  });

  test('creates Config/ rather than requiring the caller to', () => {
    assert.equal(fs.existsSync(path.join(vault, 'Config')), false);
    writeVoiceChoice(vault, { provider: 'gemini-tts', voice: 'Kore' });
    assert.equal(fs.existsSync(path.join(vault, 'Config', 'voice-choice.json')), true);
  });

  test('a second write replaces the first and leaves no .tmp behind', () => {
    writeVoiceChoice(vault, { provider: 'gemini-tts', voice: 'Kore' });
    writeVoiceChoice(vault, { provider: 'gemini-tts', voice: 'Leda' });
    assert.equal(readVoiceChoice(vault).voice, 'Leda');
    const left = fs.readdirSync(path.join(vault, 'Config'));
    assert.deepEqual(left, ['voice-choice.json'], 'atomic write must not strand a .tmp');
  });

  test('a vault with no choice reads as null, silently — this is the common case', () => {
    assert.equal(readVoiceChoice(vault), null);
    assert.deepEqual(warnings, [], 'an install that never used the picker is not a fault');
  });

  test('a truncated file reads as null and warns instead of throwing', () => {
    fs.mkdirSync(path.join(vault, 'Config'), { recursive: true });
    fs.writeFileSync(filePath(vault), '{"provider":"gemini-tts", "voi', 'utf8');
    assert.equal(readVoiceChoice(vault), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not valid JSON/);
  });

  test('a file from a future build is ignored, not guessed at', () => {
    fs.mkdirSync(path.join(vault, 'Config'), { recursive: true });
    fs.writeFileSync(filePath(vault), JSON.stringify({ schemaVersion: 99, provider: 'gemini-tts', voice: 'Kore' }), 'utf8');
    assert.equal(readVoiceChoice(vault), null);
    assert.match(warnings[0], /schemaVersion/);
  });

  test('a JSON scalar where an object belongs reads as null', () => {
    fs.mkdirSync(path.join(vault, 'Config'), { recursive: true });
    fs.writeFileSync(filePath(vault), '"gemini"', 'utf8');
    assert.equal(readVoiceChoice(vault), null);
  });

  test('an unreadable vault path never throws out of a boot-time read', () => {
    // A vault root that is actually a FILE. Windows reports ENOENT here and
    // POSIX ENOTDIR; the assertion is the one that matters on both — the boot
    // read answers null instead of throwing, whichever errno arrives.
    const notADir = path.join(vault, 'plainfile');
    fs.writeFileSync(notADir, 'x', 'utf8');
    assert.equal(readVoiceChoice(notADir), null);
  });

  test('an empty vault root is a question, not a crash', () => {
    assert.equal(readVoiceChoice(''), null);
    assert.equal(readVoiceChoice(undefined), null);
  });
});
