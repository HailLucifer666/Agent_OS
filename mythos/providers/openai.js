// openai.js — native OpenAI provider (BUG-418).
//
// A buyer holding an OpenAI key had to open an OpenRouter account and pay its
// margin to use a key they already owned. OpenAI speaks exactly the protocol
// openai-compat.js was generalised FROM, so this is a configuration entry rather
// than a provider: POST {baseURL}/chat/completions, SSE `data:` lines ending in
// `data: [DONE]`, deltas at choices[0].delta.content.
//
// Base URL ends at /v1 — the factory does not append a version segment, by
// design (z.ai needs /v4). OPENAI_BASE_URL exists so an Azure OpenAI deployment
// or a self-hosted gateway can be pointed at without code, the same BYO posture
// the API keys already have.
//
// No key means the lane skips it and says so; nothing throws at boot. That is
// the repo rule, and it is what isAvailable() gives every other provider here.
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'openai',
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  defaultModelEnv: 'OPENAI_MODEL',
  // Deliberately a current general-purpose default rather than the newest or
  // cheapest: this is what a buyer gets before they choose, and OPENAI_MODEL
  // overrides it without touching code. Not measured on this machine — there is
  // no OpenAI key here — so no latency or quality claim is made about it
  // anywhere, unlike the free-tier entries in lanes.default.js.
  defaultModel: 'gpt-4.1',
});

module.exports = provider;
