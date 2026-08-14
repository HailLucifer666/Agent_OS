// vision-call.js — the one way an effector asks the vision lane to look at an
// image. Shared by screen_look (from-pc.js) and camera_look (from-dashboard.js).
//
// It exists because of two things the 2026-08-10 webcam incident exposed, both
// of which were invisible rather than subtle:
//
//   1. NOTHING RECORDED WHICH MODEL ANSWERED, OR HOW LONG IT TOOK. brain.think()
//      returns { provider, model } and no caller logged either. The only way to
//      learn that two screen_look calls took 16s and 63s was to subtract audit
//      timestamps by hand, days later. Every vision call now emits one
//      `vision.call` line: provider, model, ms, ok.
//
//   2. THE CALL WAS EFFECTIVELY UNBOUNDED. CHAIN_ATTEMPT_TIMEOUT_MS is 30s PER
//      ATTEMPT and the vision lane is seven models deep, so a starved free-tier
//      provider can hold a "quick look" for a minute or more. Meanwhile a Live
//      turn lasts seconds: the model is asked to speak long before the answer
//      exists, and when the operator pushes ("can you see? you didn't answer")
//      it fills the silence with an invention. Bounding the call does not stop
//      the model guessing — nothing here can, the turn boundary is the model's —
//      but it collapses the window from a minute to seconds, and it turns a
//      hanging look into an honest "the vision model did not answer in time".
//
// The timeout resolves rather than rejects, with timedOut:true, because the
// caller has to be able to say WHY it saw nothing. A thrown error would surface
// as a bare failure string and the distinction would be lost.

const DEFAULT_VISION_TIMEOUT_MS = 12000;

// Per-ATTEMPT bound, threaded into chain.js — distinct from the total-call bound
// above, and the fix for the 2026-08-14 screen_look failures.
//
// The two numbers used to be incompatible rather than merely different. This
// function raced the WHOLE call against 12s while chain.js gave EACH provider
// attempt CHAIN_ATTEMPT_TIMEOUT_MS = 30000. So when the first-ranked vision model
// was merely slow — not dead, and therefore invisible to the laneEmpty preflight
// below — the outer race expired at 12s while the chain was still inside attempt
// #1, and models 2-5 were never tried at all. Both of that session's screen_look
// calls failed that way, with all five cloud vision providers keyed and alive.
// The lane had failover; the budget just never let it run.
//
// 4s per attempt lets the 12s budget genuinely walk 2-3 models. It is deliberately
// aggressive: a vision call answers a question asked mid-conversation, so a model
// that cannot reply in 4 seconds has already lost to the next one in the ranking,
// and being wrong about that costs a retry against a slower model rather than a
// wrong answer. Falls back to the outer budget when that is somehow shorter — a
// per-attempt bound above the total bound would reintroduce the exact bug.
const DEFAULT_VISION_ATTEMPT_TIMEOUT_MS = 4000;

// Wave 5 (2026-08-13) — lane preflight. registry.js already walks the vision
// lane alive-provider-only (chainFor), same discipline probes.js's own status
// read uses; requiring it directly here mirrors that existing pattern rather
// than threading a new dependency through every caller. Pure lookup, no
// network call of its own.
const registry = require('../brain/registry');

/**
 * Ask the vision lane about one image, bounded and instrumented.
 *
 * @param {object} brain            brain facade (must expose think())
 * @param {object} opts
 * @param {string} opts.prompt      the question to ask about the image
 * @param {string} opts.b64         base64 image data, no data: prefix
 * @param {string} opts.source      brain.think source tag ('screen-look' | 'camera-look')
 * @param {string} [opts.mime]      image mime type (default image/png)
 * @param {number} [opts.timeoutMs] override; falls back to DEFAULT_VISION_TIMEOUT_MS
 * @param {number} [opts.attemptTimeoutMs] per-provider-attempt override; falls back
 *   to DEFAULT_VISION_ATTEMPT_TIMEOUT_MS, and is clamped below timeoutMs
 * @param {object} [opts.logger]    logger with info(); omitted = no instrumentation
 * @param {Function} [opts.chainFor] test seam — defaults to the real
 *   registry.chainFor. Only meaningful when `brain` IS the production brain
 *   facade (which calls the same registry internally) — a caller passing a
 *   different/fake `brain.think` should inject a stub here too, or the
 *   preflight below is answering about a lane that fake brain never touches.
 * @returns {Promise<{content:?string, provider:?string, model:?string, offline:boolean, timedOut:boolean, ms:number}>}
 */
async function visionThink(brain, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
    ? o.timeoutMs
    : DEFAULT_VISION_TIMEOUT_MS;
  const requestedAttemptMs = Number.isFinite(o.attemptTimeoutMs) && o.attemptTimeoutMs > 0
    ? o.attemptTimeoutMs
    : DEFAULT_VISION_ATTEMPT_TIMEOUT_MS;
  // A per-attempt bound at or above the total bound is the bug, not a config
  // choice — it guarantees the chain never gets past attempt #1.
  const attemptTimeoutMs = Math.min(requestedAttemptMs, timeoutMs);
  const startedAt = Date.now();
  const rawLog = (o.logger && typeof o.logger.info === 'function') ? o.logger : null;
  // Instrumentation must never be able to fail the thing it measures. Found by
  // test rather than in production: a logger whose info() throws took the whole
  // look down, which was already true of the terminal vision.call line before the
  // per-attempt lines below multiplied the number of chances to hit it. Same rule
  // as pcm-player's throwing-callback guard — the log is an optimisation, the
  // answer is the product.
  const log = rawLog
    ? { info: (evt, data) => { try { rawLog.info(evt, data); } catch (_) { /* logging only */ } } }
    : null;
  // Per-provider latency, which BUG-209 named as the missing evidence that made
  // reordering the vision lane a guess. One line per attempt, so a slow lane is
  // now readable as "which model, how long" instead of a single silent 12s.
  const attempts = [];
  const chainFor = typeof o.chainFor === 'function' ? o.chainFor : registry.chainFor;

  // Wave 5 — the 2026-08-12/13 session's ×4 screen_look / camera_look
  // failures: with the fast vision providers down, the lane degraded to
  // 90-185s NIM models, and this function's own 12s timeout always lost —
  // reported as timedOut:true with no hint that the WHOLE lane was actually
  // unreachable, not just slow. chainFor() is the same alive-only ranking
  // brain.think's own chain-walk already uses internally; checking it here
  // costs one cheap lookup and turns "waited 12s, got silence" into an honest,
  // FAST failure naming which providers were tried and found dead.
  try {
    const aliveChain = await chainFor('vision');
    if (!aliveChain.length) {
      const ms0 = Date.now() - startedAt;
      if (log) log.info('vision.call', { source: o.source || 'vision-look', ms: ms0, ok: false, laneEmpty: true });
      return {
        content: null, provider: null, model: null, offline: true, timedOut: false, ms: ms0,
        laneEmpty: true,
        reason: 'the vision lane has no live provider right now (every configured vision model is down or unconfigured)',
      };
    }
  } catch (_) { /* preflight is best-effort — never block the real call on it */ }

  const think = brain.think({
    lane: 'vision',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: String(o.prompt || 'Describe this image, briefly and concretely.') },
        { type: 'image_url', image_url: { url: 'data:' + (o.mime || 'image/png') + ';base64,' + o.b64 } },
      ],
    }],
    source: o.source || 'vision-look',
    attemptTimeoutMs,
    onAttemptEnd: (a) => {
      attempts.push(a);
      if (log) log.info('vision.attempt', { source: o.source || 'vision-look', ...a });
    },
  });

  let timer = null;
  const TIMED_OUT = Symbol('vision-timeout');
  const settled = await Promise.race([
    think.catch((err) => ({ __error: err })),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  const ms = Date.now() - startedAt;

  if (settled === TIMED_OUT) {
    // The underlying call is NOT cancellable (brain.think has no abort seam), so
    // it keeps running and its result is discarded. Attach a no-op catch so a
    // later rejection cannot surface as an unhandled promise rejection.
    think.then(() => {}, () => {});
    // `attempts` is the whole point of the 2026-08-14 change: a bare "timed out"
    // could not distinguish "one slow model ate the budget" (the actual cause)
    // from "every model was tried and all were slow" (a lane-ordering problem).
    if (log) {
      log.info('vision.call', {
        source: o.source || 'vision-look', ms, ok: false, timedOut: true,
        timeoutMs, attemptTimeoutMs, attemptsTried: attempts.length,
        attempts: attempts.map((a) => `${a.provider}:${a.model} ${a.ms}ms${a.timedOut ? ' timeout' : ''}`),
      });
    }
    return {
      content: null, provider: null, model: null, offline: false, timedOut: true, ms,
      attemptsTried: attempts.length,
    };
  }

  if (settled && settled.__error) {
    if (log) log.info('vision.call', { source: o.source || 'vision-look', ms, ok: false, error: String(settled.__error && settled.__error.message || settled.__error).slice(0, 200) });
    throw settled.__error;
  }

  const result = settled || {};
  if (log) {
    log.info('vision.call', {
      source: o.source || 'vision-look',
      provider: result.provider || null,
      model: result.model || null,
      ms,
      ok: !result.offline && !!result.content,
      offline: !!result.offline,
      chars: result.content ? String(result.content).length : 0,
      attemptsTried: attempts.length,
    });
  }
  return {
    content: result.content || null,
    provider: result.provider || null,
    model: result.model || null,
    offline: !!result.offline,
    timedOut: false,
    ms,
  };
}

module.exports = { visionThink, DEFAULT_VISION_TIMEOUT_MS, DEFAULT_VISION_ATTEMPT_TIMEOUT_MS };
