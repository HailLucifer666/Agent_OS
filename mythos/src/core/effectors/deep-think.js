'use strict';

// deep-think.js — the one way an effector asks the REASONING lane a question,
// bounded and instrumented. Backs the `think_deeply` tool (from-computer.js).
//
// WHY THIS EXISTS AT ALL. Before 2026-08-14 there was no route from a
// conversation to a good model. The Live voice path (voice/live-session.js,
// voice/live-tool-adapter.js) contains ZERO brain.think calls — it talks to
// Google's bidi Live endpoint directly — so re-ranking every lane in
// lanes.default.js could not change conversational quality by one word. The
// Live model itself is capped at Flash tier on this key (all six
// bidiGenerateContent models are Flash; Pro Live is 404, and Google's own
// QuotaFailure IDs confirm free tier), and that ceiling is not fixable from
// here. A TOOL is the only mechanism: the conversation delegates the hard part
// to a 4/4 reasoning model and speaks the answer back.
//
// Structure is deliberately COPIED from vision-call.js rather than re-derived —
// the per-attempt timeout threading, the attempt log, the wrapped-logger guard
// and the lane preflight are all fixes that were paid for once already:
//   - a caller whose total budget is shorter than chain.js's per-attempt step
//     gets NO failover at all, because the first slow provider eats everything;
//   - a logger whose info() throws must not be able to fail the call it measures;
//   - "waited N seconds, got silence" and "the whole lane is unreachable" are
//     different answers and the operator has to be told which one happened.

const registry = require('../brain/registry');

// Total bound. Longer than vision's 12s ON PURPOSE and the difference is the
// whole point of the tool: a look answers a question the operator asked about
// something on screen right now, while think_deeply is the explicit "go away and
// think about this properly" verb. 20s still keeps it inside a conversation —
// past that the operator has moved on and an honest "that took too long" beats a
// late answer. Measured heads: Cerebras gpt-oss-120b 778ms, zai-glm-4.7 1306ms,
// NIM nemotron-3.5-lightning 4123ms (all on ~50-token probes, 2026-08-14 — real
// prompts are 10k+ tokens and will be slower, which is the other reason for the
// margin).
const DEFAULT_DEEP_THINK_TIMEOUT_MS = 20000;

// Per-ATTEMPT bound, threaded into chain.js. Same invariant vision-call.js
// documents: a per-attempt bound at or above the total bound guarantees the
// chain never gets past attempt #1, so this is clamped below the total. 7s lets
// a 20s budget genuinely walk ~3 of the four cloud entries in PREF_REASONING.
const DEFAULT_DEEP_THINK_ATTEMPT_TIMEOUT_MS = 7000;

const MAX_QUESTION_CHARS = 8000;

/**
 * Ask the reasoning lane one question, bounded and instrumented.
 *
 * @param {object} brain              brain facade (must expose think())
 * @param {object} opts
 * @param {string} opts.question      the question to reason about
 * @param {string} [opts.context]     extra grounding text pasted before the question
 * @param {string} [opts.source]      brain.think source tag (default 'think-deeply')
 * @param {number} [opts.timeoutMs]   total bound; falls back to the default above
 * @param {number} [opts.attemptTimeoutMs] per-provider-attempt bound, clamped below timeoutMs
 * @param {object} [opts.logger]      logger with info(); omitted = no instrumentation
 * @param {Function} [opts.chainFor]  test seam — defaults to the real registry.chainFor.
 *   Only meaningful when `brain` IS the production brain facade (which calls the
 *   same registry internally); a caller passing a fake brain.think should inject
 *   a stub here too, or the preflight is answering about a lane that fake never
 *   touches. Same caveat vision-call.js carries, for the same reason.
 * @returns {Promise<{content:?string, provider:?string, model:?string, offline:boolean,
 *   timedOut:boolean, ms:number, laneEmpty?:boolean, reason?:string, attemptsTried?:number}>}
 */
async function deepThink(brain, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
    ? o.timeoutMs
    : DEFAULT_DEEP_THINK_TIMEOUT_MS;
  const requestedAttemptMs = Number.isFinite(o.attemptTimeoutMs) && o.attemptTimeoutMs > 0
    ? o.attemptTimeoutMs
    : DEFAULT_DEEP_THINK_ATTEMPT_TIMEOUT_MS;
  const attemptTimeoutMs = Math.min(requestedAttemptMs, timeoutMs);
  const startedAt = Date.now();
  const source = o.source || 'think-deeply';

  const rawLog = (o.logger && typeof o.logger.info === 'function') ? o.logger : null;
  // Instrumentation must never be able to fail the thing it measures — the
  // guard vision-call.js added after a throwing logger took a whole look down.
  const log = rawLog
    ? { info: (evt, data) => { try { rawLog.info(evt, data); } catch (_) { /* logging only */ } } }
    : null;
  const attempts = [];
  const chainFor = typeof o.chainFor === 'function' ? o.chainFor : registry.chainFor;

  const question = String(o.question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) {
    // BUG-478 2026-10-06: the other silent early return; same line as the rest.
    if (log) log.info('deepthink.refused', { reason: 'empty-question' });
    return {
      content: null, provider: null, model: null, offline: true, timedOut: false,
      ms: 0, reason: 'no question was given to think about',
    };
  }

  // Lane preflight. With no reasoning provider alive this returns FAST and says
  // so, instead of spending the full budget to report an indistinguishable
  // silence. Same cheap registry lookup the chain walk uses internally.
  try {
    const aliveChain = await chainFor('reasoning');
    if (!aliveChain.length) {
      const ms0 = Date.now() - startedAt;
      if (log) log.info('deepthink.call', { source, ms: ms0, ok: false, laneEmpty: true });
      return {
        content: null, provider: null, model: null, offline: true, timedOut: false, ms: ms0,
        laneEmpty: true,
        reason: 'the reasoning lane has no live provider right now (every configured reasoning model is down or unconfigured)',
      };
    }
  } catch (_) { /* preflight is best-effort — never block the real call on it */ }

  const contextBlock = o.context ? ('Context:\n' + String(o.context).slice(0, MAX_QUESTION_CHARS) + '\n\n') : '';

  const think = brain.think({
    lane: 'reasoning',
    messages: [{
      role: 'user',
      content: contextBlock
        + 'Think this through carefully and answer it properly:\n\n' + question
        + '\n\nGive the answer itself, not a description of how you would approach it. '
        + 'If the question cannot be answered from what you were given, say exactly what is missing.',
    }],
    source,
    attemptTimeoutMs,
    onAttemptEnd: (a) => {
      attempts.push(a);
      if (log) log.info('deepthink.attempt', { source, ...a });
    },
  });

  let timer = null;
  const TIMED_OUT = Symbol('deep-think-timeout');
  const settled = await Promise.race([
    think.catch((err) => ({ __error: err })),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  const ms = Date.now() - startedAt;

  if (settled === TIMED_OUT) {
    // brain.think has no abort seam, so the underlying call keeps running and its
    // result is discarded. Attach a no-op catch so a later rejection cannot
    // surface as an unhandled promise rejection.
    think.then(() => {}, () => {});
    if (log) {
      log.info('deepthink.call', {
        source, ms, ok: false, timedOut: true, timeoutMs, attemptTimeoutMs,
        attemptsTried: attempts.length,
        attempts: attempts.map((a) => `${a.provider}:${a.model} ${a.ms}ms${a.timedOut ? ' timeout' : ''}`),
      });
    }
    return {
      content: null, provider: null, model: null, offline: false, timedOut: true, ms,
      attemptsTried: attempts.length,
      reason: 'the reasoning model did not answer within ' + timeoutMs + 'ms',
    };
  }

  if (settled && settled.__error) {
    if (log) log.info('deepthink.call', { source, ms, ok: false, error: String((settled.__error && settled.__error.message) || settled.__error).slice(0, 200) });
    throw settled.__error;
  }

  const result = settled || {};
  const content = result.content || (result.parsed ? JSON.stringify(result.parsed) : null);
  if (log) {
    log.info('deepthink.call', {
      source,
      provider: result.provider || null,
      model: result.model || null,
      ms,
      ok: !result.offline && !!content,
      offline: !!result.offline,
      chars: content ? String(content).length : 0,
      attemptsTried: attempts.length,
    });
  }
  // BUG-458: the chain now walks past an empty reply, so "every reasoning model
  // answered with nothing" arrives here as offline + emptyReplies. It is not
  // offline, and think_deeply speaks `reason` verbatim (from-computer.js), so name
  // it. The `!!content` check above stays as a backstop for a brain that is not
  // chain.js (tests reach it); chain.js itself can no longer return empty text.
  const emptyReason = (result.offline && result.emptyReplies > 0)
    ? ('every reasoning model that answered returned no text (' + result.emptyReplies + ' empty repl'
      + (result.emptyReplies === 1 ? 'y' : 'ies') + ')')
    : null;
  return {
    content: content,
    provider: result.provider || null,
    model: result.model || null,
    offline: !!result.offline,
    timedOut: false,
    ms,
    ...(emptyReason ? { reason: emptyReason, emptyReplies: result.emptyReplies } : {}),
  };
}

module.exports = {
  deepThink,
  DEFAULT_DEEP_THINK_TIMEOUT_MS,
  DEFAULT_DEEP_THINK_ATTEMPT_TIMEOUT_MS,
  MAX_QUESTION_CHARS,
};
