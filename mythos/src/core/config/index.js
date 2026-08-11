'use strict';

const fs = require('fs');
const path = require('path');
const { SCHEMA } = require('./schema');
const { deriveVoiceDefaults, deriveLiveVoiceDefaults, deriveWakewordDefaults } = require('./voice-defaults');
const { applyVoiceChoice } = require('./voice-choice');
const { readVoiceChoice } = require('./voice-choice-store');

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
  const base = dir || path.join(__dirname, '..', '..', '..', 'ui', 'public', 'models', 'wakeword');
  return WAKEWORD_ASSETS.every((name) => {
    try { return fs.statSync(path.join(base, name)).size > 0; } catch { return false; }
  });
}

function loadConfig({ envOverrides, wakewordModelsDir } = {}) {
  const raw = { ...process.env, ...envOverrides };
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
  return result;
}

module.exports = { validate, loadConfig, SCHEMA };
