// ollama.js — local Ollama chat streaming provider (Phase 2).
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen3:latest';

let modelsCache = { at: 0, models: [] };
const MODELS_CACHE_MS = 30000;

// Stateful filter that strips <think>...</think> blocks from a token stream,
// working across chunk boundaries. Feed raw chunks in, get visible text out.
function createThinkFilter() {
  let inThink = false;
  let buf = '';

  function feed(chunk) {
    buf += chunk;
    let out = '';
    for (;;) {
      if (!inThink) {
        const start = buf.indexOf('<think>');
        if (start === -1) {
          // No open tag yet — hold back a tail in case '<think>' is split across chunks.
          const holdBack = Math.min(buf.length, '<think>'.length - 1);
          out += buf.slice(0, buf.length - holdBack);
          buf = buf.slice(buf.length - holdBack);
          break;
        }
        out += buf.slice(0, start);
        buf = buf.slice(start + '<think>'.length);
        inThink = true;
      } else {
        const end = buf.indexOf('</think>');
        if (end === -1) {
          // No close tag yet — hold back a tail in case '</think>' is split across chunks,
          // discarding only what can't possibly be part of it.
          const holdBack = Math.min(buf.length, '</think>'.length - 1);
          buf = buf.slice(buf.length - holdBack);
          break;
        }
        buf = buf.slice(end + '</think>'.length);
        inThink = false;
      }
    }
    return out;
  }

  // Releases any held-back tail once the stream ends (no more chunks coming,
  // so there's no risk of a split '<think>' tag arriving later).
  function flush() {
    if (inThink) return '';
    const out = buf;
    buf = '';
    return out;
  }

  return { feed, flush };
}

async function chat(messages, opts = {}) {
  const { model, onToken, signal } = opts;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || DEFAULT_MODEL, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`ollama chat failed: ${res.status} ${text || res.statusText}`);
  }

  const filter = createThinkFilter();
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
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const content = evt?.message?.content;
      if (content) {
        const visible = filter.feed(content);
        if (visible) {
          full += visible;
          if (onToken) onToken(visible);
        }
      }
    }
  }

  const tail = filter.flush();
  if (tail) {
    full += tail;
    if (onToken) onToken(tail);
  }

  return full;
}

async function listModels() {
  const now = Date.now();
  if (now - modelsCache.at < MODELS_CACHE_MS) return modelsCache.models;

  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags failed: ${res.status}`);
  const data = await res.json();
  const models = (data.models || [])
    .map((m) => m.name || m.model)
    .filter(Boolean)
    .filter((name) => !/bert|bge/i.test(name));

  modelsCache = { at: now, models };
  return models;
}

module.exports = { chat, listModels };
