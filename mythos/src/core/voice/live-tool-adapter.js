'use strict';
// live-tool-adapter.js — Phase 3 (V2 §8), the safety seam. This is the ONLY
// place the Live transport touches safety, and it is an ADAPTER, not a
// reimplementation:
//
// AD-1 (single execution surface): identical gate -> dispatch path as
// voice-agent.js's executeAction() and server/index.js's handleConfirmReply() —
// leash.check() -> (allow | requireConfirm | deny) -> the injected
// dispatchAction(decision, ctx). This module NEVER reaches into the effector
// hub's raw invocation method directly; test/anti-drift-single-dispatch.test.js's
// literal scan enforces that repo-wide.
//
// AD-2 (leash owns the audit write): leash.check() already writes the audit
// line on every branch (allow/deny/confirm/dry-run). This module must never
// write a second one for the same decision.
//
// AD-4 (no fabricated success): Live has no needs_result loop — the model's
// spoken claim about whether a tool succeeded is reconciled against the REAL
// outcome on turnComplete (onLiveTurnComplete below), same discipline as
// handleUtterance's summarizeActionsForResult.
//
// Deferred-confirm design: Gemini expects a functionResponse promptly, and a T3
// confirm can sit for up to LEASH_CONFIRM_TTL_MS. So a T3/T4 call gets an
// IMMEDIATE reply of awaiting_human_confirmation (which makes the model SAY it
// needs approval — good behaviour, not a workaround) and dispatches NOTHING;
// the real outcome is injected later as a realtimeInput text turn once the
// human accepts via the existing confirm modal (resolveLiveConfirm below).

// BUG-113: same commitment-ledger primitive the batch path (server/index.js)
// uses — a no-op unless assistantText matches the explicit commitment-phrase
// list, so ordinary Live turns are unaffected.
const { createHash } = require('crypto');

const { logCommitmentIfPresent } = require('../effectors/from-calendar');

// B3 (2026-08-12 diagnosis, G4): reuse voice-agent.js's own NEGATIVE_RE rather
// than keep a second, driftable copy of the same regex in this module.
const { NEGATIVE_RE } = require('./voice-agent');

// BUG-117 — 2026-08-05: MYTHOS blamed the operator for messages the pipeline
// injected itself ("you said the click failed"). It is not the model being
// careless: the frozen Gemini Live wire protocol (V2 spine §3) has NO
// system-role channel after setup. Everything sent post-setup through
// liveSession.sendText() leaves as realtimeInput:{text}, which Gemini attributes
// to the USER role — there is no frame we are allowed to send that says
// otherwise. Reusing a functionResponse is not an option either: both injection
// sites fire AFTER the original toolResponse for that call has already gone.
//
// So the only honest fix is framing, and it has two halves that must agree:
//   1. this prefix, which is self-describing on its own, and
//   2. LIVE_SYSTEM_NOTICE_INSTRUCTION below, which the Live system instruction
//      carries so the model knows what the prefix means before it ever sees one.
// They live together in this module so the two can never drift apart. All three
// injection sites use them: reportLateOutcome(), resolveLiveConfirm(), and
// server/index.js's proactiveSpeak() Live route.
const SYSTEM_NOTICE_PREFIX =
  '[SYSTEM NOTICE — automated message from MYTHOS\'s own pipeline, NOT the operator speaking]';

const LIVE_SYSTEM_NOTICE_INSTRUCTION =
  `AUTOMATED SYSTEM NOTICES. Some messages that arrive in this conversation as if the operator ` +
  `spoke them begin with "${SYSTEM_NOTICE_PREFIX}". They are NOT the operator speaking. They are ` +
  `automated notices from MYTHOS's own pipeline — the real outcome of a tool you called, the ` +
  `operator's answer to an approval prompt, or a proactive alert. The transport has no separate ` +
  `system channel, which is the only reason they look like operator speech. Treat them as ground ` +
  `truth about what happened, act on them, but NEVER say or imply the operator told you any of it, ` +
  `and never blame the operator for their content.`;

function createLiveToolAdapter(deps) {
  const {
    leash, dispatchAction, bus, logger, connectionId,
    memory, historyAppend, reflection,
    summarizeActionsForResult,
    getLiveSession,                 // () => current liveSession (may be null/not-open)
    sanitizeErrorForClient,
    goals,                          // BUG-113: raw GoalSystem, optional — commitment ledger only
    toolAckDeadlineMs,              // BUG-128: test seam only — see TOOL_ACK_DEADLINE_MS
  } = deps;

  if (!leash || typeof leash.check !== 'function') throw new Error('createLiveToolAdapter requires leash');
  if (typeof dispatchAction !== 'function') throw new Error('createLiveToolAdapter requires dispatchAction(decision, ctx)');
  if (typeof summarizeActionsForResult !== 'function') throw new Error('createLiveToolAdapter requires summarizeActionsForResult(actions)');

  const sanitize = typeof sanitizeErrorForClient === 'function'
    ? sanitizeErrorForClient
    : (err) => String((err && err.message) || err || 'Unknown error');
  // Security-review fix: apply the same sanitization to a raw effector error
  // string as to a thrown Error — an effector's fail() shape can embed raw OS
  // error text/paths (e.g. run_command's stderr), and that must not reach the
  // model/episodic memory unsanitized just because it came back as {ok:false}
  // instead of a throw.
  // effectorReason marks this as an effector's OWN honest fail() text rather than a
  // thrown exception. Without the tag, sanitizeErrorForClient cannot tell the two apart
  // and flattened both to "An internal error occurred." — which is how app_reply's
  // perfectly good "whatsapp is not open, so there is no conversation to reply to"
  // reached the model as a generic error on 2026-08-02. The tag is set HERE, at the one
  // call site that actually knows the origin, so the sanitizer stays deny-by-default for
  // everything else instead of inferring intent from a missing .stack.
  function sanitizeResultError(raw) {
    return sanitize({ message: String(raw == null ? 'Failed.' : raw), effectorReason: true });
  }

  // Security-review fix: an orphaned confirm (human never responds; the WS
  // connection drops before a reply) must not leak in this Map forever.
  // leash's own confirm registry already sweeps on every create() using
  // config.LEASH_CONFIRM_TTL_MS; this mirrors that pattern for the adapter's
  // parallel {name, callId} bookkeeping, using a generous fixed upper bound
  // (well past any real LEASH_CONFIRM_TTL_MS) since by the time an entry is
  // this stale it can never be legitimately resolved anyway.
  const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;
  const MAX_SUMMARY_CHARS = 300;

  // WAVE 3 — tools whose wall-clock exceeds a Live turn, so awaiting them inside
  // the turn guarantees the model narrates before the answer exists. Membership is
  // about DURATION, not risk: spotify_play drives cua-driver (5-10s per click
  // sequence), hermes_task runs an agent (minutes), and the cua_* tools each do a
  // full UIA hit-test round trip. Everything else is fast enough to await.
  const SLOW_TOOLS = {
    spotify_play: true,
    hermes_task: true,
    cua_click: true,
    cua_get_window_state: true,
    // BUG-120 — 2026-08-05: browser_switch was awaited inside the turn, and it
    // is anything but fast: it disconnects the attached browser, closes it,
    // relaunches another with a debug port and re-attaches. The turn ended long
    // before that finished, so Gemini re-issued the same call — twice the
    // relaunch, from one operator request. Membership here is about DURATION,
    // per this list's own rule, and by that rule it always belonged.
    browser_switch: true,
    // 2026-08-10 — the vision pair. By this list's own rule membership is about
    // DURATION, and two real screen_look calls that session took 16s and 63s
    // (audit: 09:53:47 -> 09:54:03, 09:51:40 -> 09:52:43) against a 1500ms ack
    // deadline. The operator asked "can you see? you didn't answer", and the model
    // — holding no answer and no instruction — invented one. Acking instantly with
    // "say what you are DOING, do not claim completion" is the difference between
    // "I'm looking now" and "you're holding a black smartphone".
    //
    // screen_read_text is deliberately NOT here: it returned in ~1s both times
    // that session, and awaiting a fast read is strictly better than a two-step.
    screen_look: true,
    camera_look: true,
  };

  // BUG-128 — 2026-08-06: SLOW_TOOLS is a hand-maintained list, and the list is
  // always one incident behind. Three open_web calls ran twice ~28s apart with
  // DIFFERENT call ids, each preceded by a live-tool-outcome-late-for-turn: the
  // turn ended before the toolResponse went back, the model saw no answer for
  // the ids it asked about, and re-issued the whole batch. BUG-120's dedup is
  // keyed on call.id by design, so fresh ids sail straight past it.
  //
  // The general fix is to stop letting ANY call outlive its turn unanswered:
  // whatever has not resolved by this deadline gets the same status:'started'
  // reply SLOW_TOOLS gets, and its real outcome arrives later on the same
  // [SYSTEM] channel. SLOW_TOOLS stays because it acks instantly — the model is
  // told "say what you are doing" without the operator hearing 1.5s of silence
  // first. This is the net underneath it, not a replacement for it.
  const TOOL_ACK_DEADLINE_MS = Number.isFinite(toolAckDeadlineMs) ? toolAckDeadlineMs : 1500;
  const DEADLINE_EXCEEDED = Symbol('tool-ack-deadline-exceeded');

  // Settle to {outcome} | {error} | DEADLINE_EXCEEDED. The timer is cleared on
  // the fast path so a resolved dispatch never holds the event loop open for
  // the rest of the deadline, and unref'd so it cannot on its own either.
  function raceDeadline(promise, ms) {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([
      promise.then((outcome) => ({ outcome }), (error) => ({ error })),
      deadline,
    ]).then((settled) => { clearTimeout(timer); return settled; });
  }

  function logBatch(calls) {
    try {
      const list = Array.isArray(calls) ? calls : [];
      const shape = list.map((c) => `${c.name}:${JSON.stringify(c.args || {})}`).join('|');
      logger.info('live.tool-call-batch', {
        count: list.length,
        tools: list.map((c) => c.name),
        callIds: list.map((c) => c.id),
        // Truncated sha1: enough to match two batches, short enough to read.
        batchHash: createHash('sha1').update(shape).digest('hex').slice(0, 12),
      });
    } catch { /* instrumentation must never break a turn */ }
  }

  const STARTED_MESSAGE =
    'This action takes longer than this turn. Say what you are DOING, not what happened — ' +
    'do NOT claim completion. The real outcome will arrive as a [SYSTEM] message; report it then.';

  // BUG-120 — the other half. Making browser_switch slow removes the specific
  // trigger seen on 2026-08-05, but nothing in this seam ever stopped the model
  // re-issuing ANY call before its toolResponse arrived, and a re-dispatched
  // world-changing action is not a cosmetic problem. Dedup is on call.id only:
  // Gemini reuses the id when it retries the same call, whereas two genuine
  // clicks on the same button (a legitimate "click it again") carry different
  // ids, so an args-hash would eat real work. TTL-bounded so the map cannot
  // grow for the life of a session.
  const DUPLICATE_CALL_TTL_MS = 30 * 1000;
  const recentCallIds = new Map(); // call.id -> firstSeenAt

  function isDuplicateCall(callId) {
    if (!callId) return false; // no id, nothing to key on — never suppress blindly
    const now = Date.now();
    for (const [id, seenAt] of recentCallIds) {
      if (now - seenAt > DUPLICATE_CALL_TTL_MS) recentCallIds.delete(id);
    }
    if (recentCallIds.has(callId)) return true;
    recentCallIds.set(callId, now);
    return false;
  }

  const livePendingConfirms = new Map(); // confirmId -> {name, callId, createdAt}
  const liveTurnActions = [];            // AD-4: reconciled on turnComplete
  // Security-review fix: onToolCall (live-session.js) is fire-and-forget, so a
  // slow dispatchAction could in principle resolve after turnComplete has
  // already read+cleared liveTurnActions for this turn. Tagging each push
  // with the turn generation active when the call STARTED, and only
  // committing it if that generation is still current, stops a late outcome
  // from bleeding into a LATER turn's audit/episodic narrative — the model
  // still gets its functionResponse either way (that send is unconditional).
  let turnGeneration = 0;

  // BUG-120 follow-up — 2026-08-12: isDuplicateCall above only suppresses a
  // repeat of the SAME call.id, and only while that id is still tracked. It
  // has nothing to say about two calls that carry DIFFERENT ids but identical
  // {name, args} — which is exactly what a live session produced: four
  // open_web calls in three seconds (01:43:49-52, tripping the circuit
  // breaker) and thirteen set_persona_level calls in one second (02:18:47).
  // Every one of those completed in milliseconds, so there was never a
  // "still running" window for the id-based guard to catch — by the time the
  // repeat arrived under its fresh id, the earlier call had already resolved.
  //
  // This is a second, ADDITIVE gate — the call.id guard above stays exactly
  // as it is. It is keyed on name+JSON.stringify(args) and scoped to the
  // CURRENT turn only: the set is cleared explicitly in onLiveTurnComplete,
  // right next to the liveTurnActions splice that already owns "what happens
  // at turn end", so a legitimate "do it again" request on a later turn is
  // never blocked, matching isDuplicateCall's own id-reuse rule. Idempotent
  // reads are exempt — repeating list_windows or read_status is harmless, so
  // gating them would only add suppression risk for zero safety benefit;
  // open_web and a persona write are not idempotent, and neither is anything
  // else not on this list, so the default is to gate.
  //
  // The caller passes the SAME per-batch generation snapshot commitAction()
  // uses (myGeneration, not the live turnGeneration) — a call belonging to a
  // batch whose turn has already closed gets the same treatment a late
  // outcome gets from commitAction: it neither consults nor mutates the
  // CURRENT turn's set, so a turn boundary landing mid-batch can never wipe
  // out signatures another call in that same (now-stale) batch already
  // recorded.
  const IDEMPOTENT_READ_TOOLS = {
    list_windows: true,
    read_status: true,
  };
  const executedSignatures = new Set();

  function isDuplicateSignature(generation, name, args) {
    if (IDEMPOTENT_READ_TOOLS[name]) return false;
    if (generation !== turnGeneration) return false;
    let signature;
    try {
      signature = `${name}:${JSON.stringify(args || {})}`;
    } catch (err) {
      // A non-serialisable arg must degrade this ONE call, not the whole
      // batch — same defensive-by-default convention truncateForModel below
      // already follows. Wrongly suppressing a call is worse than wrongly
      // allowing one, so this fails open: not a duplicate.
      logger.warn('live.duplicate-signature-unserializable', { tool: name, error: err.message });
      return false;
    }
    if (executedSignatures.has(signature)) return true;
    executedSignatures.add(signature);
    return false;
  }

  function sweepPendingConfirms() {
    if (livePendingConfirms.size === 0) return;
    const now = Date.now();
    for (const [id, entry] of livePendingConfirms) {
      if (now - entry.createdAt > PENDING_CONFIRM_TTL_MS) livePendingConfirms.delete(id);
    }
  }

  function humanizeLiveArgs(args) {
    const s = Object.entries(args || {})
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
    return s.length > MAX_SUMMARY_CHARS ? s.slice(0, MAX_SUMMARY_CHARS) + '…[truncated]' : s;
  }
  function truncateForModel(result) {
    try {
      const s = typeof result === 'string' ? result : JSON.stringify(result);
      return s && s.length > 4000 ? s.slice(0, 4000) + '…[truncated]' : (result ?? null);
    } catch { return String(result).slice(0, 4000); }
  }

  // Stage 3 (BUG-068): shared "did this outcome actually succeed" verdict —
  // previously only the slow/late path (reportLateOutcome) treated
  // outcome.unverified as anything other than plain success. The awaited
  // (fast) branch below built `ok` from outcome.ok alone, so a real record
  // ("the focused control exposes neither ValuePattern nor TextPattern",
  // ui_type @14:33:38) that happened to resolve inside the turn was reported
  // to the model as status:'ok'. One extraction, used by both branches.
  function evaluateOutcome(outcome) {
    const dispatchOk = Boolean(outcome && outcome.ok);
    const isUnverified = dispatchOk && Boolean(outcome.unverified);
    const result = outcome && outcome.result;
    // BUG-101: `outcome.error` is read here too. effectors/adapter.js now
    // mirrors an effector's `error` into `result` at the registration boundary,
    // but an outcome that reaches this adapter by any other route (a raw
    // effector, a future dispatch path) must not degrade to the bare 'Failed.'
    // the operator heard on 2026-08-05.
    const rawError = (result && result.error) || result
      || (outcome && outcome.error) || (outcome && outcome.reason) || 'Failed.';
    return {
      ok: dispatchOk && !isUnverified,
      dispatchOk,
      unverified: isUnverified,
      result,
      rawError,
      reason: isUnverified ? String(outcome.reason || 'no confirmation available') : null,
    };
  }

  function unverifiedNarration(toolName, reason) {
    return `${toolName} ran but could NOT be confirmed: ${reason || 'no confirmation available'}. Do not tell the operator it worked.`;
  }

  // BUG-116 — 2026-08-05 17:13:04: "The click went through, and the screen did
  // change afterwards", 49 seconds after see_and_click came back ok:false. Same
  // shape at 17:10 twice ("I've played Starboy" over error 153, "YouTube is now
  // present" over a Chrome window).
  //
  // On Live there is no turn boundary of ours to correct at — Gemini speaks its
  // own audio as results arrive, so the text inside the functionResponse is the
  // ONLY thing that teaches it what happened, both for the sentence it is
  // speaking now and for the rest of the retained session. status:'started' and
  // status:'unverified' both carried an explicit prohibition; the failure
  // branches — the ones with the strongest reason to — carried a bare error
  // string and nothing else. The status field is for us; the model reasons over
  // the prose. Hence one shared sentence, used on every "this did not happen"
  // reply, awaited or late.
  const NO_SUCCESS_CLAIM = 'This action did NOT succeed. Tell the operator plainly that it failed and what ' +
    'failed. Do NOT claim it worked, do NOT claim the screen or anything else changed as a result, and do ' +
    'NOT describe it as done later in this conversation either.';

  function failedNarration(toolName, detail) {
    return `${toolName} FAILED: ${detail} ${NO_SUCCESS_CLAIM}`;
  }

  async function handleLiveToolCalls(calls, { sendToolResponse }) {
    sweepPendingConfirms();
    // BUG-128 instrumentation: a re-issued batch carries fresh call ids, so the
    // only way to recognise one in a log is by its CONTENT. Logging the shape
    // hash next to the ids makes "same batch, different ids, 28 seconds apart"
    // readable straight from the log instead of reconstructable from the audit.
    logBatch(calls);
    const myGeneration = turnGeneration;
    function commitAction(entry) {
      // Late arrival after this turn already completed — do not misattribute
      // it to whatever turn is running now (AD-4: accurate reconciliation).
      if (myGeneration !== turnGeneration) {
        if (bus && typeof bus.emit === 'function') {
          // BUG-105: `target` as well as `tool`. Every immune consumer keys on
          // `target` (diagnostician, healer, explainer's prompt, the server's
          // episodic summary line), so a tool named only under `tool` reached
          // the explainer as "Target: (none)" and the model invented a
          // component — it told the operator the "music playback tool" was
          // late when the late tool was list_windows.
          bus.emit('health.anomaly', {
            kind: 'live-tool-outcome-late-for-turn', tool: entry.tool, target: entry.tool,
          });
        }
        return;
      }
      liveTurnActions.push(entry);
    }
    const responses = [];
    for (const call of calls) {
      // BUG-120: answer the repeat, run nothing. The model still gets a
      // functionResponse for the id it asked about (silence would leave the
      // turn hanging), and the reply names the original so it waits for that
      // outcome rather than treating this as a fresh failure.
      if (isDuplicateCall(call.id)) {
        logger.info('live.duplicate-tool-call', { tool: call.name, callId: call.id });
        responses.push({ id: call.id, name: call.name, response: {
          status: 'duplicate-suppressed',
          message: 'You already issued this exact call and it is still running. It was NOT run a second ' +
            'time. Wait for the original outcome and report that — do not claim anything happened yet.',
        }});
        continue;
      }

      // BUG-120 follow-up: same {name, args} already dispatched earlier THIS
      // turn under a different call id, whether or not it has already
      // resolved. Distinct log event name from the id-based guard above so
      // the two triggers stay tellable apart in the log/anomaly stream; same
      // status string, since both mean the same thing to the model: nothing
      // ran a second time.
      if (isDuplicateSignature(myGeneration, call.name, call.args || {})) {
        logger.info('live.duplicate-tool-call-signature', { tool: call.name, args: call.args || {} });
        responses.push({ id: call.id, name: call.name, response: {
          status: 'duplicate-suppressed',
          message: 'You already issued this exact call earlier in this turn. It was NOT run a second ' +
            'time. If that call already finished, use its outcome; otherwise wait for it — do not claim ' +
            'anything new happened.',
        }});
        continue;
      }
      const decision = { tool: call.name, args: call.args || {} };
      let verdict;
      try {
        verdict = leash.check(decision, { connectionId, goalId: null });
      } catch (err) {
        logger.warn('live.leash-threw', { tool: call.name, error: err.message });
        responses.push({ id: call.id, name: call.name, response: {
          status: 'error', error: 'gate failure',
          message: failedNarration(call.name, 'gate failure — it never ran.'),
        } });
        continue;
      }

      if (verdict.requireConfirm) {
        const summary = `Voice: ${decision.tool}` +
          (Object.keys(decision.args).length ? ` (${humanizeLiveArgs(decision.args)})` : '');
        // Security-review fix: fall back to 'system' exactly like
        // voice-agent.js's executeAction() does — leash/confirm.js treats a
        // falsy connectionId as UNSCOPED (any connection may later accept it),
        // so a missing connectionId here would otherwise open a cross-
        // connection confirm-hijack window.
        const confirmId = leash.confirm.create(
          summary, { decision, goalId: null, tier: verdict.tier }, connectionId || 'system');
        livePendingConfirms.set(confirmId, { name: call.name, callId: call.id, createdAt: Date.now() });
        if (bus && typeof bus.emit === 'function') {
          bus.emit('confirm-request', { ...decision, confirmId, summary, tier: verdict.tier });
        }
        commitAction({ tool: call.name, ok: false, confirmPending: true, summary });
        responses.push({ id: call.id, name: call.name, response: {
          status: 'awaiting_human_confirmation',
          message: `Tier ${verdict.tier} action. Tell the operator you need approval, then wait.`,
        }});
        continue;
      }

      if (!verdict.allow) {
        commitAction({ tool: call.name, ok: false, summary: `Denied: ${verdict.reason}` });
        responses.push({ id: call.id, name: call.name, response: { status: 'denied', reason: verdict.reason } });
        continue;
      }

      // WAVE 3 — tools that take longer than a Live turn get an explicit
      // started/done split instead of being awaited inside the turn.
      //
      // The Live turn completes while a cua-driven Spotify click (5-10s) or a
      // hermes task (minutes) is still running, so the model reached turnComplete
      // with no outcome and narrated a guess. That is what the 9+
      // live-tool-outcome-late-for-turn anomalies on 2026-07-31 were: not a bug in
      // the anomaly detector, but the model being asked to speak before the answer
      // existed. Awaiting harder cannot fix it — the turn boundary is the model's,
      // not ours. So say "started", and deliver the real outcome afterwards through
      // the same [SYSTEM] sendText channel resolveLiveConfirm already uses.
      if (SLOW_TOOLS[call.name]) {
        commitAction({ tool: call.name, ok: false, started: true, summary: `${call.name} started — outcome pending.` });
        responses.push({ id: call.id, name: call.name, response: {
          status: 'started', message: STARTED_MESSAGE,
        }});
        // Deliberately not awaited: the whole point is that the turn does not wait.
        dispatchAction(decision, { tier: verdict.tier, channel: 'voice-live', traceId: call.id })
          .then((outcome) => reportLateOutcome(call.name, outcome))
          .catch((err) => reportLateOutcome(call.name, { ok: false, result: sanitize(err) }));
        continue;
      }

      try {
        // BUG-128: await, but not without a bound. Anything still running at
        // TOOL_ACK_DEADLINE_MS is answered now and reconciled later, exactly
        // like a SLOW_TOOLS call — the model never reaches turnComplete with an
        // unanswered call id, which is the only reason it re-issues a batch.
        const pending = dispatchAction(decision, {
          tier: verdict.tier, channel: 'voice-live', traceId: call.id,
        });
        const settled = await raceDeadline(pending, TOOL_ACK_DEADLINE_MS);
        if (settled === DEADLINE_EXCEEDED) {
          logger.info('live.tool-ack-deadline', { tool: call.name, callId: call.id, deadlineMs: TOOL_ACK_DEADLINE_MS });
          commitAction({ tool: call.name, ok: false, started: true, summary: `${call.name} started — outcome pending.` });
          responses.push({ id: call.id, name: call.name, response: {
            status: 'started', message: STARTED_MESSAGE,
          }});
          pending
            .then((outcome) => reportLateOutcome(call.name, outcome))
            .catch((err) => reportLateOutcome(call.name, { ok: false, result: sanitize(err) }));
          continue;
        }
        if (settled.error) throw settled.error;
        const outcome = settled.outcome;
        const ev = evaluateOutcome(outcome);
        let summary, response;
        if (!ev.dispatchOk) {
          const reason = sanitizeResultError(ev.rawError);
          summary = reason.slice(0, 200);
          // BUG-116: `error` alone left the model free to narrate the click it
          // just failed to make. `message` is the instruction, same as the
          // unverified/started branches; `summary` stays the bare reason so the
          // audit/episodic record is not polluted with prompt text.
          response = {
            status: 'failed',
            error: reason.slice(0, 500),
            message: failedNarration(call.name, reason.slice(0, 500)),
          };
        } else if (ev.unverified) {
          // Wave 0's evidence contract, on the awaited path too: ok:true +
          // unverified:true must never reach the model as status:'ok'.
          summary = unverifiedNarration(call.name, ev.reason).slice(0, 200);
          response = {
            status: 'unverified',
            message: unverifiedNarration(call.name, ev.reason) + ' Report only that it was attempted.',
            result: truncateForModel(ev.result),
          };
        } else {
          summary = `${call.name} done.`;
          response = { status: 'ok', result: truncateForModel(ev.result) };
        }
        commitAction({ tool: call.name, ok: ev.ok, unverified: ev.unverified, summary });
        responses.push({ id: call.id, name: call.name, response });
      } catch (err) {
        const reason = sanitize(err);
        commitAction({ tool: call.name, ok: false, summary: reason });
        responses.push({ id: call.id, name: call.name, response: {
          status: 'error', error: reason, message: failedNarration(call.name, reason),
        } });
      }
    }
    if (responses.length) sendToolResponse(responses);
  }

  // WAVE 3 — deliver a slow tool's real outcome after its turn has ended.
  // Pushes straight to liveTurnActions rather than through commitAction: this
  // arrival is EXPECTED, so it must not raise the late-for-turn anomaly that
  // exists to catch accidental misattribution.
  function reportLateOutcome(toolName, outcome) {
    const ev = evaluateOutcome(outcome);
    let verdict;
    // BUG-116: the closing instruction is what the model is allowed to SAY about
    // this outcome, so a failure gets the explicit prohibition instead of the
    // neutral default. It is deliberately NOT folded into `verdict` — verdict is
    // also the liveTurnActions summary, i.e. the audit/episodic record, which
    // must stay a plain statement of what happened.
    let instruction = 'Report this to the operator accurately.';
    if (!ev.dispatchOk) {
      // Same unwrapping as the awaited path above: effectors put the message in
      // result.error, and handing the whole object to sanitizeResultError loses it.
      verdict = `${toolName} FAILED: ${sanitizeResultError(ev.rawError)}`;
      instruction = NO_SUCCESS_CLAIM;
    } else if (ev.unverified) {
      // Wave 0's contract, on the slow path too.
      verdict = unverifiedNarration(toolName, ev.reason);
    } else {
      verdict = `${toolName} finished. Result: ${JSON.stringify(truncateForModel(ev.result))}`;
    }
    liveTurnActions.push({ tool: toolName, ok: ev.ok, unverified: ev.unverified, summary: verdict });

    const liveSession = getLiveSession ? getLiveSession() : null;
    if (!liveSession || !liveSession.isOpen()) return; // best-effort, same as confirms
    liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${verdict} ${instruction}`);
  }

  // Hook the EXISTING confirm-accept path so an approval/rejection feeds the
  // Live session. Called from server/index.js's handleConfirmReply(), after
  // its own dispatchAction() resolves (accept) or on the reject branch.
  async function resolveLiveConfirm(confirmId, outcome, accepted) {
    const pending = livePendingConfirms.get(confirmId);
    if (!pending) return;
    // Security-review fix: delete unconditionally once resolved — this
    // confirm is decided either way (accepted or rejected) regardless of
    // whether the live session is still around to hear about it, so keeping
    // the entry only when a session happens to be open was a memory leak on
    // every accept/reject that raced a closed/gone session.
    livePendingConfirms.delete(confirmId);

    // Wave 0's evidence contract, on the confirm path. This string is the ONLY
    // thing the model learns about an approved action's outcome, and on
    // 2026-07-31 20:03 it said "It succeeded" over a ui_type that had come back
    // ok:true + unverified:true — which the model then read out as "the typing
    // has finally been sent through successfully" into an empty Notepad.
    // A confirmation gates INTENT; only evidence gates OUTCOME.
    const ok = Boolean(accepted && outcome && outcome.ok);
    const unverified = ok && Boolean(outcome.unverified);
    let verdict;
    // BUG-116, same split as reportLateOutcome: the record keeps the plain
    // statement, the model gets the explicit prohibition on a failure.
    let instruction = 'Report this to the operator accurately.';
    if (!accepted) {
      verdict = 'The operator DECLINED that action.';
    } else if (!ok) {
      verdict = `The operator APPROVED ${pending.name} but it FAILED: ${String((outcome && outcome.result) || 'unknown')}`;
      instruction = NO_SUCCESS_CLAIM;
    } else if (unverified) {
      verdict = `The operator APPROVED ${pending.name} and it ran, but the outcome is UNVERIFIED: ` +
        String(outcome.reason || 'no confirmation available') +
        '. Do NOT claim it completed — tell the operator exactly what could not be confirmed.';
    } else {
      verdict = `The operator APPROVED ${pending.name}. It succeeded. Result: ${JSON.stringify(truncateForModel(outcome.result))}`;
    }

    // Record BEFORE the session check: this entry feeds AD-4 reconciliation and
    // the audit, not just the model, so a socket that closed while the human was
    // deciding must not erase what happened. reportLateOutcome already ordered
    // it this way.
    liveTurnActions.push({ tool: pending.name, ok: ok && !unverified, unverified, summary: verdict });

    const liveSession = getLiveSession ? getLiveSession() : null;
    if (!liveSession || !liveSession.isOpen()) return; // nothing left to tell — best-effort
    liveSession.sendText(`${SYSTEM_NOTICE_PREFIX} ${verdict} ${instruction}`);
  }

  // B3 — 2026-08-12 diagnosis (G4): a show_desktop confirm was created and
  // completed via a UI accept-click 13 seconds later, in the same session the
  // operator said "No" out loud. It was not a race MYTHOS lost — nothing was
  // listening for the "No" at all. resolveSpokenConfirm (voice-agent.js) only
  // ever consults armedSpokenConfirms, and only SEND_TOOLS (whatsapp_send,
  // gmail_send) ever arm one via isOperatorInitiatedSend(); show_desktop,
  // launch_app, media_key, and every other T2+ tool land here instead, in
  // livePendingConfirms, with no equivalent path to a spoken cancel.
  //
  // Rejects ALL pending confirms, not just the most recent. Live can have more
  // than one outstanding at once (each gets its own confirm-request broadcast
  // to every open surface, per bus.subscribe('confirm-request') in
  // server/index.js), and the plan's own bias applies here too: a false-
  // positive cancel is recoverable (the operator just re-asks), whereas
  // leaving a confirm alive that the operator believes they already declined
  // is not. NEGATIVE_RE is intentionally left unanchored (it also matches
  // "wait", "hold on", or a "no" buried mid-sentence like "no, the other
  // file") — same reasoning: over-cancelling is the safe direction to err in,
  // so this does not narrow the existing matcher to reduce false positives.
  //
  // AFFIRMATIVE_RE is deliberately NOT consulted here and never will be: the
  // plan is explicit that widening voice-accept to cover confirms it was never
  // armed for is how an execution gets approved by accident. This path can
  // only ever narrow the world (cancel), never widen it (run).
  function rejectPendingConfirmsOnNegative(text) {
    if (livePendingConfirms.size === 0) return;
    if (!NEGATIVE_RE.test(String(text || ''))) return;

    const cancelledNames = [];
    for (const [id, entry] of livePendingConfirms) {
      // Security-review fix parity (line ~429): mirror the connectionId
      // fallback used at confirm.create() time, or a reject issued with an
      // undefined connectionId would mismatch the 'system'-scoped entry and
      // silently do nothing.
      leash.confirm.reject(id, connectionId || 'system');
      liveTurnActions.push({
        tool: entry.name, ok: false,
        summary: `${entry.name} cancelled — the operator said no.`,
      });
      cancelledNames.push(entry.name);
    }
    livePendingConfirms.clear();

    const liveSession = getLiveSession ? getLiveSession() : null;
    if (!liveSession || !liveSession.isOpen()) return; // best-effort, same as resolveLiveConfirm
    const names = cancelledNames.join(', ');
    liveSession.sendText(
      `${SYSTEM_NOTICE_PREFIX} The operator said no. Cancelled: ${names}. ` +
      `Do NOT run ${cancelledNames.length === 1 ? 'that action' : 'those actions'} — ` +
      'tell the operator plainly what was cancelled.',
    );
  }

  // AD-4 enforcement on turnComplete — reuses the exact history/episodic
  // shape handleUtterance already uses, so recall/audit stay consistent
  // whether a turn came through the batch or Live path.
  function onLiveTurnComplete({ userText, assistantText, turnId }) {
    // B3 — before any of this turn's ORDINARY handling (history append,
    // episodic write, reflection), a spoken "no" cancels whatever is pending.
    // Doing this first means the cancellation itself lands in liveTurnActions
    // before the splice a few lines down captures this turn's actions.
    rejectPendingConfirmsOnNegative(userText);

    // Atomic snapshot+clear (splice, not read-then-`.length=0`), and advance
    // the generation BEFORE anything else runs — any commitAction() call that
    // was mid-flight for this now-closing turn sees the new generation and
    // routes itself to health.anomaly instead of the array below.
    turnGeneration += 1;
    const actionsThisTurn = liveTurnActions.splice(0, liveTurnActions.length);
    // BUG-120 follow-up: the per-turn signature set owns exactly the same
    // lifetime as liveTurnActions above, so it is cleared right here instead
    // of lazily on next use — a set that only resets when something happens
    // to read it is a set that might never reset at all.
    executedSignatures.clear();

    if (userText) historyAppend('user', userText);
    if (assistantText) historyAppend('assistant', assistantText);
    // BUG-113: capture a spoken commitment as an inert, queryable ledger entry.
    // Best-effort — a ledger miss must never break the turn.
    if (assistantText) {
      try { logCommitmentIfPresent(assistantText, { goals: goals }); } catch (_) {}
    }
    // AD-4: the model's spoken claim is NOT the record. Outcomes are.
    const actionSummary = summarizeActionsForResult(actionsThisTurn);
    if (actionSummary) historyAppend('system', actionSummary);
    try {
      memory.episodic.write({
        kind: 'conversation', tick: memory.working.tick,
        summary: 'User: ' + userText.slice(0, 100) + ' | MYTHOS: ' + assistantText.slice(0, 100),
        detail: {
          role: 'user', text: userText.slice(0, 2000), reply: assistantText.slice(0, 1000),
          // BUG-124: prefer the session's real monotonic turn number when the
          // transport supplies one. A timestamp identifies WHEN, which is what
          // made a misalignment report impossible to chase — two records a few
          // hundred ms apart cannot be ordered against an anomaly by eye. The
          // timestamp stays as the fallback for any caller that has no turnId.
          turnId: (turnId === undefined || turnId === null) ? 'live-' + Date.now() : 'live-turn-' + turnId,
          transport: 's2s',
          actions: actionsThisTurn.map((a) => ({ tool: a.tool, ok: a.ok, summary: a.summary })),
        },
        salience: 0.6, channel: 'voice',
      });
    } catch (_) { /* best-effort, same as handleUtterance */ }
    if (reflection && typeof reflection.noteTurn === 'function') {
      try { reflection.noteTurn(); } catch (_) {}
    }
  }

  return {
    handleLiveToolCalls,
    resolveLiveConfirm,
    onLiveTurnComplete,
    // test-only introspection — never used by production wiring
    _internal: { livePendingConfirms, liveTurnActions },
  };
}

module.exports = { createLiveToolAdapter, SYSTEM_NOTICE_PREFIX, LIVE_SYSTEM_NOTICE_INSTRUCTION };
