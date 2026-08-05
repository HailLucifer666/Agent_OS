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
    // BUG-017: expose the tool's real {name, description, params} so callers (the
    // effector hub's catalog(), in turn the voice agent) can build a tool catalog
    // from the actual registration instead of a hand-maintained copy that drifts.
    // REMEDIATION P3-8: needs_result was previously dropped here — many tool
    // definitions (screen_look, media_status, etc.) already declared
    // needs_result:true, but it never survived past this adapter, making it
    // dead metadata the voice loop could never actually enforce.
    describeMeta: function() { return { name: tool.name, description: tool.description, params: tool.params, needs_result: !!tool.needs_result }; },
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
        if (result && typeof result === 'object' && 'ok' in result) {
          // BUG-101: not every tool speaks ok()/fail() — some return
          // `{ok:false, error:'why'}`. Every consumer downstream reads only
          // `.result` (live-tool-adapter's evaluateOutcome, dispatch-action's
          // audit `reasonText(result.result)`, the voice agent's summary), so
          // those failures arrived as a bare "Failed." with the reason dropped
          // on the floor. Mirror the message into `result` at this one
          // boundary — keeping `error` intact — instead of teaching every
          // consumer a second shape.
          if (result.ok === false && result.result === undefined) {
            var reason = (typeof result.error === 'string' && result.error)
              || (typeof result.reason === 'string' && result.reason)
              || '';
            if (reason) return Object.assign({}, result, { result: reason });
          }
          return result;
        }
        return { ok: true, result: result };
      } catch (err) {
        return { ok: false, result: err.message };
      }
    }
  };
}

module.exports = { effectorFromTool };
