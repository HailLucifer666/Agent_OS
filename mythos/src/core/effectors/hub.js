'use strict';

// effectors/hub.js — createEffectorHub: registry + breaker-gated dispatch.
// CA from MYTHOS-ARCHITECTURE.md §12 "Effector Hub" — logic is verbatim except the
// `breakers` field is a thin registry wrapper (not a raw Map), because the real,
// already-shipped cortex/index.js:129-130 calls `effectors.breakers.allow(name)` directly —
// see Spec Ambiguities Resolved #4. `createBreaker` comes from immune/breakers.js (Phase 6).

const { createBreaker } = require('../immune/breakers');
const { reasonText } = require('../util/reason-text');

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
    reset: function(name) {
      var b = byName.get(name);
      if (b) b.reset();
    },
    get size() { return byName.size; },
    // [Phase 9 — NEW, additive] iterable like the raw Map it wraps: P9's
    // server/index.js broadcastHealth() does `for (const [name, breaker] of
    // effectors.breakers)` (spec Full Code, Ambiguity #4) — the wrapper must
    // not break that contract vs. the raw-Map fakes the spec tests inject.
    [Symbol.iterator]: function() { return byName[Symbol.iterator](); }
  };
}

// F1 (2026-08-15): the breaker FSM models ONE kind of failure — a transient one
// that a cooldown might fix. A revoked OAuth grant is not that. In the 2026-08-14
// session gmail_unread failed five times with `invalid_grant` ("this is NOT a
// network problem and will not recover on its own", says the effector's own
// message), tripped the flapping breaker, served its 60s suppression, was
// dispatched again, and failed again — with the HUD pinned to DEGRADED for the
// whole session (core-orb.js reads `state !== 'closed'` over every breaker) and
// naming no cause.
//
// A terminal failure is therefore NOT routed through the breaker at all. The tool
// is disabled for the process, the breaker is reset to CLOSED (so the orb stops
// reporting a flap that will never resolve), and every later call returns the
// stored remedy text without touching the provider.
//
// Deliberately an explicit allow-list of signatures at the effector, never a
// broad `4xx === terminal` rule (rules/core.md §11.1): a 401/403 from a rate
// limiter and one from a dead credential look alike, and getting that wrong turns
// a transient outage into a session-long dead tool. Effectors opt in by returning
// `terminal: true` beside the existing ok/unverified/reason fields — it travels
// alongside them and is never folded into `ok` (dispatch-action.js's evidence
// contract).
function isTerminalResult(result) {
  return !!(result && result.ok === false && result.terminal === true);
}

// Same normalization dispatch-action.js uses for audit lines — some effectors'
// failure shape is `{error: msg}`, not a string, and the stored remedy must not
// become the literal "[object Object]".
function reasonOf(result) {
  return reasonText(result && result.result) || reasonText(result && result.error)
    || 'terminal failure';
}

function createEffectorHub({ bus, config }) {
  var effectors = new Map();               // tool name -> effector (the 45 gate-counted ones)
  var namedServices = new Map();            // synthetic id -> service object (goals/kanban/pipeline bridges)
  var breakers = createBreakerRegistry();   // name -> breaker (see wrapper above)
  var terminal = new Map();                 // tool name -> { reason, at } (F1, see above)

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

  // BUG-017: real tool catalog derived from the actual registrations — the
  // single source of truth callers (voice-agent's buildCatalogFromHub) merge
  // against, instead of a hand-maintained list that silently drifts out of
  // sync with what's really registered. Guarded per-entry since a future
  // effector shape might not implement describeMeta(); danger-flag computation
  // is left to the caller so this module doesn't have to depend on tiers.js.
  function catalog() {
    var out = [];
    effectors.forEach(function(e) {
      if (typeof e.describeMeta === 'function') out.push(e.describeMeta());
    });
    return out;
  }

  // WAVE 6 — 'unknown-effector' with no further information is a dead end for the
  // model AND for the operator reading the transcript. In the 2026-07-31 session
  // MYTHOS called status({}) and got exactly that string back, with no indication
  // that read_status exists. Offer the nearest registered names instead.
  //
  // Prefix and substring first (they catch the real cases: a truncated or
  // pluralised name), then a bounded edit distance for typos. Cheap: this runs
  // only on the failure path.
  function nearestToolNames(name, limit) {
    var wanted = String(name || '').toLowerCase();
    if (!wanted) return [];
    var names = Array.from(effectors.keys());
    var scored = [];
    for (var i = 0; i < names.length; i++) {
      var candidate = names[i];
      var lower = candidate.toLowerCase();
      var score = null;
      if (lower === wanted) score = 0;
      else if (lower.indexOf(wanted) !== -1 || wanted.indexOf(lower) !== -1) score = 1;
      else {
        var d = editDistance(wanted, lower);
        // Only near-misses; beyond a third of the name it is a different word.
        if (d <= Math.max(2, Math.floor(lower.length / 3))) score = 2 + d;
      }
      if (score !== null) scored.push({ name: candidate, score: score });
    }
    scored.sort(function(a, b) { return a.score - b.score || a.name.length - b.name.length; });
    return scored.slice(0, limit || 3).map(function(s) { return s.name; });
  }

  // Iterative two-row Levenshtein — no recursion, no allocation per character.
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      }
      for (var m = 0; m <= b.length; m++) prev[m] = cur[m];
    }
    return prev[b.length];
  }

  // BUG-076 — 'status' kept dead-ending on 'unknown-effector' even after the
  // Wave 6 suggestion text named read_status: the operator saw "did you mean
  // read_status?", approved it, and the NEXT call still asked for literal
  // 'status' and still got unknown-effector — a suggestion was never wired to
  // an actual retry. A tiny alias table lets the one name MYTHOS actually
  // reaches for resolve instead of merely being described.
  var ALIASES = {
    'status': 'read_status',
  };

  async function invoke(name, params, ctx) {
    var resolvedName = (!effectors.has(name) && ALIASES.hasOwnProperty(name)) ? ALIASES[name] : name;
    var effector = effectors.get(resolvedName);
    if (!effector) {
      var near = nearestToolNames(name, 3);
      return {
        ok: false,
        // The bare string is preserved as a prefix: cortex/index.js and several
        // tests match on 'unknown-effector', and this must stay recognisable.
        result: 'unknown-effector' + (near.length
          ? ': no tool named "' + name + '". Did you mean ' + near.join(', ') + '?'
          : ': no tool named "' + name + '".'),
        unknownTool: String(name || ''),
        suggestions: near,
      };
    }

    // F1: a tool that already failed terminally is not dispatched again this
    // process. The stored text is the effector's own remedy line, so the model
    // still has something actionable to say instead of a bare refusal.
    var dead = terminal.get(resolvedName);
    if (dead) {
      return { ok: false, terminal: true, result: dead.reason };
    }

    if (!breakers.allow(resolvedName)) {
      return { ok: false, result: 'circuit-open' };
    }

    var result;
    try {
      result = await effector.invoke(params, ctx);
    } catch (err) {
      // invoke() contract says effectors never throw, but hub must not trust that —
      // an uncaught throw here must still count as a breaker failure, not crash Cortex.
      // B5: Emit anomaly for observability so operator can see the root cause.
      if (bus) bus.emit('health.anomaly', { kind: 'effector-throw', target: resolvedName, error: err.message });
      result = { ok: false, result: err.message };
    }

    if (isTerminalResult(result)) {
      // F1: record, reset the breaker (it may already be OPEN from the failures
      // that led here — leaving it open pins the HUD's DEGRADED badge forever on
      // a tool that will never be retried), and announce ONCE with the remedy.
      var reason = reasonOf(result);
      if (!terminal.has(resolvedName)) {
        terminal.set(resolvedName, { reason: reason, at: Date.now() });
        breakers.reset(resolvedName);
        if (bus) {
          bus.emit('health.anomaly', {
            kind: 'effector-terminal', target: resolvedName, reason: reason
          });
        }
      }
      return result;
    }

    // BUG-272 T2: `unverified` is NOT a success for breaker purposes.
    //
    // evidence.unverified() always sets ok:true (it means "I did the thing but
    // cannot prove the world changed"), and this branch read result.ok alone — so
    // open_web(browser:true) failing seven consecutive times under Electron, with
    // no surface capable of rendering it, was recorded as seven successes. The
    // breaker exists precisely to stop a tool being retried into the ground, and
    // the one shape it could not see was the one that repeated.
    //
    // A tool that never proves anything therefore trips its breaker after the
    // usual run of attempts, which is the correct outcome: repeatedly doing
    // something unprovable is indistinguishable, from here, from repeatedly
    // failing. It stays ok:true to every OTHER consumer — the evidence contract
    // (dispatch-action.js) is explicit that unverified/reason must not be
    // flattened into ok/fail, and this does not flatten it, it only stops the
    // breaker treating "unproven" as "proven".
    if (result && result.ok && result.unverified !== true) {
      breakers.recordSuccess(resolvedName);
    } else {
      breakers.recordFailure(resolvedName);
    }

    return result;
  }

  return {
    register: register,
    registerNamed: registerNamed,
    get: get,
    invoke: invoke,
    catalog: catalog,
    get effectors() { return effectors; },
    get breakers() { return breakers; },
    // F1: read by the healer's terminal playbook and by anything that wants to
    // explain WHY a tool is missing from the planner's catalog.
    terminalFailures: function() {
      var out = {};
      for (var entry of terminal) out[entry[0]] = { reason: entry[1].reason, at: entry[1].at };
      return out;
    },
    clearTerminal: function(name) { return terminal.delete(name); },
    count: function() { return effectors.size; }
  };
}

module.exports = { createEffectorHub };
