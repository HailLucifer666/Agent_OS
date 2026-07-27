'use strict';
// W8 regression: previously-bypassed env keys (read via process.env.X with no
// schema validation, task-957 §24 W8) are now defined in config/schema.js so
// they're documented + validated + visible. The static guard below fails loudly
// if any W8 key is dropped from the schema.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA } = require('../src/core/config/schema');

// The W8 keys — every previously-bypassed operator-tunable knob that W8 added
// to the schema. If any is removed/renamed, this test fails.
const W8_KEYS = [
  'CHAIN_ATTEMPT_TIMEOUT_MS',
  'VOICE_OLLAMA_KEEP_ALIVE',
  'VOICE_RECALL_TIMEOUT_MS',
  'VOICE_INTAKE_IDLE_MS',
  'VOICE_MAX_TOOL_ITERATIONS',
  'VOICE_EMAIL_MODE',
  'VOICE_ALLOWED_DIRS',
  'BOOT_GREETING',
  'REFLECTION_EVERY_TURNS',
  'IMMUNE_EXPLAIN',
  'ANNOUNCER_REANNOUNCE_MS',
  'RATE_LIMIT_GLOBAL',
  'RATE_LIMIT_EXPENSIVE',
  'ALLOWED_ORIGINS',
  'MAX_DRAIN_PER_TICK',
  'MYTHOS_LOG_PRETTY',
  'EDGE_TTS_URL',
  'EDGE_TTS_PORT',
  'EDGE_TTS_AUTOSTART',
  'OLLAMA_EMBED_MODEL',
  'MISTRAL_EMBED_MODEL',
  'GROQ_STT_MODEL',
  'NIM_API_URL',
  'GROQ_API_URL',
  'MISTRAL_API_URL',
  'CEREBRAS_API_URL',
];

describe('W8: previously-bypassed env keys are schema-defined', () => {
  it('every W8 key is present in SCHEMA with type + default', () => {
    const missing = W8_KEYS.filter(k => !SCHEMA[k]);
    assert.deepEqual(missing, [],
      'W8 keys missing from schema: ' + missing.join(', '));
    for (const k of W8_KEYS) {
      const entry = SCHEMA[k];
      assert.ok(entry.type, k + ' must have a type');
      assert.ok('default' in entry, k + ' must have a default');
    }
  });

  it('VOICE_EMAIL_MODE is enum-constrained to gmail|mailto', () => {
    assert.deepEqual(SCHEMA.VOICE_EMAIL_MODE.enum, ['gmail', 'mailto']);
  });

  it('numeric W8 keys carry min bounds (defense against typos)', () => {
    const numericW8 = [
      'CHAIN_ATTEMPT_TIMEOUT_MS', 'VOICE_RECALL_TIMEOUT_MS', 'VOICE_INTAKE_IDLE_MS',
      'VOICE_MAX_TOOL_ITERATIONS', 'REFLECTION_EVERY_TURNS', 'ANNOUNCER_REANNOUNCE_MS',
      'RATE_LIMIT_GLOBAL', 'RATE_LIMIT_EXPENSIVE', 'MAX_DRAIN_PER_TICK',
      'EDGE_TTS_PORT'
    ];
    for (const k of numericW8) {
      assert.equal(SCHEMA[k].type, 'number', k + ' should be type:number');
      assert.ok(typeof SCHEMA[k].min === 'number', k + ' should have a numeric min');
    }
  });

  it('loadConfig coerces + validates a W8 key (rejects a bogus VOICE_EMAIL_MODE)', () => {
    const { loadConfig } = require('../src/core/config');
    // loadConfig reads process.env at call time; stash + override.
    const orig = process.env.VOICE_EMAIL_MODE;
    process.env.VOICE_EMAIL_MODE = 'banana';
    try {
      const result = loadConfig();
      assert.equal(result.ok, false, 'loadConfig must reject VOICE_EMAIL_MODE=banana');
      assert.ok(result.errors.some(e => e.indexOf('VOICE_EMAIL_MODE') !== -1),
        'errors must mention VOICE_EMAIL_MODE');
    } finally {
      if (orig === undefined) delete process.env.VOICE_EMAIL_MODE;
      else process.env.VOICE_EMAIL_MODE = orig;
    }
  });

  it('a documented W8 key parses correctly when set to a valid value', () => {
    const { loadConfig } = require('../src/core/config');
    const orig = process.env.VOICE_RECALL_TIMEOUT_MS;
    process.env.VOICE_RECALL_TIMEOUT_MS = '7000';
    try {
      const result = loadConfig();
      assert.equal(result.ok, true);
      assert.equal(result.config.VOICE_RECALL_TIMEOUT_MS, 7000);
    } finally {
      if (orig === undefined) delete process.env.VOICE_RECALL_TIMEOUT_MS;
      else process.env.VOICE_RECALL_TIMEOUT_MS = orig;
    }
  });
});
