'use strict';

// effectors/hub.js — createEffectorHub: registry + breaker-gated dispatch.
// CA from MYTHOS-ARCHITECTURE.md §12 "Effector Hub" — logic is verbatim except the
// `breakers` field is a thin registry wrapper (not a raw Map), because the real,
// already-shipped cortex/index.js:129-130 calls `effectors.breakers.allow(name)` directly —
// see Spec Ambiguities Resolved #4. `createBreaker` comes from immune/breakers.js (Phase 6).

const { createBreaker } = require('../immune/breakers');

function createBreakerRegistry() {
  var byName = new Map();
  return {
    get: function(name) { return byName.get(name); },
    set: function(name, breaker) { byName.set(name, breaker); },
    has: function(name) { return byName.has(name); },
    allow: function(name) {
      var b = byName.get(name);
      return b ? b.allow() : true;    // no breaker registered → allow (unknown effector
                                        // is rejected earlier by invoke()'s own check)
    },
    recordSuccess: function(name) {
      var b = byName.get(name);
      if (b) b.recordSuccess();
    },
    recordFailure: function(name) {
      var b = byName.get(name);
      if (b) b.recordFailure();
    },
    get size() { return byName.size; }
  };
}

function createEffectorHub({ bus, config }) {
  var effectors = new Map();               // tool name -> effector (the 45 gate-counted ones)
  var namedServices = new Map();            // synthetic id -> service object (goals/kanban/pipeline bridges)
  var breakers = createBreakerRegistry();   // name -> breaker (see wrapper above)

  function register(effector) {
    if (!effector || !effector.id || typeof effector.invoke !== 'function') {
      throw new Error('createEffectorHub.register: effector must have {id, invoke()}');
    }
    effectors.set(effector.id, effector);
    breakers.set(effector.id, createBreaker({ name: effector.id, bus: bus, config: config }));
  }

  // CROSS-PHASE FIX (consistency pass, P7 vs P5/P9): neither `get(name)` nor
  // `registerNamed(id, obj)` existed on the hub's public return shape, even
  // though Leash's `check()` (P5, §9) calls `effectors.get(toolName)` directly
  // for the dangerWhen override, and P9's server requires
  // `effectors.get('goals-effector')` to reach the Goals.md bridge. `get()`
  // checks the tool-effectors map first, then namedServices — Leash gets
  // `{dangerWhen}|undefined` for a tool, P9 gets the bridge object for a named
  // service, same method. `registerNamed` skips the `{id,invoke}` shape check
  // `register()` enforces (named services are called directly via their own
  // methods, never dispatched through `invoke()`, and get no breaker) and goes
  // into a SEPARATE map so `count()` (the "exactly 45" gate) is never inflated
  // by goals-effector/kanban-effector/pipeline-effector.
  function get(name) {
    return effectors.has(name) ? effectors.get(name) : namedServices.get(name);
  }

  function registerNamed(id, obj) {
    if (!id || !obj) throw new Error('createEffectorHub.registerNamed: requires (id, obj)');
    namedServices.set(id, obj);
  }

  async function invoke(name, params, ctx) {
    var effector = effectors.get(name);
    if (!effector) return { ok: false, result: 'unknown-effector' };

    if (!breakers.allow(name)) {
      return { ok: false, result: 'circuit-open' };
    }

    var result;
    try {
      result = await effector.invoke(params, ctx);
    } catch (err) {
      // invoke() contract says effectors never throw, but hub must not trust that —
      // an uncaught throw here must still count as a breaker failure, not crash Cortex.
      result = { ok: false, result: err.message };
    }

    if (result && result.ok) {
      breakers.recordSuccess(name);
    } else {
      breakers.recordFailure(name);
    }

    return result;
  }

  return {
    register: register,
    registerNamed: registerNamed,
    get: get,
    invoke: invoke,
    get effectors() { return effectors; },
    get breakers() { return breakers; },
    count: function() { return effectors.size; }
  };
}

module.exports = { createEffectorHub };
