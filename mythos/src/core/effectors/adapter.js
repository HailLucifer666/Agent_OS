'use strict';

// effectors/adapter.js — wraps a NOVA-style tool ({ name, description, params, danger,
// dangerWhen?, fn }) into the canonical Effector shape Cortex/EffectorHub expect.
// CA from MYTHOS-ARCHITECTURE.md §12 "Tool → Effector Adapter" — logic is verbatim,
// only the require path for tierOf changed to match Leash's real module location.

const { tierOf } = require('../leash/tiers');

function effectorFromTool(tool) {
  return {
    id: tool.name,
    tier: tierOf(tool.name),
    dangerWhen: tool.dangerWhen,           // read by leash.check() at gate time — not here
    describe: function() { return tool.description; },
    validate: function(params) {
      // Presence-only validation: every required key in tool.params (a key whose
      // description string does NOT contain "(optional)") must be present and non-empty.
      // Deliberately shallow — NOVA's tool fns already validate types/shape internally
      // and return { ok:false, result:'...' } on bad input; duplicating that here would
      // be two sources of truth for the same rule.
      var required = Object.keys(tool.params || {}).filter(function(k) {
        return String(tool.params[k]).indexOf('(optional)') === -1;
      });
      for (var i = 0; i < required.length; i++) {
        var key = required[i];
        if (params === undefined || params === null || params[key] === undefined || params[key] === '') {
          return { ok: false, reason: 'missing required param: ' + key };
        }
      }
      return { ok: true };
    },
    async invoke(params, ctx) {
      try {
        var result = await tool.fn(params, ctx);
        // Normalize: every tool.fn already returns { ok, result } via NOVA's ok()/fail()
        // helpers, but guard against a tool that forgot and returned a bare value.
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: true, result: result };
      } catch (err) {
        return { ok: false, result: err.message };
      }
    }
  };
}

module.exports = { effectorFromTool };
