'use strict';

// bug-273-c3-whole-lane-timeout.test.js — BUG-273 C3.
//
// MEASURED, mythos-server.log 2026-08-18 — two screen_look failures, minutes apart,
// reported to the operator as two unrelated problems:
//   11:35:04  google  gemini-3.5-flash-lite  ms:2672  ok:true       <- it worked
//   11:38:18  google  gemini-3.5-flash-lite  ms:4009  timedOut
//   11:38:22  mistral mistral-small-latest   ms:4001  timedOut
//   11:38:26  mistral mistral-large-2512     ms:4000  timedOut
//   11:38:30  google  gemini-flash-latest    ms:4001  timedOut
//   11:38:34  nim     llama-3.2-11b-vision   ms:4004  timedOut
//   11:38:38  nim2    llama-3.2-11b-vision   ms:4006  timedOut
//   11:38:42  nim     nemotron-nano-12b-vl   ms:4009  timedOut
//   11:38:44  every entry skipped: 'cooldown'  ->  "Vision providers are offline"
//
// Nine models across five unrelated providers aborting within 15ms of the same
// 4000ms ceiling is not nine simultaneous outages. It is one shared cause on this
// side, and the second incident is a DIRECT CONSEQUENCE of the first: the timeouts
// cooled every entry, so the next look skipped the whole lane instantly and
// reported it offline. Two incidents, one causal chain.
//
// THE MECHANISM IS A PREVIOUS FIX. BUG-272-era B1 (2026-08-14) made attemptTimedOut
// take a cooldown, reasoning that "a provider that will not answer inside its own
// step budget plainly is at fault". True — but only while the budget is generous
// next to known-good latency, and it was not: PREF_VISION's own recorded latencies
// include 3090ms and the call that SUCCEEDED three minutes earlier took 2672ms,
// against a 4000ms budget. A budget ~30% above the known-good case cannot tell slow
// from dead.
//
// TWO CHANGES, and the first is the durable one:
//   1. A timeout is provider-specific evidence only if some OTHER provider failed
//      for a reason that names it. All-timeouts drops the cooldowns instead.
//   2. The budgets clear the lane's own recorded latencies with real headroom, and
//      the total is a multiple of the step so three attempts actually fit.
//
// Q8 — RATE-LIMIT, 5xx AND NETWORK FAILURES ARE UNAFFECTED. Those name a provider
// by themselves and still cool down immediately, whatever the rest of the lane did.
// Weakening them would reopen the all-day-dead-provider bug B1 closed, and that is
// asserted here rather than trusted.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('BUG-273 C3 — the budget that could not tell slow from dead', () => {
  it('the per-attempt bound clears the lane\'s slowest recorded good latency', () => {
    const schema = read('src/core/config/schema.js');
    const m = schema.match(/VISION_ATTEMPT_TIMEOUT_MS:\s+\{ type: 'number', default: (\d+)/);
    assert.ok(m, 'the setting must still exist');
    const attemptMs = Number(m[1]);
    // 3090ms is PREF_VISION's own recorded figure for gemini-3-flash-preview; 2672ms
    // is what the successful 2026-08-18 look actually took. A budget that does not
    // clear both with room to spare turns one slow minute into a lane-wide outage.
    assert.ok(attemptMs >= 3090 * 2,
      `${attemptMs}ms must be at least double the 3090ms the lane records for its own head`);
    assert.ok(attemptMs > 4000, 'the 4000ms that produced nine identical timeouts is not enough');
  });

  it('the total budget still fits at least three attempts', () => {
    const vision = read('src/core/effectors/vision-call.js');
    const total = Number((vision.match(/DEFAULT_VISION_TIMEOUT_MS = (\d+)/) || [])[1]);
    const attemptMs = Number((read('src/core/config/schema.js')
      .match(/VISION_ATTEMPT_TIMEOUT_MS:\s+\{ type: 'number', default: (\d+)/) || [])[1]);
    assert.ok(total && attemptMs, 'both numbers must be readable');
    assert.ok(Math.floor(total / attemptMs) >= 3,
      `${total}/${attemptMs} = ${Math.floor(total / attemptMs)} attempts — raising the step without `
      + 'raising the total removes the failover the pair exists to provide, which is the '
      + 'mistake this assertion is here to catch');
  });
});

describe('BUG-273 C3 — a whole-lane timeout takes no cooldown', () => {
  const chain = read('src/core/brain/chain.js');

  it('timeout cooldowns are deferred rather than taken inside the loop', () => {
    assert.match(chain, /const deferredTimeoutCooldowns = \[\];/,
      'the decision cannot be made per-attempt: it depends on what the OTHER attempts did');
    assert.match(chain, /\} else if \(attemptTimedOut\) \{[\s\S]{0,220}deferredTimeoutCooldowns\.push/,
      'a timed-out attempt must be held, not cooled immediately');
  });

  it('Q8 — 429 / 5xx / network still cool down immediately, unchanged', () => {
    // BUG-336: namesAProvider is now derived from classifyProviderError()
    // (typed err.kind/status/code first, prose as visible fallback). The
    // behavioural contract these three tiers name a provider on their own and
    // must not be deferred is enforced by chain-provider-error-classification
    // .test.js; this pin stays structural so nobody can quietly defer them.
    assert.match(chain, /var namesAProvider = cls\.kind === 'rate-limit' \|\| cls\.kind === 'server' \|\| cls\.kind === 'network';/,
      'these three name a provider on their own and must not be deferred');
    assert.match(chain, /if \(namesAProvider\) \{[\s\S]{0,400}markCooldown\(lane, model, cooldownMs\)/,
      'and they must still mark the cooldown inside the loop');
    assert.match(chain, /if \(namesAProvider\) \{[\s\S]{0,400}breaker\.recordFailure\(\)/,
      'including the escalating half, or B1\'s all-day-outage fix is undone');
  });

  it('all-timeouts drops the cooldowns; a mixed run still takes them', () => {
    assert.match(chain, /const sharedCauseLikely = !anyAttemptSucceeded\s*\n\s*&& nonTimeoutFailures === 0\s*\n\s*&& deferredTimeoutCooldowns\.length > 1;/,
      'three conditions, and each one is load-bearing: a success or a provider-naming '
      + 'failure in the same run disproves the shared-cause theory, and a single attempt '
      + 'has no "every provider" pattern to reason about');
    assert.match(chain, /deferredTimeoutCooldowns\.forEach\(function \(c\) \{[\s\S]{0,200}markCooldown\(c\.lane, c\.model, cooldownMs\)/,
      'the mixed case must still apply every deferred cooldown');
  });

  it('a SUCCESS in the same run disproves the shared cause, so the timeouts are cooled', () => {
    // The correction that mattered most, and it was found by chain-provider-breakers'
    // own first assertion rather than by anything written here. Two bugs in one:
    //   1. the settlement only ran on the EXHAUSTED path, so any run that eventually
    //      got an answer silently dropped the cooldown — which is the common case, so
    //      B1's fix would have applied to almost nothing;
    //   2. {nim hangs, nim2 hangs, mistral answers} has zero non-timeout failures and
    //      more than one timeout, so the first rule would have exempted both dead NIM
    //      entries — the exact all-day outage B1 was written to stop.
    // The network was demonstrably fine, so the ones that timed out really were slow.
    assert.match(chain, /anyAttemptSucceeded = true;\s*\n\s*settleDeferredTimeouts\(\);\s*\n\s*return \{ content, provider: lane, model \};/,
      'the success path must record the success AND settle before returning');
    assert.match(chain, /if \(deferredSettled\) return;/,
      'and settling must be idempotent, since both exits can be reached in one call');
  });

  it('a SINGLE timed-out attempt is still cooled — a one-deep lane must not be exempt', () => {
    // `length > 1` is load-bearing. With one attempt there is no "every provider"
    // pattern to reason about, and refusing to cool would leave a genuinely dead
    // provider at the head of a one-model lane forever, which is the bug B1 fixed.
    assert.match(chain, /deferredTimeoutCooldowns\.length > 1/,
      'the all-timeouts exemption must require more than one attempt to have happened');
  });

  it('Q2 — the dropped decision is reported on two channels, never silent', () => {
    assert.match(chain, /whole-lane-timeout/, 'it must be greppable in the log');
    assert.match(chain, /kind: 'chain-whole-lane-timeout'/,
      'and reach the Health view — an invisible non-cooldown is how the opposite bug hides');
    assert.match(chain, /attemptTimeoutMs: attemptTimeoutMs,/,
      'carrying the ceiling that produced it, since that is the number to change');
    assert.match(chain, /reason: 'every ' \+ effectiveKind \+ ' attempt timed out/,
      'anomaly payloads are spoken from `reason`, so it has to read as a sentence');
  });

  it('the telemetry cannot break the chain', () => {
    assert.match(chain, /\} catch \(_\) \{ \/\* telemetry must never break the chain \*\/ \}/,
      'a bus.emit failure must not turn a recoverable vision miss into an exception');
  });
});
