'use strict';

// anthropic.js — native Anthropic provider (BUG-418).
//
// WHY THIS IS NOT A LINE IN openai-compat.js, which is the whole reason BUG-418
// called the two halves asymmetric. Anthropic's Messages API differs from the
// OpenAI shape in five ways, every one of which breaks the factory:
//
//   1. AUTH. `x-api-key: <key>`, not `Authorization: Bearer <key>`.
//   2. A REQUIRED VERSION HEADER. `anthropic-version: 2023-06-01`. Omit it and
//      the request is refused outright.
//   3. `max_tokens` IS REQUIRED, always — not an optional cap.
//   4. SYSTEM IS A TOP-LEVEL FIELD, not a message with role 'system'. A system
//      message left in the array is rejected as an invalid role.
//   5. THE STREAM IS NAMED EVENTS, not one anonymous `data:` shape terminated by
//      `[DONE]`. Text arrives as `content_block_delta` with
//      `delta.text` — reading `choices[0].delta.content` finds nothing and would
//      return an empty string as a SUCCESS, which is the quiet failure this
//      whole file exists to avoid.
//
// Everything else deliberately matches the factory's contract exactly, because
// chain.js calls all lanes identically: the same { name, chat, isAvailable,
// getStatus, getModel } surface, the same honest degradation when the key is
// absent, and the same `err.status` for BUG-336's typed provider-fault identity
// (which BUG-419 now also reads to detect an account-level refusal).

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';
// Anthropic requires this and has no "unlimited" sentinel. Generous enough for a
// build turn, overridable for a buyer who wants longer answers.
const DEFAULT_MAX_TOKENS = 4096;

function getBaseURL() {
  const v = process.env.ANTHROPIC_BASE_URL;
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : DEFAULT_BASE_URL;
}

function getApiKey() {
  const v = process.env.ANTHROPIC_API_KEY;
  return v && v.trim() ? v.trim() : null;
}

function getModel() {
  const v = process.env.ANTHROPIC_MODEL;
  return v && v.trim() ? v.trim() : 'claude-sonnet-4-5';
}

function getMaxTokens() {
  const n = Number(process.env.ANTHROPIC_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_TOKENS;
}

function isAvailable() {
  return Boolean(getApiKey());
}

function getStatus() {
  return { ok: isAvailable(), model: getModel() };
}

// Pure, and exported for that reason: the message split is the part most likely
// to be got wrong and the part a test can pin without a network.
//
// Consecutive system messages are JOINED rather than the last one winning —
// dropping context silently is worse than a slightly long system prompt, and
// MYTHOS composes its Live prompt from several sections.
function splitMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = [];
  const rest = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) system.push(text);
      continue;
    }
    // Anthropic accepts only 'user' and 'assistant'. Anything else would be
    // refused by the API with a message the operator cannot act on, so it is
    // normalised here to the role it most nearly is.
    rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return { system: system.join('\n\n'), messages: rest };
}

// Pure. Pulls the text out of one parsed SSE event, or null.
//
// `content_block_delta` with `delta.type === 'text_delta'` is the only event
// carrying assistant text. `message_delta` and `content_block_start` also have a
// `delta`/`content_block`, so matching loosely on "has a delta" would emit
// stop-reason metadata into the answer.
function textFromEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.type !== 'content_block_delta') return null;
  const delta = evt.delta;
  if (!delta || delta.type !== 'text_delta') return null;
  return typeof delta.text === 'string' && delta.text ? delta.text : null;
}

async function chat(messages, opts = {}) {
  const { model, onToken, signal } = opts;
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY missing — add it to mythos/.env to enable anthropic');
  }

  const split = splitMessages(messages);
  const body = {
    model: model || getModel(),
    max_tokens: getMaxTokens(),
    messages: split.messages,
    stream: true,
  };
  if (split.system) body.system = split.system;

  const res = await fetch(`${getBaseURL()}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || errJson?.message || detail;
    } catch {
      // keep statusText
    }
    const err = new Error(`anthropic chat failed: ${res.status} ${detail}`);
    // BUG-336 typed identity, which BUG-419 also reads: a 401 or 402 here is a
    // fact about the account and takes the provider out of every lane until a
    // call succeeds.
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      // `event:` lines name the type and carry no payload; the type is repeated
      // inside the JSON, so only `data:` needs reading. Anthropic sends no
      // [DONE] sentinel — the stream simply ends — so there is nothing to skip.
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      // An error can arrive mid-stream after a 200, which the status check above
      // cannot see. Surfacing it beats returning a truncated answer as success.
      if (evt && evt.type === 'error') {
        const err = new Error(`anthropic stream error: ${evt.error?.message || 'unknown'}`);
        err.status = 500;
        throw err;
      }
      const text = textFromEvent(evt);
      if (text) {
        full += text;
        if (onToken) onToken(text);
      }
    }
  }

  return full;
}

module.exports = {
  name: 'anthropic',
  chat,
  isAvailable,
  getStatus,
  getModel,
  getBaseURL,   // for brain/route-policy.js — every chat lane reports the host it calls
  // Seams: both are pure, and both encode a difference from the OpenAI shape
  // that a reader would otherwise have to take on trust.
  splitMessages,
  textFromEvent,
  API_VERSION,
  DEFAULT_MAX_TOKENS,
};
