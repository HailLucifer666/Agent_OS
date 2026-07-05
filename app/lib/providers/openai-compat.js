// openai-compat.js — factory for OpenAI-compatible chat-completion providers.
// Powers ZCode (z.ai) and NVIDIA NIM, both of which speak the OpenAI SSE protocol:
// POST {baseURL}/chat/completions with { model, messages, stream: true },
// receive `data:` SSE lines terminating in `data: [DONE]`, deltas in
// choices[0].delta.content. Generalized from providers/openrouter.js.
//
// IMPORTANT: baseURL must already include its version segment (/v4 for z.ai,
// /v1 for NIM). This module does NOT append /v1 — doing so breaks both providers.

function createOpenAICompatProvider(config) {
  const {
    name,
    baseURL,          // e.g. 'https://integrate.api.nvidia.com/v1' (version segment included)
    apiKeyEnv,        // env var name holding the bearer key
    defaultModelEnv,  // env var name for optional model override
    defaultModel,     // fallback model id
    alwaysMaxTokens = false, // NIM requires max_tokens; set true to inject it
  } = config;

  function getApiKey() {
    const v = process.env[apiKeyEnv];
    return v && v.trim() ? v.trim() : null;
  }

  function getModel() {
    const v = process.env[defaultModelEnv];
    return v && v.trim() ? v.trim() : defaultModel;
  }

  function isAvailable() {
    return Boolean(getApiKey());
  }

  function getStatus() {
    return { ok: isAvailable(), model: getModel() };
  }

  async function chat(messages, opts = {}) {
    const { model, onToken, signal } = opts;
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error(`${apiKeyEnv} missing — add it to app/.env to enable ${name}`);
    }

    const body = {
      model: model || getModel(),
      messages,
      stream: true,
    };
    if (alwaysMaxTokens) body.max_tokens = 4096;

    const res = await fetch(`${baseURL}/chat/completions`, {
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
        detail = errJson?.error?.message || errJson?.message || detail;
      } catch {
        // keep statusText
      }
      throw new Error(`${name} chat failed: ${res.status} ${detail}`);
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

  return { name, chat, isAvailable, getStatus, getModel };
}

module.exports = { createOpenAICompatProvider };
