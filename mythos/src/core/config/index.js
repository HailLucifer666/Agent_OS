'use strict';

const fs = require('fs');
const path = require('path');
const { SCHEMA } = require('./schema');
const { deriveVoiceDefaults, deriveLiveVoiceDefaults, deriveWakewordDefaults } = require('./voice-defaults');
const { applyVoiceChoice } = require('./voice-choice');
const { readVoiceChoice } = require('./voice-choice-store');
const { readSettings } = require('./settings-store');
const { findModelFile } = require('../setup/model-paths');

function validate(rawEnv, schema) {
  const errors = [];
  const config = {};

  for (const [key, def] of Object.entries(schema)) {
    let val = rawEnv[key];

    if (val === undefined || val === '') {
      if (def.required) {
        errors.push(`Missing required config: ${key}`);
        continue;
      }
      val = def.default;
    }

    if (def.type === 'number') {
      val = Number(val);
      if (isNaN(val)) {
        errors.push(`Invalid number: ${key}=${rawEnv[key]}`);
        continue;
      }
      if (def.min !== undefined && val < def.min) {
        errors.push(`${key}=${val} below minimum ${def.min}`);
      }
      if (def.max !== undefined && val > def.max) {
        errors.push(`${key}=${val} above maximum ${def.max}`);
      }
    } else if (def.type === 'bool') {
      val = val === 'true' || val === '1' || val === true;
    } else {
      val = String(val);
    }

    if (def.enum && !def.enum.includes(val)) {
      errors.push(`${key}=${val} not in [${def.enum.join(', ')}]`);
    }

    config[key] = Object.freeze(def.type === 'number' ? val : val);
  }

  return { ok: errors.length === 0, config: Object.freeze(config), errors };
}

// The three wake-word weights, checked exactly where /api/config/wakeword looks
// for them (server/routes/config.js). Never throws: an unreadable models
// directory means "no wake word", not a failed boot.
const WAKEWORD_ASSETS = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'];
function wakewordModelsPresent(dir) {
  // An explicit dir is the test seam and is honoured verbatim (see
  // server/routes/config.js for the EPERM data-loss that seam prevents).
  if (dir) {
    return WAKEWORD_ASSETS.every((name) => {
      try { return fs.statSync(path.join(dir, name)).size > 0; } catch { return false; }
    });
  }
  // Otherwise search BOTH the userData-scoped models directory and the install
  // tree. Installer parity (2026-08-11): the downloaders now write to userData
  // because the install tree ships no models and is replaced by every update, so
  // checking only the install tree would report "no wake word" on precisely the
  // machine that just downloaded one. See core/setup/model-paths.js.
  return WAKEWORD_ASSETS.every((name) => Boolean(findModelFile('wakeword', name)));
}

// Set, non-empty. The schema's own "unset" is the empty string (see validate
// above), so '' must not count as a value at any layer.
function present(obj, key) {
  return obj && obj[key] !== undefined && String(obj[key]) !== '';
}

// loadConfig({envOverrides, wakewordModelsDir, settings, envFileKeys, settingsPath})
//
// PRECEDENCE, in full (see settings-store.js for why config.json exists):
//
//   process.env  >  userData/config.json  >  mythos/.env  >  HUD voice choice
//                >  derived voice/wakeword defaults  >  schema default
//
// The awkward part is that src/main.js loads mythos/.env INTO process.env
// (process.loadEnvFile), so by the time we get here a .env value and a real
// environment value are the same thing. `envFileKeys` is how the caller tells
// them apart: it is the set of keys that appeared ONLY because .env was loaded.
// Without it, config.json could never outrank .env — and on a dev machine that
// would mean the settings panel silently did nothing.
//
// Omitting envFileKeys is safe and means "treat the whole environment as real",
// i.e. exactly the pre-existing behaviour for every headless/test caller.
function loadConfig({ envOverrides, wakewordModelsDir, settings, envFileKeys, settingsPath } = {}) {
  const processEnv = { ...process.env, ...envOverrides };
  const fromEnvFile = envFileKeys instanceof Set ? envFileKeys : new Set(envFileKeys || []);

  // Never throws — a missing file is the normal fresh-install case, and a
  // corrupt one is reported through settingsResult.error for the caller to put
  // on the bus rather than being allowed to stop boot.
  const settingsResult = settings || readSettings({ env: processEnv, settingsPath });
  const settingsValues = settingsResult.values || {};

  // Overlay config.json onto the environment, but only where the environment is
  // not carrying a REAL value. A key whose only source was .env loses here.
  const raw = { ...processEnv };
  const settingsApplied = new Set();
  for (const [key, value] of Object.entries(settingsValues)) {
    const realEnvWins = present(processEnv, key) && !fromEnvFile.has(key);
    if (realEnvWins) continue;
    raw[key] = value;
    settingsApplied.add(key);
  }

  // Fills ONLY what the operator left unset, and is spread UNDER raw so anything
  // real in the environment still wins. See voice-defaults.js for why a packaged
  // build with no .env otherwise ends up on the browser's speechSynthesis voice.
  const derived = {
    ...deriveVoiceDefaults(raw),
    // Live duplex when a Google key is present, wake word when its weights are
    // actually on disk — see voice-defaults.js for why each is decided this way.
    // Both sit in the same layer: beaten by any real env value, beating schema.
    ...deriveLiveVoiceDefaults(raw),
    ...deriveWakewordDefaults(raw, wakewordModelsPresent(wakewordModelsDir)),
  };
  // The voice the operator picked in the HUD, if any. Spread BETWEEN derived and
  // raw, which IS the precedence rule: derived defaults lose to everything, the
  // picked voice loses only to a real environment variable, and the environment
  // always wins. See voice-choice.js.
  const vaultRoot = raw.MYTHOS_VAULT_ROOT || SCHEMA.MYTHOS_VAULT_ROOT.default;
  const baseChain = derived.VOICE_TTS_CHAIN || raw.VOICE_TTS_CHAIN || raw.VOICE_TTS_PROVIDER || 'edge';
  const chosen = applyVoiceChoice(raw, readVoiceChoice(vaultRoot), baseChain);
  const result = validate({ ...derived, ...chosen, ...raw }, SCHEMA);

  // WHERE each value came from. Not cosmetic: the whole reason the four
  // 2026-08-11 incidents took two months to notice is that an effective value
  // and its origin were both invisible, so "the install behaves differently"
  // could not be turned into "this key is at its default here and set there".
  // The Settings panel renders this, and scripts/parity-check.js asserts on it.
  const origins = {};
  for (const key of Object.keys(SCHEMA)) {
    if (present(raw, key)) {
      if (settingsApplied.has(key)) origins[key] = 'config.json';
      else if (fromEnvFile.has(key)) origins[key] = '.env';
      else origins[key] = 'env';
    } else if (present(chosen, key)) origins[key] = 'voice-choice';
    else if (present(derived, key)) origins[key] = 'derived';
    else origins[key] = 'default';
  }

  return {
    ...result,
    origins: Object.freeze(origins),
    // Passed up so main.js can report a corrupt or typo'd settings file ONCE on
    // the bus. loadConfig stays pure and never touches the bus itself.
    settingsFile: settingsResult.file,
    settingsUnknown: settingsResult.unknown || [],
    settingsDropped: settingsResult.dropped || [],
    settingsError: settingsResult.error,
  };
}

module.exports = { validate, loadConfig, SCHEMA };
