'use strict';

// effectors/adapter.js — wraps a NOVA-style tool ({ name, description, params, danger,
// dangerWhen?, fn }) into the canonical Effector shape Cortex/EffectorHub expect.
// CA from MYTHOS-ARCHITECTURE.md §12 "Tool → Effector Adapter" — logic is verbatim,
// only the require path for tierOf changed to match Leash's real module location.

const { tierOf } = require('../leash/tiers');
const { reasonText, isDeadReasonText } = require('../util/reason-text');

// BUG-378 (2026-08-27). THE ONE DOOR every tool failure leaves through.
//
// Measured that day: all 29 files in this directory register exclusively via
// `hub.register(effectorFromTool(...))` — zero direct registrations — so every
// one of the 179 registered tools' failures passes through invoke() below. That
// makes this the only place the "a failure path that discards its reason" class
// has to be closed, and test/effector-failure-reason-class.test.js Part A pins
// the door shut so it stays the only one.
//
// A reason that reaches nobody is the same defect as no reason at all, and this
// tree has now paid for it four times (BUG-101 here, P2-12 in dispatch-action,
// B5 across seven effectors, and BUG-378 — which was in THIS FILE, two lines
// below the comment describing the first fix). Of 345 completed-fail rows in the
// operator's audit trail, 28 carried nothing actionable.
//
// Last resort when a tool reports failure and genuinely supplied no reason. It
// names the tool and the keys it did return, because "which effector do I open"
// is the one question the reader always has and the one an empty string always
// refused to answer. Loud beats a plausible guess: this must never be phrased so
// it reads like a diagnosis of the outside world.
//
// Bounded on purpose. dispatch-action.js truncates the audit reason to 300
// chars, but hub.js's reasonOf() stores this same text as a breaker's remedy
// with NO truncation, and the voice summary speaks it — so a tool returning an
// object with hundreds of keys would otherwise produce one unbounded sentence on
// two surfaces that never asked for a cap. Six keys is enough to recognise a
// shape; the count tells the reader when there are more.
var MAX_SHAPE_KEYS = 6;

// reasonText() answers "what text can I get out of this?". This answers the
// question the DOOR actually has: "did that text carry any information?" —
// because here the answer is STORED as a standalone field, not concatenated into
// a caller's own sentence, so a token like 'NaN' is worse than nothing. Returns
// '' for a dead answer so the `||` below falls through to noReasonGiven().
//
// Found by hostile-input probe 2026-08-27, not by reading: `{ok:false,
// error: NaN}` produced the string 'NaN', which is truthy, so the mirror
// accepted it and the operator's entire explanation was three letters. Three of
// fifteen probed shapes did this. FRAGILITY, NOT AN OBSERVED LIVE BUG — no
// effector in this tree is known to return NaN — closed because a door that
// substitutes a reason should not accept a token it would reject from anyone
// else.
function usableReason(raw) {
  var text = reasonText(raw);
  return isDeadReasonText(text) ? '' : text;
}

function noReasonGiven(toolName, result) {
  var keys;
  try {
    var all = Object.keys(result || {});
    keys = all.length === 0 ? 'none'
      : all.length <= MAX_SHAPE_KEYS ? all.join(', ')
        : all.slice(0, MAX_SHAPE_KEYS).join(', ') + ' and ' + (all.length - MAX_SHAPE_KEYS) + ' more';
  } catch (_) {
    // Checked in node 26 rather than assumed, because the first draft of this
    // comment was wrong: `Object.keys(Object.create(null))` returns `[]` and
    // does NOT throw. The only thing here that throws is a Proxy with an
    // `ownKeys` trap that raises. Rare, but this is the last resort itself, and
    // the last resort throwing would replace a diagnosable failure with a stack
    // trace from the error reporter.
    keys = 'unreadable';
  }
  return toolName + ' reported a failure with no reason (returned keys: ' + keys + ')';
}

function effectorFromTool(tool) {
  return {
    id: tool.name,
    tier: tierOf(tool.name),
    dangerWhen: tool.dangerWhen,           // read by leash.check() at gate time — not here
    prepare: tool.prepare,                 // B2a: async resolution, run by leash.prepare() before check()
    approvalFor: tool.approvalFor,         // B2a: resolved target -> { approval: 'none'|'required'|'refuse', detail }
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
          // `== null` catches undefined AND null deliberately. The two say the
          // same thing here — "this failure carried no reason" — and reading
          // only `undefined` let `{ok:false, result:null}` walk past the mirror
          // untouched to become an empty audit reason. FRAGILITY, NOT A LIVE
          // BUG, and recorded as such: verified 2026-08-27 that no effector in
          // this tree returns `result: null` and no consumer anywhere
          // distinguishes null from undefined on `.result`, so nothing was
          // observed failing this way. It is closed because the invariant should
          // hold for the shape, not because the shape was seen.
          if (result.ok === false && result.result == null) {
            // BUG-378: this mirror used to read ONLY the string spellings and
            // then `if (reason) return ...` — so it declined to act in exactly
            // the cases where the reason was most degraded, and fell through
            // leaving `result` undefined. Measured on HEAD before the fix: of
            // twelve real failure shapes, seven arrived at the audit row as an
            // empty string for all 179 tools, and two of those seven
            // ({error: {code:'ECONNRESET'}}, a thrown {code:'ENOENT'}) were
            // carrying a perfectly readable reason that this line dropped.
            //
            // reasonText() handles the non-string spellings (it digs out
            // .error/.message, else JSON-dumps rather than emitting
            // "[object Object]"), and it is the same normaliser
            // dispatch-action.js and hub.js's reasonOf() already use — one
            // shared normaliser rather than a third local copy to drift.
            var reason = usableReason(result.error) || usableReason(result.reason);
            return Object.assign({}, result, {
              result: reason || noReasonGiven(tool.name, result),
            });
          }
          return result;
        }
        return { ok: true, result: result };
      } catch (err) {
        // BUG-378, THE FOURTH INSTANCE OF THE CLASS, and it was here — nine
        // lines under the comment describing the fix for the first instance.
        // `err.message` is undefined for anything that is not an Error, and
        // effector adapters in this tree really do throw bare strings and plain
        // {code, path} bags, so this returned `result: undefined` and the
        // operator was told a tool failed with no reason at all. reasonText()
        // was extracted in B5 (2026-08-13) for precisely this and never reached
        // this line.
        return { ok: false, result: usableReason(err) || noReasonGiven(tool.name, err) };
      }
    }
  };
}

module.exports = { effectorFromTool };
