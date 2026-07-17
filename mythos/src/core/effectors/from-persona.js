'use strict';

// effectors/from-persona.js — voice-tunable personality dials.
// "Dial up the humor", "be more formal", "less sass" → set_persona_level;
// "how are you configured" → persona_status. Both delegate to the identity
// module (src/core/identity/index.js), which owns Identity/persona.json and
// folds the levels into persona() on every brain call — no restart needed.

var effectorFromTool = require('./adapter').effectorFromTool;

function ok(r) { return { ok: true, result: r }; }
function fail(m) { return { ok: false, result: { error: m } }; }

// Spoken-language synonyms → canonical trait names. Opposite-direction words
// (serious, verbose…) flip the requested direction instead of failing.
var TRAIT_SYNONYMS = {
  humor: 'humor', humour: 'humor', funny: 'humor', wit: 'humor', jokes: 'humor',
  warmth: 'warmth', warm: 'warmth', friendliness: 'warmth', friendly: 'warmth',
  formality: 'formality', formal: 'formality', polite: 'formality', politeness: 'formality',
  sass: 'sass', sassy: 'sass', sarcasm: 'sass', attitude: 'sass', snark: 'sass',
  proactivity: 'proactivity', proactive: 'proactivity', initiative: 'proactivity',
  terseness: 'terseness', terse: 'terseness', brevity: 'terseness', brief: 'terseness', concise: 'terseness',
  strict: 'strictness', strictness: 'strictness', coach: 'strictness', 'drill sergeant': 'strictness', accountability: 'strictness'
};
// Words that mean the INVERSE of a trait: "be more verbose" = terseness down.
var INVERSE_SYNONYMS = {
  serious: 'humor', seriousness: 'humor',
  verbose: 'terseness', verbosity: 'terseness', detailed: 'terseness', wordy: 'terseness'
};
var STEP = 2; // up/down step size — big enough to hear the difference

function buildTools(ctx) {
  var identity = ctx && ctx.identity;

  function persona_status() {
    try {
      if (!identity || typeof identity.getPersonaLevels !== 'function') {
        return fail('Persona levels unavailable.');
      }
      return ok({ levels: identity.getPersonaLevels(), scale: '0-10' });
    } catch (err) {
      return fail(err.message);
    }
  }

  function set_persona_level(args) {
    try {
      if (!identity || typeof identity.setPersonaLevel !== 'function') {
        return fail('Persona levels unavailable.');
      }
      var rawTrait = String((args && args.trait) || '').toLowerCase().trim();
      var canonical = TRAIT_SYNONYMS[rawTrait] || null;
      var inverted = false;
      if (!canonical && INVERSE_SYNONYMS[rawTrait]) {
        canonical = INVERSE_SYNONYMS[rawTrait];
        inverted = true;
      }
      if (!canonical) {
        return fail('Unknown trait "' + rawTrait + '". Valid: humor, warmth, formality, sass, proactivity, terseness, strictness.');
      }
      var levels = identity.getPersonaLevels();
      var value = args && args.value;
      var target;
      if (value === 'up' || value === 'down') {
        var dir = (value === 'up') !== inverted ? 1 : -1;
        target = levels[canonical] + dir * STEP;
      } else {
        target = Number(value);
        if (inverted && isFinite(target)) target = 10 - target;
      }
      var res = identity.setPersonaLevel(canonical, target);
      if (!res.ok) return fail(res.error);
      return ok({ trait: res.trait, value: res.value, levels: res.levels });
    } catch (err) {
      return fail(err.message);
    }
  }

  return [
    { name: 'persona_status', description: 'Read the current personality settings (humor, warmth, formality, sass, proactivity, terseness, strictness — each 0-10). Use when the user asks how your personality is configured.', params: {}, danger: false, fn: persona_status },
    { name: 'set_persona_level', description: 'Adjust a personality trait. Use when the user says things like "dial up the humor", "be more formal", "less sass", "be brief", "be stricter with me", "hold me accountable". trait: humor|warmth|formality|sass|proactivity|terseness|strictness (synonyms OK). value: a number 0-10, or "up"/"down" to nudge from the current setting.', params: { trait: 'string — the trait to adjust', value: 'number 0-10, or "up"/"down"' }, danger: false, fn: set_persona_level }
  ];
}

function registerFromPersona(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = { registerFromPersona, buildTools };
