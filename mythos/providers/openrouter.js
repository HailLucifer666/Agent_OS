// openrouter.js — OpenRouter chat streaming provider (Phase 2).

function isAvailable() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

async function chat(messages, opts = {}) {
  const { model, onToken, signal } = opts;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing — add it to app/.env');

  const body = { model, messages, stream: true };

  // Reasoning models on OpenRouter return their chain-of-thought in a separate
  // `reasoning` field. This provider only ever accumulates delta.content, so
  // those tokens are generated, billed against the account's quota, and then
  // discarded unread. Excluding them stops paying for output nobody reads —
  // which matters here because the free tier exposes no rate-limit headers, so
  // remaining daily quota is unmeasurable and worth conserving.
  //
  // NOT a latency optimization: measured 2026-07-29 over 5 paired calls against
  // inclusionai/ling-3.0-flash, median 950ms excluded vs 975ms kept — identical
  // within noise. (An earlier single-sample reading suggested a 3x speedup; it
  // did not survive repetition. Don't re-justify this flag on speed.)
  //
  // Set OPENROUTER_KEEP_REASONING=1 to keep it (e.g. when debugging a model's
  // logic, or if a future model routes its actual answer through that field).
  if (!process.env.OPENROUTER_KEEP_REASONING) {
    body.reasoning = { exclude: true };
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || detail;
    } catch {
      // ignore parse failure, keep statusText
    }
    const err = new Error(`openrouter chat failed: ${res.status} ${detail}`);
    err.status = res.status; // BUG-336: typed provider-fault identity for chain.js
    throw err;
  }

  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = evt?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        if (onToken) onToken(delta);
      }
    }
  }

  return full;
}

function getModel() {
  return null;
}

function getStatus() {
  return { ok: isAvailable(), model: getModel() };
}

module.exports = { name: 'openrouter', chat, isAvailable, getModel, getStatus };
