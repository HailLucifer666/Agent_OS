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
 * @param {object} [opts.logger]    logger with info(); omitted = no instrumentation
 * @returns {Promise<{content:?string, provider:?string, model:?string, offline:boolean, timedOut:boolean, ms:number}>}
 */
async function visionThink(brain, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
    ? o.timeoutMs
    : DEFAULT_VISION_TIMEOUT_MS;
  const startedAt = Date.now();
  const log = (o.logger && typeof o.logger.info === 'function') ? o.logger : null;

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
    if (log) log.info('vision.call', { source: o.source || 'vision-look', ms, ok: false, timedOut: true, timeoutMs });
    return { content: null, provider: null, model: null, offline: false, timedOut: true, ms };
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

module.exports = { visionThink, DEFAULT_VISION_TIMEOUT_MS };
