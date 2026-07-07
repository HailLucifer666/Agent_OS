// s2s-completions.js — POST /voice/v1/chat/completions: an OpenAI-chat-completions-shaped
// endpoint so the huggingface/speech-to-speech pipeline (Phase 2, browser-free voice) can be
// pointed at this dashboard as its "LLM backend" via --responses_api_base_url. This is a thin
// transport adapter: it extracts the user's utterance from an OpenAI-shaped request body and
// hands it to voice-agent.js's existing, transport-agnostic handleUtterance({text, ctx}) —
// exactly the same brain Phase 1's WS voice-utterance handler calls. No changes to voice-agent.js,
// tools-dashboard.js, tools-computer.js, or the WS protocol were needed or made.
//
// Extracted into its own module (mirrors voice/routes.js's extraction pattern) so server.js
// doesn't grow an inline handler for this — createS2sCompletionsRouter(deps) is mounted once
// in server.js at the literal path /voice/v1/chat/completions.

const crypto = require('crypto');

// buildCompletion(say, model) -> OpenAI chat.completion response object. Kept as a standalone,
// separately-callable/exported function (not inlined in the route handler) so a future SSE
// branch (see app/services/README.md's validation checklist) is a small diff around this seam,
// not a rewrite of the route.
function buildCompletion(say, model) {
  return {
    id: 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'voice-agent',
    choices: [{ index: 0, message: { role: 'assistant', content: say }, finish_reason: 'stop' }],
  };
}

// Extracts the LAST message with role:'user' from an OpenAI-shaped messages array — NOT
// simply the last array element, since a well-formed client can append a trailing
// assistant/system message after the user's turn. Returns the trimmed content string, or
// null if no usable user message is present (missing/non-array messages, no role:'user'
// entry, or that message's content is empty/whitespace-only after trim).
function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content.trim() : '';
      return content ? content : null;
    }
  }
  return null;
}

// Matches the exact accept-phrase contract the Phase 1 browser client uses (voice-control.js)
// so "say yes to confirm" behaves identically regardless of which transport is talking to
// voice-agent.js.
const ACCEPT_RE = /^(yes|yeah|do it|confirm|go ahead)\b/i;

// createS2sCompletionsRouter({ voiceAgent, isLoopback, confirm }) -> Express handler for
// POST /voice/v1/chat/completions. Deps are injected (not required at module scope) so tests
// can stub voiceAgent.handleUtterance/confirm and isLoopback without touching the real modules.
//
// Security note (fixed post-review): the S2S pipeline is a single long-running local process,
// not a per-request caller, so it needs one STABLE connectionId for the lifetime of this router
// instance — never `null`. confirm.js's connection-scoping check (`entry.connectionId !== null
// && entry.connectionId !== connectionId`) treats a `null` entry as "unscoped" by design (that
// escape hatch exists only for test code with no connection concept). Passing `ctx.connectionId:
// null` here would have silently opted this entire live, network-reachable path out of the
// Phase 1 connection-binding fix — any other WS connection could then accept/execute a
// danger-tier action (delete_goal, kill_session, etc.) that the S2S pipeline queued.
//
// Functional note: this endpoint is otherwise fully stateless per Phase-1 design (each request
// is an independent handleUtterance call), but a danger-tier confirm can only ever be resolved
// by a SUBSEQUENT request recognizing it's an answer to a pending confirm — there is no separate
// "voice-confirm-reply" message type on this transport the way there is on the WS protocol. So
// this module tracks, in memory, at most one pending confirmId for this connectionId at a time.
function createS2sCompletionsRouter({ voiceAgent, isLoopback, confirm }) {
  const connectionId = 's2s-' + crypto.randomUUID();
  let pendingConfirmId = null;

  return async function postChatCompletions(req, res) {
    if (!isLoopback(req)) {
      return res.status(403).json({ error: 'chat/completions is loopback-only.' });
    }

    const body = req.body || {};
    const userText = extractLastUserText(body.messages);
    if (!userText) {
      return res.status(400).json({ error: 'messages must include a non-empty role:"user" message.' });
    }

    // stream:true is deliberately ignored for this pass — we always return the same
    // non-streamed JSON rather than erroring or implementing SSE. Whether the s2s client
    // actually requires streaming from this endpoint is unverified in this environment;
    // see app/services/README.md's validation checklist.

    try {
      // A confirm is pending and this utterance looks like an accept — resolve it directly
      // instead of running a fresh LLM turn. Anything else (including a brand-new, unrelated
      // command) is a silent pivot, per the Phase 1 UX decision: we don't force a spoken
      // "cancelled" here, we just let the stale confirm expire on its own TTL and proceed
      // with a normal utterance below.
      if (pendingConfirmId && ACCEPT_RE.test(userText)) {
        const confirmId = pendingConfirmId;
        pendingConfirmId = null;
        const action = confirm.accept(confirmId, connectionId);
        if (action) {
          const result = await voiceAgent.executeConfirmedAction(action, { ctx: { connectionId } });
          const say = result.ok ? result.summary : `That didn't work: ${result.summary}`;
          return res.json(buildCompletion(say, body.model));
        }
        // Expired/already-consumed — fall through and treat this utterance normally.
      } else {
        pendingConfirmId = null;
      }

      const result = await voiceAgent.handleUtterance({ text: userText, ctx: { mode: 's2s', connectionId } });
      if (result && result.confirmPending && result.confirmPending.confirmId) {
        pendingConfirmId = result.confirmPending.confirmId;
      }
      res.json(buildCompletion(result && result.say, body.model));
    } catch (err) {
      const requestId = req.id || 'unknown';
      res.status(500).json({ error: 'Internal server error.', requestId });
    }
  };
}

module.exports = { createS2sCompletionsRouter, buildCompletion, extractLastUserText };
