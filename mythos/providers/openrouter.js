// openrouter.js — OpenRouter chat streaming provider (Phase 2).

function isAvailable() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

async function chat(messages, opts = {}) {
  const { model, onToken, signal } = opts;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing — add it to app/.env');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
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
    throw new Error(`openrouter chat failed: ${res.status} ${detail}`);
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
