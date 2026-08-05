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

function createLiveToolAdapter(deps) {
  const {
    leash, dispatchAction, bus, logger, connectionId,
    memory, historyAppend, reflection,
    summarizeActionsForResult,
    getLiveSession,                 // () => current liveSession (may be null/not-open)
    sanitizeErrorForClient,
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
  };

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

  async function handleLiveToolCalls(calls, { sendToolResponse }) {
    sweepPendingConfirms();
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
      const decision = { tool: call.name, args: call.args || {} };
      let verdict;
      try {
        verdict = leash.check(decision, { connectionId, goalId: null });
      } catch (err) {
        logger.warn('live.leash-threw', { tool: call.name, error: err.message });
        responses.push({ id: call.id, name: call.name, response: { status: 'error', error: 'gate failure' } });
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
          status: 'started',
          message: 'This action takes longer than this turn. Say what you are DOING, not what happened — ' +
            'do NOT claim completion. The real outcome will arrive as a [SYSTEM] message; report it then.',
        }});
        // Deliberately not awaited: the whole point is that the turn does not wait.
        dispatchAction(decision, { tier: verdict.tier, channel: 'voice-live', traceId: call.id })
          .then((outcome) => reportLateOutcome(call.name, outcome))
          .catch((err) => reportLateOutcome(call.name, { ok: false, result: sanitize(err) }));
        continue;
      }

      try {
        const outcome = await dispatchAction(decision, {
          tier: verdict.tier, channel: 'voice-live', traceId: call.id,
        });
        const ev = evaluateOutcome(outcome);
        let summary, response;
        if (!ev.dispatchOk) {
          summary = sanitizeResultError(ev.rawError).slice(0, 200);
          response = { status: 'failed', error: sanitizeResultError(ev.rawError).slice(0, 500) };
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
        commitAction({ tool: call.name, ok: false, summary: sanitize(err) });
        responses.push({ id: call.id, name: call.name, response: { status: 'error', error: sanitize(err) } });
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
    if (!ev.dispatchOk) {
      // Same unwrapping as the awaited path above: effectors put the message in
      // result.error, and handing the whole object to sanitizeResultError loses it.
      verdict = `${toolName} FAILED: ${sanitizeResultError(ev.rawError)}`;
    } else if (ev.unverified) {
      // Wave 0's contract, on the slow path too.
      verdict = unverifiedNarration(toolName, ev.reason);
    } else {
      verdict = `${toolName} finished. Result: ${JSON.stringify(truncateForModel(ev.result))}`;
    }
    liveTurnActions.push({ tool: toolName, ok: ev.ok, unverified: ev.unverified, summary: verdict });

    const liveSession = getLiveSession ? getLiveSession() : null;
    if (!liveSession || !liveSession.isOpen()) return; // best-effort, same as confirms
    liveSession.sendText(`[SYSTEM] ${verdict} Report this to the operator accurately.`);
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
    if (!accepted) {
      verdict = 'The operator DECLINED that action.';
    } else if (!ok) {
      verdict = `The operator APPROVED ${pending.name} but it FAILED: ${String((outcome && outcome.result) || 'unknown')}`;
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
    liveSession.sendText(`[SYSTEM] ${verdict} Report this to the operator accurately.`);
  }

  // AD-4 enforcement on turnComplete — reuses the exact history/episodic
  // shape handleUtterance already uses, so recall/audit stay consistent
  // whether a turn came through the batch or Live path.
  function onLiveTurnComplete({ userText, assistantText }) {
    // Atomic snapshot+clear (splice, not read-then-`.length=0`), and advance
    // the generation BEFORE anything else runs — any commitAction() call that
    // was mid-flight for this now-closing turn sees the new generation and
    // routes itself to health.anomaly instead of the array below.
    turnGeneration += 1;
    const actionsThisTurn = liveTurnActions.splice(0, liveTurnActions.length);

    if (userText) historyAppend('user', userText);
    if (assistantText) historyAppend('assistant', assistantText);
    // AD-4: the model's spoken claim is NOT the record. Outcomes are.
    const actionSummary = summarizeActionsForResult(actionsThisTurn);
    if (actionSummary) historyAppend('system', actionSummary);
    try {
      memory.episodic.write({
        kind: 'conversation', tick: memory.working.tick,
        summary: 'User: ' + userText.slice(0, 100) + ' | MYTHOS: ' + assistantText.slice(0, 100),
        detail: {
          role: 'user', text: userText.slice(0, 2000), reply: assistantText.slice(0, 1000),
          turnId: 'live-' + Date.now(), transport: 's2s',
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

module.exports = { createLiveToolAdapter };
