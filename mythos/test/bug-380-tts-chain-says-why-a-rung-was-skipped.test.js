'use strict';

// test/bug-380-tts-chain-says-why-a-rung-was-skipped.test.js — BUG-380.
//
// THE DEFECT, AND WHY IT IS WHY THE "TTS chain" MAP NODE HAS NO EVIDENCE
//
// Track D-3 asked for dead provider lanes to stop costing a timeout. Measured
// first, and the one live instance is the TTS chain — reported by the repo's own
// doctor.js, in its own words:
//
//   gap  Kokoro model (TTS chain rung)  no .onnx weights under models/kokoro —
//        the first fallback to kokoro will spend up to 15000ms downloading
//        before falling through to edge
//        why: kokoro is a member of VOICE_TTS_CHAIN, so its absence is paid for
//             at runtime rather than reported here
//
// `VOICE_TTS_CHAIN` on this machine is `gemini,kokoro,edge,piper`, so kokoro is
// rung 2 with no weights on disk. Two corrections to the work order's framing,
// both from reading the code rather than the ticket: the cost is paid ONCE per
// process, not per call (`providers/tts.js` — "resolve() probes the configured
// chain ONCE", with a sticky `active` provider), and `kokoro-tts.js`'s
// LOAD_TIMEOUT_MS bounds "only the FIRST probe of a cold load". So this is 15
// seconds of silence on the first fallback, not 15 seconds a turn.
//
// WHAT IS ACTUALLY BROKEN — and it is not the download policy
//
// Whether to ship kokoro weights or drop the rung is a DECISION, and the plan
// already lists it as one of three open operator decisions. What is a defect is
// that the cost is INVISIBLE, because the reason is discarded twice on the way
// out:
//
//   providers/tts.js       async function probe(p) {
//                            try { return await p.isAvailable(); }
//                            catch { return false; }        <-- reason gone
//                          }
//                          log.info('tts.unavailable', { provider: nameOf(p) })
//                                                          <-- which, never why
//
//   providers/kokoro-tts.js isAvailable() ... catch { return false; }
//                                                          <-- reason gone again
//
// So a load timeout, a bad model id and a corrupt cache are indistinguishable,
// and nothing anywhere records that fifteen seconds just went into a stalled
// download. That is the same class as the last two tickets — a failure path that
// discards its reason — this time on the most user-visible surface in the
// product, the voice path.
//
// SCOPE. This does not change the download policy, the chain order, or any
// provider's `isAvailable(): boolean` contract. It makes the cost legible so the
// operator's decision can be an informed one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTtsChain } = require('../providers/tts');

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (msg, meta) => lines.push({ level: 'info', msg, meta: meta || {} }),
    warn: (msg, meta) => lines.push({ level: 'warn', msg, meta: meta || {} }),
    error: (msg, meta) => lines.push({ level: 'error', msg, meta: meta || {} }),
    debug: () => {},
  };
}

// A rung. `mode` decides how it declines, which is the whole point: today all
// three modes are indistinguishable in the log.
function rung(name, mode, opts) {
  const o = opts || {};
  return {
    name,
    async isAvailable() {
      if (mode === 'available') return true;
      if (mode === 'throws') throw new Error(o.message || 'kokoro model load timed out after 15000ms');
      if (mode === 'slow-false') {
        await new Promise((r) => setTimeout(r, o.ms || 30));
        return false;
      }
      return false; // 'false'
    },
    unavailableReason: o.reason ? () => o.reason : undefined,
    async synthesize() { return { audio: Buffer.from('x'), mime: 'audio/wav', provider: name }; },
  };
}

// Deliberately local rather than imported: this branch must not depend on a
// helper that lives in another open branch.
function unreadable(text) {
  if (text === undefined) return 'the reason is absent';
  if (text === null) return 'the reason is null';
  if (typeof text !== 'string') return 'the reason is a ' + typeof text;
  if (!text.trim()) return 'the reason is empty';
  if (['undefined', 'null', '[object Object]', 'false'].includes(text.trim())) {
    return 'the reason is the dead literal ' + JSON.stringify(text);
  }
  return null;
}

// Uses the `providers` injection seam added for this fix. The first draft of
// this helper tried to reach the chain through config names and reconstruct it
// afterwards; that silently built the REAL chain and probed the REAL kokoro
// provider, so every test case paid LOAD_TIMEOUT_MS. Measured: 15,109ms per case,
// six cases. That accident is also the live proof the cost is real.
function chainOf(providers, log) {
  return createTtsChain({ config: {}, logger: log, providers: providers });
}

describe('BUG-380 — a skipped TTS rung says WHY, not just which', () => {
  it('a rung that reports unavailable is logged with its reason', async () => {
    const log = capturingLogger();
    const chain = chainOf([
      rung('kokoro', 'false', { reason: 'no .onnx weights under models/kokoro' }),
      rung('edge', 'available'),
    ], log);
    const active = await chain.resolve();
    assert.equal(active && active.name, 'edge', 'the chain still falls through correctly');

    const skipped = log.lines.filter((l) => l.msg === 'tts.unavailable');
    assert.equal(skipped.length, 1, 'the skip is still reported once');
    const why = unreadable(skipped[0].meta.reason);
    assert.equal(why, null, 'the skip must carry a reason — ' + why);
    assert.match(skipped[0].meta.reason, /weights/,
      'and it must be the provider\'s own reason, not a generic placeholder');
  });

  it('a rung whose isAvailable() THROWS does not lose the thrown message', async () => {
    // This is the bare `catch { return false }`. A load timeout, a bad model id
    // and a corrupt cache are all the same `false` today.
    const log = capturingLogger();
    const chain = chainOf([
      rung('kokoro', 'throws', { message: 'kokoro model load timed out after 15000ms' }),
      rung('edge', 'available'),
    ], log);
    const active = await chain.resolve();
    assert.equal(active && active.name, 'edge', 'a throwing rung must still be survivable');

    const skipped = log.lines.filter((l) => l.msg === 'tts.unavailable');
    assert.equal(skipped.length, 1);
    const why = unreadable(skipped[0].meta.reason);
    assert.equal(why, null, 'a thrown reason must survive — ' + why);
    assert.match(skipped[0].meta.reason, /timed out after 15000ms/,
      'the actual timeout message is the whole diagnostic value here');
  });

  it('the time a rung cost is recorded, so a 15s stall is a number', async () => {
    const log = capturingLogger();
    const chain = chainOf([
      rung('kokoro', 'slow-false', { ms: 40 }),
      rung('edge', 'available'),
    ], log);
    await chain.resolve();
    const skipped = log.lines.filter((l) => l.msg === 'tts.unavailable');
    assert.equal(skipped.length, 1);
    assert.equal(typeof skipped[0].meta.ms, 'number',
      'without a number nobody can tell a 2ms decline from a 15000ms stall');
    assert.ok(skipped[0].meta.ms >= 30,
      'the recorded cost must be the real elapsed time, got ' + skipped[0].meta.ms);
  });

  it('a rung with no unavailableReason() still gets something actionable', async () => {
    // Most providers will not implement the optional hook. They must not end up
    // worse off than a generic placeholder — the provider name plus the timing
    // is the floor.
    const log = capturingLogger();
    const chain = chainOf([rung('piper', 'false'), rung('edge', 'available')], log);
    await chain.resolve();
    const skipped = log.lines.filter((l) => l.msg === 'tts.unavailable');
    assert.equal(skipped.length, 1);
    assert.equal(unreadable(skipped[0].meta.reason), null);
    assert.equal(skipped[0].meta.provider, 'piper', 'and it still says which rung');
  });
});

describe('BUG-380 — negative controls: the resolve path itself must not change', () => {
  it('the first available rung still wins, and is still sticky', async () => {
    const log = capturingLogger();
    let probes = 0;
    const first = rung('gemini', 'available');
    const inner = first.isAvailable;
    first.isAvailable = async function () { probes += 1; return inner.call(this); };
    const chain = chainOf([first, rung('edge', 'available')], log);

    assert.equal((await chain.resolve()).name, 'gemini');
    assert.equal((await chain.resolve()).name, 'gemini');
    assert.equal(probes, 1, 'resolve() probes ONCE and remembers — the sticky contract');
    assert.equal(log.lines.filter((l) => l.msg === 'tts.unavailable').length, 0,
      'nothing was skipped, so nothing is reported as skipped');
    assert.equal(log.lines.filter((l) => l.msg === 'tts.resolved').length, 1);
  });

  it('a chain with nothing available still warns exactly once', async () => {
    const log = capturingLogger();
    const chain = chainOf([rung('kokoro', 'false'), rung('edge', 'throws')], log);
    assert.equal(await chain.resolve(), null);
    assert.equal(log.lines.filter((l) => l.msg === 'tts.none-available').length, 1);
    assert.equal(log.lines.filter((l) => l.msg === 'tts.unavailable').length, 2,
      'both rungs are reported, each with its own reason');
    for (const l of log.lines.filter((x) => x.msg === 'tts.unavailable')) {
      assert.equal(unreadable(l.meta.reason), null, 'every skip explains itself');
    }
  });
});

// ---------------------------------------------------------------------------
// The REAL kokoro provider. Added because a mutation survived: everything above
// uses fake rungs, so kokoro's own `unavailableReason()` — the second of the two
// places the reason was being dropped — was never exercised at all.
//
// WHAT THIS DOES NOT DO, deliberately: it does not call the real
// `isAvailable()`. That probe downloads weights from Hugging Face bounded at
// LOAD_TIMEOUT_MS, and on this machine (no weights on disk) it costs the full
// 15,109ms — measured, when an earlier draft of this file did it by accident six
// times over. A test that pays fifteen seconds to assert a string is a test
// people delete. kokoro has no loader injection seam and adding one would change
// a live voice path, which is a different decision from making the log honest.
//
// So: the contract is asserted at the source, and that limit is stated rather
// than hidden. The behavioural half of the guarantee is covered by the injected
// rungs above, which drive the identical code path in providers/tts.js.
const fsReal = require('fs');
const pathReal = require('path');
const kokoro = require('../providers/kokoro-tts');

describe('BUG-380 — the real kokoro rung exposes a reason', () => {
  it('exports the optional hook the chain looks for', () => {
    assert.equal(typeof kokoro.unavailableReason, 'function',
      'providers/tts.js probes for exactly this name after a false');
    assert.equal(typeof kokoro.isAvailable, 'function',
      'and isAvailable() stays the boolean contract every provider shares');
  });

  it('reports nothing before it has declined anything', () => {
    // null, not '' and not a placeholder: "I have no reason to give" and "the
    // reason is empty" are different facts, and the chain supplies its own floor.
    assert.equal(kokoro.unavailableReason(), null);
  });

  it('every decline path in the source records a reason', () => {
    // Source-shape, and narrow: three `return false` paths exist in
    // isAvailable() and each must set lastUnavailableReason first. The sticky
    // path is the one that was missed in the first draft — loadModel()'s own
    // .catch() can set modelFailed without isAvailable() ever seeing the error,
    // so probes 2..n would have reported "gave no reason" for a cause that was
    // known on probe 1.
    const src = fsReal.readFileSync(
      pathReal.join(__dirname, '..', 'providers', 'kokoro-tts.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function isAvailable()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const declines = body.split('return false').length - 1;
    assert.ok(declines >= 2, 'expected the sticky and the catch decline paths, found ' + declines);
    // A MUTATION SURVIVED THE FIRST DRAFT OF THIS LINE. It asserted only that
    // the string `lastUnavailableReason =` appears — which is still true after
    // `lastUnavailableReason = null`, i.e. after the exact defect being guarded
    // against. The reason has to be derived from the ERROR, so that is what is
    // asserted now.
    assert.match(body, /lastUnavailableReason = \(text\.trim\(\)/,
      'the catch path must build its reason from the thrown error text, not '
      + 'assign a constant or null — a decline that records nothing IS this defect');
    assert.match(body, /const text = \(err && err\.message\)/,
      'and it must actually read the error message');
    // The sticky branch specifically.
    assert.match(body, /if \(modelFailed\)[\s\S]{0,400}lastUnavailableReason/,
      'the sticky already-failed branch must supply a reason too');
    assert.match(body, /weights dir/,
      'and the reason should name the directory, since "no weights" is the '
      + 'commonest cause and the operator can act on a path');
  });
});
